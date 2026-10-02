import type { BranchRow, FileEntry, LogRow, StashRow } from '../types'

/** Most characters a `Code` element takes. */
export const CODE_LIMIT = 10000
const HUNK_BUDGET = 9000

// ---------------------------------------------------------------- status

export type ParsedStatus = {
  branch: string | null
  oid: string
  upstream: string | null
  ahead: number
  behind: number
  entries: FileEntry[]
}

/** Splits off the first `count` space-separated fields; the rest is one string. */
const fields = (line: string, count: number): [string[], string] => {
  const head: string[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    const next = line.indexOf(' ', at)
    if (next === -1) {
      head.push(line.slice(at))
      return [head, '']
    }
    head.push(line.slice(at, next))
    at = next + 1
  }
  return [head, line.slice(at)]
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export const parseStatus = (out: string): ParsedStatus => {
  const result: ParsedStatus = {
    branch: null,
    oid: '',
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
  }
  const parts = out.split('\0')

  for (let i = 0; i < parts.length; i++) {
    const line = parts[i] ?? ''
    if (line === '') continue

    if (line.startsWith('# ')) {
      const [key = '', ...rest] = line.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        result.oid = value === '(initial)' ? '' : value.slice(0, 8)
      } else if (key === 'branch.head') {
        result.branch = value === '(detached)' ? null : value
      } else if (key === 'branch.upstream') {
        result.upstream = value
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          result.ahead = Number(match[1])
          result.behind = Number(match[2])
        }
      }
      continue
    }

    const tag = line[0]
    if (tag === '1') {
      const [head, path] = fields(line, 8)
      const xy = head[1] ?? '..'
      result.entries.push({ path, kind: 'ordinary', x: xy[0] ?? '.', y: xy[1] ?? '.' })
    } else if (tag === '2') {
      const [head, path] = fields(line, 9)
      const xy = head[1] ?? '..'
      const orig = parts[++i] ?? ''
      result.entries.push({ path, orig, kind: 'rename', x: xy[0] ?? '.', y: xy[1] ?? '.' })
    } else if (tag === 'u') {
      const [head, path] = fields(line, 10)
      const xy = head[1] ?? '..'
      result.entries.push({ path, kind: 'unmerged', x: xy[0] ?? 'U', y: xy[1] ?? 'U' })
    } else if (tag === '?') {
      result.entries.push({ path: line.slice(2), kind: 'untracked', x: '.', y: '?' })
    }
  }

  return result
}

export const isStaged = (e: FileEntry) =>
  (e.kind === 'ordinary' || e.kind === 'rename') && e.x !== '.'
export const isUnstaged = (e: FileEntry) =>
  (e.kind === 'ordinary' || e.kind === 'rename') && e.y !== '.'
export const isUntracked = (e: FileEntry) => e.kind === 'untracked'
export const isConflicted = (e: FileEntry) => e.kind === 'unmerged'

export const letterColor = (letter: string) => {
  switch (letter) {
    case 'A':
    case '?':
      return 'green'
    case 'D':
      return 'red'
    case 'R':
    case 'C':
      return 'cyan'
    case 'U':
      return 'magenta'
    default:
      return 'yellow'
  }
}

// ------------------------------------------------------------------ diff

export type Hunk = {
  header: string
  lines: string[]
  /** A piece cut from a hunk too long for one `Code`: it cannot be applied alone. */
  isSplit: boolean
}

export type FileDiff = {
  path: string
  /** The lines ahead of the first hunk (`diff --git`, `index`, `---`, `+++`). */
  header: string[]
  hunks: Hunk[]
  isBinary: boolean
  isCombined: boolean
  /** Mode changes, renames, and anything else that has no hunk. */
  notes: string[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const pathOfHeader = (line: string) => {
  const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
  if (match) return match[2] ?? match[1] ?? ''
  const combined = /^diff --(?:cc|combined) (.*)$/.exec(line)
  return combined?.[1] ?? line
}

/** Cuts a hunk whose text is over `budget` into hunks that each fit. */
export const splitHunk = (hunk: Hunk, budget = HUNK_BUDGET): Hunk[] => {
  const size = hunk.header.length + hunk.lines.reduce((n, l) => n + l.length + 1, 0)
  if (size <= budget) return [hunk]

  const match = HUNK.exec(hunk.header)
  let oldLine = Number(match?.[1] ?? 1)
  let newLine = Number(match?.[3] ?? 1)
  const pieces: Hunk[] = []
  let chunk: string[] = []
  let chunkSize = 0
  let oldStart = oldLine
  let newStart = newLine
  let oldCount = 0
  let newCount = 0

  const flush = () => {
    if (chunk.length === 0) return
    pieces.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines: chunk,
      isSplit: true,
    })
    chunk = []
    chunkSize = 0
    oldStart = oldLine
    newStart = newLine
    oldCount = 0
    newCount = 0
  }

  for (const raw of hunk.lines) {
    const line = raw.length > budget - 200 ? `${raw.slice(0, budget - 240)}…` : raw
    if (chunkSize + line.length + 1 > budget - 60) flush()
    chunk.push(line)
    chunkSize += line.length + 1
    const mark = line[0]
    if (mark === ' ' || line === '') {
      oldLine++
      newLine++
      oldCount++
      newCount++
    } else if (mark === '-') {
      oldLine++
      oldCount++
    } else if (mark === '+') {
      newLine++
      newCount++
    }
  }
  flush()

  return pieces
}

/** Parses unified diff text (one file, or a whole `git show`) into files and hunks. */
export const parseDiff = (text: string): FileDiff[] => {
  const files: FileDiff[] = []
  if (text.trim() === '') return files

  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  let file: FileDiff | null = null
  let hunk: Hunk | null = null

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      file = {
        path: pathOfHeader(line),
        header: [line],
        hunks: [],
        isBinary: false,
        isCombined: !line.startsWith('diff --git '),
        notes: [],
      }
      files.push(file)
      hunk = null
      continue
    }

    if (file === null) {
      file = { path: '', header: [], hunks: [], isBinary: false, isCombined: false, notes: [] }
      files.push(file)
    }

    if (line.startsWith('@@@')) {
      file.isCombined = true
      hunk = null
      file.notes.push(line)
      continue
    }

    if (HUNK.test(line)) {
      hunk = { header: line, lines: [], isSplit: false }
      file.hunks.push(hunk)
      continue
    }

    if (hunk !== null && !file.isCombined) {
      hunk.lines.push(line)
      continue
    }

    if (file.isCombined) {
      file.notes.push(line)
      continue
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.isBinary = true
    if (!line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith('index ')) {
      file.notes.push(line)
    }
    file.header.push(line)
  }

  return files
}

/** A patch holding one hunk of a file, for `git apply`. */
export const hunkPatch = (file: FileDiff, hunk: Hunk) =>
  `${file.header.join('\n')}\n${hunk.header}\n${hunk.lines.join('\n')}\n`

/** The text a `Code` element draws for a hunk. */
export const hunkSource = (hunk: Hunk) => `${hunk.header}\n${hunk.lines.join('\n')}`

export const countHunks = (files: FileDiff[]) => files.reduce((n, f) => n + f.hunks.length, 0)

// ------------------------------------------------------------------- log

export const LOG_FORMAT = '\x1e%H\x1f%h\x1f%D\x1f%an\x1f%ar\x1f%s'

/** Parses `git log --graph --pretty=format:LOG_FORMAT`. */
export const parseLog = (out: string): LogRow[] => {
  const rows: LogRow[] = []
  for (const line of out.split('\n')) {
    if (line === '') continue
    const cut = line.indexOf('\x1e')
    if (cut === -1) {
      rows.push({ graph: line, hash: '', short: '', refs: '', author: '', date: '', subject: '' })
      continue
    }
    const [hash = '', short = '', refs = '', author = '', date = '', ...subject] = line
      .slice(cut + 1)
      .split('\x1f')
    rows.push({ graph: line.slice(0, cut), hash, short, refs, author, date, subject: subject.join('\x1f') })
  }
  return rows
}

// -------------------------------------------------------------- branches

export const BRANCH_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(contents:subject)',
  '%(committerdate:relative)',
].join('%1f')

/** Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`. */
export const parseBranches = (out: string): BranchRow[] => {
  const rows: BranchRow[] = []
  for (const line of out.split('\n')) {
    if (line === '') continue
    const [ref = '', name = '', head = '', upstream = '', track = '', subject = '', date = ''] = line.split('\x1f')
    const isRemote = ref.startsWith('refs/remotes/')
    if (isRemote && name.endsWith('/HEAD')) continue
    rows.push({ name, isRemote, isCurrent: head === '*', upstream, track, subject, date })
  }
  return rows.sort((a, b) => Number(a.isRemote) - Number(b.isRemote) || Number(b.isCurrent) - Number(a.isCurrent))
}

// ----------------------------------------------------------------- stash

export const STASH_FORMAT = '%gd%x1f%s%x1f%cr'

export const parseStashes = (out: string): StashRow[] =>
  out
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      const [ref = '', subject = '', date = ''] = line.split('\x1f')
      return { ref, subject, date }
    })

// ------------------------------------------------------------------ misc

/** First lines of a command's complaint, short enough for a notice. */
export const brief = (text: string, max = 400) => {
  const trimmed = text.trim().split('\n').filter(l => l.trim() !== '').slice(0, 6).join('\n')
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export const statusLabel = (e: FileEntry, isStagedSide: boolean) => {
  if (e.kind === 'untracked') return '?'
  if (e.kind === 'unmerged') return 'U'
  const letter = isStagedSide ? e.x : e.y
  return letter === '.' ? ' ' : letter
}

/** A path fit for a prompt: a code span on one line, or null when it holds control characters or backticks. */
export const quotePath = (path: string) =>
  // eslint-disable-next-line no-control-regex
  /[\x00-\x1f\x7f`]/.test(path) ? null : `\`${path}\``

/** Whether `name` is something `git switch -c` takes as a branch name and not as an option. */
export const isBranchName = (name: string) =>
  name !== '' &&
  !name.startsWith('-') &&
  // eslint-disable-next-line no-control-regex
  !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|\.lock$|^\/|\/$|\.$/.test(name)

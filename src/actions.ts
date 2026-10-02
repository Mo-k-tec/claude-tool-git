import type {
  BranchRow,
  CommitDetail,
  Confirm,
  DiffState,
  DiffTarget,
  FileEntry,
  LogState,
  Snapshot,
  Tab,
} from '../types'
import { cmd, git, OP_MARKERS, opCommand, why } from './git'
import type { Host } from './host'
import type { GitResult } from './git'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  STASH_FORMAT,
  hunkPatch,
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  isBranchName,
  parseBranches,
  quotePath,
  parseLog,
  parseStashes,
  parseStatus,
} from './parse'
import type { FileDiff, Hunk } from './parse'
import { patchUi, readSnapshot, readUi } from './store'

type H = Host

const LOG_PAGE = 100
const DIFF_PAGE = 40
const MAX_DIFF_CHARS = 800_000

const failure = (err: string): GitResult => ({ ok: false, code: 1, out: '', err })

const rootOf = async (h: H) => (await readSnapshot(h))?.root || undefined

// --------------------------------------------------------------- refresh

let isRefreshing = false
let isRefreshPending = false
let lastSignature = ''

export const statusLine = (s: Snapshot | null) => {
  if (s === null || !s.isRepo) return undefined
  const staged = s.entries.filter(isStaged).length
  const changed = s.entries.filter(e => isUnstaged(e) || isConflicted(e)).length
  const fresh = s.entries.filter(isUntracked).length
  const parts = [`⎇ ${s.branch ?? `(${s.head || 'detached'})`}`]
  if (s.ahead > 0) parts.push(`↑${s.ahead}`)
  if (s.behind > 0) parts.push(`↓${s.behind}`)
  if (staged > 0) parts.push(`●${staged}`)
  if (changed > 0) parts.push(`✚${changed}`)
  if (fresh > 0) parts.push(`…${fresh}`)
  if (s.op !== null) parts.push(`(${s.op})`)
  return parts.join(' ')
}

const notRepo = (error: string | null): Snapshot => ({
  isRepo: false,
  root: '',
  gitDir: '',
  branch: null,
  head: '',
  upstream: null,
  ahead: 0,
  behind: 0,
  entries: [],
  op: null,
  error,
  signature: `no-repo:${error ?? ''}`,
})

/** Reads the repository's state and, when it changed, redraws everything that shows it. */
export const refresh = async (h: H, isForced = false) => {
  if (isRefreshing) {
    // A read already under way may predate the change that asked for this one.
    if (isForced) isRefreshPending = true
    return
  }
  isRefreshing = true
  try {
    let isForcedNow = isForced
    do {
      isRefreshPending = false
      await refreshOnce(h, isForcedNow)
      isForcedNow = true
    } while (isRefreshPending)
  } finally {
    isRefreshing = false
  }
}

const refreshOnce = async (h: H, isForced: boolean) => {
  const top = await git(h, cmd.toplevel, { isRead: true })
  let snapshot: Snapshot
  if (!top.ok) {
    const isMissing = top.code === -1
    snapshot = notRepo(isMissing ? why(top) : null)
  } else {
    const [root = '', gitDir = ''] = top.out.trim().split('\n')
    const status = await git(h, cmd.status, { cwd: root, isRead: true })
    if (!status.ok) {
      snapshot = { ...notRepo(why(status)), isRepo: true, root, gitDir }
    } else {
      const parsed = parseStatus(status.out)
      let op: Snapshot['op'] = null
      for (const [marker, kind] of OP_MARKERS) {
        if (await h.exists(`${gitDir}/${marker}`)) {
          op = kind
          break
        }
      }
      snapshot = {
        isRepo: true,
        root,
        gitDir,
        branch: parsed.branch,
        head: parsed.oid,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        entries: parsed.entries,
        op,
        error: null,
        signature: '',
      }
      snapshot.signature = JSON.stringify([
        snapshot.root,
        snapshot.branch,
        snapshot.head,
        snapshot.upstream,
        snapshot.ahead,
        snapshot.behind,
        snapshot.op,
        snapshot.entries,
      ])
    }
  }

  if (isForced || snapshot.signature !== lastSignature) {
    lastSignature = snapshot.signature
    await h.setSnapshot(snapshot)
    h.setStatus(statusLine(snapshot))
    await reloadViews(h)
  }
}

/** Reloads whatever the current tab shows. */
export const reloadViews = async (h: H) => {
  const ui = await readUi(h)
  const tasks: Promise<unknown>[] = []
  if (ui.tab === 'status' && ui.diff !== null) tasks.push(reloadDiff(h))
  if (ui.tab === 'log' && ui.log !== null) {
    tasks.push(loadLog(h, ui.log.count, ui.log.isAll))
    if (ui.detail !== null) tasks.push(openCommit(h, ui.detail.hash))
  }
  if (ui.tab === 'branches') tasks.push(loadBranches(h))
  if (ui.tab === 'stash') tasks.push(loadStashes(h))
  await Promise.all(tasks)
}

// ------------------------------------------------------------- run an op

const setNotice = (
  h: H,
  level: 'info' | 'error',
  text: string,
) => patchUi(h, { notice: { level, text } })

/** Runs one user-visible operation: marks the pane busy, reports failure, refreshes. */
export const act = async (
  h: H,
  label: string,
  run: () => Promise<GitResult | null>,
  okText?: string,
): Promise<boolean> => {
  const ui = await readUi(h)
  if (ui.busy !== null) {
    h.toast(`Still ${ui.busy.toLowerCase()}…`)
    return false
  }
  await patchUi(h, { busy: label, notice: null, confirm: null })
  let isOk = false
  try {
    const result = await run()
    if (result !== null && !result.ok) {
      await setNotice(h, 'error', `${label} failed: ${why(result)}`)
    } else {
      isOk = true
      if (okText !== undefined) await setNotice(h, 'info', okText)
    }
  } catch (error) {
    await setNotice(h, 'error', `${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await patchUi(h, { busy: null })
    await refresh(h, true)
  }
  return isOk
}

export const dismissNotice = (h: H) => patchUi(h, { notice: null })

// ------------------------------------------------------------- navigation

export const switchTab = async (h: H, tab: Tab) => {
  await patchUi(h, { tab, confirm: null, diff: null, detail: null })
  if (tab === 'log') {
    const ui = await readUi(h)
    await loadLog(h, ui.log?.count ?? LOG_PAGE, ui.log?.isAll ?? false)
  } else if (tab === 'branches') {
    await loadBranches(h)
  } else if (tab === 'stash') {
    await loadStashes(h)
  }
}

export type FileRef = { path: string; isStaged: boolean; isUntracked: boolean; entry: FileEntry }

/** Every file the status list shows, in the order it shows them. */
export const orderedFiles = (snapshot: Snapshot | null): FileRef[] => {
  const entries = snapshot?.entries ?? []
  return [
    ...entries.filter(isConflicted).map(entry => ({ path: entry.path, isStaged: false, isUntracked: false, entry })),
    ...entries.filter(isStaged).map(entry => ({ path: entry.path, isStaged: true, isUntracked: false, entry })),
    ...entries.filter(isUnstaged).map(entry => ({ path: entry.path, isStaged: false, isUntracked: false, entry })),
    ...entries.filter(isUntracked).map(entry => ({ path: entry.path, isStaged: false, isUntracked: true, entry })),
  ]
}

// ------------------------------------------------------------------ diffs

const clip = (text: string) =>
  text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n` : text

const titleOf = (target: DiffTarget) => {
  switch (target.kind) {
    case 'worktree':
      return `${target.path} (${target.isUntracked ? 'untracked' : target.isStaged ? 'staged' : 'unstaged'})`
    case 'commit':
      return target.hash.slice(0, 8)
    default:
      return target.ref
  }
}

const diffArgs = (target: DiffTarget, isConflict: boolean): readonly string[] => {
  switch (target.kind) {
    case 'worktree':
      if (target.isUntracked) return cmd.diffUntracked(target.path)
      if (isConflict) return cmd.diffConflict(target.path)
      return target.isStaged ? cmd.diffStaged(target.path) : cmd.diffWorktree(target.path)
    case 'commit':
      return cmd.showCommit(target.hash)
    default:
      return cmd.stashShow(target.ref)
  }
}

const loadDiffState = async (h: H, target: DiffTarget, limit: number): Promise<DiffState> => {
  const snapshot = await readSnapshot(h)
  const isConflict =
    target.kind === 'worktree' &&
    (snapshot?.entries.some(e => e.path === target.path && isConflicted(e)) ?? false)
  const result = await git(h, diffArgs(target, isConflict), { cwd: snapshot?.root, isRead: true })
  // `diff --no-index` exits 1 when the files differ.
  const isDiffOk = result.ok || (target.kind === 'worktree' && target.isUntracked && result.code === 1)
  return {
    target,
    title: titleOf(target),
    text: isDiffOk ? clip(result.out) : '',
    error: isDiffOk ? null : why(result),
    limit,
  }
}

export const openFile = async (h: H, file: FileRef) => {
  const target: DiffTarget = {
    kind: 'worktree',
    path: file.path,
    isStaged: file.isStaged,
    isUntracked: file.isUntracked,
  }
  await patchUi(h, { diff: await loadDiffState(h, target, DIFF_PAGE), confirm: null })
}

export const closeDiff = (h: H) => patchUi(h, { diff: null, confirm: null })

/** Redraws the open diff from git; closes it when the file no longer has changes. */
export const reloadDiff = async (h: H) => {
  const ui = await readUi(h)
  if (ui.diff === null) return
  const next = await loadDiffState(h, ui.diff.target, ui.diff.limit)
  const isGone = next.target.kind === 'worktree' && next.error === null && next.text.trim() === ''
  await patchUi(h, { diff: isGone ? null : next })
}

export const showMoreDiff = async (h: H) => {
  const ui = await readUi(h)
  if (ui.diff !== null) await patchUi(h, { diff: { ...ui.diff, limit: ui.diff.limit + DIFF_PAGE } })
  else if (ui.detail !== null) {
    await patchUi(h, {
      detail: { ...ui.detail, diff: { ...ui.detail.diff, limit: ui.detail.diff.limit + DIFF_PAGE } },
    })
  }
}

/** Steps to the neighbouring file in the status list while a diff is open. */
export const stepFile = async (h: H, step: 1 | -1) => {
  const ui = await readUi(h)
  const snapshot = await readSnapshot(h)
  const target = ui.diff?.target
  if (target === undefined || target.kind !== 'worktree') return
  const files = orderedFiles(snapshot)
  const at = files.findIndex(
    f => f.path === target.path && f.isStaged === target.isStaged && f.isUntracked === target.isUntracked,
  )
  const next = files[(at + step + files.length) % files.length]
  if (next !== undefined) await openFile(h, next)
}

// ------------------------------------------------------ stage and discard

const pathsArg = (paths: readonly string[]) => (paths.length === 0 ? ['.'] : paths)

export const stageFiles = async (h: H, label: string, paths: readonly string[]) => {
  const root = await rootOf(h)
  return act(h, label, () => git(h, cmd.stage(pathsArg(paths)), { cwd: root }))
}

export const unstageFiles = async (h: H, label: string, paths: readonly string[]) => {
  const root = await rootOf(h)
  const snapshot = await readSnapshot(h)
  return act(h, label, async () => {
    const unborn = snapshot?.head === ''
    return git(h, unborn ? cmd.unstageUnborn(paths) : cmd.unstage(pathsArg(paths)), { cwd: root })
  })
}

export const stageAll = async (h: H) => {
  const root = await rootOf(h)
  return act(h, 'Staging all', () => git(h, cmd.stageAll, { cwd: root }))
}

export const unstageAll = async (h: H) => {
  const root = await rootOf(h)
  const snapshot = await readSnapshot(h)
  return act(h, 'Unstaging all', () =>
    git(
      h,
      snapshot?.head === '' ? cmd.unstageUnborn(snapshot.entries.filter(isStaged).map(e => e.path)) : cmd.unstageAll,
      { cwd: root },
    ),
  )
}

export const discardFile = async (h: H, path: string, isUntrackedFile: boolean) => {
  const root = await rootOf(h)
  return act(h, 'Discarding', () =>
    git(h, isUntrackedFile ? cmd.discardUntracked(path) : cmd.discard(path), { cwd: root }),
  )
}

export const discardAll = async (h: H) => {
  const root = await rootOf(h)
  return act(h, 'Discarding all', async () => {
    const restored = await git(h, cmd.discardAll, { cwd: root })
    if (!restored.ok) return restored
    return git(h, cmd.cleanAll, { cwd: root })
  })
}

/** Stages, unstages or discards one hunk of the open file diff. */
export const applyHunk = async (
  h: H,
  file: FileDiff,
  hunk: Hunk,
  mode: 'stage' | 'unstage' | 'discard',
) => {
  const root = await rootOf(h)
  const args = mode === 'stage' ? cmd.applyCached : mode === 'unstage' ? cmd.applyCachedReverse : cmd.applyReverse
  const label = mode === 'stage' ? 'Staging hunk' : mode === 'unstage' ? 'Unstaging hunk' : 'Discarding hunk'
  return act(h, label, () => git(h, args, { cwd: root, stdin: hunkPatch(file, hunk) }))
}

// ------------------------------------------------------------ conflicts

export const resolveWith = async (h: H, path: string, side: 'ours' | 'theirs') => {
  const root = await rootOf(h)
  return act(h, `Taking ${side}`, async () => {
    const checked = await git(h, side === 'ours' ? cmd.checkoutOurs(path) : cmd.checkoutTheirs(path), { cwd: root })
    if (!checked.ok) return checked
    return git(h, cmd.stage([path]), { cwd: root })
  })
}

export const continueOp = async (h: H) => {
  const snapshot = await readSnapshot(h)
  const root = snapshot?.root
  const op = snapshot?.op
  if (!op) return
  return act(h, `Continuing ${op}`, () => git(h, opCommand(op, 'continue'), { cwd: root, timeoutMs: 120_000 }))
}

export const abortOp = async (h: H) => {
  const snapshot = await readSnapshot(h)
  const root = snapshot?.root
  const op = snapshot?.op
  if (!op) return
  return act(h, `Aborting ${op}`, () => git(h, opCommand(op, 'abort'), { cwd: root, timeoutMs: 120_000 }))
}

// ------------------------------------------------------------------ commit

export const setSubject = (h: H, value: string) => patchUi(h, { subject: value })
export const setBody = (h: H, value: string) => patchUi(h, { body: value })

export const toggleAmend = async (h: H) => {
  const ui = await readUi(h)
  if (ui.isAmend) {
    await patchUi(h, { isAmend: false })
    return
  }
  const snapshot = await readSnapshot(h)
  const last = ui.subject === '' ? await git(h, cmd.lastMessage, { cwd: snapshot?.root, isRead: true }) : null
  if (last !== null && last.ok) {
    const [subject = '', ...rest] = last.out.trim().split('\n')
    await patchUi(h, { isAmend: true, subject, body: rest.join('\n').trim() })
  } else {
    await patchUi(h, { isAmend: true })
  }
}

export const commit = async (h: H) => {
  const ui = await readUi(h)
  const snapshot = await readSnapshot(h)
  if (snapshot === null) return
  if (snapshot.op === 'merge' && !snapshot.entries.some(isConflicted) && ui.subject.trim() === '') {
    await continueOp(h)
    return
  }
  const hasStaged = snapshot.entries.some(isStaged)
  if (!hasStaged && !ui.isAmend) {
    await setNotice(h, 'error', 'Nothing is staged. Stage files first (a stages everything).')
    return
  }
  if (ui.subject.trim() === '' && !ui.isAmend) {
    await setNotice(h, 'error', 'Write a commit message first.')
    return
  }
  const args =
    ui.subject.trim() === '' && ui.isAmend ? cmd.amendNoEdit : cmd.commit(ui.subject.trim(), ui.body, ui.isAmend)
  const isOk = await act(h, ui.isAmend ? 'Amending' : 'Committing', () =>
    git(h, args, { cwd: snapshot.root, timeoutMs: 60_000 }),
  )
  if (isOk) {
    await patchUi(h, { subject: '', body: '', isAmend: false, diff: null })
    await setNotice(h, 'info', ui.isAmend ? 'Amended the last commit.' : 'Committed.')
  }
}

const MESSAGE_RULES = [
  'Write a git commit message for the staged changes below.',
  'Format: one subject line of at most 72 characters in the imperative mood, no trailing period;',
  'then, only if the change needs it, a blank line and a short body that explains why.',
  'Match the style of the recent subjects. Plain text only: no markdown, no code fences,',
  'no quotes around the message, and no trailers or attribution lines of any kind.',
  'Reply with the message and nothing else.',
].join(' ')

export const generateMessage = async (h: H) => {
  const snapshot = await readSnapshot(h)
  if (snapshot === null) return
  if (!snapshot.entries.some(isStaged)) {
    await setNotice(h, 'error', 'Stage something first: the message is written from the staged changes.')
    return
  }
  await act(h, 'Writing a message', async () => {
    const diff = await git(h, cmd.stagedDiff, { cwd: snapshot.root, isRead: true })
    if (!diff.ok) return diff
    const recent = await git(h, cmd.recentSubjects, { cwd: snapshot.root, isRead: true })
    const changes = diff.out.length > 24_000 ? `${diff.out.slice(0, 24_000)}\n[diff cut]` : diff.out
    const reply = await h.complete({
      model: 'haiku',
      system: MESSAGE_RULES,
      prompt: `Recent commit subjects:\n${recent.out.trim() || '(none)'}\n\nStaged changes:\n${changes}`,
      maxTokens: 400,
      timeoutMs: 45_000,
    })
    if (!reply.isAnswered) return failure(`the model did not answer (${reply.reason})`)
    const cleaned = reply.text
      .trim()
      .replace(/^```[a-z]*\n?|\n?```$/g, '')
      .replace(/^(co-authored-by|generated with).*$/gim, '')
      .trim()
    const [subject = '', ...rest] = cleaned.split('\n')
    await patchUi(h, { subject: subject.trim(), body: rest.join('\n').trim() })
    return null
  })
}

// ---------------------------------------------------------------- remotes

export const fetchRemotes = async (h: H) => {
  const root = await rootOf(h)
  return act(h, 'Fetching', () => git(h, cmd.fetch, { cwd: root, timeoutMs: 120_000 }), 'Fetched.')
}

export const pull = async (h: H) => {
  const snapshot = await readSnapshot(h)
  if (snapshot?.upstream === null || snapshot === null) {
    await setNotice(h, 'error', 'This branch has no upstream to pull from.')
    return
  }
  return act(h, 'Pulling', () => git(h, cmd.pull, { cwd: snapshot.root, timeoutMs: 120_000 }), 'Pulled.')
}

export const push = async (h: H) => {
  const snapshot = await readSnapshot(h)
  if (snapshot === null || snapshot.branch === null) {
    await setNotice(h, 'error', 'Switch to a branch before pushing.')
    return
  }
  return act(
    h,
    'Pushing',
    async () => {
      if (snapshot.upstream !== null) return git(h, cmd.push, { cwd: snapshot.root, timeoutMs: 120_000 })
      const remotes = await git(h, cmd.remotes, { cwd: snapshot.root, isRead: true })
      const names = remotes.out.split('\n').filter(Boolean)
      const remote = names.includes('origin') ? 'origin' : names[0]
      if (remote === undefined) return failure('there is no remote to push to')
      return git(h, cmd.pushUpstream(remote, snapshot.branch ?? 'HEAD'), { cwd: snapshot.root, timeoutMs: 120_000 })
    },
    'Pushed.',
  )
}

// -------------------------------------------------------------------- log

export const loadLog = async (h: H, count: number, isAll: boolean) => {
  const snapshot = await readSnapshot(h)
  const result = await git(h, cmd.log(count, isAll, LOG_FORMAT), { cwd: snapshot?.root, isRead: true })
  const rows = result.ok ? parseLog(result.out) : []
  const commits = rows.filter(r => r.hash !== '').length
  const log: LogState = {
    rows,
    count,
    isAll,
    hasMore: commits >= count,
    error: result.ok ? null : (snapshot?.head === '' ? 'No commits yet.' : why(result)),
  }
  await patchUi(h, { log })
}

export const logMore = async (h: H) => {
  const ui = await readUi(h)
  await loadLog(h, (ui.log?.count ?? LOG_PAGE) + LOG_PAGE, ui.log?.isAll ?? false)
}

export const toggleAllBranches = async (h: H) => {
  const ui = await readUi(h)
  await loadLog(h, LOG_PAGE, !(ui.log?.isAll ?? false))
}

export const openCommit = async (h: H, hash: string) => {
  const snapshot = await readSnapshot(h)
  const cwd = snapshot?.root
  const [message, stat, diff] = await Promise.all([
    git(h, cmd.commitMessage(hash), { cwd, isRead: true }),
    git(h, cmd.commitStat(hash), { cwd, isRead: true }),
    loadDiffState(h, { kind: 'commit', hash }, (await readUi(h)).detail?.diff.limit ?? DIFF_PAGE),
  ])
  const detail: CommitDetail = {
    hash,
    message: message.ok ? message.out.trim() : why(message),
    stat: stat.ok ? stat.out.trimEnd() : '',
    diff,
  }
  await patchUi(h, { detail })
}

export const closeCommit = (h: H) => patchUi(h, { detail: null, confirm: null })

export const cherryPick = async (h: H, hash: string) => {
  const root = await rootOf(h)
  return act(h, 'Cherry-picking', () => git(h, cmd.cherryPick(hash), { cwd: root, timeoutMs: 60_000 }), 'Cherry-picked.')
}

export const revertCommit = async (h: H, hash: string) => {
  const root = await rootOf(h)
  return act(h, 'Reverting', () => git(h, cmd.revert(hash), { cwd: root, timeoutMs: 60_000 }), 'Reverted.')
}

export const checkoutCommit = async (h: H, hash: string) => {
  const root = await rootOf(h)
  return act(h, 'Checking out', () => git(h, cmd.switchDetach(hash), { cwd: root }), `Detached at ${hash.slice(0, 8)}.`)
}

// --------------------------------------------------------------- branches

export const loadBranches = async (h: H) => {
  const snapshot = await readSnapshot(h)
  const result = await git(h, cmd.branches(BRANCH_FORMAT), { cwd: snapshot?.root, isRead: true })
  await patchUi(h, { branches: result.ok ? parseBranches(result.out) : [] })
}

export const switchBranch = async (h: H, branch: BranchRow) => {
  const root = await rootOf(h)
  const local = branch.isRemote ? branch.name.slice(branch.name.indexOf('/') + 1) : branch.name
  return act(h, 'Switching', () => git(h, cmd.switchTo(local), { cwd: root }), `On ${local}.`)
}

export const setNewBranch = (h: H, value: string) => patchUi(h, { newBranch: value })

export const createBranch = async (h: H) => {
  const ui = await readUi(h)
  const name = ui.newBranch.trim()
  if (name === '') {
    await setNotice(h, 'error', 'Type a name for the new branch.')
    return
  }
  if (!isBranchName(name)) {
    await setNotice(h, 'error', `"${name}" is not a valid branch name.`)
    return
  }
  const root = await rootOf(h)
  const isOk = await act(h, 'Creating branch', () => git(h, cmd.switchCreate(name), { cwd: root }), `On new branch ${name}.`)
  if (isOk) await patchUi(h, { newBranch: '' })
}

export const deleteBranch = async (h: H, name: string) => {
  const root = await rootOf(h)
  return act(h, 'Deleting branch', () => git(h, cmd.deleteBranch(name, false), { cwd: root }), `Deleted ${name}.`)
}

export const mergeBranch = async (h: H, name: string) => {
  const root = await rootOf(h)
  return act(h, 'Merging', () => git(h, cmd.merge(name), { cwd: root, timeoutMs: 60_000 }), `Merged ${name}.`)
}

// ------------------------------------------------------------------ stash

export const loadStashes = async (h: H) => {
  const snapshot = await readSnapshot(h)
  const result = await git(h, cmd.stashList(STASH_FORMAT), { cwd: snapshot?.root, isRead: true })
  await patchUi(h, { stashes: result.ok ? parseStashes(result.out) : [] })
}

export const setStashMessage = (h: H, value: string) => patchUi(h, { stashMessage: value })

export const stashPush = async (h: H) => {
  const ui = await readUi(h)
  const root = await rootOf(h)
  const isOk = await act(h, 'Stashing', () => git(h, cmd.stashPush(ui.stashMessage.trim()), { cwd: root }), 'Stashed.')
  if (isOk) await patchUi(h, { stashMessage: '' })
}

export const stashApply = async (h: H, ref: string, isPop: boolean) => {
  const root = await rootOf(h)
  return act(
    h,
    isPop ? 'Popping stash' : 'Applying stash',
    () => git(h, isPop ? cmd.stashPop(ref) : cmd.stashApply(ref), { cwd: root }),
    isPop ? 'Popped.' : 'Applied.',
  )
}

export const stashDrop = async (h: H, ref: string) => {
  const root = await rootOf(h)
  return act(h, 'Dropping stash', () => git(h, cmd.stashDrop(ref), { cwd: root }), 'Dropped.')
}

export const openStash = async (h: H, ref: string) => {
  await patchUi(h, { diff: await loadDiffState(h, { kind: 'stash', ref }, DIFF_PAGE) })
}

// ---------------------------------------------------------------- confirm

export const ask = (kind: Confirm['kind'], arg: string, text: string): Confirm => ({ kind, arg, text })

export const setConfirm = (h: H, confirm: Confirm | null) => patchUi(h, { confirm })

/** Runs what a confirmed `Confirm` stands for. */
export const runConfirmed = async (h: H, confirm: Confirm, ctx: { file?: FileDiff; hunk?: Hunk; untracked?: boolean }) => {
  await patchUi(h, { confirm: null })
  switch (confirm.kind) {
    case 'discard-file':
      return discardFile(h, confirm.arg, ctx.untracked === true)
    case 'discard-hunk':
      if (ctx.file !== undefined && ctx.hunk !== undefined) return applyHunk(h, ctx.file, ctx.hunk, 'discard')
      return
    case 'discard-all':
      return discardAll(h)
    case 'delete-branch':
      return deleteBranch(h, confirm.arg)
    case 'merge-branch':
      return mergeBranch(h, confirm.arg)
    case 'drop-stash':
      return stashDrop(h, confirm.arg)
    case 'abort-op':
      return abortOp(h)
    case 'revert-commit':
      return revertCommit(h, confirm.arg)
    case 'cherry-pick':
      return cherryPick(h, confirm.arg)
    case 'checkout-commit':
      return checkoutCommit(h, confirm.arg)
    case 'amend':
      return toggleAmend(h)
  }
}

// ----------------------------------------------------------- ask Claude

export const askClaude = async (h: H, text: string) => {
  await h.submit(text)
  h.toast('Sent to Claude.')
}

export const reviewPrompt = (file: DiffTarget) => {
  if (file.kind === 'worktree') {
    // A file name is repository data: it goes in as a quoted span, or not at all.
    const quoted = quotePath(file.path)
    if (quoted === null) {
      return 'Review my uncommitted changes (run `git status` and `git diff`). Point out bugs, risky edits and anything I should reconsider before committing. Don\'t edit anything.'
    }
    const how = file.isUntracked
      ? 'it is a new, untracked file'
      : file.isStaged
        ? `run \`git diff --cached -- \` with ${quoted}`
        : `run \`git diff -- \` with ${quoted}`
    return `Review my uncommitted change to ${quoted} (${how}). Point out bugs, risky edits and anything I should reconsider before committing. Don't edit anything.`
  }
  if (file.kind === 'commit') {
    return `Explain what commit ${file.hash.slice(0, 12)} changes and why it might have been made (run \`git show ${file.hash}\`). Flag anything that looks wrong. Don't edit anything.`
  }
  return `Explain what ${file.ref} holds (run \`git stash show -p ${file.ref}\`) and whether it is safe to apply. Don't edit anything.`
}

import type { Host } from './host'
import { brief } from './parse'

export type GitResult = { ok: boolean; code: number; out: string; err: string }

export type GitOptions = {
  /** Directory to run in; the session's when absent. */
  cwd?: string
  stdin?: string
  timeoutMs?: number
  /** A read that must not take `index.lock` from the model's own git commands. */
  isRead?: boolean
}

const ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_PAGER: 'cat',
  GIT_MERGE_AUTOEDIT: 'no',
}

/** Runs `git <args>` with no shell, and never rejects. */
export const git = async (
  h: Host,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> => {
  const argv = [
    'git',
    ...(options.isRead ? ['--no-optional-locks'] : []),
    '-c',
    'core.quotepath=off',
    '-c',
    'color.ui=never',
    ...args,
  ]
  try {
    const result = await h.run(argv, {
      cwd: options.cwd,
      env: ENV,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? 30_000,
    })
    return { ok: result.exitCode === 0, code: result.exitCode, out: result.stdout, err: result.stderr }
  } catch (error) {
    return { ok: false, code: -1, out: '', err: error instanceof Error ? error.message : String(error) }
  }
}

/** The complaint of a failed command, or `fallback`. */
export const why = (result: GitResult, fallback = 'git failed') =>
  brief(result.err !== '' ? result.err : result.out, 500) || fallback

/** Arguments of the commands the views run, in one place so tests can read them. */
export const cmd = {
  status: ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'] as const,
  toplevel: ['rev-parse', '--show-toplevel', '--absolute-git-dir'] as const,

  stage: (paths: readonly string[]) => ['add', '--', ...paths],
  stageAll: ['add', '-A'] as const,
  unstage: (paths: readonly string[]) => ['restore', '--staged', '--', ...paths],
  /** `restore --staged` fails before the first commit; `rm --cached` works there. */
  unstageUnborn: (paths: readonly string[]) => ['rm', '--cached', '-q', '-r', '--', ...paths],
  unstageAll: ['restore', '--staged', '.'] as const,
  discard: (path: string) => ['restore', '--worktree', '--', path],
  discardUntracked: (path: string) => ['clean', '-f', '-q', '--', path],
  discardAll: ['restore', '--worktree', '.'] as const,
  cleanAll: ['clean', '-f', '-d', '-q'] as const,

  diffWorktree: (path: string) => ['diff', '--no-ext-diff', '-U3', '--', path],
  diffStaged: (path: string) => ['diff', '--cached', '--no-ext-diff', '-U3', '--', path],
  diffUntracked: (path: string) => ['diff', '--no-index', '--no-ext-diff', '-U3', '--', '/dev/null', path],
  diffConflict: (path: string) => ['diff', '--no-ext-diff', '--', path],
  showCommit: (hash: string) => ['show', '--format=', '--no-ext-diff', '-U3', '-M', hash],
  stashShow: (ref: string) => ['stash', 'show', '-p', '--no-ext-diff', ref],

  applyCached: ['apply', '--cached', '--recount', '--whitespace=nowarn', '-'] as const,
  applyCachedReverse: ['apply', '--cached', '--reverse', '--recount', '--whitespace=nowarn', '-'] as const,
  applyReverse: ['apply', '--reverse', '--recount', '--whitespace=nowarn', '-'] as const,

  commit: (subject: string, body: string, isAmend: boolean) => [
    'commit',
    ...(isAmend ? ['--amend'] : []),
    '-m',
    subject,
    ...(body.trim() === '' ? [] : ['-m', body.trim()]),
  ],
  amendNoEdit: ['commit', '--amend', '--no-edit'] as const,
  lastMessage: ['log', '-1', '--format=%B'] as const,
  stagedDiff: ['diff', '--cached', '--no-ext-diff', '-U2', '--stat', '-p'] as const,
  recentSubjects: ['log', '-n', '8', '--format=%s'] as const,

  log: (count: number, isAll: boolean, format: string) => [
    'log',
    '--graph',
    '--decorate=short',
    `--pretty=format:${format}`,
    '-n',
    String(count),
    ...(isAll ? ['--all'] : []),
  ],
  commitMessage: (hash: string) => ['show', '-s', '--format=%B', hash],
  commitStat: (hash: string) => ['show', '--format=', '--stat=100', '-M', hash],

  branches: (format: string) => ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'],
  switchTo: (name: string) => ['switch', name],
  switchDetach: (hash: string) => ['switch', '--detach', hash],
  switchCreate: (name: string) => ['switch', '-c', name],
  deleteBranch: (name: string, isForced: boolean) => ['branch', isForced ? '-D' : '-d', '--', name],
  merge: (name: string) => ['merge', '--no-edit', name],

  stashList: (format: string) => ['stash', 'list', `--format=${format}`],
  stashPush: (message: string) => ['stash', 'push', '--include-untracked', ...(message === '' ? [] : ['-m', message])],
  stashApply: (ref: string) => ['stash', 'apply', ref],
  stashPop: (ref: string) => ['stash', 'pop', ref],
  stashDrop: (ref: string) => ['stash', 'drop', ref],

  fetch: ['fetch', '--prune', '--all'] as const,
  pull: ['pull', '--ff-only'] as const,
  push: ['push'] as const,
  pushUpstream: (remote: string, branch: string) => ['push', '--set-upstream', remote, branch],
  remotes: ['remote'] as const,

  checkoutOurs: (path: string) => ['checkout', '--ours', '--', path],
  checkoutTheirs: (path: string) => ['checkout', '--theirs', '--', path],

  cherryPick: (hash: string) => ['cherry-pick', hash],
  revert: (hash: string) => ['revert', '--no-edit', hash],
}

/** What "continue" and "abort" run for each operation in progress. */
export const opCommand = (op: string, step: 'continue' | 'abort'): string[] => {
  switch (op) {
    case 'merge':
      return step === 'abort' ? ['merge', '--abort'] : ['commit', '--no-edit']
    case 'rebase':
      return ['rebase', step === 'abort' ? '--abort' : '--continue']
    case 'cherry-pick':
      return ['cherry-pick', step === 'abort' ? '--abort' : '--continue']
    default:
      return ['revert', step === 'abort' ? '--abort' : '--continue']
  }
}

/** Marker files under the git dir that mean an operation is in progress. */
export const OP_MARKERS: ReadonlyArray<readonly [string, 'merge' | 'rebase' | 'cherry-pick' | 'revert']> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
]

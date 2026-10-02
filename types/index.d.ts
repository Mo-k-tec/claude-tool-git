export type EntryKind = 'ordinary' | 'rename' | 'unmerged' | 'untracked'

export type FileEntry = {
  path: string
  /** Original path of a rename or copy. */
  orig?: string
  kind: EntryKind
  /** Index-side status letter, '.' for none. */
  x: string
  /** Worktree-side status letter, '.' for none. */
  y: string
}

export type RepoOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export type Snapshot = {
  isRepo: boolean
  root: string
  gitDir: string
  /** Current branch, null while detached. */
  branch: string | null
  /** Abbreviated HEAD object id, '' for an unborn branch. */
  head: string
  upstream: string | null
  ahead: number
  behind: number
  entries: FileEntry[]
  op: RepoOp | null
  error: string | null
  /** Changes whenever anything the views draw from changed. */
  signature: string
}

export type Tab = 'status' | 'log' | 'branches' | 'stash'

export type Notice = { level: 'info' | 'error'; text: string }

export type ConfirmKind =
  | 'discard-file'
  | 'discard-hunk'
  | 'discard-all'
  | 'delete-branch'
  | 'merge-branch'
  | 'drop-stash'
  | 'abort-op'
  | 'revert-commit'
  | 'cherry-pick'
  | 'checkout-commit'
  | 'amend'

export type Confirm = { kind: ConfirmKind; arg: string; text: string }

export type DiffTarget =
  | { kind: 'worktree'; path: string; isStaged: boolean; isUntracked: boolean }
  | { kind: 'commit'; hash: string }
  | { kind: 'stash'; ref: string }

export type DiffState = {
  target: DiffTarget
  title: string
  text: string
  error: string | null
  /** Hunks drawn so far; "show more" raises it. */
  limit: number
}

export type LogRow = {
  /** Graph prefix as git drew it. */
  graph: string
  hash: string
  short: string
  refs: string
  author: string
  date: string
  subject: string
}

export type LogState = {
  rows: LogRow[]
  count: number
  isAll: boolean
  hasMore: boolean
  error: string | null
}

export type CommitDetail = {
  hash: string
  message: string
  stat: string
  diff: DiffState
}

export type BranchRow = {
  name: string
  isRemote: boolean
  isCurrent: boolean
  upstream: string
  track: string
  subject: string
  date: string
}

export type StashRow = { ref: string; subject: string; date: string }

export type UiState = {
  tab: Tab
  busy: string | null
  notice: Notice | null
  confirm: Confirm | null
  subject: string
  body: string
  isAmend: boolean
  diff: DiffState | null
  log: LogState | null
  detail: CommitDetail | null
  branches: BranchRow[] | null
  newBranch: string
  stashes: StashRow[] | null
  stashMessage: string
}

declare module 'claude-code' {
  interface PluginState {
    'git-view': {
      snapshot: Snapshot | null
      ui: UiState
      isBandHidden: boolean
    }
  }
}

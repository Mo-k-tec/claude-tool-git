import type { Snapshot, UiState } from '../types'
import type { Host } from './host'

export const PANE = 'git'

export const EMPTY_UI: UiState = {
  tab: 'status',
  busy: null,
  notice: null,
  confirm: null,
  subject: '',
  body: '',
  isAmend: false,
  diff: null,
  log: null,
  detail: null,
  branches: null,
  newBranch: '',
  stashes: null,
  stashMessage: '',
}

export const readUi = (h: Host): Promise<UiState> => h.getUi()
export const readSnapshot = (h: Host): Promise<Snapshot | null> => h.getSnapshot()

/** Merges `patch` into the interface state. */
export const patchUi = (h: Host, patch: Partial<UiState>) =>
  h.updateUi(ui => ({ ...ui, ...patch }))

import type {
  ModelCompleteRequest,
  ModelCompleteResult,
  PaneOpenArgs,
  ProcessRunInit,
  ProcessRunResult,
  RenderSurface,
  UiOpenResult,
} from 'claude-code'

import type { Snapshot, UiState } from '../types'

/**
 * What the mod needs from the engine. A hooks module may not pass `$` around,
 * so `register` builds this once from the `$` of a hook and the rest of the
 * mod takes it as an argument instead.
 */
export type Host = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  exists: (path: string) => Promise<boolean>
  setStatus: (text: string | undefined) => void
  toast: (text: string) => void
  copy: (text: string, surface: RenderSurface) => Promise<unknown>
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult>
  submit: (text: string) => Promise<unknown>
  getSnapshot: () => Promise<Snapshot | null>
  setSnapshot: (snapshot: Snapshot) => Promise<unknown>
  getUi: () => Promise<UiState>
  updateUi: (change: (ui: UiState) => UiState) => Promise<unknown>
  getBandHidden: () => Promise<boolean>
  setBandHidden: (isHidden: boolean) => Promise<unknown>
  openPane: (pane: PaneOpenArgs) => Promise<UiOpenResult>
  closePane: (id: string) => Promise<void>
  after: (ms: number, fn: () => void) => void
}

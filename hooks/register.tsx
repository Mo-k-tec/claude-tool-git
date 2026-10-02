import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import * as act from '../src/actions'
import type { Host } from '../src/host'
import { EMPTY_UI, PANE } from '../src/store'
import { renderBand, renderPane } from '../src/views'
import type { Tab } from '../types'

const TABS: readonly Tab[] = ['status', 'log', 'branches', 'stash']

// The scan that checks a module reads state references from consts of this file.
const snapshotAtom = atom({ plugin: 'git-view', key: 'snapshot' } as const, null)
const uiAtom = atom({ plugin: 'git-view', key: 'ui' } as const, EMPTY_UI)
const bandHiddenAtom = atom({ plugin: 'git-view', key: 'isBandHidden' } as const, false)

const OPEN = { id: PANE, title: 'Git', focus: true, closeOnEscape: true, rows: 26 } as const

export const register: Register = on => {
  // Hooks may not hand `$` on, so the engine's calls the mod needs are bound once, in
  // session.start, and everything else takes this object.
  let host: Host | null = null
  let isPaneOpen = false
  let isScheduled = false
  let tick = 0

  const open = async (h: Host, tab?: Tab) => {
    await act.refresh(h, true)
    if (tab !== undefined) await act.switchTab(h, tab)
    else await act.reloadViews(h)
    return h.openPane(OPEN)
  }

  /** One refresh soon, however many tool calls ask for it. */
  const refreshSoon = (h: Host) => {
    if (isScheduled) return
    isScheduled = true
    h.after(400, () => {
      isScheduled = false
      void act.refresh(h)
    })
  }

  on('session.start', async ($, e, next) => {
    const h: Host = {
      run: (argv, init) => $.process.run(argv, init),
      exists: path => $.fs.exists(path),
      setStatus: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      copy: (text, surface) => $.ui.copy({ text, surface }),
      complete: request => $.model.complete(request),
      // Not as the person's own words: the text carries repository data, so it stays framed as the plugin's.
      submit: text => $.prompt.submit({ text }),
      getSnapshot: () => read($, snapshotAtom),
      setSnapshot: snapshot => update($, snapshotAtom, () => snapshot),
      getUi: () => read($, uiAtom),
      updateUi: change => update($, uiAtom, change),
      getBandHidden: () => read($, bandHiddenAtom),
      setBandHidden: isHidden => update($, bandHiddenAtom, () => isHidden),
      openPane: pane => $.ui.open(pane),
      closePane: id => $.ui.close({ id }),
      after: (ms, fn) => void $.clock.after(ms, fn),
    }
    host = h
    await $.command.register({
      name: 'git',
      description: 'Visual git: changes, diffs, commit, log, branches, stashes',
      argumentHint: '[log|branches|stash|refresh|band|close]',
    })
    // The pane polls quickly; with it closed the band and status line only need an occasional look.
    $.clock.every(3000, () => {
      tick += 1
      if (isPaneOpen || tick % 3 === 0) void act.refresh(h)
    })
    void act.refresh(h)

    return next(e)
  })

  // The answer is a toast, not `text`: a command that prints makes the session start a model turn
  // over its output, and opening a pane should cost nothing.
  on('command.run', { command: 'git' }, async (_$, e) => {
    const h = host
    if (h === null) return { text: 'The git pane is still starting.' }
    const word = e.args.trim().toLowerCase()

    if (word === 'close') {
      await h.closePane(PANE)
      return {}
    }
    if (word === 'refresh') {
      await act.refresh(h, true)
      h.toast('Git state refreshed.')
      return {}
    }
    if (word === 'band') {
      const isHidden = await h.getBandHidden()
      await h.setBandHidden(!isHidden)
      h.toast(isHidden ? 'Git band shown.' : 'Git band hidden.')
      return {}
    }

    const tab = word === 'branch' ? 'branches' : TABS.find(t => word !== '' && t.startsWith(word))
    if (word !== '' && tab === undefined) {
      h.toast('Usage: /git [log|branches|stash|refresh|band|close]')
      return {}
    }
    const placed = await open(h, tab)
    if (!placed.isPlaced) h.toast('Git pane is waiting for a wider terminal.')

    return {}
  })

  on('ui.open', { id: 'git' }, async (_$, e, next) => {
    isPaneOpen = true

    return next(e)
  })

  on('ui.close', { id: 'git' }, async (_$, e, next) => {
    isPaneOpen = false

    return next(e)
  })

  // The model edits files and runs git itself; look again after each of its tool calls.
  on('tool.call', async (_$, e, next) => {
    const result = await next(e)
    if (host !== null) refreshSoon(host)

    return result
  })

  on('turn.complete', async (_$, e, next) => {
    if (host !== null) refreshSoon(host)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'git' }, async ($, e, next) => {
    if (e.surface === 'mobile' || host === null) return next(e)
    // Drawing means the pane is open, whatever this load of the module saw open.
    isPaneOpen = true
    const snapshot = await read($, snapshotAtom)
    const ui = await read($, uiAtom)
    const kit = $.ui.resolve(e)
    if (snapshot === null) {
      const { Box, Text } = kit
      return (
        <Box>
          <Text dimColor>Reading the repository…</Text>
        </Box>
      )
    }

    return renderPane({ host, kit, width: e.props.bodyColumns, snapshot, ui })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'mobile' || e.props.hasSurvey || host === null) return next(e)
    const snapshot = await read($, snapshotAtom)
    const isHidden = await read($, bandHiddenAtom)
    if (snapshot === null || !snapshot.isRepo || isHidden) return next(e)
    const h = host

    return renderBand({
      kit: $.ui.resolve(e),
      snapshot,
      open: () => void open(h),
      hide: () => void h.setBandHidden(true),
    })
  })
}

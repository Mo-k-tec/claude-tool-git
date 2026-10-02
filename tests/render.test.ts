import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Snapshot, UiState } from '../types'

const EMPTY: UiState = {
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

const SNAPSHOT: Snapshot = {
  isRepo: true,
  root: '/repo',
  gitDir: '/repo/.git',
  branch: 'main',
  head: 'abc12345',
  upstream: 'origin/main',
  ahead: 1,
  behind: 2,
  op: null,
  error: null,
  signature: 's',
  entries: [
    { path: 'a.txt', kind: 'ordinary', x: '.', y: 'M' },
    { path: 'b.txt', kind: 'ordinary', x: 'A', y: '.' },
    { path: 'new name.txt', orig: 'old name.txt', kind: 'rename', x: 'R', y: '.' },
    { path: 'both.txt', kind: 'ordinary', x: 'M', y: 'M' },
    { path: 'dir/new.txt', kind: 'untracked', x: '.', y: '?' },
    { path: 'clash.txt', kind: 'unmerged', x: 'U', y: 'U' },
  ],
}

const DIFF =
  'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n@@ -10,2 +10,2 @@\n ten\n-eleven\n+ELEVEN\n'

const PANE_PROPS = {
  title: 'Git',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as never

/** Stands in for the engine beneath the plugin: state in memory, no repository, nothing running. */
const world = (on: On) => {
  mock.clock(on)
  const values = new Map<string, unknown>()
  const key = (e: { plugin: string; key: string }) => `${e.plugin}.${e.key}`
  on('state.get', (_$, e) => ({ value: { value: values.get(key(e)), version: 1 } }))
  on('state.set', (_$, e) => {
    values.set(key(e), e.value)
    return { value: { isSet: true, version: 1 } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('process.run', () => ({
    value: {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.exists', () => ({ value: false }))
  on('ui.status', () => ({ value: undefined }))

  return values
}

declare const setTimeout: (fn: () => void, ms: number) => unknown

const settle = () => new Promise<void>(done => setTimeout(done, 20))

const draw = async (
  $: Engine,
  values: Map<string, unknown>,
  surface: 'terminal' | 'desktop' | 'vscode',
  ui: Partial<UiState>,
  snapshot: Snapshot = SNAPSHOT,
) => {
  // The startup refresh finds no repository; let it finish before the fixtures go in.
  await settle()
  values.set('git-view.snapshot', snapshot)
  values.set('git-view.ui', { ...EMPTY, ...ui })
  return $.ui.mount({
    plugin: 'git-view',
    surface,
    component: 'Pane',
    requestId: 'git',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })
}

const SURFACES = ['terminal', 'desktop', 'vscode'] as const

test('changes list draws on every surface', async ($, on) => {
  const values = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await draw($, values, surface, {})
    expect(await ui.find({ key: 'subject' })).toBeDefined()
    expect(await ui.find({ key: 'toggle:unstaged:a.txt' })).toBeDefined()
    expect(await ui.find({ key: 'open:untracked:dir/new.txt' })).toBeDefined()
    expect(await ui.find({ key: 'ours:clash.txt' })).toBeDefined()
    await ui.unmount()
  }
})

test('a written message body is shown in full before it is committed', async ($, on) => {
  const values = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await draw($, values, surface, { subject: 'Add thing', body: 'Why it matters.\nSecond line.' })
    expect(await ui.find({ key: 'body-clear' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Second line/ })).toBeDefined()
    await ui.unmount()
  }
})

test('file diff with hunk actions, notice, confirm and busy', async ($, on) => {
  const values = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await draw($, values, surface, {
      diff: {
        target: { kind: 'worktree', path: 'a.txt', isStaged: false, isUntracked: false },
        title: 'a.txt (unstaged)',
        text: DIFF,
        error: null,
        limit: 40,
      },
      notice: { level: 'error', text: 'Push failed: rejected' },
      confirm: { kind: 'discard-all', arg: '', text: 'Discard everything?' },
      busy: 'Pushing',
    })
    expect(await ui.find({ key: 'hunk-toggle-0-0' })).toBeDefined()
    expect(await ui.find({ key: 'hunk-discard-0-1' })).toBeDefined()
    expect(await ui.find({ key: 'confirm-yes' })).toBeDefined()
    await ui.unmount()
  }
})

test('log, commit detail, branches and stashes draw', async ($, on) => {
  const values = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const log = await draw($, values, surface, {
      tab: 'log',
      log: {
        rows: [
          { graph: '* ', hash: 'aaaaaaaa1', short: 'aaaaaaa', refs: 'HEAD -> main', author: 'Ada', date: '1 day ago', subject: 'Fix' },
          { graph: '|\\ ', hash: '', short: '', refs: '', author: '', date: '', subject: '' },
        ],
        count: 100,
        isAll: false,
        hasMore: false,
        error: null,
      },
    })
    expect(await log.find({ key: 'commit:aaaaaaaa1' })).toBeDefined()
    await log.unmount()

    const detail = await draw($, values, surface, {
      tab: 'log',
      log: { rows: [], count: 100, isAll: false, hasMore: false, error: null },
      detail: {
        hash: 'aaaaaaaa1111',
        message: 'Fix the thing\n\nBecause.',
        stat: ' a.txt | 2 +-',
        diff: {
          target: { kind: 'commit', hash: 'aaaaaaaa1111' },
          title: 'aaaaaaaa',
          text: DIFF,
          error: null,
          limit: 40,
        },
      },
    })
    expect(await detail.find({ key: 'commit-back' })).toBeDefined()
    await detail.unmount()

    const branches = await draw($, values, surface, {
      tab: 'branches',
      branches: [
        { name: 'main', isRemote: false, isCurrent: true, upstream: 'origin/main', track: '[ahead 1]', subject: 'x', date: 'now' },
        { name: 'dev', isRemote: false, isCurrent: false, upstream: '', track: '', subject: 'y', date: 'now' },
        { name: 'origin/dev', isRemote: true, isCurrent: false, upstream: '', track: '', subject: 'y', date: 'now' },
      ],
    })
    expect(await branches.find({ key: 'switch:l:dev' })).toBeDefined()
    expect(await branches.find({ key: 'delete:l:dev' })).toBeDefined()
    await branches.unmount()

    const stash = await draw($, values, surface, {
      tab: 'stash',
      stashes: [{ ref: 'stash@{0}', subject: 'WIP on main', date: 'now' }],
    })
    expect(await stash.find({ key: 'sp:stash@{0}' })).toBeDefined()
    await stash.unmount()

    const stashDiff = await draw($, values, surface, {
      tab: 'stash',
      stashes: [],
      diff: { target: { kind: 'stash', ref: 'stash@{0}' }, title: 'stash@{0}', text: DIFF, error: null, limit: 40 },
    })
    expect(await stashDiff.find({ key: 'stash-back' })).toBeDefined()
    await stashDiff.unmount()
  }
})

test('operation banner and a directory that is not a repository', async ($, on) => {
  const values = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    const merging = await draw($, values, surface, {}, { ...SNAPSHOT, op: 'merge' })
    expect(await merging.find({ key: 'op-abort' })).toBeDefined()
    await merging.unmount()

    const none = await draw($, values, surface, {}, { ...SNAPSHOT, isRepo: false, entries: [], error: null })
    expect(await none.find({ key: 'refresh' })).toBeDefined()
    await none.unmount()
  }
})

test('band shows the branch and can be hidden', async ($, on) => {
  const values = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  values.set('git-view.snapshot', SNAPSHOT)
  const ui = await $.ui.mount({
    plugin: 'git-view',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 } as never,
    viewport: { columns: 100, rows: 40 },
  })
  expect(await ui.find({ key: 'git-open' })).toBeDefined()
  await ui.press({ key: 'git-hide' })
  expect(values.get('git-view.isBandHidden')).toBe(true)
  await ui.unmount()
})

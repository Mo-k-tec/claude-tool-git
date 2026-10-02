import type { Elements, RenderChildren } from 'claude-code'

import type { BranchRow, Confirm, DiffState, FileEntry, Snapshot, Tab, UiState } from '../types'
import * as act from './actions'
import type { FileRef } from './actions'
import {
  countHunks,
  hunkSource,
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  letterColor,
  parseDiff,
  splitHunk,
  statusLabel,
} from './parse'
import type { FileDiff, Hunk } from './parse'
import type { Host } from './host'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Code'>

export type Ctx = {
  host: Host
  kit: Kit
  width: number
  snapshot: Snapshot
  ui: UiState
}

type ConfirmCtx = { file?: FileDiff; hunk?: Hunk; untracked?: boolean }

/** What the open confirmation needs beyond its argument; set where it is asked. */
let confirmCtx: ConfirmCtx = {}

const ask = (host: Host, kind: Confirm['kind'], arg: string, text: string, ctx: ConfirmCtx = {}) => {
  confirmCtx = ctx
  void act.setConfirm(host, act.ask(kind, arg, text))
}

const SECTION_CAP = 300

const shorten = (text: string, room: number) =>
  text.length <= room ? text : `…${text.slice(text.length - Math.max(8, room - 1))}`

// ---------------------------------------------------------------- shell

export const renderPane = (ctx: Ctx) => {
  const { kit, snapshot, ui } = ctx
  const { Box, Text } = kit

  if (!snapshot.isRepo) return renderNoRepo(ctx)

  return (
    <Box flexDirection="column">
      {renderHeader(ctx)}
      {renderTabs(ctx)}
      {renderOp(ctx)}
      {renderNotice(ctx)}
      {ui.confirm !== null && renderConfirm(ctx, ui.confirm)}
      {ui.tab === 'status' && renderStatusTab(ctx)}
      {ui.tab === 'log' && renderLogTab(ctx)}
      {ui.tab === 'branches' && renderBranchesTab(ctx)}
      {ui.tab === 'stash' && renderStashTab(ctx)}
      <Text dimColor>{' '}</Text>
    </Box>
  )
}

const renderNoRepo = ({ host, kit, snapshot }: Ctx) => {
  const { Box, Text, Button } = kit
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Not a git repository</Text>
      <Text dimColor>
        {snapshot.error ?? 'The session directory is not inside a git work tree. Use /cd or open a repository, then refresh.'}
      </Text>
      <Button key="refresh" hotkey="r" plain label="Refresh" onPress={() => void act.refresh(host, true)} />
    </Box>
  )
}

const renderHeader = ({ host, kit, snapshot, ui }: Ctx) => {
  const { Box, Text, Button } = kit
  const name = snapshot.branch ?? `detached at ${snapshot.head || '?'}`
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text bold color="cyan">{`⎇ ${name}`}</Text>
        {snapshot.upstream !== null && <Text dimColor>{`→ ${snapshot.upstream}`}</Text>}
        {snapshot.ahead > 0 && <Text color="green">{`↑${snapshot.ahead}`}</Text>}
        {snapshot.behind > 0 && <Text color="yellow">{`↓${snapshot.behind}`}</Text>}
        {ui.busy !== null && <Text color="yellow">{`${ui.busy}…`}</Text>}
      </Box>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Button key="refresh" hotkey="r" plain label="Refresh" onPress={() => void act.refresh(host, true)} />
        <Button key="fetch" hotkey="f" plain label="Fetch" onPress={() => void act.fetchRemotes(host)} />
        <Button key="pull" hotkey="l" plain label="Pull" onPress={() => void act.pull(host)} />
        <Button key="push" hotkey="p" plain label="Push" onPress={() => void act.push(host)} />
      </Box>
    </Box>
  )
}

const TABS: ReadonlyArray<readonly [Tab, string, string]> = [
  ['status', '1', 'Changes'],
  ['log', '2', 'Log'],
  ['branches', '3', 'Branches'],
  ['stash', '4', 'Stashes'],
]

const renderTabs = ({ host, kit, snapshot, ui }: Ctx) => {
  const { Box, Text, Button } = kit
  return (
    <Box flexDirection="row" gap={2} flexWrap="wrap" marginTop={1}>
      {TABS.map(([tab, hotkey, label]) => {
        const count = tab === 'status' && snapshot.entries.length > 0 ? ` (${snapshot.entries.length})` : ''
        return ui.tab === tab ? (
          <Text key={`tab-${tab}`} bold underline>{`${hotkey}: ${label}${count}`}</Text>
        ) : (
          <Button
            key={`tab-${tab}`}
            hotkey={hotkey}
            plain
            label={`${label}${count}`}
            onPress={() => void act.switchTab(host, tab)}
          />
        )
      })}
    </Box>
  )
}

const renderOp = ({ host, kit, snapshot }: Ctx) => {
  const { Box, Text, Button } = kit
  if (snapshot.op === null) return null
  const conflicts = snapshot.entries.filter(isConflicted).length
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text color="magenta" bold>
        {`${snapshot.op} in progress${conflicts > 0 ? `, ${conflicts} file${conflicts === 1 ? '' : 's'} in conflict` : ''}`}
      </Text>
      <Box flexDirection="row" gap={2}>
        {conflicts === 0 && (
          <Button key="op-continue" hotkey="e" plain label="Continue" onPress={() => void act.continueOp(host)} />
        )}
        <Button
          key="op-abort"
          hotkey="z"
          plain
          label="Abort"
          onPress={() => ask(host, 'abort-op', '', `Abort the ${snapshot.op} and go back to how things were?`)}
        />
      </Box>
    </Box>
  )
}

const renderNotice = ({ host, kit, ui }: Ctx) => {
  const { Box, Text, Button } = kit
  if (ui.notice === null) return null
  return (
    <Box flexDirection="row" gap={1} marginTop={1}>
      <Text color={ui.notice.level === 'error' ? 'red' : 'green'}>{ui.notice.text}</Text>
      <Button key="notice-dismiss" plain label="×" onPress={() => void act.dismissNotice(host)} />
    </Box>
  )
}

const renderConfirm = ({ host, kit }: Ctx, confirm: Confirm) => {
  const { Box, Text, Button } = kit
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>{confirm.text}</Text>
      <Box flexDirection="row" gap={2}>
        <Button
          key="confirm-yes"
          hotkey="y"
          plain
          label="Yes"
          onPress={() => void act.runConfirmed(host, confirm, confirmCtx)}
        />
        <Button key="confirm-no" hotkey="n" plain label="No" onPress={() => void act.setConfirm(host, null)} />
      </Box>
    </Box>
  )
}

// -------------------------------------------------------------- changes

const renderStatusTab = (ctx: Ctx) => {
  const { ui } = ctx
  if (ui.diff !== null && ui.diff.target.kind === 'worktree') return renderFileDiff(ctx, ui.diff)
  return renderChanges(ctx)
}

const renderChanges = (ctx: Ctx) => {
  const { host, kit, snapshot, ui } = ctx
  const { Box, Text, Button, Input } = kit
  const conflicted = snapshot.entries.filter(isConflicted)
  const staged = snapshot.entries.filter(isStaged)
  const unstaged = snapshot.entries.filter(isUnstaged)
  const untracked = snapshot.entries.filter(isUntracked)
  const isClean = snapshot.entries.length === 0

  return (
    <Box flexDirection="column" marginTop={1}>
      <Input
        key="subject"
        label={ui.isAmend ? 'Amend: ' : 'Message: '}
        placeholder="Commit message, then Enter"
        value={ui.subject}
        submitLabel="commit"
        onInput={value => void act.setSubject(host, value)}
        onSubmit={() => void act.commit(host)}
      />
      {ui.body !== '' && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Body, committed as written:</Text>
            <Button key="body-clear" plain label="clear" onPress={() => void act.setBody(host, '')} />
          </Box>
          <Text dimColor>{ui.body.length > 1500 ? `${ui.body.slice(0, 1500)}…` : ui.body}</Text>
        </Box>
      )}
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Button key="commit" hotkey="c" plain label={ui.isAmend ? 'Amend' : 'Commit'} onPress={() => void act.commit(host)} />
        <Button key="generate" hotkey="g" plain label="Write message" onPress={() => void act.generateMessage(host)} />
        <Button
          key="amend"
          hotkey="m"
          plain
          label={ui.isAmend ? 'Amend: on' : 'Amend: off'}
          onPress={() => void act.toggleAmend(host)}
        />
      </Box>

      {isClean && (
        <Box marginTop={1}>
          <Text dimColor>Working tree clean.</Text>
        </Box>
      )}

      {conflicted.length > 0 &&
        renderSection(ctx, 'Conflicts', 'magenta', conflicted.length, null,
          conflicted.slice(0, SECTION_CAP).map(entry => renderConflictRow(ctx, entry)))}
      {staged.length > 0 &&
        renderSection(ctx, 'Staged', 'green', staged.length, (
          <Button key="unstage-all" hotkey="u" plain label="Unstage all" onPress={() => void act.unstageAll(host)} />
        ), staged.slice(0, SECTION_CAP).map(entry => renderFileRow(ctx, entry, 'staged')))}
      {unstaged.length > 0 &&
        renderSection(ctx, 'Changes', 'yellow', unstaged.length, (
          <Box flexDirection="row" gap={2}>
            <Button key="stage-all" hotkey="a" plain label="Stage all" onPress={() => void act.stageAll(host)} />
            <Button
              key="discard-all"
              hotkey="x"
              plain
              label="Discard all"
              onPress={() =>
                ask(host, 'discard-all', '', 'Discard ALL unstaged changes and delete untracked files? This cannot be undone.')
              }
            />
          </Box>
        ), unstaged.slice(0, SECTION_CAP).map(entry => renderFileRow(ctx, entry, 'unstaged')))}
      {untracked.length > 0 &&
        renderSection(ctx, 'Untracked', 'cyan', untracked.length, (
          unstaged.length === 0 ? (
            <Button key="stage-all" hotkey="a" plain label="Stage all" onPress={() => void act.stageAll(host)} />
          ) : null
        ), untracked.slice(0, SECTION_CAP).map(entry => renderFileRow(ctx, entry, 'untracked')))}
    </Box>
  )
}

const renderSection = (
  { kit }: Ctx,
  title: string,
  color: string,
  count: number,
  action: RenderChildren,
  rows: RenderChildren,
) => {
  const { Box, Text } = kit
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2}>
        <Text bold color={color}>{`${title} (${count})`}</Text>
        {action}
      </Box>
      {rows}
      {count > SECTION_CAP && <Text dimColor>{`… ${count - SECTION_CAP} more not shown`}</Text>}
    </Box>
  )
}

const rowLabel = (ctx: Ctx, entry: FileEntry) =>
  shorten(entry.orig !== undefined ? `${entry.orig} → ${entry.path}` : entry.path, ctx.width - 8)

const renderFileRow = (ctx: Ctx, entry: FileEntry, section: 'staged' | 'unstaged' | 'untracked') => {
  const { host, kit } = ctx
  const { Box, Text, Button } = kit
  const letter = statusLabel(entry, section === 'staged')
  const file: FileRef = {
    path: entry.path,
    isStaged: section === 'staged',
    isUntracked: section === 'untracked',
    entry,
  }
  const id = `${section}:${entry.path}`
  return (
    <Box key={id} flexDirection="row" gap={1}>
      <Button
        key={`toggle:${id}`}
        plain
        label={section === 'staged' ? '−' : '+'}
        onPress={() =>
          void (section === 'staged'
            ? act.unstageFiles(host, 'Unstaging', [entry.path, ...(entry.orig !== undefined ? [entry.orig] : [])])
            : act.stageFiles(host, 'Staging', [entry.path]))
        }
      />
      <Text color={letterColor(letter)} bold>{letter}</Text>
      <Button key={`open:${id}`} plain label={rowLabel(ctx, entry)} onPress={() => void act.openFile(host, file)} />
    </Box>
  )
}

const renderConflictRow = (ctx: Ctx, entry: FileEntry) => {
  const { host, kit } = ctx
  const { Box, Text, Button } = kit
  const file: FileRef = { path: entry.path, isStaged: false, isUntracked: false, entry }
  return (
    <Box key={`conflict:${entry.path}`} flexDirection="row" gap={1} flexWrap="wrap">
      <Text color="magenta" bold>U</Text>
      <Button key={`open:c:${entry.path}`} plain label={rowLabel(ctx, entry)} onPress={() => void act.openFile(host, file)} />
      <Button key={`ours:${entry.path}`} plain dimColor label="ours" onPress={() => void act.resolveWith(host, entry.path, 'ours')} />
      <Button key={`theirs:${entry.path}`} plain dimColor label="theirs" onPress={() => void act.resolveWith(host, entry.path, 'theirs')} />
      <Button key={`resolved:${entry.path}`} plain dimColor label="mark resolved" onPress={() => void act.stageFiles(host, 'Marking resolved', [entry.path])} />
    </Box>
  )
}

// ----------------------------------------------------------------- diffs

const renderFileDiff = (ctx: Ctx, diff: DiffState) => {
  const { host, kit } = ctx
  const { Box, Text, Button } = kit
  const target = diff.target
  if (target.kind !== 'worktree') return null
  const files = parseDiff(diff.text)
  const isConflict = ctx.snapshot.entries.some(e => e.path === target.path && isConflicted(e))
  const canHunk = !target.isUntracked && !isConflict
  const fileRef: FileRef = {
    path: target.path,
    isStaged: target.isStaged,
    isUntracked: target.isUntracked,
    entry: { path: target.path, kind: 'ordinary', x: '.', y: '.' },
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Button key="diff-back" hotkey="b" plain label="Back" onPress={() => void act.closeDiff(host)} />
        <Button key="diff-prev" hotkey="k" plain label="Prev file" onPress={() => void act.stepFile(host, -1)} />
        <Button key="diff-next" hotkey="j" plain label="Next file" onPress={() => void act.stepFile(host, 1)} />
      </Box>
      <Text bold>{diff.title}</Text>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        {!isConflict && (
          <Button
            key="diff-toggle"
            hotkey="s"
            plain
            label={target.isStaged ? 'Unstage file' : 'Stage file'}
            onPress={() =>
              void (target.isStaged
                ? act.unstageFiles(host, 'Unstaging', [target.path])
                : act.stageFiles(host, 'Staging', [target.path]))
            }
          />
        )}
        {!target.isStaged && (
          <Button
            key="diff-discard"
            hotkey="x"
            plain
            label="Discard file"
            onPress={() =>
              ask(
                host,
                'discard-file',
                target.path,
                target.isUntracked
                  ? `Delete untracked ${target.path}? This cannot be undone.`
                  : `Discard all unstaged changes to ${target.path}? This cannot be undone.`,
                { untracked: target.isUntracked },
              )
            }
          />
        )}
        <Button
          key="diff-ask"
          hotkey="v"
          plain
          label="Ask Claude to review"
          onPress={() => void act.askClaude(host, act.reviewPrompt(target))}
        />
      </Box>
      {renderDiffBody(ctx, diff, files, canHunk ? target.isStaged : null, fileRef)}
    </Box>
  )
}

/**
 * Draws parsed diffs. `stagedSide` null means no hunk actions; true/false is
 * whether the hunks are in the index (unstage) or the worktree (stage/discard).
 */
const renderDiffBody = (
  ctx: Ctx,
  diff: DiffState,
  files: FileDiff[],
  stagedSide: boolean | null,
  _file?: FileRef,
) => {
  const { host, kit } = ctx
  const { Box, Text, Button, Code } = kit
  if (diff.error !== null) return <Text color="red">{diff.error}</Text>
  if (files.length === 0) return <Text dimColor>No changes.</Text>

  let drawn = 0
  const total = countHunks(files)
  const blocks = files.map((file, fi) => {
    const rows: RenderChildren[] = []
    const label = file.path !== '' && files.length > 1 ? file.path : ''
    if (label !== '') rows.push(<Text key={`file-${fi}`} bold color="cyan">{label}</Text>)
    for (const [ni, note] of file.notes.entries()) {
      if (ni < 4 && !file.isCombined) rows.push(<Text key={`note-${fi}-${ni}`} dimColor>{note}</Text>)
    }
    if (file.isBinary) rows.push(<Text key={`bin-${fi}`} dimColor>Binary file, no text diff.</Text>)
    if (file.isCombined) {
      rows.push(
        <Code key={`combined-${fi}`} source={file.notes.join('\n').slice(0, 9000)} wrap="truncate-end" />,
      )
    }
    for (const [hi, hunk] of file.hunks.entries()) {
      if (drawn >= diff.limit) break
      drawn++
      const pieces = splitHunk(hunk)
      const canAct = stagedSide !== null && pieces.length === 1
      if (canAct) {
        rows.push(
          <Box key={`hunk-actions-${fi}-${hi}`} flexDirection="row" gap={2}>
            <Button
              key={`hunk-toggle-${fi}-${hi}`}
              plain
              dimColor
              label={stagedSide ? 'unstage hunk' : 'stage hunk'}
              onPress={() => void act.applyHunk(host, file, hunk, stagedSide ? 'unstage' : 'stage')}
            />
            {!stagedSide && (
              <Button
                key={`hunk-discard-${fi}-${hi}`}
                plain
                dimColor
                label="discard hunk"
                onPress={() =>
                  ask(host, 'discard-hunk', '', 'Discard this hunk from the working tree? This cannot be undone.', {
                    file,
                    hunk,
                  })
                }
              />
            )}
          </Box>,
        )
      } else if (stagedSide !== null) {
        rows.push(
          <Text key={`hunk-big-${fi}-${hi}`} dimColor>
            Large hunk shown in pieces: stage the whole file.
          </Text>,
        )
      }
      for (const [pi, piece] of pieces.entries()) {
        rows.push(<Code key={`code-${fi}-${hi}-${pi}`} source={hunkSource(piece)} format="diff" />)
      }
    }
    return rows
  })

  return (
    <Box flexDirection="column" marginTop={1}>
      {blocks}
      {total > drawn && (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{`${total - drawn} more hunk${total - drawn === 1 ? '' : 's'} not shown`}</Text>
          <Button key="diff-more" hotkey="m" plain label="Show more" onPress={() => void act.showMoreDiff(host)} />
        </Box>
      )}
    </Box>
  )
}

// ------------------------------------------------------------------- log

const renderLogTab = (ctx: Ctx) => {
  const { ui } = ctx
  if (ui.detail !== null) return renderCommit(ctx)
  return renderLog(ctx)
}

const renderLog = (ctx: Ctx) => {
  const { host, kit, ui } = ctx
  const { Box, Text, Button } = kit
  const log = ui.log
  if (log === null) return <Text dimColor>Loading the log…</Text>
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Button
          key="log-all"
          hotkey="a"
          plain
          label={log.isAll ? 'All branches: on' : 'All branches: off'}
          onPress={() => void act.toggleAllBranches(host)}
        />
        {log.hasMore && <Button key="log-more" hotkey="m" plain label="Load more" onPress={() => void act.logMore(host)} />}
      </Box>
      {log.error !== null && <Text dimColor>{log.error}</Text>}
      {log.rows.map((row, i) =>
        row.hash === '' ? (
          <Text key={`g-${i}`} color="magenta" dimColor>{row.graph}</Text>
        ) : (
          <Box key={`c-${row.hash}`} flexDirection="row" gap={1} flexWrap="wrap">
            <Text color="magenta">{row.graph}</Text>
            <Button
              key={`commit:${row.hash}`}
              plain
              label={`${row.short} ${row.subject}`}
              onPress={() => void act.openCommit(host, row.hash)}
            />
            {row.refs !== '' && <Text color="yellow">{`(${row.refs})`}</Text>}
            <Text dimColor>{`${row.author}, ${row.date}`}</Text>
          </Box>
        ),
      )}
    </Box>
  )
}

const renderCommit = (ctx: Ctx) => {
  const { host, kit, ui } = ctx
  const { Box, Text, Button, Code } = kit
  const detail = ui.detail
  if (detail === null) return null
  const files = parseDiff(detail.diff.text)
  const short = detail.hash.slice(0, 8)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Button key="commit-back" hotkey="b" plain label="Back" onPress={() => void act.closeCommit(host)} />
        <Button
          key="commit-copy"
          hotkey="h"
          plain
          label="Copy hash"
          onPress={press => void host.copy(detail.hash, press.surface)}
        />
        <Button
          key="commit-checkout"
          hotkey="o"
          plain
          label="Checkout"
          onPress={() => ask(host, 'checkout-commit', detail.hash, `Check out ${short} (detached HEAD)?`)}
        />
        <Button
          key="commit-pick"
          hotkey="i"
          plain
          label="Cherry-pick"
          onPress={() => ask(host, 'cherry-pick', detail.hash, `Cherry-pick ${short} onto the current branch?`)}
        />
        <Button
          key="commit-revert"
          hotkey="t"
          plain
          label="Revert"
          onPress={() => ask(host, 'revert-commit', detail.hash, `Revert ${short} with a new commit?`)}
        />
        <Button
          key="commit-ask"
          hotkey="v"
          plain
          label="Ask Claude to explain"
          onPress={() => void act.askClaude(host, act.reviewPrompt({ kind: 'commit', hash: detail.hash }))}
        />
      </Box>
      <Text bold color="yellow">{short}</Text>
      <Text>{detail.message}</Text>
      {detail.stat !== '' && <Code source={detail.stat.slice(0, 9000)} wrap="truncate-end" />}
      {renderDiffBody(ctx, detail.diff, files, null)}
    </Box>
  )
}

// -------------------------------------------------------------- branches

const renderBranchesTab = (ctx: Ctx) => {
  const { host, kit, ui } = ctx
  const { Box, Text, Button, Input } = kit
  const branches = ui.branches
  if (branches === null) return <Text dimColor>Loading branches…</Text>
  const local = branches.filter(b => !b.isRemote)
  const remote = branches.filter(b => b.isRemote)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Input
        key="new-branch"
        label="New branch: "
        placeholder="name, then Enter"
        value={ui.newBranch}
        submitLabel="create"
        onInput={value => void act.setNewBranch(host, value)}
        onSubmit={() => void act.createBranch(host)}
      />
      <Box flexDirection="row" gap={2}>
        <Button key="branch-create" hotkey="c" plain label="Create and switch" onPress={() => void act.createBranch(host)} />
      </Box>
      <Box marginTop={1}>
        <Text bold color="green">{`Local (${local.length})`}</Text>
      </Box>
      {local.map(branch => renderBranchRow(ctx, branch))}
      {remote.length > 0 && (
        <Box marginTop={1}>
          <Text bold color="cyan">{`Remote (${remote.length})`}</Text>
        </Box>
      )}
      {remote.map(branch => renderBranchRow(ctx, branch))}
    </Box>
  )
}

const renderBranchRow = ({ host, kit }: Ctx, branch: BranchRow) => {
  const { Box, Text, Button } = kit
  const id = `${branch.isRemote ? 'r' : 'l'}:${branch.name}`
  const detail = [branch.track, branch.subject, branch.date].filter(part => part !== '').join(' · ')
  return (
    <Box key={id} flexDirection="row" gap={1} flexWrap="wrap">
      <Text color="green">{branch.isCurrent ? '*' : ' '}</Text>
      {branch.isCurrent ? (
        <Text bold>{branch.name}</Text>
      ) : (
        <Button key={`switch:${id}`} plain label={branch.name} onPress={() => void act.switchBranch(host, branch)} />
      )}
      <Text dimColor>{detail}</Text>
      {!branch.isCurrent && !branch.isRemote && (
        <Button
          key={`merge:${id}`}
          plain
          dimColor
          label="merge"
          onPress={() => ask(host, 'merge-branch', branch.name, `Merge ${branch.name} into the current branch?`)}
        />
      )}
      {!branch.isCurrent && !branch.isRemote && (
        <Button
          key={`delete:${id}`}
          plain
          dimColor
          label="delete"
          onPress={() => ask(host, 'delete-branch', branch.name, `Delete branch ${branch.name}? Git refuses if it is not fully merged.`)}
        />
      )}
    </Box>
  )
}

// ---------------------------------------------------------------- stashes

const renderStashTab = (ctx: Ctx) => {
  const { host, kit, ui } = ctx
  const { Box, Text, Button, Input } = kit

  if (ui.diff !== null && ui.diff.target.kind === 'stash') {
    const target = ui.diff.target
    const files = parseDiff(ui.diff.text)
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Button key="stash-back" hotkey="b" plain label="Back" onPress={() => void act.closeDiff(host)} />
          <Button key="stash-view-apply" hotkey="a" plain label="Apply" onPress={() => void act.stashApply(host, target.ref, false)} />
          <Button key="stash-view-pop" hotkey="o" plain label="Pop" onPress={() => void act.stashApply(host, target.ref, true)} />
          <Button
            key="stash-ask"
            hotkey="v"
            plain
            label="Ask Claude to explain"
            onPress={() => void act.askClaude(host, act.reviewPrompt(target))}
          />
        </Box>
        <Text bold>{ui.diff.title}</Text>
        {renderDiffBody(ctx, ui.diff, files, null)}
      </Box>
    )
  }

  const stashes = ui.stashes
  if (stashes === null) return <Text dimColor>Loading stashes…</Text>
  return (
    <Box flexDirection="column" marginTop={1}>
      <Input
        key="stash-message"
        label="Stash: "
        placeholder="optional message, then Enter"
        value={ui.stashMessage}
        submitLabel="stash"
        onInput={value => void act.setStashMessage(host, value)}
        onSubmit={() => void act.stashPush(host)}
      />
      <Box flexDirection="row" gap={2}>
        <Button key="stash-push" hotkey="c" plain label="Stash changes (with untracked)" onPress={() => void act.stashPush(host)} />
      </Box>
      {stashes.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>No stashes.</Text>
        </Box>
      )}
      {stashes.map(stash => (
        <Box key={stash.ref} flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
          <Text color="yellow">{stash.ref}</Text>
          <Text>{stash.subject}</Text>
          <Text dimColor>{stash.date}</Text>
          <Button key={`sv:${stash.ref}`} plain dimColor label="view" onPress={() => void act.openStash(host, stash.ref)} />
          <Button key={`sa:${stash.ref}`} plain dimColor label="apply" onPress={() => void act.stashApply(host, stash.ref, false)} />
          <Button key={`sp:${stash.ref}`} plain dimColor label="pop" onPress={() => void act.stashApply(host, stash.ref, true)} />
          <Button
            key={`sd:${stash.ref}`}
            plain
            dimColor
            label="drop"
            onPress={() => ask(host, 'drop-stash', stash.ref, `Drop ${stash.ref}? The stash is lost.`)}
          />
        </Box>
      ))}
    </Box>
  )
}

// ------------------------------------------------------------------ band

export const renderBand = ({ kit, snapshot, open, hide }: { kit: Kit; snapshot: Snapshot; open: () => void; hide: () => void }) => {
  const { Box, Text, Button } = kit
  const staged = snapshot.entries.filter(isStaged).length
  const changed = snapshot.entries.filter(e => isUnstaged(e) || isConflicted(e)).length
  const fresh = snapshot.entries.filter(isUntracked).length
  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      <Text bold color="cyan">{`⎇ ${snapshot.branch ?? `(${snapshot.head || 'detached'})`}`}</Text>
      {snapshot.ahead > 0 && <Text color="green">{`↑${snapshot.ahead}`}</Text>}
      {snapshot.behind > 0 && <Text color="yellow">{`↓${snapshot.behind}`}</Text>}
      {staged > 0 && <Text color="green">{`●${staged}`}</Text>}
      {changed > 0 && <Text color="yellow">{`✚${changed}`}</Text>}
      {fresh > 0 && <Text color="cyan">{`…${fresh}`}</Text>}
      {snapshot.entries.length === 0 && <Text dimColor>clean</Text>}
      {snapshot.op !== null && <Text color="magenta">{snapshot.op}</Text>}
      <Button key="git-open" plain dimColor label="/git" onPress={open} />
      <Button key="git-hide" plain dimColor label="hide" onPress={hide} />
    </Box>
  )
}


# claude-tool-git

Visual git inside the Claude Code CLI. A mod (a plugin of function hooks) that adds a `/git` pane with
changes, diffs, hunk staging, commits, a log graph, branches and stashes, plus a one-line branch band above the prompt.

> Claude Code's mod API is early access and may change between releases. This was built against Claude Code 2.1.287
> and needs hooks modules to be enabled for your account.

## Install

Clone it anywhere and point Claude Code at the folder.

```sh
git clone git@github.com:Mo-k-tec/claude-tool-git.git ~/.claude/mods/git-view
```

For one run:

```sh
claude --plugin-dir ~/.claude/mods/git-view
```

For every session, add the folder to the `env` block of `~/.claude/settings.json` and restart your terminal:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/.claude/mods/git-view" } }
```

## Use

`/git` opens the pane for the repository of the session's directory. `/git log`, `/git branches` and `/git stash` open it on
those tabs; `/git refresh`, `/git band` (toggle the band) and `/git close` do what they say. Esc returns to the prompt;
Tab, the arrow keys and clicks work inside the pane. Every button shows its hotkey.

| Tab | What it does |
| --- | --- |
| 1 Changes | Conflicted, staged, unstaged and untracked files. Open a file for a highlighted diff with per-hunk stage, unstage and discard. Commit box with amend, and a model-written message (`g`). |
| 2 Log | Commit graph (all branches toggle). Open a commit for its message, stat and diff; copy hash, checkout, cherry-pick, revert. |
| 3 Branches | Switch, create, merge, delete; remote branches switch to a tracking branch. |
| 4 Stashes | Stash (with untracked files), view, apply, pop, drop. |

`r` refreshes, `f` fetches, `l` pulls (fast-forward only), `p` pushes (sets the upstream when there is none). A merge, rebase or
cherry-pick in progress shows Continue and Abort. Discarding, deleting a branch, merging, dropping a stash, reverting,
cherry-picking and aborting all ask first. There is no force-push.

The pane refreshes on a timer and after each of Claude's tool calls, so it follows what the agent does.
"Ask Claude to review/explain" buttons send a prompt to the session.

## Things to know

- **Git hooks do not run.** The mod API runs git with repo hooks off, so commits made from the pane skip `pre-commit` and friends.
- **Credentials can't be asked for.** Push, pull and fetch run without a terminal; if git needs a password the operation fails
  with git's message. Credential helpers and SSH agents work.
- **Model-written messages send the staged diff** (first 24,000 characters) to the model through your Claude Code session.
  Don't use it on changes you wouldn't paste into a chat.
- Terminal CLI only: the mod runs git through `$.process.run`, which the desktop app and editors don't offer.

## Layout

```
hooks/register.tsx   wiring: command, events, state, rendering hooks
src/host.ts          the engine calls the mod needs (a hooks module may not pass `$` around)
src/git.ts           running git; every command's arguments in one place
src/parse.ts         status, diff, log, branch and stash parsers (pure)
src/actions.ts       refresh and every operation
src/views.tsx        the pane and band
types/index.d.ts     state contract
tests/               parser tests and mounted-tree tests on the terminal, desktop and VS Code surfaces
```

```sh
claude plugin validate .
claude plugin test .
```

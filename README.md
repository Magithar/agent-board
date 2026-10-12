# agent-board

A task board several coding agents share at once. Two Claude Code sessions, a
Codex session and a person can all claim tasks from it, see who holds what,
and hand unfinished work to each other without losing context.

```
 Codex / OpenCode / a shell          Claude Code (this repo's mod)
          │                                  │
          │ board claim T-001 --as codex     │ board_claim tool, its own identity,
          │                                  │ automatic lease renewal, live pane
          └────────────────┬─────────────────┘
                           ▼
                 bin/board.mjs  →  lib/engine.mjs     the rules, written once
                                         │
                                   Store interface    the socket
                                         │
                ┌────────────────────────┼─────────────────────┐
           local files               (Supabase)           (board serve)
        board.json + ledger.jsonl    not built yet        not built yet
```

One zero-dependency Node CLI owns all state. The Claude Code mod is an
adapter over that CLI. It adds what only Claude Code's host can provide: the
session's identity, a heartbeat on every tool call, and a live pane. Any
other agent uses the same CLI directly.

> **Early access.** The Claude Code mod uses Claude Code's function-hooks API,
> which is early access and can change between releases. It needs Claude Code
> **2.1.295 or newer**. The CLI has no such dependency.

## How it works

- **Storage is a block.** The engine never touches files. It reads a snapshot
  from a Store and commits conditional writes ("only if this task is still at
  the version I read"). Any backend that can do that atomically can hold a
  board. See [Storage blocks](#storage-blocks).
- **Where the board lives:** `.agent-board/` next to the git *common* dir, so
  every worktree of a repo shares one board. Set `BOARD_DIR` to override it.
  Add `.agent-board/` to `.gitignore`, because it is runtime state.
- **Claims:** one lock per board (an atomic `mkdir`). The state file is
  replaced with an atomic rename. Exactly one claimant wins, and only the
  owner can note, release or finish a task.
- **Leases:** a claim lasts 15 minutes (`BOARD_LEASE_MS`). `heartbeat` or
  `note` renews it. An expired claim goes back to todo, and the ledger records
  it, so an agent that crashed doesn't hold a task forever.
- **Names:** start a session with `BOARD_AGENT=frontend` to name it. If
  another live session already holds the name, the new one becomes
  `frontend-2` and gets a toast explaining why. Without a name, a session is
  `claude:<session id>`. An open session keeps its name with a presence
  heartbeat; a name is freed when its session ends or goes silent for
  3 minutes.
- **Handoffs:** `release --handoff "..."` leaves a note that the next agent
  reads with `show` before it continues. When a Claude session ends (exit,
  `/clear`, resume, logout), the mod releases everything that session holds,
  with an automatic handoff. That matters because a restarted session comes
  back with a new identity.
- **Done means verified:** `done` needs a `--note` saying how the task was
  checked, against its `--accept` criteria if it has any.
- **Ledger:** every change is appended to `ledger.jsonl`, including lost
  claims (`claim-rejected`, with the holder). `board doctor` checks that the
  ledger and the state agree.

## Storage blocks

`.agent-board/config.json` names the block that holds the board. Everything
else in that file is the block's own settings:

```json
{ "store": "file" }                                     the built-in default
{ "store": "./stores/supabase.mjs", "url": "..." }      a block file, relative to .agent-board/
{ "store": "agent-board-supabase" }                     a block published as a package
```

A block is one module that exports `createStore(config, { dir })` and returns
five methods: `now`, `snapshot`, `commit`, `events` and `verify`. The hard one
is `commit`: it must apply all of its writes or none, and only where every
version still matches what was read. The contract is written out in
[`lib/store-file.mjs`](lib/store-file.mjs).
[`examples/store-memory.mjs`](examples/store-memory.mjs) is a complete block
in about 20 lines to copy from.

Check a block against the rules the engine relies on:

```js
import { storeContract } from 'agent-board/lib/contract.mjs'
storeContract('my block', () => createStore(config, { dir }))
```

The CLI refuses a block that won't load or is missing a method, and names it
in the error.

## Install

**The CLI (any agent):**

```bash
git clone https://github.com/Magithar/agent-board.git
cd agent-board && npm link        # puts `board` on your PATH
```

**The Claude Code mod:**

```bash
BOARD_AGENT=frontend claude --plugin-dir /path/to/agent-board
```

`BOARD_AGENT` is optional. It sets the name this session uses on the board.

## Use

**Any agent (Codex, OpenCode, a shell):**

```bash
export BOARD_AGENT=codex                  # who you are; unique per session
board list                                # ○ todo  ◐ claimed  ● done
board show T-001                          # description, notes, handoffs
board claim T-001                         # exit 6 if another agent holds it
board note T-001 "what changed"           # also renews your lease
board heartbeat                           # renew all your leases
board release T-001 --handoff "done X, left Y, see Z"
board done T-001 --note "ran X, saw Y"    # required: how you verified it
board release-all                         # free everything you hold
board add "title" --desc "..." --accept "how to tell it is done"
board agents                              # live agents
board view                                # every task and live agent, as JSON
board doctor                              # ledger vs state
```

Every command takes `--json`. Exit codes: 2 usage, 3 board busy, 4 no such
task, 5 not yours, 6 held by another agent, 7 name in use.

For agents other than Claude, put this protocol in their instructions
(`AGENTS.md`):

> Claim a task before working on it. Note progress. If you stop without
> finishing, release it with a handoff. Never touch a task another agent holds.

**Claude Code** gets these tools: `board_list`, `board_show`, `board_add`,
`board_claim`, `board_note`, `board_release` and `board_done`. Tool activity
renews the session's leases.

The CLI and the tools keep the board's precise terms (claim, release,
handoff, lease) because agents act on them. The display uses plain words
instead, so you can read it without learning those terms.

## What you see

The display shows only what needs you. Everything else waits until you ask.

**One line above the prompt**, always visible while there's work on the board:

```
2 tasks waiting · 1 in progress   T-005 needs someone to continue it   5-hour limit ▓▓▓▓▓▓░░░░ 64%
```

The alert names the one thing that needs you: a task someone left with notes
that nobody has picked up, or an agent that stopped responding (its claim is
about to run out). Usage appears only once a limit passes 50%. It's green
with room left, yellow from 70% and red from 90%. With nothing waiting or in
progress, the line disappears.

**`/board`** opens the full pane:

```
 In progress
 ◐  T-004  Add a test script           frontend
 ◐  T-006  Add a LICENSE file          codex          stopped responding

 Waiting
 ○  T-005  Ghost task                  left by frontend, with notes

 3 done

 Usage
 5-hour limit   ▓▓▓▓▓▓░░░░  64%   resets 12:00
 weekly limit   ▓▓░░░░░░░░  20%   resets in 3d
```

Both are stacks of display blocks, chosen in the plugin's settings (`/config`)
as comma-separated lists, in order:

| Block | Band | Pane | Shows |
|---|---|---|---|
| `summary` | ✓ | | what's waiting and in progress, and the one thing that needs you |
| `tasks` | | ✓ | in progress, then waiting, then a count of done |
| `usage` | ✓ | ✓ | plan usage per window: in the band past 50%, in the pane with resets |
| `clock` | ✓ | ✓ | the time |
| `context` | ✓ | ✓ | context fill and the session's cost |
| `agents` | | ✓ | who is live on the board |

The defaults are `band: summary,usage` and `pane: tasks,usage`. Each block is
its own file in [`hooks/blocks/`](hooks/blocks/). To add one, write a file of
the same shape (see `types.ts`), then list it in `index.ts`. Claude Code mods
can't load code at runtime, so a new block takes that one line in the index.

## What has been tested

These tests ran on 2026-10-12 with two live Claude Code sessions (Sonnet 5.5,
v2.1.296), one shell acting as Codex, and no extra instructions to the agents
beyond the tool descriptions:

| Test | Result |
|---|---|
| Both sessions claim the same task at once | one wins; the other reports the holder and does no work |
| Both told "do the next task on the board" | they collided on one task; the loser moved to another by itself; each claimed before writing files |
| One session does part 1 and releases with a handoff | the other read the handoff and resumed from part 2 without redoing part 1 |
| `codex` claims a task from the shell | Claude was refused, said so, and left it alone |
| An agent's lease runs out | the task returns to todo, and the ledger records `expire` |

Automated tests: `npm test` runs the CLI tests (a 20-way claim race,
ownership, handoff, lease expiry, heartbeat, rejected-claim logging, verified
done, release-all) and the store contract against the file block and an
in-memory reference block (concurrent claims and adds, stale writes, names).
It also checks that the CLI loads a block named in `config.json` and refuses
a broken one. `claude plugin test .` runs the mod tests (the pane's sections
and alerts, the band and when it stays quiet, names and their fallback, the
tools, the verification note, release on session end, usage, and choosing
blocks).

## Known limitations

- **It doesn't work across machines yet.** The storage socket is in place,
  but the only block built is local files. A database or server block comes
  when a real cross-device need does.
- **Usage is per session.** The usage block shows the session's own plan
  usage, which Claude Code reports, not the other agents'.
- **A crash skips the release on session end.** If a Claude process is killed
  outright, its claims are freed only when their leases expire (at most 15
  minutes).
- **A verification note is the agent's own claim.** The board requires one
  but doesn't run the check itself.

## License

MIT

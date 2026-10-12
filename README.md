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
                    bin/board.mjs        the only thing that writes the board
                           ▼
             <repo>/.agent-board/   board.json  +  ledger.jsonl
```

One zero-dependency Node CLI owns all state. The Claude Code mod is an
adapter over that CLI. It adds what only Claude Code's host can provide: the
session's identity, a heartbeat on every tool call, and a live pane. Any
other agent uses the same CLI directly.

> **Early access.** The Claude Code mod uses Claude Code's function-hooks API,
> which is early access and can change between releases. It needs Claude Code
> **2.1.295 or newer**. The CLI has no such dependency.

## How it works

- **Where the board lives:** `.agent-board/` next to the git *common* dir, so
  every worktree of a repo shares one board. Set `BOARD_DIR` to override it.
  Add `.agent-board/` to `.gitignore`, because it is runtime state.
- **Claims:** one lock per board (an atomic `mkdir`). The state file is
  replaced with an atomic rename. Exactly one claimant wins, and only the
  owner can note, release or finish a task.
- **Leases:** a claim lasts 15 minutes (`BOARD_LEASE_MS`). `heartbeat` or
  `note` renews it. An expired claim goes back to todo, and the ledger records
  it, so an agent that crashed doesn't hold a task forever.
- **Handoffs:** `release --handoff "..."` leaves a note that the next agent
  reads with `show` before it continues.
- **Ledger:** every change is appended to `ledger.jsonl`. `board doctor`
  checks that the ledger and the state agree.

## Install

**The CLI (any agent):**

```bash
git clone https://github.com/Magithar/agent-board.git
cd agent-board && npm link        # puts `board` on your PATH
```

**The Claude Code mod:**

```bash
claude --plugin-dir /path/to/agent-board
```

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
board done T-001 --note "tested by ..."
board add "title" --desc "..."
board doctor                              # ledger vs state
```

Every command takes `--json`. Exit codes: 2 usage, 3 lock busy, 4 no such
task, 5 not yours, 6 held by another agent.

For agents other than Claude, put this protocol in their instructions
(`AGENTS.md`):

> Claim a task before working on it. Note progress. If you stop without
> finishing, release it with a handoff. Never touch a task another agent holds.

**Claude Code** gets these tools: `board_list`, `board_show`, `board_add`,
`board_claim`, `board_note`, `board_release` and `board_done`. It runs as
`claude:<session>`, and tool activity renews its leases. `/board` opens a
live pane, and the status line shows open tasks and the ones this session
holds.

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
ownership, handoff, lease expiry and heartbeat). `claude plugin test .` runs
the mod tests (the pane, the tools and expired claims).

## Known limitations

- **A restarted Claude session gets a new identity**, so a task it held stays
  locked until its lease expires (at most 15 minutes).
- **"Done" isn't tied to acceptance criteria.** An agent can mark a task done
  without testing it.
- **Rejected claims aren't recorded in the ledger**, so collisions appear only
  in the agents' transcripts.
- **It doesn't work across machines.** The board is a local directory.

## License

MIT

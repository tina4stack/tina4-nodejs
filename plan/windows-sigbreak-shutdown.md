# Task: Windows Ctrl+Break (SIGBREAK) runs the graceful shutdown

Outcome: on Windows, Ctrl+Break and the CTRL_BREAK_EVENT a console or service
manager sends a process group drain in-flight requests and exit 0, exactly like
SIGTERM/SIGINT on POSIX. Before: `startServer()` listened for SIGTERM/SIGINT
only, so SIGBREAK hit Node's default action and killed the server mid-request
(exit 3221225786 = 0xC000013A). POSIX behaviour unchanged.

## Scope
- [x] Read the tina4-python fix (`_arm_shutdown_signals`: SIGINT/SIGBREAK/SIGTERM on Windows)
- [x] server.ts: on win32 register a SIGBREAK listener into `gracefulShutdown()`;
      remove it in `close()` beside SIGTERM/SIGINT (the background.ts invariant
      holds: the listener exits)
- [x] test/_ctrlBreak.ts: PowerShell + Win32 helper that starts the server in
      its own console process group and sends it a real CTRL_BREAK_EVENT
- [x] test/gracefulShutdown.test.ts: SIGBREAK section (Windows); SKIP with the
      reason on POSIX
- [x] CLAUDE.md graceful-shutdown section names SIGBREAK
- [x] `npm run typecheck` green

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| Ctrl+Break drains on Windows | ✅ (fix/windows-test-portability) | ⏳ parallel PR (ctrl handler) | ❌ cannot trap BREAK on Windows | ✅ this task |

## Tests (real — no mocks)
- [x] SIGBREAK lets the in-flight request finish (real CTRL_BREAK_EVENT, real socket)
- [x] SIGBREAK exits with code 0
- [x] SIGBREAK stops accepting / drains rather than exiting immediately / releases the port
- [x] Mutation: listener dropped -> in-flight ECONNRESET, exit 3221225786, exit 210ms after the break (3 FAIL)

## Bugs
- [x] SIGBREAK untrapped on Windows -> instant kill, no drain (fixed in this task)

## Commits
- (see the PR for fix/windows-sigbreak-shutdown)

## Status: Complete (Windows verified locally; POSIX gate is Linux CI)

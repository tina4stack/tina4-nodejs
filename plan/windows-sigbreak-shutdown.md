# Task: Windows Ctrl+Break (SIGBREAK) runs the graceful shutdown

Outcome: on Windows, Ctrl+Break and the CTRL_BREAK_EVENT a console or service
manager sends a process group drain in-flight requests and exit 0, exactly like
SIGTERM/SIGINT on POSIX. Before: `startServer()` listened for SIGTERM/SIGINT
only, so SIGBREAK hit Node's default action and killed the server mid-request
(exit 3221225786 = 0xC000013A). POSIX behaviour unchanged.

## Scope
- [x] Read the tina4-python fix (`_arm_shutdown_signals`: SIGINT/SIGBREAK/SIGTERM on Windows)
- [x] server.ts: `shutdownSignals()` (SIGTERM+SIGINT, plus SIGBREAK on win32);
      one `gracefulShutdown()` listener per signal, all removed in `close()`
      (the background.ts invariant holds: every listener exits). Kept the
      listen callback's complexity flat so the metrics ratchet stays green
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
- [x] shutdownSignals(): POSIX/macOS exactly SIGTERM+SIGINT, Windows adds SIGBREAK (pure; runs on every OS)
- [x] Mutation: Windows list without SIGBREAK -> 4 FAIL; POSIX list with SIGBREAK -> 2 FAIL
- [x] Mutation (first shape): listener dropped -> in-flight ECONNRESET, exit 3221225786, exit 210ms after the break (3 FAIL)

## Bugs
- [x] SIGBREAK untrapped on Windows -> instant kill, no drain (fixed in this task)
- [ ] Pre-existing (origin/v3), NOT fixed here: `server.listen` callback awaits
      `startLoopbackSiblings()` (binds ::1, an I/O turn) BEFORE arming the signal
      listeners, so a SIGTERM in that gap hits Node's default (killed, no exit 0).
      Surfaced on PR CI as "a teardown throw during shutdown still exits 0
      (signal=SIGTERM)". Needs the listeners armed before the first await -
      maintainer decision, separate change

## Commits
- (see the PR for fix/windows-sigbreak-shutdown)

## Status: Complete (Windows verified locally; POSIX gate is Linux CI)

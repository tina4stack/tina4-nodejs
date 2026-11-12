# Task: Graceful shutdown teardown must be exception-safe (exit 0 on a teardown throw)

Outcome: a handled SIGTERM/SIGINT drains and exits 0 even when a teardown step
throws/rejects. PHP already has this (Server::cleanup $cleanedUp guard +
try/catch(\Throwable) around stop()/forceShutdown()). Node's `gracefulShutdown`
left its teardown body unguarded, and the handlers call it as
`void gracefulShutdown(...)`, so a throw -> rejected promise -> unhandledRejection
-> Node terminates NON-ZERO (exit 1) on a handled signal. Close that gap.

## Scope
- [x] Read PHP reference (Server::cleanup/stop/forceShutdown) + its test
- [x] Wrap gracefulShutdown teardown in try/catch; degrade (Log.error, else
      process.stderr.write) and STILL process.exit(0); keep `shuttingDown` latch
- [x] Belt-and-braces `.catch` on onSigterm/onSigint void-promise wrappers
- [x] NO-MOCK regression in test/gracefulShutdown.test.ts (real child, real signal,
      real failing sink)
- [x] `npm run typecheck` green (tsc exit 0)
- [x] push feature/release3.13.162

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| teardown-throw still exits 0 | ✅ | ✅ | ✅ | ⏳ this task |

## Tests (real — no mocks)
- [x] a teardown throw during shutdown still exits 0: TINA4_LOG_STRICT=true +
      a real log file made read-only after boot (sink opens writable at boot,
      the first teardown Log write EACCES's) + TINA4_SHUTDOWN_TIMEOUT=-5 (invalid
      -> a Log.warning emitted into the failing sink during teardown). SIGTERM;
      assert exit code 0 (not killed-by-signal, not 1).
      Gate: without the guard, the strict-sink throw escapes the un-awaited
      `void gracefulShutdown()` as an unhandledRejection -> Node exits 1.

## Bugs
- [ ] (none logged)

## Commits
- (pending)

## Status: In Progress
```
Branch: feature/release3.13.162 (v3 release line). Node-only parity fill; PHP/Ruby/Python already guard.
```

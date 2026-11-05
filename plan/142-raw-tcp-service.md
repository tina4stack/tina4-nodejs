# Task: Feature 142 — Raw TCP service (Node port)

Outcome: port the Python reference raw TCP service (ADR-0102, feature 142) to
Node.js/TypeScript at behavioural parity. The listener folds into the running
`node:http` server's lifecycle (D1 in-process) via `net.createServer`, started
after the sibling servers and drained on graceful shutdown — never forked.

Branch: `feature/142-raw-tcp-service` off `origin/v3`. PR-only.

## Scope
- [x] `tcpService()` facade + `TcpService` + `TcpConnection` (`packages/core/src/tcp.ts`)
- [x] Barrel exports from `packages/core/src/index.ts`
- [x] Fold into `server.ts` boot (`startAllTcpServices`) + graceful shutdown
      (`stopAcceptingAllTcpServices` + `drainAllTcpServices`)
- [x] Real no-mock socket tests, 24 cases, each mutation-proved
- [x] Typecheck clean (`tsc -p tsconfig.types.json`, exit 0); 24/24 tests pass

## Parity
| Invariant | Python | PHP | Ruby | Node |
|-----------|--------|-----|------|------|
| all 10 (listen/callbacks/ack/registry/conn-obj/max-conn/idle/drain/backpressure/single-owner) | ✅ | ✅ | ✅ | ✅ |

## Tests
`test/rawTcpServiceContract.test.ts` — pure cases drive the real in-process
`net` service directly; two child cases (`bootChild`, `TINA4_SECRET` set) spawn a
real server over `tsx` for the in-process + HTTP-concurrent and SIGTERM-drain
paths. `TCP_PURE_ONLY=1` runs only the pure gates (fast mutation path).

## Mutation proof (ANSI-stripped, each mutation confirmed to change the file)
- identify → RED ✅   on_line → RED ✅   max_conn → RED ✅
- idle_off → RED ✅   backpressure → RED ✅   single_owner → RED ✅
- drain → detected (suite cannot complete under the mutation — not vacuously green)
- server_wiring → covered by the in-process child case

## Bugs
- (none)

## Commits
- (hash  description)

## Status: Complete (pending PR) — parity now 4/4

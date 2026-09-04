# Task: Port dual-stack loopback server fix (PHP PR #206) to tina4-nodejs

Outcome: the built-in dev server ALSO listens on the sibling loopback family, so
`localhost` is reachable on Windows (which resolves it to `::1` first). Best-effort,
async-error-guarded, closed on shutdown. Branch `feature/release3.13.132`.

## Scope
- [x] Read PHP reference (Tina4/Server.php loopbackBindHosts + openLoopbackSiblings + ServerDualStackLoopbackTest)
- [x] Read Node server.ts primary createServer/listen + all close paths
- [x] Add exported `loopbackBindHosts(host): string[]` (camelCase, unbracketed addrs) + barrel export
- [x] Start sibling `createServer(dispatch)` listeners on same port, async-error-guarded
- [x] Close siblings in ALL shutdown paths (closeListeners, timeout force-close, handle close)
- [x] Tests: unit (8 cases) + real dual-stack sockets (skip if ::1 unavailable)
- [x] `npm run typecheck` exit 0 + tests green (stashed-baseline diff = +0 failures)

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| dual-stack loopback | ✅ | ✅ (#206) | ✅ | ⬜ this task |

## Mapping (loopbackBindHosts — UNBRACKETED, Node takes bare "::1")
- localhost           -> ["127.0.0.1", "::1"]
- 127.0.0.1 / 0.0.0.0 -> ["::1"]
- ::1 / ::            -> ["127.0.0.1"]
- else (explicit LAN) -> []
- normalize: host.trim().replace(/^\[|\]$/g,"").toLowerCase()

## Tests (real sockets, no mocks, positive + negative)
- [x] loopbackBindHosts: all 5 mapping cases + :: + bracket/whitespace normalise (8 unit, pure fn)
- [x] server bound to 127.0.0.1 serves real HTTP on BOTH 127.0.0.1 AND ::1 (skip if ::1 unavailable)
- [x] negative control: unbound ::1 port refuses (probe can fail)
- [x] GATE proven by mutation: siblings disabled -> ::1 GET -> -1 (ERR_CONNECTION_REFUSED)

## Verification (macOS Darwin 25.6.0, Node local)
- typecheck exit 0
- serverDualStackLoopback.test.ts: 11 passed, 0 failed, 0 skipped
- stashed-baseline diff (affected server subsystem, +0 failures):
  aiPortRange 6/0, bindPortPrecedence 6/0, dualPortContract 9/0, gracefulShutdown 23/0,
  portConfig 12/0, portTakeoverContract 5/0, serverParity 3/0, sessionBuiltinServerCookie 4/0,
  syncSocketTransport pass, integration 38/0 — IDENTICAL baseline vs applied
- full 262-file live-service suite: lab-only (per repo convention), not run on this host

## Bugs
- (none)

## Commits
- (pending commit on feature/release3.13.132)

## Status: Complete

# Task: Honest dev-admin version check (Node, v3)

Outcome: a version check that could not reach the registry answers `latest: null` +
`error`, never `latest == current` (which the toolbar renders as a green "up to date").
Mirror the Python reference exactly; mock-free real-server/real-closed-port test.

## Scope
- [x] Read Python reference (`_api_version_check`, `toolbar_js`) + its mock-free test
- [x] Read Node `handleVersionCheck` (devAdmin.ts:2072) + `toolbarJs()` (3022)
- [x] Server: env URL, `latest:null`+error on fetch-throw / non-ok / no-version; export it
- [x] Toolbar JS: `couldNotCheck(el,why)` + `if (!latest)` before `if (latest === current)`; export it
- [x] Mock-free test `test/devAdminVersionCheck.test.ts` (real closed port + real local http server)
- [x] Run new test green, `npm run typecheck` exit 0, dev-admin regression green
- [x] Commit to v3 (no push, no version bump)

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| honest version check | ✅ | ⬜ (own PR) | ⬜ (own PR) | ✅ this task |

(Task scope is Node only — PHP/Ruby tracked separately per the orchestrator.)

## Tests (real — no mocks, positive + negative)
- [x] unreachable registry (real closed port) → latest null, latest!=current, error truthy, current==TINA4_VERSION
- [x] reachable no-version (real local http server → {}) → latest null + error truthy
- [x] reachable with-version (real local http server → {"version":"3.13.200"}) → latest=="3.13.200", no error key
- [x] toolbar JS: contains couldNotCheck, `if (!latest)` index < `if (latest === current)` index

## Bugs
- [x] handleVersionCheck returned {current, latest:current} on any failure — a check that did not happen reported "up to date". Proven by mutation: old body → negative test 5 FAIL ({current,latest} both "3.13.134"); new body → 11 PASS.
- [x] (found in passing) push.ts:266 `as unknown as BodyInit` did not typecheck on clean v3 HEAD (TS2304, no DOM lib) — blocked the typecheck gate. Fixed to `Uint8Array` (Node-only TS cast, no parity). Separate commit.

## Verify (real, at HEAD)
- new test: 11 passed, 0 failed (npx tsx, real closed port + real local http server)
- npm run typecheck: exit 0
- all test/devAdmin*.test.ts: 7 files, 0 failed

## Commits
- (dev-admin) fix(dev-admin): a version check that did not happen says so
- (push) fix(push): cast the fetch body to Uint8Array so typecheck resolves

## Status: Complete

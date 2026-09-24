# Task: Unique per-run scratch dirs in the Node test suite

**Outcome:** no Node test hard-codes a shared `/tmp` path, so two suites on one host
(one as root, one as andre) can never collide again; a guard keeps it that way.

Trigger (2026-09-24, shared lab): `createTableCallableDefault`, `ormNullForUnset`,
`parityStaticOrm` died with "attempt to write a readonly database" because a
concurrent root run had created `/tmp/tina4-cd61-test`, `/tmp/tina4-orm-null-unset-165`
and `/tmp/tina4-parity-static-orm` as root.

## Scope
- [x] Inventory fixed scratch paths in test/ (literal `"/tmp/`, template literals, `join("/tmp", ...)`, `join(tmpdir(), "<const>")`), helpers + fixtures included
- [x] Convert each to `mkdtempSync(join(tmpdir(), "<old-name>-"))` + `rmSync(dir, { recursive: true, force: true })` in cleanup
- [x] Missing-path probes (`/tmp/nonexistent-*`) -> child of a fresh unique dir (guaranteed absent)
- [x] Keep justified exceptions (string-only / wire-only / documented default) in an allow-list with reasons
- [x] Guard test `test/noFixedTmpPaths.test.ts` (picked up by run-all automatically)
- [x] Mutation-prove the guard (fixed path in a test, fixed tmpdir name in a helper, stale allow-list entry)
- [x] Concurrency proof on the lab: root + andre at once, before (red 3/3 rounds) and after (green 3/3 rounds)
- [x] Full Node suite on the lab + `npm run typecheck` (see Status for the numbers)
- [x] Survey Python / PHP / Ruby suites for the same pattern (report only, no changes here)
- [x] PR to v3 (not merged)

## Parity
| Concern | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| unique scratch dirs in tests | survey | survey | survey | this PR |

## Tests (real, no mocks)
- [x] `noFixedTmpPaths.test.ts`: detector positive + negative cases, real tree scan, stale allow-list check
- [x] the three failing files pass concurrently as root and andre on the lab (separate checkouts, real /tmp, 3 rounds)

## Bugs
- [x] dotenvCorpus used `sqlite:///tmp/...` (three slashes = RELATIVE), so every run wrote `tmp/tina4_truthiness_*.db` into the repo checkout (gitignored, piling up unseen; found in 4 lab checkouts). Now an absolute per-run dir.
- [x] createTableCallableDefault, ormNullForUnset, parityStaticOrm, formToken, routeGroupAuth, routeGroupsContract, three queue visibility-timeout cases, fakeData/testClientContract probes: never removed their scratch dirs. Now cleaned.
- [x] autoMigrate, ormCompositeKey, writePathContract built `sqlite://${absPath}` = `sqlite:///tmp/...` (relative), so their DBs landed in the repo's tmp/ instead of the mkdtemp dir. Found by the lab full run leaving tmp/tina4-node-tests-<pid>/ behind.
- [ ] (not this PR) service namespaces are also shared between concurrent runs: queue.test Mongo collection, cache-backends Redis DB 3, memcached tenant keys. Seen red when root and andre ran together; each passes alone.
- [ ] (lab env, not code) /home/andre/.npm contains root-owned files from another worker's sudo npm, so packInstall / zeroDependencyInstall / cliLint die with EACCES as andre (same on clean origin/v3). Lab runs here used a private npm_config_cache.

## Commits
- 2838ed9  test: give every test a unique per-run scratch dir, guard against fixed /tmp paths
- 12df3fc  test: sqlite scratch DBs land in their unique dir, not the repo checkout

## Status: Complete (PR open, not merged)

Lab (andrevanzuydam.com, Linux, Node v24.18.0, andre, TINA4_REQUIRE_SERVICES=1 + OIDC,
private npm cache) at 12df3fc: **9350 passed, 0 failed, 0 skipped across 359 files**,
`npm run typecheck` exit 0, nothing left in the repo's tmp/. Two earlier full runs on the
same tree had 4 and 5 failures, all shared-environment: the npm-cache EACCES above (same on
origin/v3) and shared Mongo/Redis/memcached flakes that pass in isolation on both branch
and origin/v3.

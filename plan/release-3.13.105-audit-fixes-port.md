# Task: Port 4 audit fixes from Python 3.13.105 to Node.js

## Outcome
Node parity with Python master commit `38b7bfd` (v3.13.105 audit-bug batch): four bugs
land in Node with named positive+negative regression tests, each proven-a-gate by
mutation. Docstrings on `Queue.size()` / `failed()` / `deadLetters()` harmonised.
Single atomic commit on `feature/release3.13.105`.

## Scope
- [x] Read Python master 38b7bfd — 4 bugs + docs parity
- [x] Audit Node source for each bug (present? already-fixed?)
- [x] Test 1: `Model.clearCache()` cascades to `db.cacheClear()`
- [x] Fix 1: `BaseModel.clearCache()` calls `getDb().cacheClear()` in try/catch
- [x] Test 2: `Queue.retry()` no-arg revives every dead letter
- [x] Verify Node's `retry(no-arg)` already iterates every DL (lock-in only)
- [x] Test 3: `job.retry()` unlinks dead-letter file (LiteBackend.retryJob)
- [x] Fix 3: `LiteBackend.retryJob(queue, job, ...)` unlinks failed_dir file first
- [x] Test 4: Mongo `retry(id)` finds DL and `purge(status)` returns real count
- [x] Fix 4: Mongo `retry` op looks up DL namespace + returns FOUND; `purge` routes DL statuses
- [x] Docstring parity on `Queue.size()`, `failed()`, `deadLetters()`
- [x] Update `CLAUDE.md` `### Queue` section with the size-alias distinction
- [x] Run full suite at HEAD, all green
- [x] Single commit with Tina4 + Claude co-authors, push origin

## Parity
| Bug | Python master | Node port |
|-----|--------------|-----------|
| PY-06-22 clearCache cascade | ✅ 38b7bfd | ✅ this port |
| PY-12-04 retry() short-circuit | ✅ 38b7bfd | ✅ already-loop, lock-in test only |
| PY-12-05 retry(job) leaves DL file | ✅ 38b7bfd | ✅ this port |
| Mongo retry_job + purge | ✅ 38b7bfd | ✅ this port |

## Tests (real, no mocks, +/- each)
- [x] `test/modelClearCacheCascadesToDb.test.ts` — real SQLite, both cache layers on
- [x] `test/queueRetryReviveEveryDeadLetter.test.ts` — real file-backed queue, 3 DLs
- [x] `test/queueJobRetryRemovesDeadLetter.test.ts` — real file-backed queue, 2 DLs
- [x] `test/queueMongoRetryAndPurge.test.ts` — real live Mongo, skip-if-unreachable

## Bugs
- [x] Node bug analog of PY-06-22 (baseModel.ts:1394 clearCache does not touch db cache)
- [x] Node bug analog of PY-12-05 (liteBackend.ts:682 retryJob does not unlink failed/)
- [x] Node bug analog of Mongo retry_job (mongoBackend.ts retry op filters by wrong ns)
- [x] Node bug analog of Mongo purge (mongoBackend.ts purge op scopes only to base ns)

## Commits
- (hash on push) fix(queue,orm): 4 audit bugs + doc parity for 3.13.105
- Also: bump versionConsistency.test lock to 3.13.105 (was stale at 3.13.104)

## Verification
- Local Mac (M-series, node v24): 4 new tests all green.
- Lab (192.168.88.99, Ubuntu 24.04, node v24.18): full `npm test` --
  **8419 passed / 0 failed / 43 skipped across 329 files** (43 skips are
  pre-existing service-availability gates -- Firebird port mismatch, MQTT
  TLS cert, ODBC DSN, PostGIS -- none introduced by this port).
- Mutation-proof on lab: reverted DL-namespace filter -> 3 red; restored
  -> 3 green. Reverted purge routing -> 2 red; restored -> 2 green.
- `queueFailureLifecycle.test` (14 assertions), `queue.test.ts` (217
  assertions on Mongo) both green with the changes.

## Status: Complete

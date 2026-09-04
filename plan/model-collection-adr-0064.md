# Task: Port ModelCollection (ADR-0064) to tina4-nodejs

Outcome: ORM read queries (`where`/`select`/`find` filter-form/`all`/`withTrashed`) return a
`ModelCollection` — a real Array carrying the query total (from the fetch COUNT probe, zero extra
queries) plus `getTotalRecords()` and the seven-key `toPaginate()` envelope. Array-compatible.
Parity with the Python reference (DONE).

## Scope
- [x] Read ADR-0064 + Python collection.py + Python test_orm_model_collection.py
- [x] Read Node baseModel.ts read methods, DatabaseResult.toPaginate, probeTotal, adapterFetch
- [x] New file packages/orm/src/modelCollection.ts (Array subclass, Symbol.species=Array)
- [x] Export ModelCollection from packages/orm/src/index.ts
- [x] Wire where/all/select/find(filter)/withTrashed -> _collect helper -> ModelCollection
- [x] Real-SQLite tests (test/ormModelCollection.test.ts), positive + negative, mirror Python case-for-case
- [x] Mutation-check the total source (return .length -> red -> restore)
- [x] Build (esbuild dist + tsc types) green
- [x] Full suite `tsx test/run-all.ts` + `npm run typecheck` green, yourself

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| ModelCollection + getTotalRecords + toPaginate | done | (other worker) | (other worker) | done |

## Tests (real node:sqlite, no mocks, positive + negative) — all mirror the Python reference
- [x] where total outside pagination (seed 250, limit=20 offset=40 -> len 20, total 250)
- [x] all carries table total (257)
- [x] select carries total (music 7)
- [x] find(filter) carries total (250)
- [x] find(pk) still single (not a collection)
- [x] toPaginate 7-key envelope, page/per_page/total_pages correct, == db.fetch(...).toPaginate()
- [x] array-compat: Array.isArray, for-of, index, map, filter, length, spread, JSON.stringify
- [x] empty page still reports total (offset 1000 -> len 0, total 250)
- [x] zero matches -> total 0
- [x] soft-delete excluded live (4) / included withTrashed (5)
- [x] getTotalRecords survives on the returned collection

## Bugs
- (none found yet)

## Commits
- (feature/release3.13.132) ModelCollection (ADR-0064): new modelCollection.ts (Array subclass,
  Symbol.species=Array), _collect helper wiring where/all/select/find(filter)/withTrashed through the
  fetch COUNT probe, real-SQLite tests (49 assertions), mutation-proven.

## Verification (self-run at HEAD, macOS, Node via tsx, node:sqlite)
- test/ormModelCollection.test.ts: 49 passed, 0 failed.
- `npm run typecheck`: exit 0.
- Full runner `npx tsx test/run-all.ts`: 8134 passed, 33 failed, 233 skipped across 351 files.
  BASELINE (my change stashed): 8085 passed, 33 failed, 233 skipped across 350 files.
  Delta = +1 file / +49 passed / +0 failed / +0 skipped; the 27 failed files are IDENTICAL to
  baseline => my change introduced ZERO regressions. All 27 are pre-existing environment failures:
  no local Mongo/Redis/Valkey/Memcached/Postgres/MySQL/MSSQL/Firebird/Kafka/RabbitMQ/GreenMail,
  a vitest "URL must be of scheme file" harness error (6 vitest suites), and the runner charging
  Mongo-skip files "no summary line". None touch ORM reads.
- Mutation proof: `_collect` total = data.length (page) instead of the probe -> 11 assertions RED
  incl. "where getTotalRecords is the whole matching set (250) got 20" -> restored.

## Status: Complete

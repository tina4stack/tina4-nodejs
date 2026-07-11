# Task: Fix broken Node dev-MCP tools + invoke-all conformance lock-in

## Goal
An invoke-every-tool sweep found 4 Node `/__dev/mcp` dev tools functionally broken (0 threw,
but return wrong data / no-op / echo). Fix them to mirror the Python master
(`tina4-python/tina4_python/mcp/tools.py`) and add a conformance lock-in test that enumerates
EVERY registered tool and asserts none throw AND the 4 return CORRECT payloads.

Branch: `v3` (build on top; no push, no version bump — already 3.13.70).

## Context / root cause
- `migration_status` (mcp.ts ~1380) and `migration_run` (~1423) pass `globalThis.__tina4_db`
  (the Database WRAPPER) into `orm.status(db)` / `orm.migrate(db)`. Those read applied-state via
  `adapterQuery(db,...)` -> `adapter.query(...)`, but the wrapper has NO `.query`/`.queryAsync`
  (only fetch/execute/tableExists). `adapterQuery` throws -> SWALLOWED by the silent catch at
  `migration.ts:1078` in `status()` -> appliedNames empty -> everything reported "pending" (wrong)
  and `migrate` re-applies every call (non-idempotent). The raw adapter (`getAdapter()`) is what
  the API wants — server.ts boot + CLI migrate.ts both pass it and work.
- `seed_table` (~1586) calls `seedTable(db, table, count)` with NO field map -> seeder early-returns
  `{seeded:0}` (no rows) and returns the whole SeedSummary as `inserted`.
- `route_test` (~1191) is an echo stub `{info,method,path}` — never dispatches.

## Scope
- [x] migration_status: pass raw `orm.getAdapter()`; return {completed, pending}
- [x] migration_run: pass raw `orm.getAdapter()`; keep {applied, skipped, failed} (idempotent)
- [x] migration.ts status(): un-swallow the adapterQuery failure — Log.error instead of silent
      (Python #57 "don't swallow" lesson)
- [x] seeder.ts: add `autoFieldMap(db, table)` (parity with Python `auto_field_map`), export it
- [x] seed_table: build field map via autoFieldMap; insert real rows; return int `{table, inserted}`
- [x] route_test: dispatch via in-process TestClient; return {status, body, contentType}
- [x] test/mcpDevToolsConformance.test.ts: enumerate registry, invoke every tool via JSON-RPC
      tools/call against a real throwaway app (temp node:sqlite, route, model, migration, plan);
      assert none throw + the 4 correct payloads (catches returns-200-but-wrong-data)

## Tests (real — no mocks, positive + negative)
- [x] conformance test FAILS pre-fix (wrong data / no-op / echo), PASSES post-fix
- [x] re-invoke the 4 for real: status shows applied migration completed; 2nd migration_run
      idempotent; seed_table inserted > 0; route_test numeric status

## Verify
- [x] new test green; full `npx tsx test/run-all.ts`; `npm run typecheck`
      (pre-existing PG/Valkey service-gated failures OK)

## Commits
- (hash) fix(mcp): dev tools migration_status/migration_run raw-adapter + unswallow, seed_table
  field-map, route_test real dispatch + invoke-all conformance test

## Verification (2026-07-11, macOS, Node 24.9.0, node:sqlite)
- Conformance test PRE-FIX: 61 passed, 11 failed (all 4 tools caught: all-pending,
  non-idempotent, 0-rows/object, echo stub). POST-FIX: 72 passed, 0 failed.
- Full runner: Grand Total 5451 passed, 9 failed across 155 files. The 9 failures are the
  pre-existing PostgreSQL ("role tina4 does not exist") + Valkey ("command failed")
  service-gated set (unchanged baseline: 5451-72 = 5379 / 155-1 = 154 matches CLAUDE.md).
  Zero new failures from these changes.
- `npm run typecheck`: clean (exit 0).

## Status: Complete

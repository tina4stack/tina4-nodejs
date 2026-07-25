# Node PG `_inTransaction` never set -> batch-in-txn defeats atomicity

## Goal
Node's Postgres adapter never sets its `_inTransaction` flag, so a batch insert
nested inside a caller's explicit transaction wraps its OWN BEGIN/COMMIT and
commits the outer transaction early — a later rollback then undoes nothing.
Verify-then-fix against a REAL Postgres, NO mocks.

## Root cause (confirmed by reading packages/orm/src/adapters/postgres.ts)
- `private _inTransaction = false;` (L78) — only ever INITIALISED and READ.
- `startTransactionAsync()` (L326): `await this.executeAsync("BEGIN")` — does NOT
  set `_inTransaction = true`.
- `commitAsync()` (L334) / `rollbackAsync()` (L342): `COMMIT`/`ROLLBACK` — do NOT
  clear `_inTransaction`.
- `executeManyAsync()` (L162): `const owns = !this._inTransaction;` -> ALWAYS true,
  so a batch ALWAYS does its own BEGIN...COMMIT even inside a caller's txn ->
  the inner COMMIT commits the OUTER txn; the caller's rollback undoes nothing.

## Fix (small)
Set `this._inTransaction = true` in `startTransactionAsync()` (after BEGIN);
set it `false` in `commitAsync()` and `rollbackAsync()`. Then `owns` correctly
detects an outer txn and the batch JOINS it (no inner BEGIN/COMMIT). Keep the
standalone batch path (no outer txn) exactly as-is.

## Reference (Python master)
tina4-python postgres adapter: confirm the `owns_txn` / `_in_transaction` guard is
set/cleared around start/commit/rollback (the Node comment at L77 cites it). Match.

## Scope
- [x] Stand up a real Postgres (docker). `postgres:16` (16.13) on host port 5433. No mocks.
- [x] REPRO FIRST: startTransactionAsync -> executeManyAsync(2 rows) -> rollbackAsync ->
      re-read shows the batch rows SURVIVED on current code (bug real). Proof captured:
      `_inTransaction=false` after start; PG NOTICEs "there is already a transaction in
      progress" (wrongful inner BEGIN) + "there is no transaction in progress" (the outer
      ROLLBACK no-op'd because the inner COMMIT already committed); rows surviving = 2.
- [x] Fix postgres.ts: `_inTransaction=true` in startTransactionAsync (after BEGIN);
      `=false` in commitAsync/rollbackAsync. Matches Python master contract.
- [x] No-mock lock-in test `test/pgBatchTxnAtomicity.test.ts` (7 assertions, real PG,
      env-gated exactly like pgAsyncApi.test.ts): (neg) executeManyAsync inside a txn is
      undone by rollback; (neg) same via the public insertAsync(table,[rows]) batch entry;
      (pos) commit persists — verified on a FRESH connection (durable); (standalone) a batch
      with no outer txn auto-commits; (standalone atomicity) a bad row mid-batch rolls the
      whole batch back. Negatives PROVEN to FAIL on reverted (old) code: 4 passed / 3 failed,
      exit 1. Fixed code: 7/7, exit 0.
- [x] Full `npm test` + typecheck GREEN at HEAD (re-run with both PG DBs present):
      typecheck clean; suite 5759 passed / 0 failed across 183 files. New test RAN (7 passed,
      not skipped). Qualified: macOS arm64, Node v24.9.0, PostgreSQL 16.13.
- [x] Crosscheck PHP + Ruby executeMany/batch owns-guard; report only (not fixed here):
      - Python master: CORRECT — `start_transaction` sets `_in_transaction`, commit/rollback
        clear it; base `execute_many` owns_txn = `_autocommit and not _in_transaction`.
      - PHP: NOT vulnerable. Active PDO PG path (`PdoPostgresAdapter` + `PdoAdapterTrait`):
        adapter `executeMany` opens NO transaction (loops execute; "atomicity provided by the
        facade") and autocommit/lastId use PDO-native `inTransaction()` — no hand-maintained
        never-set flag. (Facade `Database::executeMany` unconditionally begin/commit — same
        nesting shape as the Node WRAPPER finding below; guarded by the facade's own
        nested-begin depth guard — worth a PHP-side confirm, but the Node-style flag bug does
        not exist.)
      - Ruby: NOT vulnerable. `Database#execute_many` owns-guard is a thread-local pin
        (`already_pinned`) reliably set by `start_transaction`/`transaction`; a batch nested
        in an outer tx skips begin/commit and joins it. Driver has no never-set flag.
      - Verdict: the never-set `_inTransaction` flag was a NODE-ONLY adapter regression.
- [x] Branch feature/pg-intransaction-flag off v3. Commit. Do NOT merge, do NOT tag.

## Related finding (Node, distinct code path — SURFACED, not fixed; needs go-ahead)
The PUBLIC `Database.executeMany` wrapper (packages/orm/src/database.ts L961) reimplements
batching and calls `adapterStartTransaction`/`adapterCommit` UNCONDITIONALLY — it does NOT
route through the adapter's (now-fixed) owns-guard and does NOT check `inExplicitTransaction()`.
Grounded repro on real PG: `db.startTransaction()` -> `db.executeMany(insert, 2 rows)` ->
`db.rollback()` leaves 2 rows (should be 0). This is engine-agnostic (all engines via the
wrapper) and is a PARITY DIVERGENCE from Python (whose `Database.execute_many` delegates to
`adapter.execute_many`, inheriting the owns_txn guard). Recommended fix: make the wrapper
guard begin/commit/rollback with `this.inExplicitTransaction()` (or delegate to
`adapter.executeManyAsync`) so a batch joins an open transaction. Left for a separate scoped
change (own lock-in test + cross-engine + PHP/Ruby facade parity) pending maintainer go-ahead.

## Constraints
- No mocks. Real Postgres only. feedback_no_mock_testing, feedback_independent_verification.
- Python is master. Match its contract; if Python is wrong, surface it.
- One worker in this tree only.

## Status: Adapter fix DONE (green, real PG). Wrapper finding surfaced for decision.

# Node Database.executeMany facade — atomicity inside an explicit transaction

## Goal
The PUBLIC facade `Database.executeMany` (packages/orm/src/database.ts:961) opens
its OWN transaction unconditionally, so a batch nested in a caller's explicit
transaction commits the outer txn early and a later rollback undoes nothing.
Verify-then-fix against a REAL Postgres, NO mocks. Then crosscheck the FACADE-level
execute_many in PHP + Ruby for the same hole (the earlier PG task only checked the
ADAPTER-level executeMany; the facade is the new concern).

## Root cause (confirmed by reading, this session)
`executeMany` (L961-977): `adapterStartTransaction` -> loop -> `adapterCommit`
UNCONDITIONALLY. The sibling write methods (insert/update/delete/execute, L762 etc.)
correctly guard with `if (this.autoCommit && !this.inExplicitTransaction())`.
`inExplicitTransaction()` (L834) = a pinned adapter in txStore; `getNextAdapter()`
(L609) returns that pinned adapter when a txn is open. So the batch already runs on
the right connection — it just must NOT open/commit/rollback its own txn when one is
already open.

## The fix (small, mirrors the adapter owns-guard)
```
async executeMany(sql, paramSets = []) {
  const adapter = this.getNextAdapter();          // pinned adapter when in a txn
  const results = [];
  const owns = !this.inExplicitTransaction();      // NEW
  if (owns) await adapterStartTransaction(adapter);
  try {
    for (const params of paramSets) results.push(await adapterExecute(adapter, sql, params));
    if (owns) await adapterCommit(adapter);
  } catch (e) {
    if (owns) await adapterRollback(adapter);
    throw e;
  }
  return results;
}
```
Standalone batch (no outer txn): unchanged (owns=true -> own BEGIN/COMMIT, atomic).
Inside an explicit txn: owns=false -> joins the caller's txn; caller's rollback undoes it.

## Reference (Python master)
tina4-python `Database.execute_many` delegates to `adapter.execute_many`, inheriting
the owns_txn guard -> CORRECT. Match this contract.

## Scope
- [x] Stand up a real Postgres (docker `postgres:16` -> 16.13, localhost:5432). No mocks.
- [x] REPRO FIRST: db.startTransaction() -> db.executeMany(insert, 2 rows) ->
      db.rollback() -> re-read shows rows SURVIVED on current code. PROVEN:
      "count after ... rollback: 2 -> BUG CONFIRMED — 2 rows SURVIVED (expected 0)".
- [x] Fix database.ts executeMany with the owns-guard above (packages/orm/src/database.ts:976).
- [x] No-mock lock-in test test/executeManyFacadeTxn.test.ts (real PG, env-gated like
      pgBatchTxnAtomicity.test.ts): (neg) db.executeMany inside db.startTransaction is
      UNDONE by db.rollback (demonstrated FAIL on old code via `git stash`);
      (pos) committed by db.commit, verified on a FRESH connection;
      (standalone) db.executeMany with no outer txn is atomic (a mid-batch bad row
      rolls the whole batch back). 6 assertions, all PASS on fixed code.
- [x] Full `npm test` + typecheck GREEN at HEAD (re-run twice; both green).
      typecheck exit 0; suite 5743 passed / 0 failed across 184 files + i18n 44 passed.
      Facade test + pgBatchTxnAtomicity both RAN (not skipped) against the live PG.
- [x] CROSSCHECK the FACADE execute_many in PHP + Ruby + Python against the SAME scenario:
      - PHP `Database::executeMany` (Tina4/Database/Database.php:1367) — CORRECT.
        The unconditional startTransaction()/commit()/rollback() route through the
        DEPTH-GUARDED wrappers (txDepth + insideExplicitTransaction): a nested begin
        only bumps depth (no real BEGIN) and an inner commit only unwinds depth (no
        real COMMIT). LIVE on real PG: 0 rows after rollback. Guard genuinely works.
      - Ruby `Database#execute_many` (lib/tina4/database.rb:679) — CORRECT.
        Facade-level `already_pinned = !Thread.current[@tx_pin_key].nil?` owns-guard;
        start_transaction sets the pin, so a nested batch joins the outer txn (no
        inner begin/commit). LIVE on real PG: 0 rows after rollback.
      - Python master `Database.execute_many` (database/connection.py:547) — CORRECT.
        Delegates to adapter.execute_many, whose `owns_txn = autocommit and not
        _in_transaction` guard (adapter.py:363) joins the outer txn. Verified by source.
      Verdict: Node was the ONLY framework with the facade hole. No PHP/Ruby follow-up needed.
- [x] Branch feature/executemany-facade-atomicity off v3. Commit. Do NOT merge/tag.

## Constraints
- No mocks. Real Postgres only. feedback_no_mock_testing, feedback_independent_verification.
- Python is master. Match its contract; if Python is wrong, surface it.
- One worker in this tree only.

## Crosscheck dashboard (facade execute_many, scenario: startTx -> batch -> rollback)
| Framework | Facade guard | Verdict | How verified |
|-----------|--------------|---------|--------------|
| Python (master) | adapter owns_txn (delegated) | CORRECT | source (adapter.py:363) |
| PHP    | txDepth + insideExplicitTransaction depth guard | CORRECT | LIVE real PG (0 rows) |
| Ruby   | thread-pin already_pinned owns-guard            | CORRECT | LIVE real PG (0 rows) |
| Node   | inExplicitTransaction() owns-guard (THIS FIX)   | FIXED   | LIVE real PG (2->0 rows) |

## Status: DONE (branch feature/executemany-facade-atomicity; NOT merged, NOT tagged)

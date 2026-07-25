# Node Firebird rollback() silent no-op (behavioral parity miss)

## Goal
Node's Firebird adapter runs every statement on the auto-committing connection,
never on the active transaction — so `rollbackAsync()` rolls back an empty
transaction and the write survives. Twin of the PHP pdo_firebird bug fixed in
3.13.86 (PdoAdapterTrait autocommit-toggle). Fix Node to route statements through
the active transaction, verify-then-fix against a REAL Firebird, no mocks.

## Root cause (confirmed by reading packages/orm/src/adapters/firebird.ts)
- `query()`  L242 -> `this.db.query(...)`   (connection/pool, auto-commit)
- `execute()` L252 -> `this.db.execute(...)` (connection/pool, auto-commit)
- `startTransactionAsync()` L407 creates `this.transaction` via
  `this.db.transaction(ISOLATION_READ_COMMITTED, cb)` but NOTHING runs on it.
- `commitAsync()`/`rollbackAsync()` act on `this.transaction`, which saw no
  statements -> rollback is a no-op; the already-auto-committed INSERT stays.

## Reference (Python master)
Read tina4_python's firebird adapter: confirm how the master routes statements
through the active transaction when one is open (that is the intended behavior to
match). Fix Node to the same contract; do NOT invent a new one.

## Live Firebird (no-mock)
- Container `tina4-fb-node` (firebirdsql/firebird:5.0.2) up, host port **3053**.
- user SYSDBA / pass masterkey / db server-path /var/lib/firebird/data/test.fdb.
- `node-firebird` is an optional peer dep and is NOT installed — `npm install
  node-firebird` in the tree first (it's what CI installs for the Firebird specs).
- Confirm the exact connect/URL shape node-firebird needs (host, port, database
  path, user, password). Set TINA4_TEST_FIREBIRD_URL to match the existing specs.

## Scope
- [x] Read Python master firebird adapter (reference contract).
      Contract: ALL statements run on ONE connection (`self._conn`);
      `start_transaction()` sets `_in_transaction=True` which SUPPRESSES the
      per-statement autocommit in `execute()` (firebird.py:305); `commit()`/
      `rollback()` act on the connection. Node has no such suppression hook
      (node-firebird `db.query/execute` always auto-commit), so the equivalent
      is to route statements through the transaction OBJECT while one is open.
- [x] npm install node-firebird (--no-save); confirmed live connect to
      localhost:3053, db /var/lib/firebird/data/test.fdb, SYSDBA/masterkey.
- [x] REPRO FIRST (verify-then-fix): scratchpad script opened txn -> insert ->
      rollback -> re-read: marker count = 1 (row SURVIVED). Bug is real. After
      fix the same script shows count = 0.
- [x] Fix: added `statementHandle()` returning `this.transaction ?? this.db`;
      queryPromise/executePromise route through it. Covers query/execute/
      insertAsync/update/delete/fetch uniformly. Read-after-write + standalone
      autocommit verified intact.
- [x] No-mock lock-in test (test/firebirdRollback.test.ts): read-after-write in
      txn, ROLLBACK->row GONE (negative — FAILS on old code: 3 passed/1 failed),
      COMMIT->row PRESENT, standalone autocommit. 4/4 green on fixed code, real FB.
- [x] Full `npm test` GREEN (typecheck + all) at HEAD. Ran TWICE (independent
      re-run): 5734 passed / 0 failed across 182 files + i18n vitest 44 passed;
      typecheck clean. macOS 26.5.2, Node v24.9.0, live Firebird 5.0.2 @ :3053.
      firebirdRollback.test RAN (4 passed, not skipped).
- [x] Crosscheck: Ruby's firebird_driver.rb has the SAME structural shape
      (begin_transaction sets @transaction=@connection.transaction but
      execute/execute_query run on @connection) — SUSPECT same no-op, needs its
      own live-fb repro. Python master correct. PHP already fixed (3.13.86).
      SURFACED as a separate item (not fixed in this Node tree/branch).

## Constraints
- No mocks. Real Firebird only. feedback_no_mock_testing, feedback_independent_verification.
- Python is master (feedback_python_master). Match its contract; if Python is
  wrong, surface it — don't mirror a bug.
- Branch feature/firebird-rollback-noop off v3; do NOT merge/tag (owner gates release).
- One worker in this tree only (feedback_no_parallel_workers_one_tree).

## Ruby crosscheck (separate item — NOT fixed here)
`tina4-ruby/lib/tina4/drivers/firebird_driver.rb`: `begin_transaction` sets
`@transaction = @connection.transaction`, but `execute`/`execute_query` run on
`@connection` — the SAME structural shape as the Node bug (statements never
touch the transaction bracket). Strongly SUSPECT of the same silent rollback
no-op (and the `fb` gem's connection-level transaction semantics may make it a
different-but-related bug: `@transaction&.commit`/`&.rollback` no-op if
`Connection#transaction` returns nil). Needs its OWN live-Firebird repro in the
Ruby tree before a fix — do not fix from a code read. Python master correct;
PHP already fixed (3.13.86).

## Status: DONE (Node) — Ruby surfaced as a separate task

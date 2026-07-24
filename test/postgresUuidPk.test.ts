/**
 * Regression test for issue #38 — UUID-PK INSERT then SELECT must not
 * abort the transaction on PostgreSQL.
 *
 * Mirrors tests/test_postgres_uuid_pk.py from tina4-python.
 *
 * In tina4-python, psycopg2 issues a `SELECT lastval()` probe after every
 * INSERT to pick up the auto-increment id. On UUID PK tables that probe
 * raises and aborts the whole transaction, so the next SELECT fails with
 * ``current transaction is aborted, commands ignored until end of
 * transaction block``. The python fix wraps the probe in a SAVEPOINT.
 *
 * The Node.js `pg` driver doesn't probe `lastval()` — the adapter uses
 * ``INSERT ... RETURNING *`` (postgres.ts insertAsync) and the generic
 * executeAsync path just reads ``result.rows[0].id`` if it exists. So no
 * savepoint port is needed; this test exists as a regression safety net.
 *
 * Skipped automatically when no postgres is reachable so CI without a
 * container just no-ops.
 *
 * Run with: npx tsx test/postgresUuidPk.test.ts
 */
import net from "node:net";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USER ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASS ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function pgReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.connect(PG_PORT, PG_HOST, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

console.log("=== Postgres UUID-PK regression test (#38) ===\n");

const reachable = await pgReachable();
if (!reachable) {
  console.log(`  \x1b[33mSKIP\x1b[0m PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} — skipping`);
  // Print the count line the runner expects so the suite stays green.
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m0 passed\x1b[0m, \x1b[31m0 failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(0);
}

// Try to load the pg-backed adapter. If pg isn't installed at all, skip.
let PostgresAdapter: any = null;
try {
  ({ PostgresAdapter } = await import("../packages/orm/src/adapters/postgres.ts"));
} catch (err) {
  console.log(`  \x1b[33mSKIP\x1b[0m Could not load PostgresAdapter: ${(err as Error).message}`);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m0 passed\x1b[0m, \x1b[31m0 failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(0);
}

// Ensure pg the npm package is actually installed so connect() doesn't blow up
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  await import("pg");
} catch {
  console.log(`  \x1b[33mSKIP\x1b[0m 'pg' package not installed — npm install pg`);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m0 passed\x1b[0m, \x1b[31m0 failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(0);
}

async function withFreshDb<T>(
  fn: (db: any) => Promise<T>,
): Promise<T> {
  const db = new PostgresAdapter({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASS,
    database: PG_DB,
  });
  await db.connect();
  await db.executeAsync("DROP TABLE IF EXISTS t4_issue38_uuid");
  await db.executeAsync(
    "CREATE TABLE t4_issue38_uuid (" +
      "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), " +
      "  name text" +
      ")",
  );
  try {
    return await fn(db);
  } finally {
    try { await db.executeAsync("DROP TABLE IF EXISTS t4_issue38_uuid"); } catch {}
    db.close();
  }
}

// 1. INSERT then SELECT — the smoking gun
await withFreshDb(async (db) => {
  await db.executeAsync(
    "INSERT INTO t4_issue38_uuid (name) VALUES ($1)",
    ["alice"],
  );
  // Before the python fix this used to fail with InFailedSqlTransaction.
  // On Node `pg` it always worked because no lastval() probe runs — but
  // we keep this as a regression test in case the adapter ever changes.
  const rows = await db.queryAsync<{ name: string }>(
    "SELECT name FROM t4_issue38_uuid WHERE name = $1",
    ["alice"],
  );
  assert("INSERT then SELECT does not raise", rows.length === 1);
  assert("SELECT returns the inserted row", rows[0]?.name === "alice");
});

// 2. INSERT then multiple SELECTs on the same connection
await withFreshDb(async (db) => {
  await db.executeAsync("INSERT INTO t4_issue38_uuid (name) VALUES ($1)", ["bob"]);
  await db.executeAsync("INSERT INTO t4_issue38_uuid (name) VALUES ($1)", ["carol"]);

  const rows = await db.queryAsync<{ name: string }>(
    "SELECT name FROM t4_issue38_uuid ORDER BY name",
  );
  assert("two UUID INSERTs followed by SELECT returns both rows",
    rows.length === 2 && rows[0]?.name === "bob" && rows[1]?.name === "carol");
});

// 3. INSERT-UPDATE-SELECT chain
await withFreshDb(async (db) => {
  await db.executeAsync("INSERT INTO t4_issue38_uuid (name) VALUES ($1)", ["dave"]);
  await db.executeAsync(
    "UPDATE t4_issue38_uuid SET name = $1 WHERE name = $2",
    ["dave2", "dave"],
  );
  const row = await db.fetchOneAsync<{ name: string }>(
    "SELECT name FROM t4_issue38_uuid",
  );
  assert("INSERT → UPDATE → SELECT chain works on UUID PK",
    row?.name === "dave2");
});

// 4. Explicit transaction with multiple UUID INSERTs → commit
await withFreshDb(async (db) => {
  await db.startTransactionAsync();
  await db.executeAsync("INSERT INTO t4_issue38_uuid (name) VALUES ($1)", ["e1"]);
  await db.executeAsync("INSERT INTO t4_issue38_uuid (name) VALUES ($1)", ["e2"]);
  await db.executeAsync("INSERT INTO t4_issue38_uuid (name) VALUES ($1)", ["e3"]);
  await db.commitAsync();

  const row = await db.fetchOneAsync<{ n: string }>(
    "SELECT count(*) AS n FROM t4_issue38_uuid",
  );
  assert("explicit transaction → 3 UUID INSERTs → commit persists all rows",
    String(row?.n) === "3", `n=${row?.n}`);
});

// 5. Explicit transaction → rollback drops everything
await withFreshDb(async (db) => {
  await db.startTransactionAsync();
  await db.executeAsync("INSERT INTO t4_issue38_uuid (name) VALUES ($1)", ["x1"]);
  await db.executeAsync("INSERT INTO t4_issue38_uuid (name) VALUES ($1)", ["x2"]);
  await db.rollbackAsync();

  const row = await db.fetchOneAsync<{ n: string }>(
    "SELECT count(*) AS n FROM t4_issue38_uuid",
  );
  assert("rollback drops all UUID inserts (proves we were in one txn)",
    String(row?.n) === "0", `n=${row?.n}`);
});

// 6. INSERT ... RETURNING id still works — the adapter's primary path
await withFreshDb(async (db) => {
  const result = await db.insertAsync("t4_issue38_uuid", { name: "frank" });
  assert("insertAsync on UUID PK returns success",
    result?.success === true,
    `result=${JSON.stringify(result)}`);
  assert("insertAsync on UUID PK returns a non-null lastInsertId (uuid)",
    result?.lastId !== null && result?.lastId !== undefined);
  // #256: the surfaced id is the actual 36-char UUID string the row was given,
  // not a coerced number/null.
  assert("insertAsync UUID lastId is the actual uuid string",
    typeof result?.lastId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.lastId),
    `lastId=${JSON.stringify(result?.lastId)}`);
});

// 7. SERIAL-PK contract guard (#256): widening lastId to accept a UUID
// string must NOT break the integer auto-increment path — a SERIAL PK insert
// still returns the new integer id as a number.
await (async () => {
  const db = new PostgresAdapter({
    host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASS, database: PG_DB,
  });
  await db.connect();
  await db.executeAsync("DROP TABLE IF EXISTS t4_issue256_serial");
  await db.executeAsync(
    "CREATE TABLE t4_issue256_serial (id SERIAL PRIMARY KEY, name text)",
  );
  try {
    const r1 = await db.insertAsync("t4_issue256_serial", { name: "g1" });
    const r2 = await db.insertAsync("t4_issue256_serial", { name: "g2" });
    assert("insertAsync on SERIAL PK returns a numeric lastId",
      typeof r1?.lastId === "number" && typeof r2?.lastId === "number",
      `r1=${JSON.stringify(r1?.lastId)} r2=${JSON.stringify(r2?.lastId)}`);
    assert("SERIAL lastId increments (id2 = id1 + 1)",
      Number(r2?.lastId) === Number(r1?.lastId) + 1,
      `r1=${r1?.lastId} r2=${r2?.lastId}`);
  } finally {
    try { await db.executeAsync("DROP TABLE IF EXISTS t4_issue256_serial"); } catch {}
    db.close();
  }
})();

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

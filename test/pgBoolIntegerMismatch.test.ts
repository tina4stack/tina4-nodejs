/**
 * Regression test for #57 — a write that a bound value cannot satisfy must FAIL
 * LOUD, never silently swallow the error and leave an empty table.
 *
 * Root cause (Python #57): pre-3.13.38 `Database.execute()` swallowed the driver
 * exception and returned False; the reporter never checked the return, called
 * commit(), and found an empty table. The contract now (all four frameworks) is:
 * `execute()` RE-RAISES the driver error (recording it on `getError()`) — it
 * never returns false — so a doomed write is impossible to miss.
 *
 * This pins that contract on a REAL PostgreSQL: bind a JS boolean to a NOT-NULL
 * INTEGER column and assert `execute()` THROWS and the table stays empty. SQLite
 * cannot catch this (it is dynamically typed and would happily store the value),
 * so the check only means anything against a real relational engine — hence PG.
 *
 * Cross-driver note: Python's psycopg2 adapts `True` to a SQL boolean and PG
 * rejects the bool->int assignment with SQLSTATE 42804 (datatype_mismatch). The
 * Node `pg` driver serialises the boolean to the text `true`, so PG rejects it
 * with 22P02 (invalid_text_representation: `invalid input syntax for type
 * integer: "true"`). Different SQLSTATE, identical fail-loud outcome — which is
 * exactly what #57 is about. This test asserts the outcome, not the SQLSTATE.
 *
 * Skipped automatically when no PostgreSQL is reachable (or `pg` is not
 * installed) so CI without a container just no-ops.
 *
 * Run with: npx tsx test/pgBoolIntegerMismatch.test.ts
 */
import net from "node:net";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "5432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USER ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASS ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function summaryAndExit(code = 0): never {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(code);
}

function pgReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
    socket.connect(PG_PORT, PG_HOST, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

console.log("=== #57 fail-loud on bool→INTEGER (real PostgreSQL) ===\n");

if (!(await pgReachable())) {
  console.log(`  \x1b[33mSKIP\x1b[0m PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} — skipping`);
  summaryAndExit(0);
}

try {
  await import("pg");
} catch {
  console.log(`  \x1b[33mSKIP\x1b[0m 'pg' package not installed — npm install pg`);
  summaryAndExit(0);
}

const { initDatabase, closeDatabase } = await import("../packages/orm/src/index.ts");
const URL = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;
const db = await initDatabase({ url: URL });

try {
  await db.execute("DROP TABLE IF EXISTS t57_bool_int");
  await db.execute("CREATE TABLE t57_bool_int (id SERIAL PRIMARY KEY, n INTEGER NOT NULL)");

  // ── The #57 scenario: a JS boolean bound to a NOT-NULL INTEGER column ──
  let threw = false;
  let errorAtThrow: string | null = null;
  let message = "";
  try {
    await db.execute("INSERT INTO t57_bool_int (n) VALUES (?)", [true]);
  } catch (e) {
    threw = true;
    errorAtThrow = db.getError();
    message = (e as Error)?.message ?? String(e);
  }

  assert("#57 execute() THROWS on bool→INTEGER (does not return false)", threw, `(message=${message})`);
  assert("#57 getError() records the cause at throw-time (fail-loud)", errorAtThrow !== null && errorAtThrow !== "", `(getError=${errorAtThrow})`);
  assert(
    "#57 the error names the integer-column rejection",
    /integer/i.test(message),
    `(message=${message})`,
  );

  // The doomed write must NOT have landed — the reporter's empty table, but now
  // it is empty because the write LOUDLY failed, not because it silently no-op'd.
  const afterBad = await db.fetch("SELECT COUNT(*) AS c FROM t57_bool_int");
  assert(
    "#57 table stays empty after the rejected write",
    Number((afterBad.records[0] as { c: number | string }).c) === 0,
    `(count=${JSON.stringify(afterBad.records[0])})`,
  );

  // Proof the table/connection are healthy: a VALID integer write lands fine,
  // so the empty table above was caused by the rejection, not a broken setup.
  await db.execute("INSERT INTO t57_bool_int (n) VALUES (?)", [42]);
  const afterGood = await db.fetch("SELECT COUNT(*) AS c FROM t57_bool_int");
  assert(
    "#57 a valid integer write still lands after the rejection",
    Number((afterGood.records[0] as { c: number | string }).c) === 1,
    `(count=${JSON.stringify(afterGood.records[0])})`,
  );
} finally {
  try { await db.execute("DROP TABLE IF EXISTS t57_bool_int"); } catch {}
  try { await closeDatabase(); } catch {}
}

summaryAndExit(fail > 0 ? 1 : 0);

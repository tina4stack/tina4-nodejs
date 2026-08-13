/**
 * ODBC provider contract -- feature 13 (ODBC-DEC-01 provision a REAL ODBC source
 * + run the shared write-path fixture through it; ODBC-DEC-02 the latent fixes).
 *
 * Pins the ODBC write-path behaviours against a REAL ODBC source, no mocks. The
 * SAME cases are proven in all four frameworks; the shared fixture is
 * tina4-documentation/plan/v3/fixtures/odbcprovider_contract.json.
 *
 * ODBC is the generic escape hatch; its query/CRUD path had NEVER run against a
 * real ODBC source, so every finding was latent. The lab provisions unixODBC +
 * the PostgreSQL ODBC driver (psqlodbc), and this suite drives the write path.
 *
 *   * ODBC-PK-STUB: columnsAsync() reported primaryKey=false for every column, so
 *     a PK-keyed update(table, data) with no explicit filter could not introspect
 *     the key. Fixed to read the ODBC catalog (SQLPrimaryKeys via primaryKeys()).
 *   * ODBC-NODE-QUIRKS: updateAsync() had NO string-WHERE branch, so Object.keys()
 *     walked the STRING -> ["0","1",...] (a nonsense WHERE); and executeManyAsync()
 *     had no owns-guard, so nested in a caller's transaction its commit committed
 *     the OUTER transaction early. Both fixed.
 *   * ODBC-FAILLOUD (cross-language lock): a fetch on a bad query RAISES.
 *
 * TINA4_TEST_ODBC_DSN is the connection-string body (after odbc:///); unset ->
 * skip (a machine with no ODBC is the skip case, not the design).
 * TINA4_TEST_ODBC_AUTH_DSN (a password-protected source, no UID/PWD) +
 * TINA4_TEST_ODBC_USERNAME/_PASSWORD drive the credentials case.
 */
import { Database, initDatabase } from "../packages/orm/src/index.ts";

const ODBC_DSN = process.env.TINA4_TEST_ODBC_DSN;
const ODBC_AUTH_DSN = process.env.TINA4_TEST_ODBC_AUTH_DSN;
const ODBC_USER = process.env.TINA4_TEST_ODBC_USERNAME;
const ODBC_PASS = process.env.TINA4_TEST_ODBC_PASSWORD;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, why: string): void {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${why}`);
}

async function makeDb(): Promise<any> {
  return (await initDatabase({ url: "odbc:///" + (ODBC_DSN as string) })) as any;
}

// A plain table with an explicit INTEGER primary key. ODBC has no reliable
// last-insert-id, so the write-path fixture supplies the key explicitly - which
// is exactly what exercises the PK-catalog introspection.
async function makeTable(db: any, name: string, pk = "id"): Promise<void> {
  await db.execute(`DROP TABLE IF EXISTS ${name}`);
  await db.execute(`CREATE TABLE ${name} (${pk} INTEGER PRIMARY KEY, name VARCHAR(50))`);
}

async function threw(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

console.log("\n--- ODBC provider contract ---");

const CASES: Array<[string, (db: any) => Promise<void>]> = [
  ["a select returns rows", async (db) => {
    await makeTable(db, "odbc_node_select");
    await db.insert("odbc_node_select", { id: 1, name: "alpha" });
    await db.insert("odbc_node_select", { id: 2, name: "beta" });
    await db.insert("odbc_node_select", { id: 3, name: "gamma" });
    const result = await db.fetch("SELECT id, name FROM odbc_node_select ORDER BY id");
    const names = result.records.map((r: any) => r.name).join(",");
    ok("a select returns rows", result.count === 3 && names === "alpha,beta,gamma", `count=${result.count} names=${names}`);
  }],

  ["an insert round-trips on a fresh connection", async (db) => {
    await makeTable(db, "odbc_node_ins");
    await db.insert("odbc_node_ins", { id: 1, name: "x" });
    const reader = await makeDb();
    const row = await reader.fetchOne("SELECT name FROM odbc_node_ins WHERE id = ?", [1]);
    try { await reader.close(); } catch { /* already gone */ }
    ok("an insert round-trips on a fresh connection", !!row && row.name === "x", `row=${JSON.stringify(row)}`);
  }],

  ["a PK-keyed update with no filter works", async (db) => {
    await makeTable(db, "odbc_node_pk");
    await db.insert("odbc_node_pk", { id: 1, name: "one" });
    await db.insert("odbc_node_pk", { id: 2, name: "two" });
    // No explicit filter: the guard introspects the PK via the ODBC catalog
    // (was hardcoded false -> threw).
    await db.update("odbc_node_pk", { id: 1, name: "ONE" });
    const rows: Record<number, string> = {};
    for (const r of (await db.fetch("SELECT id, name FROM odbc_node_pk")).records) rows[Number(r.id)] = r.name;
    ok("a PK-keyed update with no filter works", rows[1] === "ONE" && rows[2] === "two", JSON.stringify(rows));
  }],

  ["a non-id primary key update works", async (db) => {
    await makeTable(db, "odbc_node_pk2", "thing_key");
    await db.insert("odbc_node_pk2", { thing_key: 7, name: "seven" });
    await db.update("odbc_node_pk2", { thing_key: 7, name: "SEVEN" });
    const row = await db.fetchOne("SELECT name FROM odbc_node_pk2 WHERE thing_key = ?", [7]);
    ok("a non-id primary key update works", !!row && row.name === "SEVEN", `row=${JSON.stringify(row)}`);
  }],

  ["a filterless update is guarded", async (db) => {
    await makeTable(db, "odbc_node_guard");
    await db.insert("odbc_node_guard", { id: 1, name: "keep" });
    const guarded = await threw(() => db.update("odbc_node_guard", { name: "WIPED" }));
    const row = await db.fetchOne("SELECT name FROM odbc_node_guard WHERE id = ?", [1]);
    ok("a filterless update is guarded", guarded && !!row && row.name === "keep", `guarded=${guarded} row=${JSON.stringify(row)}`);
  }],

  ["a filterless delete is guarded", async (db) => {
    await makeTable(db, "odbc_node_guard_del");
    await db.insert("odbc_node_guard_del", { id: 1, name: "keep" });
    const guarded = await threw(() => db.delete("odbc_node_guard_del"));
    const n = (await db.fetch("SELECT id FROM odbc_node_guard_del")).count;
    ok("a filterless delete is guarded", guarded && n === 1, `guarded=${guarded} rows=${n}`);
  }],

  ["a fetch on a bad query fails loud", async (db) => {
    const badFetch = await threw(() => db.fetch("SELECT * FROM odbc_node_table_that_does_not_exist_xyz"));
    const badOne = await threw(() => db.fetchOne("SELECT * FROM odbc_node_table_that_does_not_exist_xyz"));
    const good = await db.fetchOne("SELECT 1 AS one");
    ok("a fetch on a bad query fails loud", badFetch && badOne && Number(good.one) === 1, `fetch=${badFetch} one=${badOne}`);
  }],

  ["a string-where update targets the right rows", async (db) => {
    await makeTable(db, "odbc_node_strwhere");
    for (let i = 1; i <= 4; i++) await db.insert("odbc_node_strwhere", { id: i, name: "orig" });
    await db.update("odbc_node_strwhere", { name: "Z" }, "id <= ?", [3]);
    const rows: Record<number, string> = {};
    for (const r of (await db.fetch("SELECT id, name FROM odbc_node_strwhere")).records) rows[Number(r.id)] = r.name;
    ok(
      "a string-where update targets the right rows",
      rows[1] === "Z" && rows[2] === "Z" && rows[3] === "Z" && rows[4] === "orig",
      JSON.stringify(rows),
    );
  }],

  ["a batch insert inside a transaction respects the caller's rollback (owns-guard)", async (db) => {
    await makeTable(db, "odbc_node_owns");
    await db.startTransaction();
    // A batch routes through executeManyAsync. Without the owns-guard its commit
    // committed the OUTER transaction early, so the later rollback undid nothing.
    await db.insert("odbc_node_owns", [{ id: 1, name: "a" }, { id: 2, name: "b" }]);
    await db.execute("INSERT INTO odbc_node_owns (id, name) VALUES (?, ?)", [3, "c"]);
    await db.rollback();
    const n = (await db.fetch("SELECT id FROM odbc_node_owns")).count;
    ok(
      "a batch insert inside a transaction respects the caller's rollback (owns-guard)",
      n === 0,
      `${n} rows survived rollback (the batch committed the outer transaction)`,
    );
  }],
];

const CRED_CASES: Array<[string, () => Promise<void>]> = [
  ["credentials passed as params are honoured", async () => {
    // The connection string carries NO UID/PWD; the creds arrive only as params.
    const db = (await Database.create("odbc:///" + (ODBC_AUTH_DSN as string), ODBC_USER, ODBC_PASS)) as any;
    const row = await db.fetchOne("SELECT 1 AS one");
    try { await db.close(); } catch { /* already gone */ }
    ok("credentials passed as params are honoured", !!row && Number(row.one) === 1, `row=${JSON.stringify(row)}`);
  }],
  ["a wrong password fails loud", async () => {
    const failed = await threw(async () => {
      const db = (await Database.create("odbc:///" + (ODBC_AUTH_DSN as string), ODBC_USER, "definitely-the-wrong-password")) as any;
      await db.fetchOne("SELECT 1 AS one");
    });
    ok("a wrong password fails loud", failed, "a wrong password connected");
  }],
];

if (!ODBC_DSN) {
  for (const [name] of CASES) skip(name, "TINA4_TEST_ODBC_DSN not set (needs a live ODBC source)");
  for (const [name] of CRED_CASES) skip(name, "TINA4_TEST_ODBC_DSN not set");
} else {
  for (const [name, run] of CASES) {
    const db = await makeDb();
    try {
      await run(db);
    } catch (err) {
      ok(name, false, `threw: ${(err as Error).message}`);
    } finally {
      try { await db.close(); } catch { /* already gone */ }
    }
  }
  for (const [name, run] of CRED_CASES) {
    if (!ODBC_AUTH_DSN || !ODBC_USER || !ODBC_PASS) {
      skip(name, "TINA4_TEST_ODBC_AUTH_DSN / _USERNAME / _PASSWORD not set");
      continue;
    }
    try {
      await run();
    } catch (err) {
      ok(name, false, `threw: ${(err as Error).message}`);
    }
  }
}

console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);

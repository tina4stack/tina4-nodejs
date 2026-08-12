/**
 * Firebird provider contract -- feature 12 (FB-DEC-01/02/03).
 *
 * Pins the Firebird write-path + resilience behaviours against a REAL Firebird 5,
 * no mocks. The SAME cases are proven in all four frameworks; the shared fixture
 * is tina4-documentation/plan/v3/fixtures/firebirdprovider_contract.json.
 *
 *   * FB-DEC-02: db.insert() returns the GENERATOR-assigned last-id (non-`id` PK
 *     too); update/delete report the REAL affected count (node-firebird gives no
 *     DML count -- derived from a Firebird 5 `... RETURNING 1` row count).
 *   * FB-DEC-03: a binary blob round-trips byte-for-byte (a BLOB arrives as a
 *     streaming FUNCTION, read out to a Buffer -- the old no-op leaked it).
 *   * FB-DEC-01: a forced server-side disconnect transparently reconnects (Node
 *     gains the reconnect path); a logical SQL error does NOT.
 *
 * Firebird has no generic last_insert_id, so each table is created with a
 * GEN_<TABLE>_ID generator + a BEFORE INSERT trigger. TINA4_TEST_FIREBIRD_URL
 * unset -> skip (a machine with no Firebird is the skip case, not the design).
 */
import { FirebirdAdapter, initDatabase } from "../packages/orm/src/index.ts";

const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL;

// A binary payload a naive text decode or an unread blob handle corrupts: a NUL
// byte, high bytes 0xFD..0xFF, an embedded NUL, and ASCII.
const BLOB = Buffer.from([0, 1, 2, 253, 254, 255, 65, 66, 0, 67]);

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
  return (await initDatabase({ url: FIREBIRD_URL as string })) as any;
}

// A table whose PK is assigned by a GEN_<TABLE>_ID generator via a BEFORE INSERT
// trigger -- the real Firebird auto-key idiom.
async function makeTable(db: any, name: string, pk = "id", extra = ""): Promise<void> {
  for (const sql of [`DROP TRIGGER ${name}_bi`, `DROP TABLE ${name}`, `DROP GENERATOR gen_${name}_id`]) {
    try { await db.execute(sql); } catch { /* ignore */ }
  }
  let cols = `${pk} INTEGER NOT NULL PRIMARY KEY, name VARCHAR(50)`;
  if (extra) cols += `, ${extra}`;
  await db.execute(`CREATE TABLE ${name} (${cols})`);
  await db.execute(`CREATE GENERATOR gen_${name}_id`);
  await db.execute(
    `CREATE TRIGGER ${name}_bi FOR ${name} ACTIVE BEFORE INSERT POSITION 0 ` +
      `AS BEGIN IF (NEW.${pk} IS NULL) THEN NEW.${pk} = GEN_ID(gen_${name}_id, 1); END`,
  );
}

console.log("\n--- Firebird provider contract ---");

const CASES: Array<[string, (db: any) => Promise<void>]> = [
  // FB-DEC-02: generator last-id
  ["an insert returns the generator last id", async (db) => {
    await makeTable(db, "nbc_gen");
    const result = await db.insert("nbc_gen", { name: "alpha" });
    ok("an insert returns the generator last id", Number(result.lastId) === 1, `got ${result.lastId}`);
  }],
  ["a second insert returns the next generated id", async (db) => {
    await makeTable(db, "nbc_gen2");
    const first = await db.insert("nbc_gen2", { name: "a" });
    const second = await db.insert("nbc_gen2", { name: "b" });
    let durable = false;
    const reader = await makeDb();
    try {
      const row: any = await reader.fetchOne("SELECT name FROM nbc_gen2 WHERE id = ?", [2]);
      durable = row?.name === "b";
    } finally { await reader.close(); }
    ok("a second insert returns the next generated id",
      Number(first.lastId) === 1 && Number(second.lastId) === 2 && durable,
      `first=${first.lastId} second=${second.lastId} durable=${durable}`);
  }],
  ["an insert reports affected rows of one", async (db) => {
    await makeTable(db, "nbc_ins1");
    const result = await db.insert("nbc_ins1", { name: "x" });
    ok("an insert reports affected rows of one", result.affectedRows === 1, `got ${result.affectedRows}`);
  }],
  // FB-DEC-02: real affected count
  ["a multi row update reports the real affected count", async (db) => {
    await makeTable(db, "nbc_upd");
    for (const n of ["a", "b", "c", "d"]) await db.insert("nbc_upd", { name: n });
    const result = await db.update("nbc_upd", { name: "Z" }, "id <= ?", [3]);
    ok("a multi row update reports the real affected count", result.affectedRows === 3, `got ${result.affectedRows}`);
  }],
  ["an update matching no rows reports zero affected", async (db) => {
    await makeTable(db, "nbc_upd0");
    await db.insert("nbc_upd0", { name: "a" });
    const result = await db.update("nbc_upd0", { name: "Z" }, "name = ?", ["nope"]);
    ok("an update matching no rows reports zero affected", result.affectedRows === 0, `got ${result.affectedRows}`);
  }],
  ["a delete reports the real affected count", async (db) => {
    await makeTable(db, "nbc_del");
    for (const n of ["a", "b", "c"]) await db.insert("nbc_del", { name: n });
    const result = await db.delete("nbc_del", "id <= ?", [2]);
    ok("a delete reports the real affected count", result.affectedRows === 2, `got ${result.affectedRows}`);
  }],
  // FB-DEC-03: blob round-trip
  ["a binary blob round trips byte for byte", async (db) => {
    await makeTable(db, "nbc_blob", "id", "payload BLOB SUB_TYPE 0");
    await db.insert("nbc_blob", { name: "b", payload: BLOB });
    const reader = await makeDb();
    let got: Buffer | null = null;
    try {
      const row: any = await reader.fetchOne("SELECT payload FROM nbc_blob WHERE name = ?", ["b"]);
      got = row?.payload ?? null;
    } finally { await reader.close(); }
    ok("a binary blob round trips byte for byte",
      Buffer.isBuffer(got) && Buffer.compare(got as Buffer, BLOB) === 0,
      `isBuffer=${Buffer.isBuffer(got)} value=${JSON.stringify(got)}`);
  }],
  // FB-DEC-01: real reconnect
  ["a forced disconnect reconnects and the next query succeeds", async (db) => {
    await makeTable(db, "nbc_recon");
    await db.insert("nbc_recon", { name: "before" });
    const meta: any = await db.fetchOne("SELECT CURRENT_CONNECTION AS c FROM RDB$DATABASE");
    const connId = meta.c;
    const killer = await makeDb();
    await killer.execute("DELETE FROM MON$ATTACHMENTS WHERE MON$ATTACHMENT_ID = ?", [connId]);
    await killer.close();
    // The next query on the dead attachment must transparently reconnect + succeed.
    const row: any = await db.fetchOne("SELECT COUNT(*) AS n FROM nbc_recon");
    ok("a forced disconnect reconnects and the next query succeeds", Number(row?.n) === 1, `got ${JSON.stringify(row)}`);
  }],
  ["a logical sql error does not trigger a reconnect", async (db) => {
    const matcherOk =
      FirebirdAdapter.isDeadConnection(new Error("Dynamic SQL Error: syntax error at line 1")) === false &&
      FirebirdAdapter.isDeadConnection(new Error("Table NBC_NOPE does not exist")) === false;
    let threw = false;
    try { await db.fetchOne("SELECT * FROM nbc_table_that_does_not_exist_xyz"); } catch { threw = true; }
    // The connection is still usable -- no spurious reconnect churn broke it.
    let stillWorks = false;
    try { const r: any = await db.fetchOne("SELECT 1 AS x FROM RDB$DATABASE"); stillWorks = Number(r?.x) === 1; } catch { /* no */ }
    ok("a logical sql error does not trigger a reconnect", matcherOk && threw && stillWorks,
      `matcher=${matcherOk} threw=${threw} stillWorks=${stillWorks}`);
  }],
  // FB-DEC-02: non-`id` primary key
  ["a non id primary key insert returns the generated last id", async (db) => {
    await makeTable(db, "nbc_thing", "thing_key");
    const result = await db.insert("nbc_thing", { name: "hi" });
    ok("a non id primary key insert returns the generated last id", Number(result.lastId) === 1, `got ${result.lastId}`);
  }],
];

if (!FIREBIRD_URL) {
  for (const [name] of CASES) skip(name, "TINA4_TEST_FIREBIRD_URL not set (needs a live Firebird)");
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
}

console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
// node-firebird leaves a handle open after close(); exit explicitly so the
// runner does not time out on a 100%-pass run.
process.exit(failed > 0 ? 1 : 0);

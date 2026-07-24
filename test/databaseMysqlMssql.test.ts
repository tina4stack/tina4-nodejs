/**
 * Live MySQL + MSSQL driver tests (#262).
 *
 * Mirrors tina4-python/tests/test_database_drivers.py (TestMySQLLive /
 * TestMSSQLLive): probe TCP reachability, and when the engine is up create a
 * temp table, insert rows with raw JS booleans through executeAsync(...?...),
 * fetchAsync them back, and assert the boolean ROUND-TRIPS — locking in the
 * cross-framework bind contract (a raw bool binds as the engine's native
 * truthy/falsy value, never crashing or stringifying to '').
 *
 * NO MOCKS: this hits real MySQL + MSSQL servers (no stub/fake adapter). The
 * Node MySQL/MSSQL adapters are ASYNC — the sync execute()/fetch() throw
 * "Use executeAsync()...", so we drive db.executeAsync()/db.fetchAsync()
 * built via createAdapterFromUrl(). When an engine is unreachable the test
 * SKIPS cleanly (prints a SKIP line, never fails) — but under
 * TINA4_REQUIRE_SERVICES the run-all.ts gate (test/_serviceGate.ts) turns that
 * skip into a hard failure (MySQL/MSSQL joined the provisioned set in #262).
 *
 * Boolean round-trip contract verified live:
 *   - MySQL  TINYINT → 1 / 0
 *   - MSSQL  BIT     → true / false (the tedious driver returns native booleans)
 *
 * Live infra (defaults; override via the env vars below):
 *   MySQL  localhost:3306  user/pass tina4/tina4         db tina4_test
 *   MSSQL  localhost:1433  user/pass sa/"TinaSQL123!Secure" db tina4_test
 *
 * Run with: npx tsx test/databaseMysqlMssql.test.ts
 */
import net from "node:net";

const MYSQL_HOST = process.env.TINA4_TEST_MYSQL_HOST ?? "localhost";
const MYSQL_PORT = parseInt(process.env.TINA4_TEST_MYSQL_PORT ?? "3306", 10);
const MYSQL_USER = process.env.TINA4_TEST_MYSQL_USER ?? "tina4";
const MYSQL_PASS = process.env.TINA4_TEST_MYSQL_PASS ?? "tina4";
const MYSQL_DB = process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test";

const MSSQL_HOST = process.env.TINA4_TEST_MSSQL_HOST ?? "localhost";
const MSSQL_PORT = parseInt(process.env.TINA4_TEST_MSSQL_PORT ?? "1433", 10);
const MSSQL_USER = process.env.TINA4_TEST_MSSQL_USER ?? "sa";
const MSSQL_PASS = process.env.TINA4_TEST_MSSQL_PASS ?? "TinaSQL123!Secure";
const MSSQL_DB = process.env.TINA4_TEST_MSSQL_DB ?? "tina4_test";

const TABLE = "_tina4_test_bool";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${reason}`);
  skipped++;
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.connect(port, host, () => {
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

console.log("=== Live MySQL + MSSQL driver tests (#262) ===\n");

const { createAdapterFromUrl, Database } = await import("../packages/orm/src/index.ts");

// Dedicated table for the getLastId lock-in (#268) — kept separate from the
// boolean round-trip table so the two suites never collide.
const ID_TABLE = "_tina4_test_lastid";

// ── MySQL ────────────────────────────────────────────────────
console.log("--- MySQL ---");

if (!(await reachable(MYSQL_HOST, MYSQL_PORT))) {
  // "MySQL ... not reachable" matches the provisioned-service gate keywords.
  skip("MySQL live boolean round-trip", `MySQL not reachable at ${MYSQL_HOST}:${MYSQL_PORT}`);
} else {
  let db: any = null;
  try {
    db = await createAdapterFromUrl(
      `mysql://${MYSQL_USER}:${MYSQL_PASS}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`,
    );
    assert("MySQL adapter created from URL", db !== null && db !== undefined);

    await db.executeAsync(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.executeAsync(
      `CREATE TABLE ${TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), flag TINYINT)`,
    );

    // Insert raw JS booleans through ? placeholders — the bind contract under test.
    await db.executeAsync(`INSERT INTO ${TABLE} (name, flag) VALUES (?, ?)`, ["on", true]);
    await db.executeAsync(`INSERT INTO ${TABLE} (name, flag) VALUES (?, ?)`, ["off", false]);

    const inserted = (await db.fetchAsync(`SELECT name, flag FROM ${TABLE} ORDER BY id`)) as Array<{
      name: string;
      flag: number;
    }>;
    assert("MySQL inserted both rows", inserted.length === 2, JSON.stringify(inserted));

    // MySQL TINYINT: a raw bool binds as 1 / 0 (never crashing or stringifying).
    const flags = inserted.map((r) => r.flag);
    assert(
      "MySQL boolean round-trips as 1 / 0 (TINYINT)",
      flags.length === 2 && flags[0] === 1 && flags[1] === 0,
      `got ${JSON.stringify(flags)}`,
    );

    // The true row reads back as truthy, the false row as falsy.
    const onRow = (await db.fetchAsync(`SELECT flag FROM ${TABLE} WHERE name = ?`, ["on"])) as Array<{
      flag: number;
    }>;
    const offRow = (await db.fetchAsync(`SELECT flag FROM ${TABLE} WHERE name = ?`, ["off"])) as Array<{
      flag: number;
    }>;
    assert("MySQL true row is truthy", onRow.length === 1 && Boolean(onRow[0].flag) === true);
    assert("MySQL false row is falsy", offRow.length === 1 && Boolean(offRow[0].flag) === false);
  } catch (err) {
    assert("MySQL live boolean round-trip", false, `error: ${(err as Error).message}`);
  } finally {
    try {
      await db?.executeAsync(`DROP TABLE IF EXISTS ${TABLE}`);
    } catch {
      /* ignore cleanup error */
    }
    try {
      db?.close?.();
    } catch {
      /* ignore */
    }
  }

  // ── MySQL getLastId() after an AUTO_INCREMENT insert (#268) ──────────
  // Lock-in: getLastId() returns the new row's id after an insert through the
  // PROPER framework insert path (Database.create -> db.insert), captured at
  // write time (the mysql2 driver's result.insertId — the Node analog of the
  // Python master's cursor.lastrowid in tina4_python/database/mysql.py). Python
  // master returns last_id == 1 for the first auto-increment insert; we assert
  // the same here. This is NOT a raw executeAsync — it exercises insert()+
  // getLastId() exactly as an application would.
  {
    let db2: any = null;
    try {
      db2 = await Database.create(`mysql://${MYSQL_USER}:${MYSQL_PASS}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`);
      await db2.execute(`DROP TABLE IF EXISTS ${ID_TABLE}`);
      await db2.execute(`CREATE TABLE ${ID_TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100))`);

      const ins = await db2.insert(ID_TABLE, { name: "alpha" });
      const lastId = db2.getLastId();
      const row = await db2.fetchOne(`SELECT id FROM ${ID_TABLE} WHERE name = ?`, ["alpha"]);
      // Python master returns 1 for the first IDENTITY/AUTO_INCREMENT insert.
      assert(
        "MySQL getLastId() == new row id == 1 after AUTO_INCREMENT insert",
        Number(lastId) === 1 && Number(row?.id) === 1,
        `getLastId=${JSON.stringify(lastId)} rowId=${JSON.stringify(row?.id)} insert.lastId=${JSON.stringify(ins?.lastId)}`,
      );

      // Captured at write time, monotonic: a second insert bumps it to 2.
      await db2.insert(ID_TABLE, { name: "bravo" });
      const lastId2 = db2.getLastId();
      assert(
        "MySQL getLastId() advances to 2 on the second insert",
        Number(lastId2) === 2,
        `getLastId=${JSON.stringify(lastId2)}`,
      );

      // insert() surfaces the same id it captured.
      assert(
        "MySQL insert() result.lastId matches getLastId() (write-time capture)",
        Number(ins?.lastId) === 1,
        `result.lastId=${JSON.stringify(ins?.lastId)}`,
      );
    } catch (err) {
      assert("MySQL getLastId() after AUTO_INCREMENT insert", false, `error: ${(err as Error).message}`);
    } finally {
      try { await db2?.execute(`DROP TABLE IF EXISTS ${ID_TABLE}`); } catch { /* ignore */ }
      try { db2?.close?.(); } catch { /* ignore */ }
    }
  }
}

// ── MSSQL ────────────────────────────────────────────────────
console.log("\n--- MSSQL ---");

if (!(await reachable(MSSQL_HOST, MSSQL_PORT))) {
  // "MSSQL ... not reachable" matches the provisioned-service gate keywords.
  skip("MSSQL live boolean round-trip", `MSSQL not reachable at ${MSSQL_HOST}:${MSSQL_PORT}`);
} else {
  let db: any = null;
  try {
    db = await createAdapterFromUrl(
      `mssql://${MSSQL_USER}:${MSSQL_PASS}@${MSSQL_HOST}:${MSSQL_PORT}/${MSSQL_DB}`,
    );
    assert("MSSQL adapter created from URL", db !== null && db !== undefined);

    await db.executeAsync(`IF OBJECT_ID('${TABLE}','U') IS NOT NULL DROP TABLE ${TABLE}`);
    await db.executeAsync(
      `CREATE TABLE ${TABLE} (id INT IDENTITY(1,1) PRIMARY KEY, name VARCHAR(100), flag BIT)`,
    );

    // Insert raw JS booleans through ? placeholders — the bind contract under test.
    await db.executeAsync(`INSERT INTO ${TABLE} (name, flag) VALUES (?, ?)`, ["on", true]);
    await db.executeAsync(`INSERT INTO ${TABLE} (name, flag) VALUES (?, ?)`, ["off", false]);

    const inserted = (await db.fetchAsync(`SELECT name, flag FROM ${TABLE} ORDER BY id`)) as Array<{
      name: string;
      flag: boolean;
    }>;
    assert("MSSQL inserted both rows", inserted.length === 2, JSON.stringify(inserted));

    // MSSQL BIT via the tedious driver: a raw bool binds and reads back as a
    // NATIVE boolean (true / false) — lock in what the adapter actually returns.
    const flags = inserted.map((r) => r.flag);
    assert(
      "MSSQL boolean round-trips as true / false (BIT, tedious native)",
      flags.length === 2 && flags[0] === true && flags[1] === false,
      `got ${JSON.stringify(flags)}`,
    );

    // Boolean coercion is stable regardless of the driver's native type.
    const onRow = (await db.fetchAsync(`SELECT flag FROM ${TABLE} WHERE name = ?`, ["on"])) as Array<{
      flag: boolean;
    }>;
    const offRow = (await db.fetchAsync(`SELECT flag FROM ${TABLE} WHERE name = ?`, ["off"])) as Array<{
      flag: boolean;
    }>;
    assert("MSSQL true row is truthy", onRow.length === 1 && Boolean(onRow[0].flag) === true);
    assert("MSSQL false row is falsy", offRow.length === 1 && Boolean(offRow[0].flag) === false);
  } catch (err) {
    assert("MSSQL live boolean round-trip", false, `error: ${(err as Error).message}`);
  } finally {
    try {
      await db?.executeAsync(`IF OBJECT_ID('${TABLE}','U') IS NOT NULL DROP TABLE ${TABLE}`);
    } catch {
      /* ignore cleanup error */
    }
    try {
      db?.close?.();
    } catch {
      /* ignore */
    }
  }

  // ── MSSQL getLastId() after an IDENTITY insert (#268) ───────────────
  // Lock-in: getLastId() returns the new row's id after an insert through the
  // PROPER framework insert path (Database.create -> db.insert), captured at
  // write time. The MssqlAdapter appends `; SELECT SCOPE_IDENTITY() AS id` to
  // the INSERT batch and reads the id from that result row — the Node analog of
  // the Python master running cursor.execute("SELECT SCOPE_IDENTITY()...") on
  // the same session in tina4_python/database/mssql.py (session-scoped, so the
  // id belongs to the row this connection just inserted). Python master returns
  // last_id == 1 for the first IDENTITY insert; we assert the same. Also covers
  // the PHP MSSQL count-probe parity: a fetch() with ORDER BY returns the right
  // .count (the COUNT(*) subquery must not choke on the ORDER BY).
  {
    let db2: any = null;
    try {
      db2 = await Database.create(`mssql://${MSSQL_USER}:${MSSQL_PASS}@${MSSQL_HOST}:${MSSQL_PORT}/${MSSQL_DB}`);
      await db2.execute(`IF OBJECT_ID('${ID_TABLE}','U') IS NOT NULL DROP TABLE ${ID_TABLE}`);
      await db2.execute(`CREATE TABLE ${ID_TABLE} (id INT IDENTITY(1,1) PRIMARY KEY, name VARCHAR(100))`);

      const ins = await db2.insert(ID_TABLE, { name: "alpha" });
      const lastId = db2.getLastId();
      const row = await db2.fetchOne(`SELECT id FROM ${ID_TABLE} WHERE name = ?`, ["alpha"]);
      // Python master returns 1 for the first IDENTITY insert.
      assert(
        "MSSQL getLastId() == new row id == 1 after IDENTITY insert",
        Number(lastId) === 1 && Number(row?.id) === 1,
        `getLastId=${JSON.stringify(lastId)} rowId=${JSON.stringify(row?.id)} insert.lastId=${JSON.stringify(ins?.lastId)}`,
      );

      // Captured at write time (SCOPE_IDENTITY of the just-inserted row),
      // monotonic: a second insert bumps it to 2.
      await db2.insert(ID_TABLE, { name: "bravo" });
      const lastId2 = db2.getLastId();
      assert(
        "MSSQL getLastId() advances to 2 on the second insert",
        Number(lastId2) === 2,
        `getLastId=${JSON.stringify(lastId2)}`,
      );

      // insert() surfaces the same id it captured.
      assert(
        "MSSQL insert() result.lastId matches getLastId() (SCOPE_IDENTITY, write-time)",
        Number(ins?.lastId) === 1,
        `result.lastId=${JSON.stringify(ins?.lastId)}`,
      );

      // PHP MSSQL count-probe parity: fetch() with an ORDER BY returns the
      // right .count. The framework wraps the user SQL in a COUNT(*) subquery
      // for the total; an ORDER BY in the wrapped query must not break it.
      const res = await db2.fetch(`SELECT id, name FROM ${ID_TABLE} ORDER BY id`);
      assert(
        "MSSQL fetch() with ORDER BY reports count == 2",
        res.count === 2 && res.records.length === 2,
        `count=${JSON.stringify(res.count)} records=${res.records.length}`,
      );
    } catch (err) {
      assert("MSSQL getLastId() after IDENTITY insert", false, `error: ${(err as Error).message}`);
    } finally {
      try { await db2?.execute(`IF OBJECT_ID('${ID_TABLE}','U') IS NOT NULL DROP TABLE ${ID_TABLE}`); } catch { /* ignore */ }
      try { db2?.close?.(); } catch { /* ignore */ }
    }
  }
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`,
);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

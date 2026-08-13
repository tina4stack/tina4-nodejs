/**
 * SQL translator literal-safe + BIGINT-autoincrement contract - feature 7
 * (sqltranslator_contract.json), parity with
 * tina4-python/tests/test_sqltranslator_contract.py.
 *
 * Locks out a DATA-CORRUPTION defect against REAL databases (NO MOCKS): the
 * dialect rewrites (|| -> CONCAT, ILIKE -> LOWER LIKE, TRUE/FALSE -> 1/0) used to
 * MANGLE STRING LITERALS - a value of 'a||b', a label 'TRUE', or a LIKE pattern
 * that mentions ILIKE was rewritten as if it were SQL. The concat rewrite also
 * split the WHOLE statement on || so `SELECT a || b FROM t` became
 * `CONCAT(SELECT a, b FROM t)`. The rewrites are now literal-safe (mask ->
 * rewrite -> restore) and concat only rewrites the operand chain. Concat + ilike
 * run through the real MySQL adapter path (adapter.translateSql).
 *
 * SQLTRANS-DEC-03: a BIGINT ... AUTOINCREMENT DDL now yields a real 64-bit
 * auto-increment column (PostgreSQL BIGSERIAL, MySQL BIGINT AUTO_INCREMENT).
 *
 * Live infra on the .99 lab: MySQL :3306 (tina4/tina4 -> tina4_test),
 * PostgreSQL :55432 (tina4/tina4). When an engine is unreachable a case SKIPS
 * with a gate-matching reason; under TINA4_REQUIRE_SERVICES the run-all gate
 * turns that skip into a hard failure.
 *
 * Mutation-proof: revert the literal-safe rewrite and "pipes inside a string
 * literal are preserved" / "boolean token inside a string literal is preserved"
 * / "ilike pattern with multiple words survives and runs" go RED; revert the
 * PostgreSQL BIGINT branch and "bigint autoincrement creates a real bigint
 * column" goes RED.
 *
 * Run with: npx tsx test/sqlTranslatorContract.test.ts
 */
import net from "node:net";
import { createAdapterFromUrl, SQLTranslator } from "../packages/orm/src/index.js";

const MYSQL_HOST = process.env.TINA4_TEST_MYSQL_HOST ?? "localhost";
const MYSQL_PORT = parseInt(process.env.TINA4_TEST_MYSQL_PORT ?? "3306", 10);
const MYSQL_USER = process.env.TINA4_TEST_MYSQL_USERNAME ?? "tina4";
const MYSQL_PASS = process.env.TINA4_TEST_MYSQL_PASSWORD ?? "tina4";
const MYSQL_DB = process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

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
    }, 1500);
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

function tableName(prefix: string): string {
  return `tina4_sqltrans_${prefix}_${Math.random().toString(16).slice(2, 12)}`;
}

const mysqlUp = await reachable(MYSQL_HOST, MYSQL_PORT);
const pgUp = await reachable(PG_HOST, PG_PORT);

// ── Invariant 1: literal-safe concat / bool / ilike, RUN on a real engine ──

if (!mysqlUp) {
  skip("concat pipes translate outside literals and run", `MySQL not reachable at ${MYSQL_HOST}:${MYSQL_PORT}`);
  skip("pipes inside a string literal are preserved", `MySQL not reachable at ${MYSQL_HOST}:${MYSQL_PORT}`);
  skip("ilike pattern with multiple words survives and runs", `MySQL not reachable at ${MYSQL_HOST}:${MYSQL_PORT}`);
  skip("boolean token inside a string literal is preserved", `MySQL not reachable at ${MYSQL_HOST}:${MYSQL_PORT}`);
} else {
  let db: any = null;
  try {
    db = await createAdapterFromUrl(`mysql://${MYSQL_USER}:${MYSQL_PASS}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`);

    // concat pipes translate outside literals and run
    {
      const t = tableName("concat");
      await db.executeAsync(`CREATE TABLE ${t} (id INT AUTO_INCREMENT PRIMARY KEY, first_name VARCHAR(50), last_name VARCHAR(50))`);
      try {
        await db.executeAsync(`INSERT INTO ${t} (first_name, last_name) VALUES (?, ?)`, ["Jane", "Doe"]);
        const rows = (await db.fetchAsync(`SELECT (first_name || ' ' || last_name) AS fullname FROM ${t}`)) as Array<{ fullname: string }>;
        assert("concat pipes translate outside literals and run", rows.length === 1 && rows[0].fullname === "Jane Doe", JSON.stringify(rows));
      } finally {
        await db.executeAsync(`DROP TABLE ${t}`);
      }
    }

    // pipes inside a string literal are preserved
    {
      const t = tableName("litpipe");
      await db.executeAsync(`CREATE TABLE ${t} (id INT AUTO_INCREMENT PRIMARY KEY, data VARCHAR(50))`);
      try {
        await db.executeAsync(`INSERT INTO ${t} (data) VALUES (?)`, ["a||b"]);
        await db.executeAsync(`INSERT INTO ${t} (data) VALUES (?)`, ["plain"]);
        const rows = (await db.fetchAsync(`SELECT id, data FROM ${t} WHERE data = 'a||b'`)) as Array<{ data: string }>;
        assert("pipes inside a string literal are preserved", rows.length === 1 && rows[0].data === "a||b", JSON.stringify(rows));
      } finally {
        await db.executeAsync(`DROP TABLE ${t}`);
      }
    }

    // ilike pattern with multiple words survives and runs
    {
      const t = tableName("ilike");
      await db.executeAsync(`CREATE TABLE ${t} (id INT AUTO_INCREMENT PRIMARY KEY, bio VARCHAR(100))`);
      try {
        await db.executeAsync(`INSERT INTO ${t} (bio) VALUES (?)`, ["Loves TWO WORDS and coffee"]);
        await db.executeAsync(`INSERT INTO ${t} (bio) VALUES (?)`, ["nothing here"]);
        const rows = (await db.fetchAsync(`SELECT id, bio FROM ${t} WHERE bio ILIKE '%two words%'`)) as Array<{ bio: string }>;
        assert("ilike pattern with multiple words survives and runs", rows.length === 1 && rows[0].bio.includes("TWO WORDS"), JSON.stringify(rows));
      } finally {
        await db.executeAsync(`DROP TABLE ${t}`);
      }
    }

    // boolean token inside a string literal is preserved (translate-then-execute)
    {
      const t = tableName("boollit");
      await db.executeAsync(`CREATE TABLE ${t} (id INT AUTO_INCREMENT PRIMARY KEY, flag INT, label VARCHAR(20))`);
      try {
        await db.executeAsync(`INSERT INTO ${t} (flag, label) VALUES (?, ?)`, [1, "TRUE"]);
        await db.executeAsync(`INSERT INTO ${t} (flag, label) VALUES (?, ?)`, [0, "other"]);
        const canonical = `SELECT id, label FROM ${t} WHERE flag = TRUE AND label = 'TRUE'`;
        const translated = SQLTranslator.booleanToInt(canonical);
        const rows = (await db.fetchAsync(translated)) as Array<{ label: string }>;
        assert(
          "boolean token inside a string literal is preserved",
          translated.includes("flag = 1") && translated.includes("label = 'TRUE'") && rows.length === 1 && rows[0].label === "TRUE",
          `translated=${translated} rows=${JSON.stringify(rows)}`,
        );
      } finally {
        await db.executeAsync(`DROP TABLE ${t}`);
      }
    }
  } catch (err) {
    assert("MySQL literal-safe translator cases", false, `error: ${(err as Error).message}`);
  } finally {
    try { db?.close?.(); } catch { /* ignore */ }
  }
}

// ── Invariant 2: BIGINT autoincrement creates a real 64-bit column ──

async function bigintCase(engineLabel: string, url: string, engine: string): Promise<void> {
  let db: any = null;
  const t = tableName("bigint");
  try {
    db = await createAdapterFromUrl(url);
    const ddl = `CREATE TABLE ${t} (id BIGINT PRIMARY KEY AUTOINCREMENT, name VARCHAR(50))`;
    const translated = SQLTranslator.autoIncrementSyntax(ddl, engine);
    await db.executeAsync(translated);
    try {
      // Insert with NO id -> must auto-generate (a plain BIGINT PK with the
      // keyword stripped would fail the NOT NULL key here).
      await db.executeAsync(`INSERT INTO ${t} (name) VALUES (?)`, ["alpha"]);
      const rows = (await db.fetchAsync(`SELECT id FROM ${t} WHERE name = ?`, ["alpha"])) as Array<Record<string, unknown>>;
      const idOk = rows.length === 1 && Number(rows[0].id) >= 1;
      const typeRows = (await db.fetchAsync(
        `SELECT data_type AS dtype FROM information_schema.columns WHERE table_name = ? AND column_name = 'id'`,
        [t],
      )) as Array<Record<string, unknown>>;
      const typeOk = typeRows.length >= 1 && String(Object.values(typeRows[0])[0]).toLowerCase() === "bigint";
      assert(
        `bigint autoincrement creates a real bigint column (${engineLabel})`,
        idOk && typeOk,
        `id=${JSON.stringify(rows)} type=${JSON.stringify(typeRows)}`,
      );
    } finally {
      await db.executeAsync(`DROP TABLE ${t}`);
    }
  } catch (err) {
    assert(`bigint autoincrement creates a real bigint column (${engineLabel})`, false, `error: ${(err as Error).message}`);
  } finally {
    try { db?.close?.(); } catch { /* ignore */ }
  }
}

if (!pgUp) {
  skip("bigint autoincrement creates a real bigint column (postgres)", `PostgreSQL not reachable at ${PG_HOST}:${PG_PORT}`);
} else {
  await bigintCase("postgres", `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`, "postgresql");
}

if (!mysqlUp) {
  skip("bigint autoincrement creates a real bigint column (mysql)", `MySQL not reachable at ${MYSQL_HOST}:${MYSQL_PORT}`);
} else {
  await bigintCase("mysql", `mysql://${MYSQL_USER}:${MYSQL_PASS}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`, "mysql");
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

// Running this file directly (not via test/run-all.ts) bypasses the service
// gate, so a silent skip would false-green. Under TINA4_REQUIRE_SERVICES a skip
// is a hard failure here too - MySQL + PostgreSQL are provisioned on the lab.
const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");
if (requireServices && skipped > 0) {
  console.log(`  TINA4_REQUIRE_SERVICES is set but ${skipped} case(s) skipped — failing.`);
  process.exit(1);
}

process.exit(fail > 0 ? 1 : 0);

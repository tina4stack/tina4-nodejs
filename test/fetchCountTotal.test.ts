/**
 * db.fetch() reports the REAL total for the filter, independent of limit/offset,
 * on every engine.
 *
 * THE DEFECT (found while testing tina4-python#133 in Node): the COUNT probe
 * wraps the read as `SELECT COUNT(*) FROM (<sql>) AS _count_query`. SQL Server
 * and MySQL REQUIRE that derived-table alias, and each adapter declares it as
 * `countSubqueryAlias` - but Database.create() hands the probe the
 * CachedDatabaseAdapter wrapper, which did not forward the property. The probe
 * ran without the alias, the engine rejected it, the error was swallowed, and
 * `result.count` silently fell back to the PAGE length for every ordinary read.
 * PostgreSQL (16+) and SQLite accept an unaliased derived table, which is why
 * it went unnoticed there - they are the controls here.
 *
 * NO MOCKS: real SQL Server, MySQL, PostgreSQL and a real SQLite file.
 *
 * Same case names in all four frameworks:
 *   - fetch_total_is_the_filter_total_not_the_page_length
 *   - fetch_total_with_order_by_is_the_filter_total
 *   - fetch_total_is_zero_when_nothing_matches
 *   - count_probe_strips_only_a_trailing_top_level_order_by (pure function)
 *
 * The ORDER BY case is a second cause on SQL Server: it rejects an ORDER BY
 * inside a derived table (error 1033), so even with the alias forwarded the
 * probe failed for any read ending in ORDER BY. The probe now drops a trailing
 * top-level ORDER BY (it cannot change a COUNT), like Python and PHP.
 *
 * Run with: npx tsx test/fetchCountTotal.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, SQLTranslator } from "../packages/orm/src/index.ts";

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
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} (${reason})`);
  skipped++;
}

const TABLE = "issue_count_node_total";
const ROWS = 25;
const sqliteDir = mkdtempSync(join(tmpdir(), "tina4-count-total-"));

interface Dialect { label: string; url: string | undefined; urlEnv: string; drop: string; create: string }

const DIALECTS: Dialect[] = [
  {
    label: "mssql",
    url: process.env.TINA4_TEST_MSSQL_URL,
    urlEnv: "TINA4_TEST_MSSQL_URL",
    drop: `IF OBJECT_ID('${TABLE}', 'U') IS NOT NULL DROP TABLE ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id INT IDENTITY(1,1) PRIMARY KEY, n INT NOT NULL)`,
  },
  {
    label: "mysql",
    url: process.env.TINA4_TEST_MYSQL_URL,
    urlEnv: "TINA4_TEST_MYSQL_URL",
    drop: `DROP TABLE IF EXISTS ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, n INT NOT NULL)`,
  },
  {
    label: "postgres",
    url: process.env.TINA4_TEST_PG_URL,
    urlEnv: "TINA4_TEST_PG_URL",
    drop: `DROP TABLE IF EXISTS ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, n integer NOT NULL)`,
  },
  {
    label: "sqlite",
    url: `sqlite:///${join(sqliteDir, "count.db")}`,
    urlEnv: "",
    drop: `DROP TABLE IF EXISTS ${TABLE}`,
    create: `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL)`,
  },
];

async function runDialect(d: Dialect): Promise<void> {
  console.log(`\n--- ${d.label} ---`);
  if (!d.url) {
    skip(`${d.label}: fetch count total`, `[needs:${d.label}] ${d.urlEnv} not set, ${d.label} not reachable`);
    return;
  }
  const db = await Database.create(d.url);
  try {
    await db.execute(d.drop);
    await db.execute(d.create);
    for (let i = 1; i <= ROWS; i++) await db.execute(`INSERT INTO ${TABLE} (n) VALUES (?)`, [i]);

    // 22 rows match (n > 3); ask for the second page of 10.
    const page = await db.fetch(`SELECT id, n FROM ${TABLE} WHERE n > ?`, [3], 10, 10);
    assert(`${d.label}: fetch_total_is_the_filter_total_not_the_page_length`,
      page.records.length === 10 && page.count === 22,
      `records=${page.records.length} count=${page.count} (expected 10 of 22)`);

    const ordered = await db.fetch(`SELECT id, n FROM ${TABLE} WHERE n > ? ORDER BY n DESC`, [3], 10, 0);
    const firstN = Number((ordered.records[0] as Record<string, unknown> | undefined)?.n);
    assert(`${d.label}: fetch_total_with_order_by_is_the_filter_total`,
      ordered.records.length === 10 && ordered.count === 22 && firstN === ROWS,
      `records=${ordered.records.length} count=${ordered.count} first n=${firstN} (expected 10 of 22, first ${ROWS})`);

    const none = await db.fetch(`SELECT id, n FROM ${TABLE} WHERE n > ?`, [1000], 10, 0);
    assert(`${d.label}: fetch_total_is_zero_when_nothing_matches`, none.records.length === 0 && none.count === 0,
      `records=${none.records.length} count=${none.count}`);
  } finally {
    try { await db.execute(d.drop); } catch { /* best effort */ }
    db.close();
  }
}

console.log("=== db.fetch() total is the filter total on every engine ===\n\n--- count_probe_strips_only_a_trailing_top_level_order_by ---");
const STRIP_CASES: Array<[string, string]> = [
  ["SELECT * FROM t ORDER BY a DESC", "SELECT * FROM t"],
  ["SELECT * FROM t WHERE a IN (SELECT a FROM u ORDER BY a) ", "SELECT * FROM t WHERE a IN (SELECT a FROM u ORDER BY a) "],
  ["SELECT * FROM t ORDER BY a OFFSET 5 ROWS", "SELECT * FROM t ORDER BY a OFFSET 5 ROWS"],
  ["SELECT * FROM t WHERE note = 'x ORDER BY y'", "SELECT * FROM t WHERE note = 'x ORDER BY y'"],
  ["SELECT * FROM t -- ORDER BY a", "SELECT * FROM t -- ORDER BY a"],
];
const strip = (SQLTranslator as unknown as { stripTrailingOrderBy?: (sql: string) => string }).stripTrailingOrderBy;
for (const [sql, expected] of STRIP_CASES) {
  const got = typeof strip === "function" ? strip(sql) : "<SQLTranslator.stripTrailingOrderBy missing>";
  assert(`count_probe_strips_only_a_trailing_top_level_order_by: ${JSON.stringify(sql)}`, got === expected, `got ${JSON.stringify(got)}`);
}
for (const d of DIALECTS) {
  try {
    await runDialect(d);
  } catch (err) {
    assert(`${d.label}: suite ran without error`, false, (err as Error).stack ?? String(err));
  }
}
try { rmSync(sqliteDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

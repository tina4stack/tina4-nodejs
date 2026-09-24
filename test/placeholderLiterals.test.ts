/**
 * `?` placeholders are translated ONLY outside literals, quoted identifiers and
 * comments; a literal `%` works with or without parameters
 * (tina4-python#138 parity).
 *
 * THE PYTHON DEFECT: `?` -> `%s` was a plain text replace, so a `?` inside a
 * string literal became a placeholder, and psycopg read every literal `%` as a
 * placeholder once parameters were passed - and fetch() always passes its
 * LIMIT/OFFSET, so `LIKE 'abc%'` failed everywhere.
 *
 * THE NODE DEFECT: PostgreSQL (`?` -> `$n`) and SQL Server (`?` -> `@pN`) were
 * plain text replaces in the adapters, and MySQL handed `?` to mysql2's
 * client-side formatter, which substitutes every `?` in the text. So
 * `SELECT 'why?' AS v, ? AS n` bound its parameter INTO the literal and left
 * the real marker unbound. (`%` is not special to pg, tedious or mysql2, so the
 * literal-% cases are lock-ins here.) SQLite and Firebird bind `?` in the
 * engine itself and are controls.
 *
 * NO MOCKS: real PostgreSQL, MySQL, SQL Server, Firebird and a real SQLite file.
 *
 * Same case names in all four frameworks:
 *   - literal_percent_without_params
 *   - like_literal_percent_with_a_param
 *   - question_mark_in_a_string_literal
 *   - execute_literal_percent_with_a_param
 *   - pattern_passed_as_a_param
 *   - question_mark_in_a_line_comment
 *   - question_mark_in_a_block_comment
 *   - question_mark_in_a_quoted_identifier
 *   - question_mark_in_a_dollar_quoted_string (PostgreSQL)
 *   - question_mark_in_an_escape_string (PostgreSQL E'...', MySQL backslash)
 *   - placeholder_scanner (pure function)
 *   - parameterless_sql_is_sent_as_written (PostgreSQL jsonb ?, ?| and ?&)
 *   - with_params_every_question_mark_is_a_placeholder (PostgreSQL)
 *   - jsonb_exists_works_with_a_param (PostgreSQL)
 *
 * SQL WITH NO PARAMETERS IS SENT EXACTLY AS WRITTEN (cross-framework contract):
 * with nothing to bind there is no rewrite, so PostgreSQL's jsonb operators
 * `?`, `?|` and `?&` work in a parameterless query. With parameters every `?`
 * outside a literal is a placeholder; use jsonb_exists()/_any()/_all() then.
 *
 * Run with: npx tsx test/placeholderLiterals.test.ts
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

// ── Pure scanner cases ─────────────────────────────────────────────────────
console.log("=== ? placeholders outside literals only (tina4-python#138 parity) ===\n\n--- placeholder_scanner ---");
const replace = (SQLTranslator as unknown as {
  replacePlaceholders?: (sql: string, m: (i: number) => string, o?: { backslashEscapes?: boolean }) => string;
}).replacePlaceholders;
const SCAN: Array<[string, string, boolean?]> = [
  ["SELECT 'why?' AS v, ? AS n", "SELECT 'why?' AS v, $1 AS n"],
  ["SELECT ? -- why?\n, ?", "SELECT $1 -- why?\n, $2"],
  ["SELECT /* what? */ ?", "SELECT /* what? */ $1"],
  ['SELECT 1 AS "why?", ?', 'SELECT 1 AS "why?", $1'],
  ["SELECT 1 AS `why?`, ?", "SELECT 1 AS `why?`, $1"],
  ["SELECT $$why? it's$$, ?", "SELECT $$why? it's$$, $1"],
  ["SELECT $fn$ a ? b $fn$, ?", "SELECT $fn$ a ? b $fn$, $1"],
  ["SELECT E'it\\'s ?', ?", "SELECT E'it\\'s ?', $1"],
  ["SELECT 'it''s ?', ?", "SELECT 'it''s ?', $1"],
  ["SELECT 'it\\'s ?', ?", "SELECT 'it\\'s ?', $1", true],
  ["WHERE a = ? AND b = ?", "WHERE a = $1 AND b = $2"],
];
for (const [sql, expected, backslash] of SCAN) {
  const got = typeof replace === "function"
    ? replace(sql, (i) => `$${i + 1}`, { backslashEscapes: backslash === true })
    : "<SQLTranslator.replacePlaceholders missing>";
  assert(`placeholder_scanner: ${JSON.stringify(sql)}`, got === expected, `got ${JSON.stringify(got)}`);
}
{
  let got = "";
  try { got = SQLTranslator.placeholderStyle("SELECT 'a%' WHERE x = ? AND y = 'why?'", "%s"); } catch (e) { got = String(e); }
  assert("placeholder_scanner: placeholderStyle %s doubles a literal % and skips a ? in a literal",
    got === "SELECT 'a%%' WHERE x = %s AND y = 'why?'", `got ${JSON.stringify(got)}`);
}

// ── Live engines ─────────────────────────────────────────────────────────────
const sqliteDir = mkdtempSync(join(tmpdir(), "tina4-placeholders-"));

interface Dialect {
  label: string;
  url: string | undefined;
  urlEnv: string;
  from: string;
  int: string;
  quotedIdent: string;
  extra?: Array<{ name: string; sql: string; params: unknown[]; v: string; n: number }>;
}

const DIALECTS: Dialect[] = [
  {
    label: "postgres", url: process.env.TINA4_TEST_PG_URL, urlEnv: "TINA4_TEST_PG_URL",
    from: "", int: "INTEGER", quotedIdent: '"why?"',
    extra: [
      { name: "question_mark_in_a_dollar_quoted_string", sql: "SELECT $$why? not$$ AS v, CAST(? AS INTEGER) AS n", params: [9], v: "why? not", n: 9 },
      { name: "question_mark_in_an_escape_string", sql: "SELECT E'it\\'s ?' AS v, CAST(? AS INTEGER) AS n", params: [10], v: "it's ?", n: 10 },
    ],
  },
  {
    label: "mysql", url: process.env.TINA4_TEST_MYSQL_URL, urlEnv: "TINA4_TEST_MYSQL_URL",
    from: " FROM DUAL", int: "SIGNED", quotedIdent: "`why?`",
    extra: [
      { name: "question_mark_in_an_escape_string", sql: "SELECT 'it\\'s ?' AS v, CAST(? AS SIGNED) AS n", params: [10], v: "it's ?", n: 10 },
    ],
  },
  {
    label: "mssql", url: process.env.TINA4_TEST_MSSQL_URL, urlEnv: "TINA4_TEST_MSSQL_URL",
    from: "", int: "INTEGER", quotedIdent: '"why?"',
  },
  {
    label: "firebird", url: process.env.TINA4_TEST_FIREBIRD_URL, urlEnv: "TINA4_TEST_FIREBIRD_URL",
    from: " FROM RDB$DATABASE", int: "INTEGER", quotedIdent: '"why?"',
  },
  {
    label: "sqlite", url: `sqlite:///${join(sqliteDir, "p.db")}`, urlEnv: "",
    from: "", int: "INTEGER", quotedIdent: '"why?"',
  },
];

/** Case-insensitive column read (Firebird folds to upper case). */
function col(row: unknown, name: string): unknown {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const key = Object.keys(r).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : r[key];
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try { return { value: await fn() }; } catch (e) {
    const message = String((e as Error)?.message || e || "threw").split("\n")[0];
    return { error: message || "threw" };
  }
}

async function runDialect(d: Dialect): Promise<void> {
  console.log(`\n--- ${d.label} ---`);
  if (!d.url) {
    skip(`${d.label}: placeholder literals`, `${d.urlEnv} not set, ${d.label} not reachable`);
    return;
  }
  const db = await Database.create(d.url);
  const L = d.label;
  const trimmed = (v: unknown) => String(v ?? "").trimEnd();
  try {
    const r1 = await attempt(() => db.fetch(`SELECT 'a%' AS v${d.from}`, [], 5));
    assert(`${L}: literal_percent_without_params`, !r1.error && trimmed(col(r1.value!.records[0], "v")) === "a%",
      r1.error ?? JSON.stringify(r1.value!.records));

    const r2 = await attempt(() => db.fetch(`SELECT 'abc' AS v${d.from} WHERE 'abc' LIKE 'a%' AND 1 = ?`, [1], 5));
    assert(`${L}: like_literal_percent_with_a_param`, !r2.error && r2.value!.records.length === 1,
      r2.error ?? JSON.stringify(r2.value!.records));

    const r3 = await attempt(() => db.fetchOne(`SELECT 'why?' AS v, CAST(? AS ${d.int}) AS n${d.from}`, [1]));
    assert(`${L}: question_mark_in_a_string_literal`,
      !r3.error && trimmed(col(r3.value, "v")) === "why?" && Number(col(r3.value, "n")) === 1,
      r3.error ?? JSON.stringify(r3.value));

    const r4 = await attempt(() => db.execute(`SELECT 'a%' AS v${d.from} WHERE 1 = ?`, [1]));
    assert(`${L}: execute_literal_percent_with_a_param`, !r4.error, r4.error ?? "");

    const r5 = await attempt(() => db.fetch(`SELECT 'abc' AS v${d.from} WHERE 'abc' LIKE ?`, ["a%"], 5));
    assert(`${L}: pattern_passed_as_a_param`, !r5.error && r5.value!.records.length === 1,
      r5.error ?? JSON.stringify(r5.value!.records));

    const r6 = await attempt(() => db.fetchOne(`SELECT CAST(? AS ${d.int}) AS n${d.from} -- is it?\n`, [7]));
    assert(`${L}: question_mark_in_a_line_comment`, !r6.error && Number(col(r6.value, "n")) === 7,
      r6.error ?? JSON.stringify(r6.value));

    const r7 = await attempt(() => db.fetchOne(`SELECT /* what? */ CAST(? AS ${d.int}) AS n${d.from}`, [8]));
    assert(`${L}: question_mark_in_a_block_comment`, !r7.error && Number(col(r7.value, "n")) === 8,
      r7.error ?? JSON.stringify(r7.value));

    const r8 = await attempt(() => db.fetchOne(`SELECT 1 AS ${d.quotedIdent}, CAST(? AS ${d.int}) AS n${d.from}`, [11]));
    assert(`${L}: question_mark_in_a_quoted_identifier`, !r8.error && Number(col(r8.value, "n")) === 11,
      r8.error ?? JSON.stringify(r8.value));

    for (const x of d.extra ?? []) {
      const r = await attempt(() => db.fetchOne(x.sql, x.params));
      assert(`${L}: ${x.name}`, !r.error && trimmed(col(r.value, "v")) === x.v && Number(col(r.value, "n")) === x.n,
        r.error ?? JSON.stringify(r.value));
    }
  } finally {
    db.close();
  }
}

async function runParameterless(): Promise<void> {
  const url = process.env.TINA4_TEST_PG_URL;
  console.log("\n--- postgres: parameterless SQL ---");
  if (!url) {
    skip("postgres: parameterless_sql_is_sent_as_written", "TINA4_TEST_PG_URL not set, postgres not reachable");
    return;
  }
  const db = await Database.create(url);
  try {
    const one = await attempt(() => db.fetchOne(`SELECT '{"a":1}'::jsonb ? 'a' AS has`));
    assert("postgres: parameterless_sql_is_sent_as_written (jsonb ? via fetchOne)",
      !one.error && col(one.value, "has") === true, one.error ?? JSON.stringify(one.value));

    const ops = await attempt(() => db.fetch(
      `SELECT '{"a":1,"b":2}'::jsonb ?| array['a','z'] AS any_key, '{"a":1,"b":2}'::jsonb ?& array['a','b'] AS all_keys`));
    const row = ops.value?.records[0];
    assert("postgres: parameterless_sql_is_sent_as_written (jsonb ?| and ?& via fetch)",
      !ops.error && col(row, "any_key") === true && col(row, "all_keys") === true, ops.error ?? JSON.stringify(row));

    const run = await attempt(() => db.execute(`SELECT '{"a":1}'::jsonb ? 'a' AS has`));
    assert("postgres: parameterless_sql_is_sent_as_written (jsonb ? via execute)", !run.error, run.error ?? "");

    const bound = await attempt(() => db.fetchOne(`SELECT '{"a":1}'::jsonb ? 'a' AS has, CAST(? AS INTEGER) AS n`, [1]));
    assert("postgres: with_params_every_question_mark_is_a_placeholder",
      !!bound.error, `expected the jsonb ? to be bound as a second placeholder; got ${JSON.stringify(bound.value)}`);

    const exists = await attempt(() => db.fetchOne(`SELECT jsonb_exists('{"a":1}'::jsonb, ?) AS has`, ["a"]));
    assert("postgres: jsonb_exists_works_with_a_param", !exists.error && col(exists.value, "has") === true,
      exists.error ?? JSON.stringify(exists.value));
  } finally {
    db.close();
  }
}

try {
  await runParameterless();
} catch (err) {
  assert("postgres: parameterless suite ran without error", false, (err as Error).stack ?? String(err));
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

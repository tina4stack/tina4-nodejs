/**
 * The batch-write contract (feature 3 of the feature audit).
 *
 * `test/fixtures/batch_write_contract.json` is byte-identical in all four
 * frameworks and is the shared answer key: the same cases, the same engine
 * parameter caps, the same rejections, checked identically in python, php, ruby
 * and node.
 *
 * A batch that loops one INSERT per row pays a full network round-trip per row.
 * Measured over 500 rows on the .99 host: PostgreSQL 9848ms row-at-a-time
 * against 15.8ms as one multi-row VALUES (625x), MySQL 216x, MSSQL 121x.
 *
 * The chunking rules are PURE, so they are checked here without a database. The
 * live-engine half of the contract lives in the write-path runner, which proves
 * the rows actually land - a faster batch that writes the wrong rows is a bug,
 * not an optimisation.
 *
 * Run with: npx tsx test/batchWriteContract.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLTranslator } from "../packages/orm/src/sqlTranslator.js";

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(here, "fixtures", "batch_write_contract.json"), "utf-8"));

let pass = 0;
let fail = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function rows(count: number, columns: number): unknown[][] {
  return Array.from({ length: count }, (_r, r) =>
    Array.from({ length: columns }, (_c, c) => `v${r}c${c}`),
  );
}

console.log("--- every case in the shared fixture ---");
for (const kase of contract.cases) {
  const statements = SQLTranslator.buildBatchInserts(
    kase.sql,
    rows(kase.rows, kase.columns),
    kase.engine,
  );
  const want = kase.expect.statements;
  assert(
    `${kase.name}: ${want} statement(s)`,
    statements.length === want,
    `got ${statements.length}`,
  );
  if (want === 0) continue;

  const [firstSql, firstParams] = statements[0];
  const tuples = (firstSql.match(/\(/g) ?? []).length - 1;
  assert(
    `${kase.name}: first carries ${kase.expect.rows_in_first} rows`,
    tuples === kase.expect.rows_in_first,
    `got ${tuples}`,
  );
  assert(
    `${kase.name}: first binds ${kase.expect.params_in_first} params`,
    firstParams.length === kase.expect.params_in_first &&
      (firstSql.match(/\?/g) ?? []).length === kase.expect.params_in_first,
    `got ${firstParams.length}`,
  );
}

// The caps are a real engine limit, not a tunable. MSSQL's 2100 is the tightest
// and is what makes chunking mandatory.
console.log("\n--- the engine caps match the shared fixture ---");
for (const [engine, cap] of Object.entries(contract.max_bind_params)) {
  if (engine.startsWith("_")) continue;
  assert(
    `${engine} cap is ${cap}`,
    SQLTranslator.MAX_BIND_PARAMS[engine] === cap,
    `got ${SQLTranslator.MAX_BIND_PARAMS[engine]}`,
  );
}

// Exceeding the cap is a hard error on a real engine, so check exhaustively
// rather than at the two boundaries the fixture names.
console.log("\n--- no chunk ever exceeds the engine cap ---");
let capOk = true;
let capDetail = "";
for (const [engine, cap] of Object.entries(SQLTranslator.MAX_BIND_PARAMS)) {
  if (cap <= 0) continue;
  for (let columns = 1; columns <= 11; columns++) {
    const cols = Array.from({ length: columns }, (_c, i) => `c${i}`).join(", ");
    const marks = new Array(columns).fill("?").join(", ");
    const sql = `INSERT INTO t (${cols}) VALUES (${marks})`;
    for (const [, params] of SQLTranslator.buildBatchInserts(sql, rows(1500, columns), engine)) {
      if (params.length > cap) {
        capOk = false;
        capDetail = `${engine}/${columns}col had ${params.length}, cap ${cap}`;
      }
    }
  }
}
assert("every chunk stays within its engine cap", capOk, capDetail);

// Chunk boundaries are the risk: a batch spanning several statements must still
// flatten to exactly the original sequence of values.
console.log("\n--- rows and values survive the collapse in order ---");
{
  const source = rows(701, 3);
  const statements = SQLTranslator.buildBatchInserts(
    "INSERT INTO t (a, b, c) VALUES (?, ?, ?)",
    source,
    "mssql",
  );
  assert("this case actually chunks", statements.length > 1, `got ${statements.length}`);
  const flat = statements.flatMap(([, params]) => params);
  const expected = source.flat();
  assert(
    "every value survives, in order",
    flat.length === expected.length && flat.every((v, i) => v === expected[i]),
  );
}

// Returning empty means "keep looping", which is always correct. Collapsing one
// of these would silently change what the batch writes.
console.log("\n--- negative: the fixture's rejected shapes never collapse ---");
const samples: Record<string, [string, number, number]> = {
  RETURNING: ["INSERT INTO t (a) VALUES (?) RETURNING *", 1, 10],
  "ON CONFLICT": ["INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO NOTHING", 1, 10],
  "ON DUPLICATE KEY": ["INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE a = a", 1, 10],
  not_an_insert: ["UPDATE t SET a = ? WHERE b = ?", 2, 10],
  literal_in_values: ["INSERT INTO t (a, b) VALUES (?, now())", 1, 10],
  single_row: ["INSERT INTO t (a) VALUES (?)", 1, 1],
};
for (const reason of Object.keys(contract.collapsible.rejected)) {
  if (reason.startsWith("_")) continue;
  if (reason === "ragged_params") {
    assert(
      "ragged_params never collapses",
      SQLTranslator.buildBatchInserts(
        "INSERT INTO t (a, b) VALUES (?, ?)",
        [["a", "b"], ["c"]],
        "postgres",
      ).length === 0,
    );
    continue;
  }
  const [sql, columns, count] = samples[reason];
  assert(
    `${reason} never collapses`,
    SQLTranslator.buildBatchInserts(sql, rows(count, columns), "postgres").length === 0,
  );
}

// Firebird has no multi-row VALUES syntax - verified against a live 5.0.4
// (-104 Token unknown). Collapsing there emits SQL the engine cannot parse.
console.log("\n--- negative: engines that must keep the loop ---");
for (const engine of ["firebird", "odbc", "mongodb"]) {
  assert(
    `${engine} keeps the row-at-a-time loop`,
    SQLTranslator.buildBatchInserts(
      "INSERT INTO t (a, b, c) VALUES (?, ?, ?)",
      rows(100, 3),
      engine,
    ).length === 0,
  );
}
assert(
  "an unknown engine falls back rather than guessing a cap",
  SQLTranslator.buildBatchInserts("INSERT INTO t (a) VALUES (?)", rows(10, 1), "some_new_engine")
    .length === 0,
);

// The drift that made this optimisation a no-op on PostgreSQL: Python and PHP
// report "postgresql" while Ruby and Node report "postgres". Reading the cap
// table without normalising misses, the cap comes back 0, and the batch silently
// keeps looping - on the engine with the largest measured win. A live run caught
// it; this pins it.
console.log("\n--- engine aliases resolve to the same cap ---");
for (const [alias, canonical] of Object.entries(contract.engine_aliases)) {
  if (alias.startsWith("_")) continue;
  assert(`${alias} -> ${canonical}`, SQLTranslator.ENGINE_ALIASES[alias] === canonical);
  const sql = "INSERT INTO t (a, b, c) VALUES (?, ?, ?)";
  const source = rows(10, 3);
  assert(
    `${alias} produces the same statements as ${canonical}`,
    JSON.stringify(SQLTranslator.buildBatchInserts(sql, source, alias)) ===
      JSON.stringify(SQLTranslator.buildBatchInserts(sql, source, canonical as string)),
  );
}
{
  // Node's own dbType is "postgres", but the other three report "postgresql" and
  // the shared rule must hold for both spellings or the fixture is not shared.
  const statements = SQLTranslator.buildBatchInserts(
    "INSERT INTO t (a, b, c) VALUES (?, ?, ?)",
    rows(50, 3),
    "postgresql",
  );
  assert("postgresql spelled in full still collapses", statements.length === 1);
  assert("and binds every value", statements[0]?.[1].length === 150);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

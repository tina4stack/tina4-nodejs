/**
 * Firebird identifier folding (regression).
 *
 * Firebird folds an UNQUOTED identifier to UPPER CASE and treats a QUOTED one as
 * case-sensitive. The insert path used to interpolate the raw name into quotes --
 * `INSERT INTO "probe_t" ("id", "name")` -- which matches nothing after the
 * ordinary `CREATE TABLE probe_t`, so every insert against a conventionally
 * created table failed with "Table unknown". Columns were broken the same way.
 *
 * Found by running the Python master against a live Firebird 5.0.4 and then
 * checking the other three; PHP and Ruby interpolate the table name UNQUOTED and
 * were never affected, Node was.
 */
import { fbQuote } from "../packages/orm/src/adapters/firebird.ts";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  PASS ${name}`); passed++; }
  else { console.log(`  FAIL ${name} ${detail}`); failed++; }
}

console.log("\n--- Firebird identifier folding ---");

// THE bug: "probe_t" matched nothing because Firebird stored PROBE_T.
assert('a plain name is upper-cased', fbQuote("probe_t") === '"PROBE_T"', `got ${fbQuote("probe_t")}`);
assert('an already-upper name is unchanged', fbQuote("ORDERS") === '"ORDERS"', `got ${fbQuote("ORDERS")}`);

// The escape hatch for a genuinely case-sensitive CREATE TABLE "orders".
assert('an already-quoted name passes through', fbQuote('"orders"') === '"orders"', `got ${fbQuote('"orders"')}`);

// Negative half: an empty name must not become a stray pair of quotes.
assert('an empty name stays empty', fbQuote("") === "", `got ${fbQuote("")}`);

// An embedded quote is escaped by doubling, so the SQL cannot be broken out of.
assert('an embedded quote is doubled', fbQuote('we"ird') === '"WE""IRD"', `got ${fbQuote('we"ird')}`);

console.log(`\n  Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

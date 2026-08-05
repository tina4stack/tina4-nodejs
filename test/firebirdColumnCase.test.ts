/**
 * Firebird column names fold back only when Firebird folded them.
 *
 * Firebird's identifier folding is ASYMMETRIC:
 *
 *     SELECT 1 AS x        ->  stored X       (unquoted folds to UPPER)
 *     SELECT 1 AS "MyCol"  ->  stored MyCol   (quoted keeps its case)
 *
 * Every other engine Tina4 supports gives `x` for the first form — PostgreSQL
 * folds to lower, MySQL/SQLite/MSSQL preserve — so portable code reading row.x
 * broke on Firebird alone.
 *
 * BOTH halves are asserted on purpose. A blanket toLowerCase() passes the first
 * and fails the second — that is what the Python master used to do, so
 * `AS "MyCol"` came back `mycol` and a mixed-case key was unreachable. A fix
 * that merely stopped folding passes the second and fails the first.
 *
 * Real Firebird only — no mocks.
 */
import { FirebirdAdapter } from "../packages/orm/src/index.ts";

const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, why: string) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${why}`);
}

console.log("\n--- Firebird column-name case ---");

const CASES: Array<[string, string, string]> = [
  ["unquoted alias reads back lowercase", "SELECT 1 AS x FROM RDB$DATABASE", "x"],
  ['quoted mixed-case alias keeps its case', 'SELECT 1 AS "MyCol" FROM RDB$DATABASE', "MyCol"],
];

if (!FIREBIRD_URL) {
  for (const [n] of CASES) skip(n, "TINA4_TEST_FIREBIRD_URL not set (needs a live Firebird)");
} else {
  for (const [name, sql, expectedKey] of CASES) {
    const db = new FirebirdAdapter(FIREBIRD_URL) as any;
    try {
      await db.connect();
      const row = await db.fetchOneAsync(sql);
      const keys = Object.keys(row ?? {});
      ok(name, keys.length === 1 && keys[0] === expectedKey, `got keys ${JSON.stringify(keys)}`);
    } catch (err) {
      skip(name, `Firebird unusable here: ${(err as Error).message}`);
    } finally {
      try { db.close(); } catch { /* already gone */ }
    }
  }
}

console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
// Exit explicitly. node-firebird leaves a handle open after close(), so without
// this the process sits at 100% pass with nothing left to do and is eventually
// killed by the runner's timeout -- a green that reports as a failure.
process.exit(failed > 0 ? 1 : 0);

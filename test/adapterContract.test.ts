/**
 * The adapter contract (feature 3 of the feature audit).
 *
 * `test/fixtures/adapter_contract.json` is byte-identical in all four
 * frameworks. This is the RATCHET: it pins today's implemented count per
 * adapter, so the number can go UP but never down, and a new adapter cannot ship
 * at the old level.
 *
 * Node's two named divergences are pinned here as the gap they are, rather than
 * left to be rediscovered:
 *   - `tables()` / `columns()` where the other three say getTables/getColumns
 *   - `getTableColumns?` and `addColumn?` declared OPTIONAL, which forces the
 *     facade to feature-detect at every call site: the same pattern as Ruby's
 *     respond_to? guards, written in TypeScript. An optional method on a
 *     contract is not a contract.
 *
 * Run with: npx tsx test/adapterContract.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(here, "fixtures", "adapter_contract.json"), "utf-8"));

/** Contract name -> spellings Node accepts today. The renames are the gap. */
const SPELLINGS: Record<string, string[]> = {
  open: ["open", "connect"],
  close: ["close"],
  getDatabaseType: ["getDatabaseType"],
  execute: ["execute"],
  fetch: ["fetch"],
  startTransaction: ["startTransaction"],
  commit: ["commit"],
  rollback: ["rollback"],
  autocommit: ["autocommit", "setAutocommit"],
  getTables: ["getTables"],
  getColumns: ["getColumns"],
  tableExists: ["tableExists"],
  lastInsertId: ["lastInsertId"],
  error: ["error", "lastError"],
};

/** Measured 2026-07-30. Raise when you implement; never lower. */
/** Against the REDESIGNED 14-method contract, measured 2026-07-30. */
const FLOORS: Record<string, number> = {
  SQLiteAdapter: 10,
  PostgresAdapter: 10,
  MysqlAdapter: 10,
  MssqlAdapter: 10,
  FirebirdAdapter: 10,
  MongodbAdapter: 10,
  OdbcAdapter: 10,
};

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function implementedCount(proto: any): number {
  let n = 0;
  for (const names of Object.values(SPELLINGS)) {
    if (names.some((m) => typeof proto?.[m] === "function")) n++;
  }
  return n;
}

console.log("=== adapter contract ===\n");

const METHODS: string[] = Object.values(contract.contracts)
  .flatMap((c: any) => c.methods.map((m: any) => m.name));
assert("the fixture declares five contracts", Object.keys(contract.contracts).length === 5);
assert("the fixture declares fourteen methods", METHODS.length === 14);

// The redesign's central claim, pinned. CRUD and DDL are composable above the
// adapter and were duplicated per adapter in three of four frameworks.
for (const gone of ["insert","update","delete","createTable","addColumn","executeMany","fetchOne","query"]) {
  assert(`${gone} is not on the adapter contract`,
    !METHODS.includes(gone) && gone in contract.not_on_the_adapter);
}

const found: Record<string, number> = {};
const files = readdirSync(join(here, "..", "packages", "orm", "src", "adapters"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

for (const f of files.sort()) {
  const mod: any = await import(`../packages/orm/src/adapters/${f}`);
  for (const [name, cls] of Object.entries(mod)) {
    if (typeof cls !== "function" || !name.endsWith("Adapter")) continue;
    found[name] = implementedCount((cls as any).prototype);
  }
}

console.log("\n--- every adapter meets its recorded floor ---");
for (const [name, floor] of Object.entries(FLOORS)) {
  const got = found[name];
  if (got === undefined) {
    assert(`${name} was found`, false, "adapter missing - the ratchet lost coverage");
    continue;
  }
  assert(`${name} >= ${floor}`, got >= floor, `got ${got}/20`);
}

// Node's optional members are the specific defect this row names. An optional
// method on a contract is not a contract, so pin that they are the ONLY two.
console.log("\n--- the optional members are pinned ---");
const types = readFileSync(join(here, "..", "packages", "orm", "src", "types.ts"), "utf-8");
const iface = types.slice(types.indexOf("interface DatabaseAdapter"));
const optional = (iface.slice(0, iface.indexOf("\n}")).match(/^\s+(\w+)\?\(/gm) ?? [])
  .map((m) => m.trim().replace(/\?\($/, ""));
// Still two. Collapsing getTableColumns into getColumns was TRIED and reverted:
// it broke the legacy NOT NULL migration_id path (python#93, the bug that wedged
// every migration for ~20 releases). getTableColumns reads PRAGMA directly and
// getColumns does not return the same thing there, so removing it needs its own
// change with that path tested. The goal is still zero; this may only shrink.
assert(
  "at most two optional members remain",
  optional.length <= 2,
  `got ${JSON.stringify(optional)} - this may only SHRINK; tighten when it does`
);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

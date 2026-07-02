/**
 * Regression: a route path param extracted by the REAL router must bind through
 * a REAL SQLite database and match an INTEGER primary-key column.
 *
 * Background (cross-framework parity): tina4-ruby had a bug where a path capture
 * like `{id}`, extracted from a real HTTP request, arrived as an ASCII-8BIT
 * (binary) string and bound to SQLite as a BLOB, so `WHERE id = ?` never matched
 * an INTEGER PK row and `GET /api/users/{id}` returned 404 for a row that exists.
 * Node.js strings are UTF-16 internally (no byte-encoding), so the untyped param
 * binds as TEXT and SQLite coerces it to the column's INTEGER affinity. Node does
 * NOT have the bug; this locks that in.
 *
 * Plain-tsx test (run by test/run-all.ts via `npx tsx`), NOT vitest. No mocks:
 * real Router.match() extraction + a real node:sqlite database via initDatabase().
 * Run with: npx tsx test/routerPathParamPk.test.ts
 */
import { Router } from "../packages/core/src/index.ts";
import { initDatabase, closeDatabase, type Database } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const db: Database = await initDatabase({ url: "sqlite:///:memory:" });
await db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
await db.execute("INSERT INTO users (id, name) VALUES (1, 'Alice')");
await db.execute("INSERT INTO users (id, name) VALUES (2, 'Bob')");
await db.execute("INSERT INTO users (id, name) VALUES (3, 'Carol')");

// --- untyped {id}: a plain JS string that matches the INTEGER PK ---
const rUntyped = new Router();
rUntyped.get("/users/{id}", async () => {});
const mUntyped = rUntyped.match("GET", "/users/2");
assert("router matches /users/{id}", mUntyped !== null);
const idUntyped = mUntyped?.params["id"];
assert("untyped {id} is a plain JS string", typeof idUntyped === "string", `typeof=${typeof idUntyped}`);
assert("untyped {id} is not a Buffer/typed array", !Buffer.isBuffer(idUntyped));
const rowU = await db.fetchOne<{ id: number; name: string }>(
  "SELECT id, name FROM users WHERE id = ?",
  [idUntyped],
);
assert(
  "untyped string param matches INTEGER PK (numeric affinity)",
  rowU != null && rowU.id === 2 && rowU.name === "Bob",
  JSON.stringify(rowU),
);

// --- typed {id:int}: a JS number that matches ---
const rInt = new Router();
rInt.get("/users/{id:int}", async () => {});
const mInt = rInt.match("GET", "/users/3");
const idInt = mInt?.params["id"];
assert("typed {id:int} is a JS number", typeof idInt === "number" && idInt === 3, `typeof=${typeof idInt} val=${String(idInt)}`);
const rowI = await db.fetchOne<{ id: number; name: string }>(
  "SELECT id, name FROM users WHERE id = ?",
  [idInt],
);
assert("typed int param matches INTEGER PK", rowI != null && rowI.id === 3 && rowI.name === "Carol", JSON.stringify(rowI));

// --- negative control: a missing id must not false-match ---
const missing = rUntyped.match("GET", "/users/999")?.params["id"];
const rowMissing = await db.fetchOne("SELECT id FROM users WHERE id = ?", [missing]);
assert("non-existent id returns no row (not a false match)", rowMissing == null, JSON.stringify(rowMissing));

try { closeDatabase(); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

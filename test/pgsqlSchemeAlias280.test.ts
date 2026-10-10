/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Parity lock for tina4-php#280: the pgsql:// scheme (and every documented
 * alias) resolves, and resolves to the same engine as its canonical spelling.
 *
 * Node already accepts pgsql (ENGINE_ALIASES in databaseUrl.ts); this LOCKS it
 * so it cannot silently regress the way PHP's did (the URL parser mapped pgsql
 * but Database::create refused it). DatabaseUrl is the real parser the ORM uses,
 * so asserting DatabaseUrl(url).engine locks the real path. No mocks. A
 * genuinely unknown scheme must throw, never fall through to SQLite.
 *
 * Run with: npx tsx test/pgsqlSchemeAlias280.test.ts
 */

import { DatabaseUrl } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

console.log("\npgsql:// scheme alias (#280 parity)\n");

const ALIASES: Record<string, string> = {
  sqlite: "sqlite", sqlite3: "sqlite",
  postgres: "postgres", postgresql: "postgres", pgsql: "postgres",
  mysql: "mysql", mssql: "mssql", sqlserver: "mssql", firebird: "firebird",
};

for (const [scheme, engine] of Object.entries(ALIASES)) {
  const url = scheme === "sqlite" || scheme === "sqlite3"
    ? `${scheme}:///x.db`
    : `${scheme}://user:pass@localhost:5432/db`;
  let got = "";
  try { got = new DatabaseUrl(url).engine; } catch (e) { got = `THREW:${(e as Error).message}`; }
  assert(`${scheme}:// resolves to ${engine}`, got === engine, `got ${got}`);
}

// A genuinely unknown scheme is refused, never silently SQLite.
let threw = false;
try { new DatabaseUrl("bogus://host/db"); } catch { threw = true; }
assert("an unknown scheme is refused (throws)", threw);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

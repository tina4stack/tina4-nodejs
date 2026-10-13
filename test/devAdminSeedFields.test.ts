/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Characterization + lock-in for the dev-admin seed endpoint's two pure helpers,
 * extracted from handleSeed (which had cyclomatic complexity 31):
 *   - parseSeedRequest(url, body): query string beats body, sane defaults
 *   - buildSeedFieldMap(columns, fake): column-name then SQL-type heuristic
 *
 * No mocks: a REAL orm FakeData drives the generators and REAL column arrays
 * drive the heuristic. These pin the behaviour handleSeed used to inline, so
 * the extraction is provably behaviour-preserving.
 *
 * Run with: npx tsx test/devAdminSeedFields.test.ts
 */
import { parseSeedRequest, buildSeedFieldMap } from "../packages/core/src/index.ts";
import { FakeData } from "../packages/orm/src/index.ts";

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}
const u = (q: string) => new URL(`http://localhost/__dev/api/seed${q}`);

console.log("=== parseSeedRequest ===");
{
  const d = parseSeedRequest(u(""), {});
  assert("defaults: empty table, count 10, no seed, no clear/strict",
    d.table === "" && d.count === 10 && d.seed === undefined && d.clear === false && d.strict === false,
    JSON.stringify(d));

  const q = parseSeedRequest(u("?table=users&count=25&seed=7&clear=true&strict=true"), {});
  assert("query string is read", q.table === "users" && q.count === 25 && q.seed === 7 && q.clear === true && q.strict === true,
    JSON.stringify(q));

  const both = parseSeedRequest(u("?table=fromquery"), { table: "frombody", count: 99, clear: true });
  assert("query beats body for table; body supplies the rest",
    both.table === "fromquery" && both.count === 99 && both.clear === true, JSON.stringify(both));

  assert("non-numeric count falls back to 10", parseSeedRequest(u("?count=abc"), {}).count === 10);
  assert("non-numeric seed becomes undefined", parseSeedRequest(u("?seed=abc"), {}).seed === undefined);
  assert("empty seed becomes undefined", parseSeedRequest(u("?seed="), {}).seed === undefined);
  assert("boolean body clear/strict are honoured", (() => { const x = parseSeedRequest(u(""), { clear: true, strict: true }); return x.clear && x.strict; })());
  assert("a non-\"true\" clear string does not enable", parseSeedRequest(u("?clear=1"), {}).clear === false);
}

console.log("\n=== buildSeedFieldMap ===");
{
  const fake = new FakeData(42);
  const columns = [
    { name: "id", type: "INTEGER", primaryKey: true },
    { name: "uuid", type: "TEXT", primaryKey: true },      // PK by flag, not name
    { name: "email", type: "TEXT" },
    { name: "full_name", type: "TEXT" },
    { name: "phone", type: "TEXT" },
    { name: "home_city", type: "TEXT" },
    { name: "website", type: "TEXT" },
    { name: "age", type: "INTEGER" },
    { name: "price", type: "DECIMAL(10,2)" },
    { name: "active", type: "BOOLEAN" },
    { name: "created_at", type: "DATETIME" },
    { name: "bio", type: "TEXT" },
  ];
  const map = buildSeedFieldMap(columns, fake as any);

  assert("id and primary-key columns are skipped",
    !("id" in map) && !("uuid" in map), Object.keys(map).join(","));
  assert("every non-PK column has a generator", Object.keys(map).length === 10, Object.keys(map).join(","));

  const v = (k: string) => map[k]();
  assert("email column -> an email", typeof v("email") === "string" && (v("email") as string).includes("@"));
  assert("name column -> non-empty string", typeof v("full_name") === "string" && (v("full_name") as string).length > 0);
  assert("phone column -> non-empty string", typeof v("phone") === "string" && (v("phone") as string).length > 0);
  assert("city column -> non-empty string (address)", typeof v("home_city") === "string" && (v("home_city") as string).length > 0);
  assert("website column -> a url", typeof v("website") === "string" && /^https?:\/\//.test(v("website") as string));
  assert("int type -> an integer", Number.isInteger(v("age")));
  assert("decimal type -> a number", typeof v("price") === "number");
  assert("bool type -> a boolean", typeof v("active") === "boolean");
  assert("datetime type -> defined (date)", v("created_at") !== undefined && v("created_at") !== null);
  assert("unmatched text column -> a string (sentence)", typeof v("bio") === "string" && (v("bio") as string).length > 0);

  // Reproducibility: same seed -> same first value for a column.
  assert("same seed reproduces the same value",
    buildSeedFieldMap(columns, new FakeData(42) as any)["email"]() === buildSeedFieldMap(columns, new FakeData(42) as any)["email"]());
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

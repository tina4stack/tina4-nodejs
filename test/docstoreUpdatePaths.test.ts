/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * DocStore update paths cannot reach Object.prototype.
 *
 * $set, $inc and $unset walk a dotted field path through the document. A
 * `__proto__` segment used to walk off the document onto Object.prototype, so
 * an update built from a request body - `updateOne({_id}, {$set: req.body})`
 * with `{"__proto__.isAdmin": true}` - set (or with $unset, deleted) a property
 * every object in the process inherits. MongoDB stores `__proto__` as an
 * ordinary field name; the SQLite fallback now does the same, so the update
 * lands in the document and nowhere else.
 *
 * NO MOCKS: a real SQLite-backed collection, and the witness is the real global
 * prototype plus the document read back from storage.
 */

import { SqliteDatabase } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const probe = {} as Record<string, unknown>;
const users = new SqliteDatabase(":memory:").getCollection("users");
await users.insertOne({ _id: "u1", name: "ann", profile: { role: "user" } });

const stored = async (id: string) => JSON.stringify(await users.findOne({ _id: id }));

console.log("\n--- update paths through __proto__ ---");
{
  // On a document with no __proto__ field yet, the walk starts from the document itself.
  await users.insertOne({ _id: "fresh", a: 1 });
  await users.updateOne({ _id: "fresh" }, { $unset: { "__proto__.hasOwnProperty": 1 } });
  assert("$unset __proto__.hasOwnProperty did not delete from Object.prototype",
    typeof probe.hasOwnProperty === "function");
  await users.updateOne({ _id: "fresh" }, { $set: JSON.parse('{"__proto__": {"isAdmin": true}}') });
  assert("a bare __proto__ $set is stored as a field, not as the document's prototype",
    (await stored("fresh")) === '{"_id":"fresh","a":1,"__proto__":{"isAdmin":true}}', await stored("fresh"));

  await users.updateOne({ _id: "u1" }, { $set: JSON.parse('{"__proto__.isAdmin": true}') });
  assert("$set __proto__.isAdmin did not reach Object.prototype", probe.isAdmin === undefined);

  await users.updateOne({ _id: "u1" }, { $inc: { "__proto__.count": 1 } });
  await users.updateOne({ _id: "u1" }, { $inc: { "__proto__.count": 1 } });
  assert("$inc __proto__.count did not reach Object.prototype", probe.count === undefined);


  await users.updateOne({ _id: "u1" }, { $set: { "profile.__proto__.x": 1 } });
  assert("a nested profile.__proto__.x did not reach Object.prototype", probe.x === undefined);

  // The same shape MongoDB stores for these updates: an ordinary "__proto__" field.
  const expected = '{"_id":"u1","name":"ann","profile":{"role":"user","__proto__":{"x":1}},"__proto__":{"isAdmin":true,"count":2}}';
  assert("the updates are stored as an ordinary __proto__ field, as on MongoDB",
    (await stored("u1")) === expected, await stored("u1"));

  const doc = (await users.findOne({ _id: "u1" })) as Record<string, unknown>;
  assert("the document read back keeps the plain object prototype",
    Object.getPrototypeOf(doc) === Object.prototype && doc.isAdmin === undefined);

  await users.updateMany({}, { $set: { "__proto__.many": 1 } });
  await users.updateOne({ _id: "new" }, { $set: { "__proto__.up": 1 } }, { upsert: true });
  assert("updateMany and upsert did not reach Object.prototype", probe.many === undefined && probe.up === undefined);
  assert("the upsert stored its __proto__ field", (await stored("new")) === '{"_id":"new","__proto__":{"up":1}}',
    await stored("new"));

  await users.insertOne(JSON.parse('{"_id":"raw","__proto__":{"isAdmin":true}}'));
  const raw = (await users.findOne({ _id: "raw" })) as Record<string, unknown>;
  assert("an inserted __proto__ field round-trips as a field",
    (await stored("raw")) === '{"_id":"raw","__proto__":{"isAdmin":true}}' && raw.isAdmin === undefined,
    await stored("raw"));
}

console.log("\n--- ordinary update paths still work ---");
{
  await users.updateOne({ _id: "u1" }, { $set: { "profile.role": "admin", "constructor": "c" }, $inc: { visits: 2 } });
  await users.updateOne({ _id: "u1" }, { $unset: { name: 1 } });
  const doc = (await users.findOne({ _id: "u1" })) as Record<string, any>;
  assert("a dotted $set writes the nested field", doc.profile.role === "admin");
  assert("a field named constructor is an ordinary field", doc.constructor === "c");
  assert("$inc adds", doc.visits === 2);
  assert("$unset removes", !("name" in doc));
  const proj = await users.findOne({ _id: "u1" }, JSON.parse('{"__proto__":1,"visits":1}'));
  const excl = await users.findOne({ _id: "u1" }, { profile: 0, visits: 0, constructor: 0 });
  assert("an exclusion projection keeps the __proto__ field as a field",
    JSON.stringify(excl) === '{"_id":"u1","__proto__":{"isAdmin":true,"count":2,"many":1}}', JSON.stringify(excl));
  assert("an inclusion projection returns the __proto__ field as a field",
    JSON.stringify(proj) === '{"__proto__":{"isAdmin":true,"count":2,"many":1},"visits":2,"_id":"u1"}', JSON.stringify(proj));
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

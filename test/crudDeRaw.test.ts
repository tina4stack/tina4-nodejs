/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

// The table id, form id, `required` and `checked` attributes are now emitted as
// quoted {% if %} attributes in crud/table.twig + crud/form.twig rather than
// pre-built " id=.."/" required" fragments injected with |raw. Rendered HTML
// must be unchanged, and no raw attribute-fragment key may leak into the output.
//
// Real Frond render via generateTable/generateForm — NO MOCKS.
// Run with: npx tsx test/crudDeRaw.test.ts
import { generateTable, generateForm } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

console.log("=== CRUD de-rawed attributes ===\n");

const table = generateTable([{ id: 1, name: "Alice" }], { tableName: "users", pk: "id" } as any);
assert("table carries a quoted id attribute", /<table[^>]*\sid="crud-users"/.test(table), table.slice(0, 120));
assert("no table_id_attr fragment leaks", !table.includes("table_id_attr"));

const form = generateForm(
  [
    { name: "name", type: "string", label: "Full Name", required: true },
    { name: "email", type: "string", label: "Email" },
    { name: "active", type: "boolean", label: "Active", value: true },
  ] as any,
  { action: "/api/users", method: "POST" },
);
assert("required renders on the required field", /name="name"[^>]*\srequired/.test(form));
assert("required does NOT render on the optional field", !/name="email"[^>]*\srequired/.test(form));
assert("checked renders on a truthy boolean checkbox", /type="checkbox"[^>]*\schecked/.test(form));
assert("no required_attr fragment leaks", !form.includes("required_attr"));
assert("no checked_attr fragment leaks", !form.includes("checked_attr"));

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

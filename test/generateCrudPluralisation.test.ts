/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * `generate crud` pluralisation contract — the ONE rule, shared across the four
 * frameworks. Run with: npx tsx test/generateCrudPluralisation.test.ts
 *
 * The route path, route directory and list/page template are the SINGLE plural
 * of the singular base — pluralizeReserved(toSnake(name)) — never the plural of
 * an already-pluralised table. A SQL reserved-word class (order, table pluralised
 * to `orders`) must route to `orders`, NOT `orderss`. Node derived the route from
 * the TABLE with a weaker pluralizer (`toPlural`), which diverged from
 * python/php/ruby: `Status` routed to `status` where they produce `statuses`.
 * Now every framework pluralises the singular base with the same reserved-word
 * pluralizer, so the names agree.
 *
 * No mocks: drives a REAL `tina4nodejs generate crud` subprocess in a REAL
 * mkdtemp project and reads the generated tree back. Port of the same contract
 * test in tina4-python / tina4-php / tina4-ruby.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const binPath = resolve(here, "..", "packages/cli/src/bin.ts");

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

function runCrud(cwd: string, cls: string, fields: string): { exitCode: number; stderr: string } {
  const res = spawnSync("npx", ["tsx", binPath, "generate", "crud", cls, "--fields", fields], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TINA4_NO_BROWSER: "true" },
  });
  return { exitCode: res.status ?? 1, stderr: res.stderr ?? "" };
}

function hasMigration(cwd: string, needle: string): boolean {
  const dir = join(cwd, "migrations");
  return existsSync(dir) && readdirSync(dir).some((f) => f.includes(needle) && f.endsWith(".sql"));
}

console.log("=== `generate crud` pluralisation contract ===\n");

// 1. Reserved-word class: Order -> orders, never orderss.
{
  const dir = mkdtempSync(join(tmpdir(), "tina4-crud-order-"));
  try {
    const r = runCrud(dir, "Order", "total:float");
    assert("subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    assert("route dir src/routes/api/orders exists", existsSync(join(dir, "src/routes/api/orders")));
    assert("route dir src/routes/api/orderss does NOT exist", !existsSync(join(dir, "src/routes/api/orderss")));
    const listRoute = join(dir, "src/routes/api/orders/get.ts");
    assert("orders list route written", existsSync(listRoute));
    if (existsSync(listRoute)) {
      const body = readFileSync(listRoute, "utf-8");
      assert("route body has no double-plural 'orderss'", !body.includes("orderss"), body.slice(0, 300));
    }

    assert("template pages/orders.twig exists", existsSync(join(dir, "src/templates/pages/orders.twig")));
    assert("template pages/orderss.twig does NOT exist", !existsSync(join(dir, "src/templates/pages/orderss.twig")));

    assert("model src/models/Order.ts exists", existsSync(join(dir, "src/models/Order.ts")));
    assert("migration create_orders exists", hasMigration(dir, "create_orders"));
    assert("migration create_orderss does NOT exist", !hasMigration(dir, "create_orderss"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Plain class: Product -> products (once); table stays singular (create_product).
{
  const dir = mkdtempSync(join(tmpdir(), "tina4-crud-product-"));
  try {
    const r = runCrud(dir, "Product", "name:string");
    assert("Product: subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode}`);
    assert("route dir src/routes/api/products exists", existsSync(join(dir, "src/routes/api/products")));
    assert("route dir src/routes/api/productss does NOT exist", !existsSync(join(dir, "src/routes/api/productss")));
    assert("migration create_product exists (table stays singular)", hasMigration(dir, "create_product"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. Parity case: a class whose plural takes -es. `Status` -> `statuses`
//    (python/php/ruby pluralize the singular base with the reserved-word
//    pluralizer). Node used to route to `status` (toPlural short-circuits on a
//    trailing s); this locks it to the shared rule.
{
  const dir = mkdtempSync(join(tmpdir(), "tina4-crud-status-"));
  try {
    const r = runCrud(dir, "Status", "name:string");
    assert("Status: subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode}`);
    assert("route dir src/routes/api/statuses exists (parity: -es plural)", existsSync(join(dir, "src/routes/api/statuses")));
    assert("route dir src/routes/api/status does NOT exist", !existsSync(join(dir, "src/routes/api/status")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

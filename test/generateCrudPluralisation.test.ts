/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * `generate crud` table-name contract (ADR-0094) — the ONE rule, shared across
 * the four frameworks. Run with: npx tsx test/generateCrudPluralisation.test.ts
 *
 * ADR-0094: `generate crud` scaffolds an AutoCrud-backed admin PAGE at
 * /admin/<table>; it no longer emits hand-written REST route files or page
 * views. The admin route directory, the /api/<table> REST path and the migration
 * all key off the model's TABLE name (resolveTable): SINGULAR for a plain class
 * (Product -> product), and the reserved-word plural for a reserved class
 * (Order -> orders), never a double-plural (orderss). This is the same contract
 * the Ruby master proves in spec/cli_generate_spec.rb "generate crud table-name".
 *
 * No mocks: drives a REAL `tina4nodejs generate crud` subprocess in a REAL
 * mkdtemp project and reads the generated tree back.
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

// 1. Reserved-word class: Order -> table `orders`, never orderss.
{
  const dir = mkdtempSync(join(tmpdir(), "tina4-crud-order-"));
  try {
    const r = runCrud(dir, "Order", "total:float");
    assert("subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    assert("admin route dir src/routes/admin/orders exists", existsSync(join(dir, "src/routes/admin/orders")));
    assert("admin route dir src/routes/admin/orderss does NOT exist", !existsSync(join(dir, "src/routes/admin/orderss")));
    const route = join(dir, "src/routes/admin/orders/get.ts");
    assert("orders admin route written", existsSync(route));
    if (existsSync(route)) {
      const body = readFileSync(route, "utf-8");
      assert("route body has no double-plural 'orderss'", !body.includes("orderss"), body.slice(0, 300));
      assert("route registers AutoCrud for the model (serves /api/orders)", body.includes("Crud.registerBackend(Order"));
    }

    assert("model src/models/Order.ts exists", existsSync(join(dir, "src/models/Order.ts")));
    assert("migration create_orders exists", hasMigration(dir, "create_orders"));
    assert("migration create_orderss does NOT exist", !hasMigration(dir, "create_orderss"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Plain class: Product -> table stays SINGULAR (product); route /admin/product.
{
  const dir = mkdtempSync(join(tmpdir(), "tina4-crud-product-"));
  try {
    const r = runCrud(dir, "Product", "name:string");
    assert("Product: subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode}`);
    assert("admin route dir src/routes/admin/product exists (singular)", existsSync(join(dir, "src/routes/admin/product")));
    assert("admin route dir src/routes/admin/products does NOT exist", !existsSync(join(dir, "src/routes/admin/products")));
    assert("migration create_product exists (table stays singular)", hasMigration(dir, "create_product"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. Plain non-reserved class Status -> table stays SINGULAR (status), route
//    /admin/status. ADR-0094 keys the route off the TABLE (resolveTable), which
//    does not pluralise a non-reserved name.
{
  const dir = mkdtempSync(join(tmpdir(), "tina4-crud-status-"));
  try {
    const r = runCrud(dir, "Status", "name:string");
    assert("Status: subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode}`);
    assert("admin route dir src/routes/admin/status exists (singular, non-reserved)", existsSync(join(dir, "src/routes/admin/status")));
    assert("migration create_status exists", hasMigration(dir, "create_status"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

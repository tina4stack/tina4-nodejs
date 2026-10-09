/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/*
 * ADR-0094: `generate crud <Model>` scaffolds an AutoCrud-backed admin page
 * rendered by Crud.toCrud, secure by default (--public opens page + writes),
 * copies the overridable crud/*.twig templates into the app, and emits a
 * model + migration + gate test.
 *
 * NO MOCKS: the REAL generator writing into a REAL temp project directory; the
 * assertions read the exact files + bytes it produced. Mirrors the Ruby master's
 * spec/cli_generate_spec.rb "generate crud" cases.
 */

import { generate } from "../packages/cli/src/commands/generate.ts";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

async function inProject<T>(fn: () => Promise<T>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tina4-crudgen-"));
  const prev = process.cwd();
  process.chdir(dir);
  try { await fn(); } finally { process.chdir(prev); rmSync(dir, { recursive: true, force: true }); }
}

function read(p: string): string { return readFileSync(p, "utf8"); }

async function main() {
  console.log("=== generate crud (ADR-0094) — AutoCrud-backed admin page ===\n");

  // --- default: secure-by-default admin page + AutoCrud registration ---
  console.log("--- default (secure) ---");
  await inProject(async () => {
    await generate("crud", "Product", ["--fields", "name:string,price:float"]);

    const routeFile = join("src", "routes", "admin", "product", "get.ts");
    assert("admin route file src/routes/admin/product/get.ts exists", existsSync(routeFile));
    const route = existsSync(routeFile) ? read(routeFile) : "";
    assert("registers AutoCrud secure (public: false)", route.includes("Crud.registerBackend(Product, { public: false })"));
    assert("renders the toCrud admin page", route.includes("Crud.toCrud(req, { model: Product, title: \"Product Admin\" })"));
    assert("the admin page is secured by default (export const secure = true)", route.includes("export const secure = true;"));
    assert("does NOT open writes by default (no public: true)", !route.includes("public: true"));

    assert("model src/models/Product.ts exists", existsSync(join("src", "models", "Product.ts")));
    assert("a create_product migration exists", readdirSync("migrations").some((f) => /create_product\.sql$/.test(f)));

    for (const t of ["page", "table", "form", "modals"]) {
      assert(`copies the overridable crud/${t}.twig template`, existsSync(join("src", "templates", "crud", `${t}.twig`)));
    }

    const gate = join("tests", "product.test.ts");
    assert("emits a gate test tests/product.test.ts", existsSync(gate));
    const gateSrc = existsSync(gate) ? read(gate) : "";
    assert("gate test asserts the public read + gated write + secured page",
      gateSrc.includes('"/api/product"') && gateSrc.includes("401") && gateSrc.includes("secured -> 401"));
  });

  // --- --public opens the writes + the page ---
  console.log("\n--- --public ---");
  await inProject(async () => {
    await generate("crud", "Contraption", ["--fields", "name:string", "--public"]);
    const route = read(join("src", "routes", "admin", "contraption", "get.ts"));
    assert("--public registers AutoCrud public (public: true)", route.includes("Crud.registerBackend(Contraption, { public: true })"));
    assert("--public passes public: true to toCrud", route.includes("public: true }"));
    assert("--public does NOT secure the admin page (no secure export)", !route.includes("export const secure = true;"));
  });

  // --- --no-templates skips the template copy ---
  console.log("\n--- --no-templates ---");
  await inProject(async () => {
    await generate("crud", "Sprocket", ["--fields", "name:string", "--no-templates"]);
    assert("--no-templates skips copying crud/page.twig", !existsSync(join("src", "templates", "crud", "page.twig")));
    assert("but the admin route is still written", existsSync(join("src", "routes", "admin", "sprocket", "get.ts")));
  });

  // --- reserved-word model uses the reserved-word plural table ---
  console.log("\n--- reserved-word table name ---");
  await inProject(async () => {
    await generate("crud", "Order", ["--fields", "total:float"]);
    assert("Order -> /admin/orders route dir (reserved plural)", existsSync(join("src", "routes", "admin", "orders", "get.ts")));
    assert("no double-pluralised orderss dir", !existsSync(join("src", "routes", "admin", "orderss", "get.ts")));
    const route = read(join("src", "routes", "admin", "orders", "get.ts"));
    assert("the reserved route serves /api/orders via AutoCrud", route.includes("Crud.registerBackend(Order"));
  });

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });

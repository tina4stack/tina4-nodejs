/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/*
 * Crud is CSP-clean under the strict default policy (ADR-0088): default-src
 * 'self'. A nonce authorises a <script>/<style> ELEMENT but NEVER an inline on*=
 * handler or a style= attribute, so Crud must emit ZERO of those and bind every
 * action with addEventListener inside its nonce'd <script>.
 *
 * NO MOCKS: a real on-disk SQLite DB, a real BaseModel, the real router + the
 * real TestClient pipeline, and the real Frond templates. The assertions run
 * against the exact bytes Crud emits. Mirrors the Ruby master's
 * spec/crud_csp_onclick_spec.rb, including the mutation-proof of the gate and the
 * app-template override.
 */

import { BaseModel, initDatabase, getAdapter, adapterExecute, closeDatabase } from "../packages/orm/src/index.ts";
import { Crud, defaultRouter, get, TestClient } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

// Matches an inline HTML event-handler attribute (onclick=, onsubmit=, …) but
// NOT a JS property assignment (el.onclick = fn), which is CSP-allowed.
const INLINE_HANDLER_ATTR = /\son[a-z]+\s*=\s*["']/;
// Matches an inline style= attribute — dead under default-src 'self' (ADR-0088).
const INLINE_STYLE_ATTR = /\sstyle\s*=\s*["']/;

class CrudCspModel extends BaseModel {
  static tableName = "crudcspmodels";
  static fields = {
    id:    { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:  { type: "string" as const, required: true },
    email: { type: "string" as const },
  };
}

console.log("=== Crud CSP (no inline on*= / style=) Tests ===\n");

const tmpDir = mkdtempSync(join(tmpdir(), "tina4-crud-csp-"));

async function renderAdmin(cwd: string | null): Promise<string> {
  defaultRouter.clear();
  Crud._resetCrudRegistrations();
  get("/admin/crudcspmodels", async (req: Tina4Request, res: Tina4Response) => {
    const body = await Crud.toCrud(req, { model: CrudCspModel, title: "CSP CRUD" });
    return res.html(body);
  });
  const prevCwd = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const clientResponse = await new TestClient().get("/admin/crudcspmodels");
    return clientResponse.body;
  } finally {
    if (cwd) process.chdir(prevCwd);
  }
}

async function main() {
  await initDatabase({ url: `sqlite:///${join(tmpDir, "crud_csp.db")}` });
  const adapter = getAdapter();
  await adapterExecute(adapter,
    "CREATE TABLE IF NOT EXISTS crudcspmodels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT)", []);
  await adapterExecute(adapter, "INSERT INTO crudcspmodels (name, email) VALUES (?, ?)", ["Alice", "alice@example.com"]);
  await adapterExecute(adapter, "INSERT INTO crudcspmodels (name, email) VALUES (?, ?)", ["Bob", "bob@example.com"]);

  console.log("--- toCrud full page ---");
  const html = await renderAdmin(null);
  assert("emits the records and a modal", html.includes("Alice") && html.includes("Bob") && html.includes("modal-create"));

  assert("has ZERO inline on*= event-handler attributes", html.match(INLINE_HANDLER_ATTR) === null,
    JSON.stringify((html.match(new RegExp(INLINE_HANDLER_ATTR, "g")) || []).slice(0, 3)));
  assert("has ZERO inline style= attributes", html.match(INLINE_STYLE_ATTR) === null,
    JSON.stringify((html.match(new RegExp(INLINE_STYLE_ATTR, "g")) || []).slice(0, 3)));

  // Mutation proof: the gates MUST flag an injected attribute. A gate never seen
  // to fail is not known to work.
  const mutated = html.replace("<h2>", '<h2 onclick="x()" style="color:red">');
  assert("on*= gate is a real gate (catches an injected handler)", INLINE_HANDLER_ATTR.test(mutated));
  assert("style= gate is a real gate (catches an injected style)", INLINE_STYLE_ATTR.test(mutated));

  console.log("\n--- action wiring + delegated listener ---");
  assert("wires create/edit/delete/save/confirm-delete via data-crud-action",
    html.includes('data-crud-action="create"') && html.includes('data-crud-action="edit"') &&
    html.includes('data-crud-action="delete"') && html.includes('data-crud-action="save"') &&
    html.includes('data-crud-action="confirm-delete"'));
  assert("row id rides in data-id; save knows create vs edit via data-crud-mode",
    html.includes('data-id="') && html.includes('data-crud-mode="'));
  assert("binds actions through a delegated listener in a nonce'd <script>",
    html.includes("<script nonce=") && html.includes("addEventListener('click'") &&
    html.includes("button.dataset.crudAction"));
  assert("stops the modal form's native submit with a listener (not onsubmit=)",
    html.includes("addEventListener('submit'") && html.includes('data-crud-form="1"'));

  console.log("\n--- generateTable inline-edit fragment ---");
  const frag = Crud.generateTable(
    [{ id: 1, name: "Alice's \"Gadget\"", email: "a@e.com" }, { id: 2, name: "Bob", email: "b@e.com" }],
    { tableName: "crudcspmodels", primaryKey: "id" },
  );
  assert("generateTable has ZERO inline on*= attributes", frag.match(INLINE_HANDLER_ATTR) === null);
  assert("generateTable has ZERO inline style= attributes", frag.match(INLINE_STYLE_ATTR) === null);
  assert("generateTable wires Save/Delete with data-crud-inline + a delegated listener",
    frag.includes('data-crud-inline="save"') && frag.includes('data-crud-inline="delete"') &&
    frag.includes('data-table="crudcspmodels"') && frag.includes("<script nonce=") &&
    frag.includes("button.dataset.crudInline"));

  console.log("\n--- app template override ---");
  const project = mkdtempSync(join(tmpdir(), "tina4-crud-override-"));
  mkdirSync(join(project, "src", "templates", "crud"), { recursive: true });
  writeFileSync(
    join(project, "src", "templates", "crud", "table.twig"),
    '<div class="app-override-marker">OVERRIDDEN TABLE</div>',
  );
  const overridden = await renderAdmin(project);
  assert("an app src/templates/crud/table.twig wins over the framework copy",
    overridden.includes("app-override-marker") && overridden.includes("OVERRIDDEN TABLE"));
  assert("the (un-overridden) page shell still renders around it",
    overridden.includes("CSP CRUD") && overridden.includes("modal-create"));
  rmSync(project, { recursive: true, force: true });

  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });

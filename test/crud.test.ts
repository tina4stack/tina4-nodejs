/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/*
 * Crud.toCrud (ADR-0094) — the frontend-over-AutoCrud HTML admin page.
 *
 * NO MOCKS: a real on-disk SQLite database, a real BaseModel bound to it, the
 * real router + the real in-process TestClient (which dispatches through the
 * SAME runDispatch pipeline a live socket does, so the CSP nonce and request
 * are real), and the real Frond templates on disk. Mirrors the Ruby master's
 * spec/crud_spec.rb.
 */

import { BaseModel, initDatabase, getAdapter, adapterExecute, closeDatabase, Crud } from "../packages/orm/src/index.ts";
import { defaultRouter, get, TestClient } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";
// Table/pagination assembly — pure functions exercised directly (no DB).
import { tableData, pageControls, jsConfig } from "../packages/orm/src/crudTable.ts";
// The linear (ReDoS-safe) SQL-listing column parser.
import { extractColumns } from "../packages/orm/src/crudHelpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

class CrudTestModel extends BaseModel {
  static tableName = "crudtestmodels";
  static fields = {
    id:    { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:  { type: "string" as const, required: true },
    email: { type: "string" as const },
    age:   { type: "integer" as const, default: 0 },
  };
}

console.log("=== Crud.toCrud (ADR-0094) Tests ===\n");

const tmpDir = mkdtempSync(join(tmpdir(), "tina4-crud-"));

/** Register the admin page route and GET it through the real TestClient. */
async function renderAdmin(path: string, options: Record<string, unknown>): Promise<string> {
  defaultRouter.clear();
  Crud._resetCrudRegistrations();
  get("/admin/test", async (req: Tina4Request, res: Tina4Response) => {
    const body = await Crud.toCrud(req, options as any);
    return res.html(body);
  });
  const clientResponse = await new TestClient().get(path);
  return clientResponse.body;
}

async function main() {
  await initDatabase({ url: `sqlite:///${join(tmpDir, "crud.db")}` });
  const adapter = getAdapter();
  await adapterExecute(adapter,
    "CREATE TABLE IF NOT EXISTS crudtestmodels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, age INTEGER DEFAULT 0)", []);
  await adapterExecute(adapter, "INSERT INTO crudtestmodels (name, email, age) VALUES (?, ?, ?)", ["Alice", "alice@example.com", 30]);
  await adapterExecute(adapter, "INSERT INTO crudtestmodels (name, email, age) VALUES (?, ?, ?)", ["Bob", "bob@example.com", 25]);
  await adapterExecute(adapter, "INSERT INTO crudtestmodels (name, email, age) VALUES (?, ?, ?)", ["Charlie", "charlie@example.com", 35]);

  // --- toCrud with model: full page ---
  console.log("--- toCrud with model ---");
  let html = await renderAdmin("/admin/test", { model: CrudTestModel, title: "Test CRUD" });
  assert("renders a complete HTML page with the title", html.includes("Test CRUD") && html.includes("<table"));
  assert("renders every seeded row", html.includes("Alice") && html.includes("Bob") && html.includes("Charlie"));
  assert("includes create/edit/delete modals", html.includes("modal-create") && html.includes("modal-edit") && html.includes("modal-delete"));
  assert("includes modal titles", html.includes("Create New Record") && html.includes("Edit Record") && html.includes("Confirm Delete"));

  // live (as-you-type) search input, not a submit form
  assert("has a live data-crud-search input", html.includes("data-crud-search") && html.includes('placeholder="Search..."'));
  assert("has NO Search submit button", !html.includes(">Search</button>"));

  // the sort headers + pager drive the AutoCrud list endpoint over AJAX
  html = await renderAdmin("/admin/test", { model: CrudTestModel, limit: 2 });
  assert("uses AbortController for live search", html.includes("AbortController"));
  assert("AJAX re-renders the tbody (data-crud-body)", html.includes("data-crud-body"));
  assert("sort headers carry data-crud-sort", html.includes("data-crud-sort="));
  assert("pager carries data-crud-page", html.includes("data-crud-page="));

  // alignment by field type (tina4-css classes, no inline style=)
  html = await renderAdmin("/admin/test", { model: CrudTestModel });
  assert("numeric columns align text-end", html.includes('class="text-end"'));
  assert("text columns align text-start", html.includes('class="text-start"'));
  assert("no inline style= used for alignment", html.match(/\sstyle\s*=\s*["']/) === null);

  // pagination info + sort links
  assert("includes the pagination info line", html.includes("Showing 3 of 3 records"));
  assert("includes sort links for id/name/email", html.includes("sort=id") && html.includes("sort=name") && html.includes("sort=email"));

  // validation wiring present in the JS
  assert("wires inline validation errors (showErrors / data-crud-errors / r.ok)",
    html.includes("saveRecord") && html.includes("data-crud-errors") && html.includes("showErrors") && html.includes("res.ok"));

  // --- registers the full AutoCrud REST backend ---
  console.log("\n--- backend delegation (AutoCrud) ---");
  await renderAdmin("/admin/test", { model: CrudTestModel });
  const routeStrs = defaultRouter.getRoutes().map((r) => `${r.method} ${r.pattern}`);
  for (const want of [
    "GET /api/crudtestmodels", "GET /api/crudtestmodels/{id}", "POST /api/crudtestmodels",
    "PUT /api/crudtestmodels/{id}", "DELETE /api/crudtestmodels/{id}",
  ]) {
    assert(`registers ${want}`, routeStrs.includes(want), `got ${routeStrs.join(", ")}`);
  }
  const tableRoutes = routeStrs.filter((r) => r.includes("/api/crudtestmodels"));
  assert("registers EXACTLY the five AutoCrud routes (no bespoke writes)", tableRoutes.length === 5, `got ${tableRoutes.length}`);

  // idempotent — a second call does not double-register
  await renderAdmin("/admin/test", { model: CrudTestModel });
  const again = defaultRouter.getRoutes().map((r) => `${r.method} ${r.pattern}`).filter((r) => r.includes("/api/crudtestmodels"));
  assert("idempotent: still exactly five routes after a second render", again.length === 5, `got ${again.length}`);

  // --- custom sql listing shapes the grid; model still drives the backend ---
  console.log("\n--- custom sql listing ---");
  html = await renderAdmin("/admin/test", {
    model: CrudTestModel, sql: "SELECT id, name, email FROM crudtestmodels", title: "SQL CRUD",
  });
  assert("sql listing renders title + rows", html.includes("SQL CRUD") && html.includes("Alice") && html.includes("Bob"));
  const sqlRoutes = defaultRouter.getRoutes().map((r) => `${r.method} ${r.pattern}`);
  assert("sql listing: backend still comes from the model (AutoCrud)",
    sqlRoutes.includes("GET /api/crudtestmodels") && sqlRoutes.includes("POST /api/crudtestmodels"));

  // --- search filters the rendered rows ---
  console.log("\n--- search ---");
  html = await renderAdmin("/admin/test?search=Alice", { model: CrudTestModel, title: "Search Test" });
  assert("search=Alice keeps Alice, drops Bob/Charlie",
    html.includes("Alice") && !html.includes(">Bob<") && !html.includes(">Charlie<"));

  // --- pagination ---
  console.log("\n--- pagination ---");
  html = await renderAdmin("/admin/test?page=1", { model: CrudTestModel, limit: 2 });
  assert("page 1 of 2 with a Next control", html.includes("page 1 of 2") && html.includes("Next"));
  html = await renderAdmin("/admin/test?page=2", { model: CrudTestModel, limit: 2 });
  assert("page 2 of 2 with a Prev control", html.includes("page 2 of 2") && html.includes("Prev"));

  // --- CRUD uppercase alias ---
  console.log("\n--- CRUD alias ---");
  assert("Crud === CRUD (uppercase alias resolves to the same implementation)",
    (await import("../packages/orm/src/index.ts")).CRUD === Crud);

  // --- generateTable (sync) ---
  console.log("\n--- generateTable ---");
  const tableHtml = Crud.generateTable([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }], { tableName: "users", primaryKey: "id" });
  assert("generateTable renders a table with rows + the inline-edit script",
    tableHtml.includes("<table") && tableHtml.includes("Alice") && tableHtml.includes("Bob") && tableHtml.includes("crudSave"));
  assert("generateTable with no records shows the empty message", Crud.generateTable([], { tableName: "users" }).includes("No records found"));

  // --- generateForm (sync) ---
  console.log("\n--- generateForm ---");
  const formHtml = Crud.generateForm(
    [{ name: "name", type: "string", label: "Full Name", required: true }, { name: "email", type: "string", label: "Email" }],
    { action: "/api/users", method: "POST" },
  );
  assert("generateForm renders a form with the field labels + names",
    formHtml.includes("<form") && formHtml.includes("Full Name") && formHtml.includes('name="name"') && formHtml.includes('name="email"'));

  // --- model is required (ADR-0094) ---
  console.log("\n--- model required ---");
  let threw = false;
  try { await Crud.toCrud({ query: {}, path: "/admin/test" } as any, { title: "Broken" } as any); } catch { threw = true; }
  assert("throws when no model is given", threw);
  threw = false;
  try { await Crud.toCrud({ query: {}, path: "/admin/test" } as any, { sql: "SELECT id FROM crudtestmodels" } as any); } catch { threw = true; }
  assert("throws for sql-only (no model) — a model drives every write", threw);

  // --- strip_order_and_limit (pure logic) ---
  console.log("\n--- stripOrderAndLimit ---");
  assert("drops ORDER BY + LIMIT", Crud.stripOrderAndLimit("SELECT id, name FROM t ORDER BY name LIMIT 5") === "SELECT id, name FROM t");
  assert("drops a bare LIMIT", Crud.stripOrderAndLimit("SELECT * FROM t LIMIT 10") === "SELECT * FROM t");
  assert("leaves a clause-free query untouched (trimmed)", Crud.stripOrderAndLimit("  SELECT id FROM orders WHERE total > 5  ") === "SELECT id FROM orders WHERE total > 5");
  assert("matches keywords case-insensitively", Crud.stripOrderAndLimit("select id from t order by id limit 3") === "select id from t");

  // --- extractColumns (linear SQL-listing parser, ReDoS-safe) ---
  console.log("\n--- extractColumns ---");
  assert("extracts a simple column list",
    JSON.stringify(extractColumns("SELECT id, name, email FROM users")) === JSON.stringify(["id", "name", "email"]));
  assert("resolves AS aliases and table-qualified names",
    JSON.stringify(extractColumns("SELECT u.id, u.name AS full_name FROM users u")) === JSON.stringify(["id", "full_name"]));
  assert("case-insensitive, returns [*] for SELECT *",
    JSON.stringify(extractColumns("select * from products")) === JSON.stringify(["*"]));
  assert("stays linear on a pathological whitespace run (no ReDoS hang)",
    (() => { const started = Date.now(); extractColumns("SELECT " + " ".repeat(100000)); return Date.now() - started < 1000; })());

  // --- table/pagination assembly (pure logic, crudTable) ---
  console.log("\n--- crudTable pure helpers ---");
  const td = tableData({
    columns: ["id", "name"], records: [{ id: 1, name: "Al & Co <x>" }], pk: "id",
    tableName: "t", editable: false, sortable: true, inlineScript: false,
    requestPath: "/admin/t", search: "", sortCol: "id", sortDir: "asc",
    page: 1, limit: 10, tableId: null, model: null,
  });
  assert("tableData builds one header per column", Array.isArray(td.headers) && (td.headers as unknown[]).length === 2);
  assert("tableData builds one row and escapes cell values",
    (td.rows as Array<{ cells: string }>).length === 1 &&
    (td.rows as Array<{ cells: string }>)[0].cells.includes("Al &amp; Co &lt;x&gt;"));
  assert("tableData colspan = columns + 1", td.colspan === 3);

  const controls = pageControls(2, 3, "/admin/t", "", "id", "asc", 10);
  assert("pageControls yields Prev + 3 pages + Next", controls.length === 5);
  assert("pageControls marks the current page active", controls.some((c) => c.active === true && c.label === 2));
  assert("pageControls returns none for a single page", pageControls(1, 1, "/admin/t", "", "id", "asc", 10).length === 0);

  const cfg = JSON.parse(
    jsConfig({ apiPath: "/api/t", pk: "id", columns: ["id", "name"], editable: ["name"], model: null as any,
      limit: 10, search: "x", sortCol: "id", sortDir: "asc", page: 1 })
      .replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&"),
  );
  assert("jsConfig carries the api path + pk + editable", cfg.api === "/api/t" && cfg.pk === "id" && cfg.editable[0] === "name");

  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });

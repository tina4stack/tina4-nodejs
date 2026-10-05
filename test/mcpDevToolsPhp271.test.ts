/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Regression tests for tina4-php#271 (dev MCP tools), real MCP dispatch against
 * a real node:sqlite file database. No mocks.
 *   P1 database_columns reports an EMPTY table's columns; a missing table errors
 *   P2 tool args validated before invoking; api_method params + return populated
 *   P3 route_list carries each route's middleware names
 *   P4 a route file added while running registers on the reload trigger
 * Run with: npx tsx test/mcpDevToolsPhp271.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer, registerDevTools } from "../packages/core/src/mcp.js";
import { Router } from "../packages/core/src/router.js";
import { discoverRoutes, rediscoverRoutes, _resetRouteDiscovery } from "../packages/core/src/routeDiscovery.js";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.js";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_DEBUG = "true";
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-271-"));
fs.mkdirSync(path.join(proj, "src", "routes", "first"), { recursive: true });
fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "p271", version: "1.0.0", type: "module" }));
fs.writeFileSync(path.join(proj, "src", "routes", "first", "get.ts"),
  "export default async function (_req: any, res: any) { return res.json({ first: true }); }\n");

async function main(): Promise<void> {
  process.chdir(proj);
  const db: any = await initDatabase({ url: "sqlite:///" + path.join(proj, "p271.db") });
  await db.execute("CREATE TABLE empty_widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, qty INTEGER)");
  await db.execute("CREATE TABLE full_widgets (id INTEGER PRIMARY KEY, label TEXT)");
  await db.execute("INSERT INTO full_widgets (id, label) VALUES (1, 'a')");

  const server = new McpServer("/p271-mcp", "P271");
  registerDevTools(server);
  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const raw = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const parsed = JSON.parse(raw);
    if (parsed.error) return { rpcError: parsed.error };
    const text: string = parsed.result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  }

  console.log("\n=== P1 database_columns ===");
  const emptyCols = await callTool("database_columns", { table: "empty_widgets" });
  assert("empty table returns its columns", Array.isArray(emptyCols) && emptyCols.map((c: any) => c.name).join() === "id,name,qty", JSON.stringify(emptyCols));
  assert("columns carry type", Array.isArray(emptyCols) && emptyCols.find((c: any) => c.name === "name")?.type === "TEXT", JSON.stringify(emptyCols));
  assert("columns carry nullability", Array.isArray(emptyCols) && emptyCols.find((c: any) => c.name === "name")?.nullable === false, JSON.stringify(emptyCols));
  const fullCols = await callTool("database_columns", { table: "full_widgets" });
  assert("populated table still returns columns", Array.isArray(fullCols) && fullCols.length === 2);
  const missing = await callTool("database_columns", { table: "no_such_table" });
  assert("missing table errors clearly, not []", !Array.isArray(missing) && /table not found: no_such_table/.test(missing.error ?? ""), JSON.stringify(missing));

  console.log("\n=== P2 argument validation ===");
  const misnamed = await callTool("api_method", { class: "Router", method: "get" });
  assert("misnamed arg -> missing required argument 'name'",
    misnamed.error === "missing required argument 'name' (api_method takes class, name)", JSON.stringify(misnamed));
  const noArgs = await callTool("api_method", {});
  assert("no args -> missing required argument 'class'",
    noArgs.error === "missing required argument 'class' (api_method takes class, name)", JSON.stringify(noArgs));
  const unknown = await callTool("api_method", { class: "Router", name: "get", bogus: 1 });
  assert("unknown key rejected",
    unknown.error === "unknown argument 'bogus' (api_method takes class, name)", JSON.stringify(unknown));
  const noTable = await callTool("database_columns", {});
  assert("database_columns without table -> actionable error",
    noTable.error === "missing required argument 'table' (database_columns takes table)", JSON.stringify(noTable));
  const spec = await callTool("api_method", { class: "Router", name: "get" });
  assert("valid api_method call works", spec.name === "get" && typeof spec.signature === "string", JSON.stringify(spec).slice(0, 120));
  assert("api_method params populated",
    Array.isArray(spec.params) && spec.params.length >= 2 && spec.params[0].name === "path" && spec.params[0].type === "string" && spec.params[0].required === true,
    JSON.stringify(spec.params));
  assert("api_method optional param flagged", spec.params?.find((p: any) => p.name === "middleware")?.required === false);
  assert("api_method return populated", spec.return === "RouteRef", JSON.stringify(spec.return));

  console.log("\n=== P3 route_list middleware ===");
  const router = new Router();
  async function requireAdmin(_req: any, _res: any, next: any) { return next(); }
  router.get("/admin/secret", async (_req: any, res: any) => res.json({ ok: 1 }), [requireAdmin]).noAuth();
  router.get("/open", async (_req: any, res: any) => res.json({ ok: 1 }));
  (globalThis as any).__tina4_router = router;
  const routes = await callTool("route_list");
  const guarded = routes.find((r: any) => r.path === "/admin/secret");
  const open = routes.find((r: any) => r.path === "/open");
  assert("guarded route lists its middleware name", JSON.stringify(guarded?.middleware) === '["requireAdmin"]', JSON.stringify(guarded));
  assert("guarded route keeps method/path/auth_required", guarded?.method === "GET" && guarded?.auth_required === false);
  assert("open route has empty middleware list", JSON.stringify(open?.middleware) === "[]", JSON.stringify(open));

  console.log("\n=== P4 new route file mid-run ===");
  _resetRouteDiscovery();
  const live = new Router();
  for (const r of await discoverRoutes(path.join(proj, "src", "routes"))) live.addRoute(r);
  (globalThis as any).__tina4_router = live;
  const before = await callTool("route_list");
  assert("route_list has the boot-time route", before.some((r: any) => r.path === "/first"), JSON.stringify(before));
  fs.mkdirSync(path.join(proj, "src", "routes", "second"), { recursive: true });
  fs.writeFileSync(path.join(proj, "src", "routes", "second", "get.ts"),
    "export default async function (_req: any, res: any) { return res.json({ second: true }); }\n");
  assert("new file absent until the reload trigger", !(await callTool("route_list")).some((r: any) => r.path === "/second"));
  for (const r of await rediscoverRoutes()) live.addRoute(r); // what POST /__dev/api/reload does
  assert("new file visible in route_list after reload trigger", (await callTool("route_list")).some((r: any) => r.path === "/second"));

  await closeDatabase();
  delete (globalThis as any).__tina4_router;
  process.chdir(os.tmpdir());
  fs.rmSync(proj, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

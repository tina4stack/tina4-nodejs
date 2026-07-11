/**
 * MCP dev-tools conformance — invoke EVERY registered /__dev/mcp dev tool via
 * real JSON-RPC `tools/call` against a real throwaway app and assert that:
 *
 *   (1) NO tool throws — no JSON-RPC error, and no handler returns a code-bug
 *       error string (TypeError / "is not a function" / "cannot read property"
 *       / module-resolution failures). A graceful `{error: "..."}` (e.g. "Not a
 *       git repository") is fine — that is the tool behaving, not throwing.
 *
 *   (2) the four tools an invoke-every-tool sweep found returning
 *       200-but-WRONG-DATA are now CORRECT (this is the class of bug a plain
 *       "did it throw / did it 200?" check misses):
 *         - migration_status shows an APPLIED migration as completed, not pending
 *         - a second migration_run is IDEMPOTENT (applies nothing, no error)
 *         - seed_table INSERTS rows (inserted > 0) — real rows land in the table
 *         - route_test DISPATCHES (numeric HTTP status + real body) — not an echo
 *
 * No mocks: a real temp node:sqlite FILE database, a real in-process router +
 * TestClient, real migration/seed/plan files on disk, driven through the ACTUAL
 * server.handleMessage JSON-RPC dispatch. This test FAILS against the pre-fix
 * code (all-pending / non-idempotent / 0-rows / echo stub) and PASSES after.
 *
 * Run with: npx tsx test/mcpDevToolsConformance.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { McpServer, registerDevTools } from "../packages/core/src/mcp.js";
import { get, post, defaultRouter } from "../packages/core/src/index.js";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.js";

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

// Error-string patterns that mean the HANDLER crashed (a real bug), not a
// graceful domain error. Mirrors the invoke-every-tool sweep's classifier.
const CODE_BUG =
  /is not a function|is not defined|cannot read propert|cannot find module|cannot find package|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE|is not a constructor|unexpected token|unexpected identifier|referenceerror|typeerror:|undefined \(reading/i;

const origCwd = process.cwd();
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-mcp-conformance-"));

async function main(): Promise<void> {
  // ── 1. Build a real throwaway project on disk ──────────────────
  for (const d of ["src/models", "src/routes", "src/templates", "src/public", "migrations", "data/sessions", "logs", "plan"]) {
    fs.mkdirSync(path.join(proj, d), { recursive: true });
  }
  fs.writeFileSync(path.join(proj, "package.json"),
    JSON.stringify({ name: "conformance-app", version: "9.9.9", type: "module", engines: { node: ">=20" }, dependencies: {}, devDependencies: {} }, null, 2));
  fs.writeFileSync(path.join(proj, "CLAUDE.md"),
    "# Conformance App\n\n## Routes\nThis app exposes a ping route.\n\n## Models\nA Widget model with name and qty.\n");
  fs.writeFileSync(path.join(proj, "README.md"), "# Conformance\nRoutes and models live here.\n");
  // A real ORM model file (orm_describe scans src/models for .ts/.js files).
  fs.writeFileSync(path.join(proj, "src/models/Widget.ts"),
    "export default class Widget { static tableName = 'widgets'; static fields = { id:{type:'integer',primaryKey:true,autoIncrement:true}, name:{type:'string'}, qty:{type:'integer'} }; }\n");
  // A real migration that creates the table the seed + query tools use.
  fs.writeFileSync(path.join(proj, "migrations/000001_create_widgets.sql"),
    "CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, qty INTEGER);\n");
  fs.writeFileSync(path.join(proj, "data/sessions/probe-session.json"), JSON.stringify({ user: "zed" }));
  fs.writeFileSync(path.join(proj, "logs/debug.log"), "line1\nline2\nline3\nline4\n");

  // registerDevTools captures process.cwd() at call time -> chdir BEFORE it.
  process.chdir(proj);
  process.env.TINA4_DEBUG = "true";

  // ── 2. Real throwaway node:sqlite FILE database ────────────────
  const dbPath = path.join(proj, "conformance.db");
  await initDatabase({ url: "sqlite:///" + dbPath }); // 4 slashes -> absolute path

  // ── 3. Real routes on the router; expose it the way route_list/route_test
  //       read it (globalThis.__tina4_router, else the default router). ───────
  get("/ping", async (_req: any, res: any) => res.json({ pong: true }));
  post("/api/echo", async (req: any, res: any) => res.json({ got: req.body ?? null }));
  (globalThis as any).__tina4_router = defaultRouter;

  // ── 4. The REAL dev-MCP server (registers every dev tool) ──────
  const server = new McpServer("/conformance-mcp", "Conformance Test");
  registerDevTools(server);

  async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const raw = await server.handleMessage({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params });
    return raw ? JSON.parse(raw) : {};
  }
  // Returns { rpcError, value }: rpcError is a JSON-RPC-level throw; value is
  // the tool's parsed result payload (parsed from the text content block).
  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ rpcError: any; value: any; raw: string }> {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) return { rpcError: r.error, value: null, raw: "" };
    const text: string = r.result?.content?.[0]?.text ?? "";
    let value: any = text;
    try { value = JSON.parse(text); } catch { /* plain string result */ }
    return { rpcError: null, value, raw: text };
  }

  // ── 5. Enumerate EVERY registered tool from the registry (no hardcoding) ──
  const listed = await rpc("tools/list", {});
  const toolNames: string[] = (listed.result?.tools ?? []).map((t: any) => t.name);
  assert("tools/list returns a non-empty tool registry", toolNames.length > 0, `count=${toolNames.length}`);

  // ────────────────────────────────────────────────────────────────
  // PHASE A — the four fixed tools, CORRECT-payload assertions in a
  // controlled order. This is what catches "returns-200-but-wrong-data".
  // ────────────────────────────────────────────────────────────────
  console.log("\n=== Phase A: fixed-tool correctness (real payloads) ===\n");

  const migFile = "000001_create_widgets.sql";

  // migration_status BEFORE running -> the migration is PENDING, none completed.
  const statusBefore = await callTool("migration_status");
  assert("migration_status (fresh): no rpc throw", statusBefore.rpcError === null, JSON.stringify(statusBefore.rpcError));
  assert("migration_status (fresh): migration is pending",
    Array.isArray(statusBefore.value?.pending) && statusBefore.value.pending.includes(migFile),
    JSON.stringify(statusBefore.value));
  assert("migration_status (fresh): nothing completed yet",
    Array.isArray(statusBefore.value?.completed) && !statusBefore.value.completed.includes(migFile),
    JSON.stringify(statusBefore.value));

  // migration_run -> applies the migration.
  const run1 = await callTool("migration_run");
  assert("migration_run (1st): no rpc throw", run1.rpcError === null, JSON.stringify(run1.rpcError));
  assert("migration_run (1st): applied the migration",
    Array.isArray(run1.value?.applied) && run1.value.applied.includes(migFile),
    JSON.stringify(run1.value));
  assert("migration_run (1st): no failures",
    Array.isArray(run1.value?.failed) && run1.value.failed.length === 0,
    JSON.stringify(run1.value));

  // migration_status AFTER -> the migration is now COMPLETED, not pending.
  // (Pre-fix: passing the Database wrapper made adapterQuery throw + swallow, so
  // this reported the applied migration as still pending — the wrong-data bug.)
  const statusAfter = await callTool("migration_status");
  assert("migration_status (after run): migration is COMPLETED (not pending)",
    Array.isArray(statusAfter.value?.completed) && statusAfter.value.completed.includes(migFile),
    JSON.stringify(statusAfter.value));
  assert("migration_status (after run): migration no longer pending",
    Array.isArray(statusAfter.value?.pending) && !statusAfter.value.pending.includes(migFile),
    JSON.stringify(statusAfter.value));

  // migration_run AGAIN -> IDEMPOTENT: applies nothing, skips the applied file,
  // no error. (Pre-fix it re-applied every migration on every call.)
  const run2 = await callTool("migration_run");
  assert("migration_run (2nd): no rpc throw", run2.rpcError === null, JSON.stringify(run2.rpcError));
  assert("migration_run (2nd): IDEMPOTENT — applied nothing",
    Array.isArray(run2.value?.applied) && run2.value.applied.length === 0,
    JSON.stringify(run2.value));
  assert("migration_run (2nd): skipped the already-applied migration",
    Array.isArray(run2.value?.skipped) && run2.value.skipped.includes(migFile),
    JSON.stringify(run2.value));
  assert("migration_run (2nd): no failures / no 'already exists' error",
    Array.isArray(run2.value?.failed) && run2.value.failed.length === 0 && !run2.value?.error,
    JSON.stringify(run2.value));

  // seed_table -> INSERTS real rows into the migrated table. inserted > 0.
  // (Pre-fix: no field map -> seeder no-op -> inserted was a SeedSummary object.)
  const SEED_COUNT = 3;
  const seed = await callTool("seed_table", { table: "widgets", count: SEED_COUNT });
  assert("seed_table: no rpc throw", seed.rpcError === null, JSON.stringify(seed.rpcError));
  assert("seed_table: returns an INTEGER inserted count > 0",
    typeof seed.value?.inserted === "number" && seed.value.inserted > 0,
    JSON.stringify(seed.value));
  assert("seed_table: inserted the requested row count",
    seed.value?.inserted === SEED_COUNT,
    JSON.stringify(seed.value));
  // Prove the rows actually landed — query the real table through database_query.
  const count = await callTool("database_query", { sql: "SELECT COUNT(*) AS n FROM widgets" });
  const seededRows = Number(count.value?.records?.[0]?.n ?? -1);
  assert("seed_table: rows are really in the table (COUNT matches)",
    seededRows === SEED_COUNT,
    `COUNT=${seededRows} ${count.raw.slice(0, 160)}`);

  // route_test -> DISPATCHES the route and returns a numeric HTTP status + body.
  // (Pre-fix: an echo stub returning {info, method, path} — no dispatch.)
  const rtOk = await callTool("route_test", { method: "GET", path: "/ping" });
  assert("route_test: no rpc throw", rtOk.rpcError === null, JSON.stringify(rtOk.rpcError));
  assert("route_test: returns a NUMERIC status",
    typeof rtOk.value?.status === "number",
    JSON.stringify(rtOk.value));
  assert("route_test: GET /ping dispatched -> 200 with real body",
    rtOk.value?.status === 200 && String(rtOk.value?.body ?? "").includes("pong"),
    JSON.stringify(rtOk.value));
  assert("route_test: is NOT the old echo stub (no `info` key)",
    rtOk.value && typeof rtOk.value === "object" && !("info" in rtOk.value),
    JSON.stringify(rtOk.value));
  // Negative case: an unknown path really 404s (proves real routing, not echo).
  const rtMiss = await callTool("route_test", { method: "GET", path: "/does-not-exist" });
  assert("route_test: unknown path dispatched -> numeric 404",
    typeof rtMiss.value?.status === "number" && rtMiss.value.status === 404,
    JSON.stringify(rtMiss.value));

  // ────────────────────────────────────────────────────────────────
  // PHASE B — invoke EVERY registered tool once; none may throw.
  // Deterministic order so dependent tools succeed (create the plan before
  // reading/switching/archiving it, write a file before patching it, etc.).
  // ────────────────────────────────────────────────────────────────
  console.log("\n=== Phase B: invoke every registered tool — none may throw ===\n");

  const args: Record<string, Record<string, unknown>> = {
    database_query: { sql: "SELECT id, name, qty FROM widgets" },
    database_execute: { sql: "INSERT INTO widgets (name, qty) VALUES (?, ?)", params: '["Bolt", 7]' },
    database_tables: {},
    database_columns: { table: "widgets" },
    route_list: {},
    route_test: { method: "GET", path: "/ping" },
    swagger_spec: {},
    template_render: { template: "Hello {{ name }}", data: '{"name":"Zed"}' },
    file_read: { path: "package.json" },
    file_write: { path: "conformance_probe.txt", content: "probe-body\n" },
    file_patch: { path: "conformance_probe.txt", old_string: "probe-body", new_string: "probe-patched", count: 1 },
    file_list: { path: "." },
    asset_upload: { filename: "probe-asset.txt", content: "asset", encoding: "utf-8" },
    migration_status: {},
    migration_create: { description: "conformance extra" },
    migration_run: {},
    queue_status: { topic: "default" },
    session_list: {},
    cache_stats: {},
    orm_describe: {},
    log_tail: { lines: 3 },
    error_log: { limit: 5 },
    env_list: {},
    seed_table: { table: "widgets", count: 2 },
    system_info: {},
    docs_list: {},
    docs_search: { query: "route", limit: 3 },
    docs_section: { file: "CLAUDE.md", heading: "Routes" },
    git_status: {},
    deps_list: {},
    project_overview: {},
    index_rebuild: {},
    index_search: { query: "widget", limit: 5 },
    index_file: { path: "package.json" },
    index_overview: {},
    plan_create: { title: "Conformance Plan", goal: "probe the tools", steps: ["step one", "step two"], make_current: true },
    plan_current: {},
    plan_list: {},
    plan_read: { name: "conformance_plan" },
    plan_switch_to: { name: "conformance_plan" },
    plan_complete_step: { index: 0 },
    plan_add_step: { text: "step three" },
    plan_note: { text: "a breadcrumb" },
    plan_flesh: { name: "__nonexistent_plan__", prompt: "" }, // nonexistent -> bails before any AI fetch
    plan_archive: { name: "conformance_plan" },
    api_search: { query: "Database", k: 3 },
    api_class: { name: "Database" },
    api_method: { class: "Database", name: "fetch" },
    code_search: { query: "router", k: 3 },
  };

  const order = [
    "system_info", "deps_list", "git_status", "env_list",
    "file_write", "file_patch", "file_read", "file_list", "asset_upload",
    "database_execute", "database_query", "database_tables", "database_columns",
    "route_list", "route_test", "swagger_spec", "template_render",
    "migration_create", "migration_status", "migration_run",
    "queue_status", "session_list", "cache_stats", "orm_describe", "log_tail", "error_log", "seed_table",
    "docs_list", "docs_search", "docs_section",
    "index_rebuild", "index_search", "index_file", "index_overview", "project_overview",
    "plan_create", "plan_current", "plan_list", "plan_read", "plan_switch_to", "plan_complete_step", "plan_add_step", "plan_note", "plan_flesh", "plan_archive",
    "api_search", "api_class", "api_method", "code_search",
  ];

  // Invoke ordered tools, then any remaining registered tool (safety net so a
  // NEWLY-added tool is still exercised even before it lands in `order`).
  const invoked = new Set<string>();
  const sequence = [...order.filter((t) => toolNames.includes(t)), ...toolNames.filter((t) => !order.includes(t))];

  for (const name of sequence) {
    if (invoked.has(name)) continue;
    invoked.add(name);
    let res: { rpcError: any; value: any; raw: string };
    try {
      res = await callTool(name, args[name] ?? {});
    } catch (e) {
      assert(`${name}: did not throw`, false, `harness-caught throw: ${(e as Error).message}`);
      continue;
    }
    if (res.rpcError) {
      assert(`${name}: did not throw`, false, `JSON-RPC error: ${JSON.stringify(res.rpcError)}`);
      continue;
    }
    // A handler-returned error string is only a FAILURE when it looks like a
    // code bug; a graceful domain error (e.g. "Not a git repository") is fine.
    const errStr = res.value && typeof res.value === "object" && !Array.isArray(res.value) && typeof res.value.error === "string"
      ? res.value.error
      : null;
    if (errStr && CODE_BUG.test(errStr)) {
      assert(`${name}: no code-bug error`, false, `code-bug: ${errStr}`);
    } else {
      assert(`${name}: invoked without throwing`, true);
    }
  }

  // Every registered tool must have been exercised.
  assert("every registered tool was invoked",
    toolNames.every((t) => invoked.has(t)),
    `missed: ${toolNames.filter((t) => !invoked.has(t)).join(", ")}`);
}

try {
  await main();
} catch (e) {
  assert("conformance harness ran to completion", false, (e as Error).stack ?? String(e));
} finally {
  try { closeDatabase(); } catch { /* noop */ }
  process.chdir(origCwd);
  try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`MCP Dev-Tools Conformance: ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(50)}\n`);

if (fail > 0) {
  process.exit(1);
}

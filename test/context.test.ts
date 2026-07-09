/**
 * Real, no-mock tests for the native Context code/doc grounding subsystem.
 *
 * Every test uses a REAL temp SQLite file (node:sqlite) and REAL temp source
 * files — there is nothing to mock. They pin the same behaviours as
 * tina4-python/tests/test_context.py:
 *
 *   1. ranking: a definition out-ranks a test that merely mentions the symbol;
 *   2. reindex-on-change: indexPath is an UPSERT (new found, old gone, no dupes);
 *   3. FTS5 availability guard: detected for real, and a Context that finds FTS5
 *      absent degrades to safe no-ops instead of crashing;
 *   4. reindexFile UPSERT against a subdir root (+ skip/ineligible/delete);
 *   5. result shape + the dev-MCP code_search tool over a real temp project;
 *   6. the dev-reload TRIGGER (handleReload) reindexes the changed file.
 *
 * Symbols are deliberately NON-OVERLAPPING (wombat/giraffe, whirligig, …) so no
 * two probes cross-match on FTS and false-pass/fail.
 *
 * Run with: npx tsx test/context.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  Context,
  defaultContext,
  existingContext,
  _sharedContexts,
  DevAdmin,
  Router,
} from "../packages/core/src/index.js";
import { McpServer, registerDevTools } from "../packages/core/src/mcp.js";

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

// A real, symlink-free temp dir (macOS /var + mkdtemp are symlinks; realpath so
// the index root and a chdir'd process.cwd() agree in reindexFile).
function realTmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ctx-")));
}

function write(root: string, rel: string, body: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ── 1. ranking — definition above a test that mentions the symbol ──────────
console.log("\n--- ranking: definition out-ranks test that mentions symbol ---");
{
  const root = realTmp();
  const app = path.join(root, "app");
  write(app, "src/auth.ts",
    "export function issueToken(user) {\n" +
    "  // issue an auth token for a user\n" +
    "  return sign(user);\n" +
    "}\n");
  // a test file that MENTIONS issueToken many times (BM25 loves this) but does
  // NOT define it — it must not out-rank the definition.
  write(app, "tests/auth.test.ts",
    "export function checkAuthFlow() {\n" +
    "  if (!issueToken(1)) throw new Error('no');\n" +
    "  if (!issueToken(2)) throw new Error('no');\n" +
    "  if (!issueToken(3)) throw new Error('no');\n" +
    "  if (!issueToken(4)) throw new Error('no');\n" +
    "}\n");

  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  const n = ctx.indexRoot(app);
  assert("indexRoot inserts chunks", n > 0, `n=${n}`);

  const res = ctx.search("issueToken", 5);
  const paths = res.map((r) => r.path);
  assert("definition source surfaces", paths.some((p) => p.endsWith("auth.ts") && !p.includes("test")), JSON.stringify(paths));
  assert("test file surfaces too", paths.some((p) => p.includes("auth.test")), JSON.stringify(paths));
  const srcIdx = res.findIndex((r) => r.path.endsWith("auth.ts") && !r.path.includes("test"));
  const testIdx = res.findIndex((r) => r.path.includes("auth.test"));
  assert("definition out-ranks the test", srcIdx >= 0 && testIdx >= 0 && srcIdx < testIdx, `src=${srcIdx} test=${testIdx} ${JSON.stringify(paths)}`);
  assert("top hit is the definition, not the test", res.length > 0 && !res[0].path.includes("test"), JSON.stringify(paths));
  ctx.close();
  cleanup(root);
}

// ── 2. reindex-on-change — UPSERT: new found, old gone, no duplication ─────
console.log("\n--- reindexPath is an UPSERT ---");
{
  const root = realTmp();
  const f = write(root, "app/src/mod.ts", "export function wombat() {\n  return 1;\n}\n");
  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  ctx.indexPath(f, "src/mod.ts");

  assert("wombat found first", ctx.search("wombat").some((r) => r.path === "src/mod.ts"));
  const rowsBefore = ctx.count();

  fs.writeFileSync(f, "export function giraffe() {\n  return 2;\n}\n", "utf-8");
  ctx.indexPath(f, "src/mod.ts");

  assert("giraffe found after reindex", ctx.search("giraffe").some((r) => r.path === "src/mod.ts"));
  assert("wombat chunks are gone (upsert deleted stale)", !ctx.search("wombat").some((r) => r.path === "src/mod.ts"));
  assert("no row duplication (delete-then-insert)", ctx.count() === rowsBefore, `before=${rowsBefore} after=${ctx.count()}`);
  ctx.close();
  cleanup(root);
}

console.log("\n--- indexPath second call replaces, not appends ---");
{
  const root = realTmp();
  const f = write(root, "app/src/dup.ts", "export function onlyOne() {\n  return 42;\n}\n");
  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  ctx.indexPath(f, "src/dup.ts");
  const n1 = ctx.count();
  ctx.indexPath(f, "src/dup.ts");
  assert("re-indexing an unchanged file does not append duplicates", ctx.count() === n1, `n1=${n1} n2=${ctx.count()}`);
  ctx.close();
  cleanup(root);
}

// ── 3. FTS5 availability guard ─────────────────────────────────────────────
console.log("\n--- FTS5 availability guard ---");
{
  assert("fts5Available() is true on this Node build", Context.fts5Available() === true);
}
{
  const root = realTmp();
  write(root, "app/src/x.ts", "export function y() {\n  return 1;\n}\n");
  // inject a predicate reporting FTS5 ABSENT — exercises the real graceful-
  // degradation branch (no mocking of sqlite or files).
  const ctx = new Context(path.join(root, ".tina4", "context.db"), () => false);
  assert("available is false when FTS5 absent", ctx.available === false);
  assert("indexRoot is a no-op (0)", ctx.indexRoot(path.join(root, "app")) === 0);
  assert("indexPath is a no-op (0)", ctx.indexPath(path.join(root, "app", "src", "x.ts"), "src/x.ts") === 0);
  assert("search returns []", JSON.stringify(ctx.search("anything")) === "[]");
  ctx.close();

  const ok = new Context(path.join(root, ".tina4", "ok.db"));
  assert("a normal Context on this interpreter IS available", ok.available === true);
  ok.close();
  cleanup(root);
}

// ── 4. result shape, score ordering, doc chunking, dir skipping ────────────
console.log("\n--- result shape + score ordering ---");
{
  const root = realTmp();
  write(root, "app/src/widget.ts",
    "export function buildWidget(spec) {\n  return new Widget(spec);\n}\n\n" +
    "export class Widget {}\n");
  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  ctx.indexRoot(path.join(root, "app"));

  const res = ctx.search("buildWidget", 5);
  assert("at least one hit", res.length > 0);
  let shapeOk = true;
  for (const r of res) {
    if (!("path" in r && "score" in r && "snippet" in r)) shapeOk = false;
    if (typeof r.score !== "number") shapeOk = false;
    if (typeof r.snippet !== "string" || r.snippet.length === 0) shapeOk = false;
  }
  assert("every hit has {path, score:number, snippet:non-empty}", shapeOk, JSON.stringify(res));
  const scores = res.map((r) => r.score);
  const desc = [...scores].sort((a, b) => b - a);
  assert("higher score = better; sorted descending", JSON.stringify(scores) === JSON.stringify(desc), JSON.stringify(scores));
  ctx.close();
  cleanup(root);
}

console.log("\n--- indexes docs as prose + skips vendor dirs ---");
{
  const root = realTmp();
  write(root, "app/docs/guide.md",
    "# Overview\n\nThe whirligig subsystem manages the flux capacitor and its temporal bindings.\n");
  // these live under dirs neemee skips — must NOT be indexed
  write(root, "app/__pycache__/junk.py", "def whirligig_flux_capacitor(): pass\n");
  write(root, "app/node_modules/lib.js", "function whirligigFluxCapacitor(){}\n");

  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  ctx.indexRoot(path.join(root, "app"));

  const res = ctx.search("whirligig flux capacitor", 5);
  const paths = res.map((r) => r.path);
  assert("doc surfaces (chunked as prose)", paths.some((p) => p.endsWith("guide.md")), JSON.stringify(paths));
  assert("__pycache__ is skipped", !paths.some((p) => p.includes("__pycache__")), JSON.stringify(paths));
  assert("node_modules is skipped", !paths.some((p) => p.includes("node_modules")), JSON.stringify(paths));
  ctx.close();
  cleanup(root);
}

console.log("\n--- empty / stopword query returns [] ---");
{
  const root = realTmp();
  write(root, "app/src/a.ts", "export function a() {\n  return 1;\n}\n");
  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  ctx.indexRoot(path.join(root, "app"));
  assert("empty query -> []", JSON.stringify(ctx.search("")) === "[]");
  assert("whitespace query -> []", JSON.stringify(ctx.search("   ")) === "[]");
  ctx.close();
  cleanup(root);
}

// ── 5. reindexFile UPSERT against a subdir root ────────────────────────────
console.log("\n--- reindexFile upserts against a subdir root ---");
{
  const root = realTmp();
  write(root, "src/mod.ts", "export function wombat() {\n  return 1;\n}\n");
  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  ctx.indexRoot(path.join(root, "src")); // root = src/, label = "mod.ts"
  assert("wombat found (label relative to src)", ctx.search("wombat").some((r) => r.path === "mod.ts"));

  fs.writeFileSync(path.join(root, "src", "mod.ts"), "export function giraffe() {\n  return 2;\n}\n", "utf-8");
  const old = process.cwd();
  process.chdir(root);
  try {
    assert("reindexFile('src/mod.ts') upserts (>=1)", ctx.reindexFile("src/mod.ts") >= 1);
  } finally {
    process.chdir(old);
  }
  assert("new content found after reindexFile", ctx.search("giraffe").some((r) => r.path === "mod.ts"));
  assert("old content gone after reindexFile", !ctx.search("wombat").some((r) => r.path === "mod.ts"));
  ctx.close();
  cleanup(root);
}

console.log("\n--- reindexFile skips outside-root / ineligible / skip-dirs ---");
{
  const root = realTmp();
  write(root, "src/a.ts", "export function a() {\n  return 1;\n}\n");
  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  ctx.indexRoot(path.join(root, "src"));
  const old = process.cwd();
  process.chdir(root);
  try {
    write(root, "README.md", "# top-level, outside src/\n");
    assert("outside index root -> -1", ctx.reindexFile("README.md") === -1);
    write(root, "src/data.bin", "x");
    assert("ineligible extension -> -1", ctx.reindexFile("src/data.bin") === -1);
    write(root, "src/__pycache__/j.ts", "export function j() {}\n");
    assert("under a skip-dir -> -1", ctx.reindexFile("src/__pycache__/j.ts") === -1);
  } finally {
    process.chdir(old);
  }
  ctx.close();
  cleanup(root);
}

console.log("\n--- reindexFile drops a deleted file ---");
{
  const root = realTmp();
  const f = write(root, "src/gone.ts", "export function uniqueGoneSym() {\n  return 1;\n}\n");
  const ctx = new Context(path.join(root, ".tina4", "context.db"));
  ctx.indexRoot(path.join(root, "src"));
  assert("uniqueGoneSym found before delete", ctx.search("uniqueGoneSym").some((r) => r.path === "gone.ts"));
  fs.unlinkSync(f);
  const old = process.cwd();
  process.chdir(root);
  try {
    assert("delete -> drop rows (0)", ctx.reindexFile("src/gone.ts") === 0);
  } finally {
    process.chdir(old);
  }
  assert("deleted file's chunks are gone", JSON.stringify(ctx.search("uniqueGoneSym")) === "[]");
  ctx.close();
  cleanup(root);
}

console.log("\n--- defaultContext is a shared singleton ---");
{
  _sharedContexts.clear();
  const root = realTmp();
  const db = path.join(root, ".tina4", "ctx.db");
  write(root, "src/x.ts", "export function findmeSym() {\n  return 1;\n}\n");
  const a = defaultContext(path.join(root, "src"), db);
  assert("same db path -> same instance", a === defaultContext(undefined, db));
  assert("existingContext(db) is the instance", existingContext(db) === a);
  assert("existingContext(other) is undefined", existingContext(path.join(root, "nope.db")) === undefined);
  assert("shared index is searchable", a.search("findmeSym").some((r) => r.path.includes("x.ts")));
  a.close();
  _sharedContexts.clear();
  cleanup(root);
}

// ── 6. the dev-reload TRIGGER reindexes the changed file end-to-end ────────
console.log("\n--- handleReload (POST /__dev/api/reload) reindexes changed file ---");
{
  process.env.TINA4_DEBUG = "true";
  _sharedContexts.clear();
  const root = realTmp();
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "mod.ts"), "export function wombat() {\n  return 1;\n}\n", "utf-8");

  // Register the DevAdmin routes on a real Router and grab the reload handler —
  // the same pattern devAdmin.test.ts uses to invoke a __dev endpoint.
  const router = new Router();
  DevAdmin.register(router);
  const reload = router.getRoutes().find((r) => r.method === "POST" && r.pattern === "/__dev/api/reload")?.handler;
  assert("POST /__dev/api/reload handler is registered", reload !== undefined);

  const old = process.cwd();
  process.chdir(root);
  try {
    // build the shared index the way code_search does (cwd/.tina4/context.db)
    const ctx = defaultContext(src);
    assert("wombat indexed before edit", ctx.search("wombat").some((r) => r.path === "mod.ts"));

    // edit, then FIRE the reload trigger with the changed file (real req/res)
    fs.writeFileSync(path.join(src, "mod.ts"), "export function giraffe() {\n  return 2;\n}\n", "utf-8");
    if (reload) {
      const req: any = { url: "/__dev/api/reload", method: "POST", headers: {}, body: { file: "src/mod.ts", type: "reload" } };
      const res: any = { json() {}, html() {} };
      await reload(req, res);
    }

    assert("reload trigger reindexed new content", ctx.search("giraffe").some((r) => r.path === "mod.ts"));
    assert("old content gone after reload reindex", !ctx.search("wombat").some((r) => r.path === "mod.ts"));
    ctx.close();
  } finally {
    process.chdir(old);
    _sharedContexts.clear();
  }
  cleanup(root);
}

// ── 7. dev-MCP code_search tool — real registration over a temp project ────
console.log("\n--- dev-MCP code_search tool ---");
{
  const root = realTmp();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.ts"),
    "export function widgetFactory(name) {\n" +
    "  // create a configured widget\n" +
    "  return { name };\n" +
    "}\n", "utf-8");

  const old = process.cwd();
  process.chdir(root); // registerDevTools captures projectRoot = cwd
  try {
    const server = new McpServer("/test-code-search", "code_search test");
    registerDevTools(server);

    // tool is registered (sibling of api_search)
    const listed = JSON.parse(await server.handleMessage({
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    }));
    const names = new Set<string>((listed.result.tools as Array<{ name: string }>).map((t) => t.name));
    assert("code_search is registered", names.has("code_search"), [...names].join(","));

    const resp = JSON.parse(await server.handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "code_search", arguments: { query: "widgetFactory" } },
    }));
    assert("code_search call returns a result", "result" in resp, JSON.stringify(resp));
    const payload = JSON.parse(resp.result.content[0].text);
    assert("payload is an array", Array.isArray(payload), JSON.stringify(payload));
    const paths = (payload as Array<{ path: string }>).map((r) => r.path);
    assert("finds service.ts", paths.some((p) => p.endsWith("service.ts")), JSON.stringify(payload));
  } finally {
    process.chdir(old);
    _sharedContexts.clear();
  }
  cleanup(root);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

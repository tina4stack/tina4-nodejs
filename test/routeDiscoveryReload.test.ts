/**
 * Tests for reload-aware route discovery — covers the developer pain
 * point where a fresh `tina4 init` + a file added to src/routes/ did not
 * register until a server restart.
 *
 * Run with: npx tsx test/routeDiscoveryReload.test.ts
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverRoutes,
  rediscoverRoutes,
  _resetRouteDiscovery,
} from "../packages/core/src/routeDiscovery.ts";

/** Push a file's mtime forward so an edit isn't masked by same-millisecond writes. */
function bumpMtime(filePath: string, secondsAhead = 2): void {
  const when = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(filePath, when, when);
}

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

function makeTempProject(): { dir: string; routes: string } {
  const dir = resolve(tmpdir(), `tina4_reload_discovery_${process.pid}_${Date.now()}`);
  const routes = join(dir, "src", "routes");
  mkdirSync(routes, { recursive: true });
  return { dir, routes };
}

function writeRouteFile(routesDir: string, relPath: string, body: string): string {
  const full = join(routesDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
}

console.log("=== Route Discovery — Reload Behaviour ===\n");

// ── Test 1: discoverRoutes is idempotent ────────────────────────────────
{
  const { dir, routes } = makeTempProject();
  _resetRouteDiscovery();

  writeRouteFile(
    routes,
    "get.ts",
    `export default async function (req: any, res: any) { res.json({ ok: true }); }\n`,
  );

  const first = await discoverRoutes(routes);
  const second = await discoverRoutes(routes);

  assert("first scan picks up the file", first.length === 1, `got ${first.length}`);
  assert("second scan adds zero new routes", second.length === 0, `got ${second.length}`);

  rmSync(dir, { recursive: true });
}

// ── Test 2: rediscoverRoutes picks up files added after the first scan ──
{
  const { dir, routes } = makeTempProject();
  _resetRouteDiscovery();

  writeRouteFile(
    routes,
    "get.ts",
    `export default async function (req: any, res: any) { res.json({ ok: true }); }\n`,
  );

  const initial = await discoverRoutes(routes);
  assert("initial scan finds the root file", initial.length === 1);

  // Simulate the user dropping a new file after the server is already running.
  writeRouteFile(
    routes,
    join("hello", "get.ts"),
    `export default async function (req: any, res: any) { res.json({ ok: true }); }\n`,
  );

  const added = await rediscoverRoutes();
  assert("rediscoverRoutes returns only the new file", added.length === 1, `got ${added.length}`);
  assert("new route has the expected pattern", added[0]?.pattern === "/hello", `pattern=${added[0]?.pattern}`);

  rmSync(dir, { recursive: true });
}

// ── Test 3: rediscoverRoutes is a no-op before any discoverRoutes call ──
{
  _resetRouteDiscovery();
  const added = await rediscoverRoutes();
  assert("rediscoverRoutes returns [] with no prior scan", added.length === 0);
}

// ── Test 4: broken route file leaves a .broken sentinel ─────────────────
{
  const { dir, routes } = makeTempProject();
  _resetRouteDiscovery();
  const originalCwd = process.cwd();
  process.chdir(dir);

  // Deliberate syntax error inside the module that will throw at import time.
  writeRouteFile(
    routes,
    "get.ts",
    `export default async function (req, res {\n  // unclosed brace — parse error\n`,
  );

  try {
    await discoverRoutes(routes);

    const brokenDir = join(dir, "data", ".broken");
    assert("data/.broken directory is created on import failure", existsSync(brokenDir));
    if (existsSync(brokenDir)) {
      const sentinels = readdirSync(brokenDir).filter((f) => f.startsWith("discover_") && f.endsWith(".broken"));
      assert("at least one .broken sentinel is written", sentinels.length > 0, `found ${sentinels.length}`);
      if (sentinels.length > 0) {
        const payload = readFileSync(join(brokenDir, sentinels[0]), "utf8");
        assert("sentinel mentions auto_discover_failure", payload.includes("auto_discover_failure"));
        assert("sentinel references the broken file path", payload.includes("get.ts"));
      }
    }
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true });
  }
}

// ── Test 5: editing an existing route file re-enters discovery ──────────
// This is the bug fix. Previously an already-seen file was skipped outright
// (`if (_seenFiles.has(filePath)) continue;`), so an edit to get.ts never
// reached the import() call and the stale handler was served forever. With
// mtime tracking the skip is bypassed when the file changes, so the edited
// file is re-imported and returned by rediscoverRoutes() — and addRoute()
// replaces the route by pattern. (The bumped mtime also drives the `?t=`
// cache-bust, which delivers the new module under plain Node — see Test 5b.)
{
  const { dir, routes } = makeTempProject();
  _resetRouteDiscovery();

  const file = writeRouteFile(
    routes,
    "get.ts",
    `export default async function (req: any, res: any) { res.json({ version: "v1" }); }\n`,
  );

  const first = await discoverRoutes(routes);
  assert("edit: first scan picks up the file", first.length === 1, `got ${first.length}`);
  assert("edit: first handler is v1", first[0]?.handler.toString().includes(`"v1"`));

  // A second scan with NO change skips the file (mtime unchanged).
  const noChange = await rediscoverRoutes();
  assert("edit: unchanged file is skipped on rescan", noChange.length === 0, `got ${noChange.length}`);

  // Developer edits the file while the server is running.
  writeFileSync(
    file,
    `export default async function (req: any, res: any) { res.json({ version: "v2" }); }\n`,
  );
  bumpMtime(file);

  // The edit bumps mtime → the skip is bypassed → the file is re-imported and
  // returned. This is the behaviour the fix adds; before the fix this was [].
  const after = await rediscoverRoutes();
  assert("edit: rediscover re-enters the changed file", after.length === 1, `got ${after.length}`);
  assert("edit: changed file keeps its pattern", after[0]?.pattern === "/", `pattern=${after[0]?.pattern}`);

  rmSync(dir, { recursive: true });
}

// ── Test 5b: the cache-bust query delivers the NEW module source ────────
// The mtime feeds the `?t=<mtime>` import() cache-bust. Under plain Node's
// ESM loader (the production/built runtime, dist/*.js) a changed file is
// re-evaluated and the fresh handler is returned. We assert this directly
// against node's loader with a .mjs module so it's independent of the tsx
// dev loader (which caches .ts by path and is exercised by Test 5 above).
{
  const dir = resolve(tmpdir(), `tina4_reload_cachebust_${process.pid}_${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const mod = join(dir, "handler.mjs");

  const { statSync } = await import("node:fs");

  writeFileSync(mod, `export const handler = () => "v1";\n`);
  const a = await import(`file://${mod}?t=${statSync(mod).mtimeMs}`);
  assert("cachebust: first import is v1", a.handler() === "v1");

  writeFileSync(mod, `export const handler = () => "v2";\n`);
  bumpMtime(mod);
  const b = await import(`file://${mod}?t=${statSync(mod).mtimeMs}`);
  assert("cachebust: mtime-keyed re-import delivers v2 (not stale v1)", b.handler() === "v2", `got ${b.handler()}`);

  rmSync(dir, { recursive: true });
}

// ── Test 6: an unchanged file is NOT re-imported on a second pass ───────
// Module top-level side effects must run exactly once per (file, mtime).
// We prove it by having the module increment a global counter at import
// time and asserting it stays at 1 across a no-op rediscover.
{
  const { dir, routes } = makeTempProject();
  _resetRouteDiscovery();

  const counterKey = `__tina4_reload_import_count_${process.pid}`;
  (globalThis as any)[counterKey] = 0;

  const file = writeRouteFile(
    routes,
    "get.ts",
    `(globalThis as any)[${JSON.stringify(counterKey)}] += 1;\n` +
    `export default async function (req: any, res: any) { res.json({ ok: true }); }\n`,
  );
  // Keep the file's mtime stable across both scans.
  bumpMtime(file);

  await discoverRoutes(routes);
  const afterFirst = (globalThis as any)[counterKey];
  assert("unchanged: module imported once on first scan", afterFirst === 1, `count=${afterFirst}`);

  const second = await rediscoverRoutes();
  const afterSecond = (globalThis as any)[counterKey];
  assert("unchanged: rediscover returns nothing for the untouched file", second.length === 0, `got ${second.length}`);
  assert("unchanged: module NOT re-imported (counter still 1)", afterSecond === 1, `count=${afterSecond}`);

  delete (globalThis as any)[counterKey];
  rmSync(dir, { recursive: true });
}

// ── Test 7: e2e — POST /__dev/api/reload re-registers the changed route ──
// Drive the real devAdmin reload handler (the production hot-reload path):
// it calls rediscoverRoutes() and registers every result on defaultRouter
// via addRoute(), which replaces by pattern. We assert the full wiring:
//   1. editing a route file makes the reload handler re-discover it,
//   2. it is re-registered on the default router (addRoute called),
//   3. the route still resolves and is NOT duplicated (replace-by-pattern).
// Under plain Node the re-registered handler is the fresh v2 module (the
// `?t=<mtime>` bust); under the tsx dev loader the module body is cached by
// path, so we assert the wiring/registration here and prove fresh-source
// delivery against node's loader in Test 5b.
{
  const { dir, routes } = makeTempProject();
  _resetRouteDiscovery();

  const { defaultRouter, Router } = await import("../packages/core/src/router.ts");
  const { DevAdmin } = await import("../packages/core/src/index.ts");
  process.env.TINA4_DEBUG = "true";

  // Use a unique path so this test's route can't collide with another test's
  // "/" route on the shared default router.
  const file = writeRouteFile(
    routes,
    join("reload_e2e", "get.ts"),
    `export default async function (req: any, res: any) { res.json({ version: "v1" }); }\n`,
  );
  const pattern = "/reload_e2e";

  // Initial discovery → register on the default router (mirrors server boot).
  const initial = await discoverRoutes(routes);
  for (const r of initial) defaultRouter.addRoute(r);
  const before = defaultRouter.match("GET", pattern);
  assert("e2e: route resolves before reload", before !== null);

  const getCountFor = (p: string) =>
    defaultRouter.getRoutes().filter((r) => r.method === "GET" && r.pattern === p).length;
  assert("e2e: exactly one route registered before reload", getCountFor(pattern) === 1);

  // Register the devAdmin endpoints so we can invoke the real reload handler.
  const adminRouter = new Router();
  DevAdmin.register(adminRouter);
  const reloadHandler = adminRouter.getRoutes().find(
    (r) => r.method === "POST" && r.pattern === "/__dev/api/reload",
  )?.handler;
  assert("e2e: reload handler is registered", reloadHandler !== undefined);

  // Edit the file, then fire the reload exactly as the Rust CLI would.
  writeFileSync(
    file,
    `export default async function (req: any, res: any) { res.json({ version: "v2" }); }\n`,
  );
  bumpMtime(file);

  if (reloadHandler) {
    let captured: any;
    const res: any = { json(d: any) { captured = d; }, html() {} };
    const req: any = { url: "/__dev/api/reload", method: "POST", headers: {}, body: { file: "reload_e2e/get.ts", type: "reload" } };
    await reloadHandler(req, res);
    assert("e2e: reload responded ok", captured?.ok === true);
  }

  const after = defaultRouter.match("GET", pattern);
  assert("e2e: route still resolves after reload", after !== null);
  assert("e2e: route replaced in place, not duplicated", getCountFor(pattern) === 1, `count=${getCountFor(pattern)}`);

  rmSync(dir, { recursive: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

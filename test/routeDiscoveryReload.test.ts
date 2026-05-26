/**
 * Tests for reload-aware route discovery — covers the developer pain
 * point where a fresh `tina4 init` + a file added to src/routes/ did not
 * register until a server restart.
 *
 * Run with: npx tsx test/routeDiscoveryReload.test.ts
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverRoutes,
  rediscoverRoutes,
  _resetRouteDiscovery,
} from "../packages/core/src/routeDiscovery.ts";

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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

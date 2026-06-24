/**
 * Tests that route discovery works correctly when basePath is provided.
 * Run with: npx tsx test/basePath.test.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverRoutes, _resetRouteDiscovery } from "../packages/core/src/routeDiscovery.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== basePath Route Discovery Tests ===\n");

// Create a temporary directory structure simulating basePath usage
import { tmpdir } from "node:os";
const tmpBase = resolve(tmpdir(), `tina4-basepath-test-${Date.now()}`);
const routesDir = join(tmpBase, "src", "routes");
const apiUsersDir = join(routesDir, "api", "users");
const apiUsersIdDir = join(routesDir, "api", "users", "[id]");

try {
  // Set up directory structure
  mkdirSync(apiUsersDir, { recursive: true });
  mkdirSync(apiUsersIdDir, { recursive: true });

  // Create route files
  writeFileSync(
    join(apiUsersDir, "get.ts"),
    `export default async function(req: any, res: any) { return res.json({ users: [] }); }\n`
  );
  writeFileSync(
    join(apiUsersDir, "post.ts"),
    `export default async function(req: any, res: any) { return res.json({ created: true }); }\n`
  );
  writeFileSync(
    join(apiUsersIdDir, "get.ts"),
    `export default async function(req: any, res: any) { return res.json({ id: req.params.id }); }\n`
  );

  // Test 1: discoverRoutes finds routes when given the correct routesDir
  console.log("--- Route discovery with explicit routesDir ---");
  const routes = await discoverRoutes(routesDir);

  assert("discovers routes from routesDir", routes.length === 3, `expected 3 routes, got ${routes.length}`);

  const methods = routes.map((r) => r.method).sort();
  assert("found GET and POST methods", JSON.stringify(methods) === JSON.stringify(["GET", "GET", "POST"]), `methods: ${methods}`);

  const patterns = routes.map((r) => r.pattern).sort();
  assert("correct patterns generated", patterns.includes("/api/users"), `patterns: ${patterns}`);
  assert("dynamic param pattern correct", patterns.includes("/api/users/{id}"), `patterns: ${patterns}`);

  // Test 2: discovery wired through the basePath entry point finds the routes.
  // The server resolves its routes dir as resolve(basePath, "src/routes"); we
  // exercise that exact derivation and assert discoverRoutes() returns the 3
  // routes with the right patterns — proving the basePath wiring drives real
  // discovery, not that node's path.resolve concatenates strings.
  console.log("\n--- discovery via basePath entry point ---");
  const basePath = tmpBase;
  const routesFromBase = resolve(basePath, "src/routes");
  _resetRouteDiscovery(); // forget Test 1's scan so the same files re-discover
  const basePathRoutes = await discoverRoutes(routesFromBase);
  assert(
    "basePath-derived dir discovers all 3 routes",
    basePathRoutes.length === 3,
    `expected 3 routes from ${routesFromBase}, got ${basePathRoutes.length}`,
  );
  const basePatterns = basePathRoutes.map((r) => r.pattern).sort();
  assert(
    "basePath discovery yields the api/users patterns",
    basePatterns.includes("/api/users") && basePatterns.includes("/api/users/{id}"),
    `patterns: ${basePatterns}`,
  );
  const basePathMethods = basePathRoutes.map((r) => r.method).sort();
  assert(
    "basePath discovery yields GET, GET, POST",
    JSON.stringify(basePathMethods) === JSON.stringify(["GET", "GET", "POST"]),
    `methods: ${basePathMethods}`,
  );

  // Test 3: without a basePath, discovery is cwd-relative — so resolving the
  // same "src/routes" against the process cwd (NOT tmpBase) must NOT find the
  // temp routes. This proves the real behaviour the old assertion only hinted
  // at: discovery follows the resolved path, and an unset basePath silently
  // points it at the wrong (cwd) tree rather than the temp project.
  console.log("\n--- discovery without basePath uses cwd (finds nothing here) ---");
  const routesFromCwd = resolve("src/routes");
  assert(
    "cwd-relative path differs from the temp routes dir",
    routesFromCwd !== routesFromBase,
    `cwd path ${routesFromCwd} unexpectedly equals base path ${routesFromBase}`,
  );
  _resetRouteDiscovery();
  const cwdRoutes = await discoverRoutes(routesFromCwd);
  assert(
    "cwd-relative discovery does NOT find the temp routes",
    cwdRoutes.length !== 3,
    `expected to miss the 3 temp routes from ${routesFromCwd}, got ${cwdRoutes.length}`,
  );

} finally {
  // Clean up
  rmSync(tmpBase, { recursive: true, force: true });
}

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);

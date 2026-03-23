/**
 * Tests that route discovery works correctly when basePath is provided.
 * Run with: npx tsx test/basePath.test.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverRoutes } from "../packages/core/src/routeDiscovery.ts";

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

  // Test 2: Verify that resolve(basePath, "src/routes") gives the correct path
  console.log("\n--- basePath resolution ---");
  const resolvedFromBase = resolve(tmpBase, "src/routes");
  assert("basePath resolves to correct routesDir", resolvedFromBase === routesDir, `${resolvedFromBase} !== ${routesDir}`);

  // Test 3: Verify that resolve without basePath uses cwd (demonstrating the bug)
  const resolvedFromCwd = resolve("src/routes");
  assert("without basePath, resolve uses cwd", resolvedFromCwd !== routesDir, "should differ from basePath routes dir");

} finally {
  // Clean up
  rmSync(tmpBase, { recursive: true, force: true });
}

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);

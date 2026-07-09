/**
 * Tests for the AutoCrud `public` opt-in (parity with tina4-python + tina4-php).
 *
 * Node's write routes are already secure-by-default (router.ts marks
 * POST/PUT/PATCH/DELETE `secure: true` unless a def sets `secure: false`).
 * AutoCrud must therefore be secure-by-default too, and expose a `public`
 * escape hatch so a developer can open the generated write routes — the same
 * knob python (`public=True`) and php (`bool $public`) grew.
 *
 * These tests exercise the REAL route-generation path (generateCrudRoutes) and
 * the REAL router secure-by-default gate (Router.addRoute / match) — no mocks.
 *
 * Run with: npx tsx test/autoCrudPublic.test.ts
 */
import { generateCrudRoutes, AutoCrud } from "../packages/orm/src/index.ts";
import type { DiscoveredModel } from "../packages/orm/src/index.ts";
import { Router } from "../packages/core/src/router.ts";

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

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE"]);

// Distinct table names (no overlap with autoCrud.test / autoCrudFlag.test) so
// several models can coexist in one Router without pattern collisions.
function modelFor(tableName: string): DiscoveredModel {
  return {
    filePath: `src/models/${tableName}.ts`,
    definition: {
      tableName,
      fields: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        title: { type: "string", required: true },
      },
    },
  };
}

// Register a set of route defs on a fresh Router and read back the router's
// resolved `secure` flag for a given method+concrete-path. This is the REAL
// secure-by-default gate (router.ts:187), not a re-implementation.
function routerSecure(defs: ReturnType<typeof generateCrudRoutes>, method: string, path: string): boolean | undefined {
  const router = new Router();
  for (const def of defs) router.addRoute(def);
  return router.match(method, path)?.secure;
}

console.log("=== AutoCrud `public` opt-in Tests ===\n");

// ── Test 1: DEFAULT registration → write routes are secure (gated) ──────────
console.log("--- Default (secure-by-default) ---");
{
  const defs = generateCrudRoutes([modelFor("secure_notes")]);
  const writeDefs = defs.filter((d) => WRITE_METHODS.has(d.method));

  assert("default: has 3 write route defs (POST/PUT/DELETE)", writeDefs.length === 3,
    `got ${writeDefs.length}`);

  // Def-level: secure-by-default means the def does NOT opt out (`secure` is not
  // false) — it leaves the flag unset so the router applies its write gate.
  assert("default: no write def sets secure:false",
    writeDefs.every((d) => d.secure !== false),
    `secure values: ${writeDefs.map((d) => `${d.method}=${String(d.secure)}`).join(", ")}`);

  // Behavioural: the REAL router gates each write route (secure === true).
  assert("default: router gates POST (secure=true)",
    routerSecure(defs, "POST", "/api/secure_notes") === true);
  assert("default: router gates PUT (secure=true)",
    routerSecure(defs, "PUT", "/api/secure_notes/1") === true);
  assert("default: router gates DELETE (secure=true)",
    routerSecure(defs, "DELETE", "/api/secure_notes/1") === true);
}

// ── Test 2: PUBLIC registration → write route defs are secure:false ─────────
console.log("\n--- public: true (explicit opt-out of the write gate) ---");
{
  const defs = generateCrudRoutes([modelFor("open_notes")], { public: true });
  const writeDefs = defs.filter((d) => WRITE_METHODS.has(d.method));

  assert("public: has 3 write route defs (POST/PUT/DELETE)", writeDefs.length === 3,
    `got ${writeDefs.length}`);

  // Def-level: every write def explicitly opts out (secure === false).
  assert("public: every write def has secure:false",
    writeDefs.every((d) => d.secure === false),
    `secure values: ${writeDefs.map((d) => `${d.method}=${String(d.secure)}`).join(", ")}`);

  // Behavioural: the REAL router leaves each write route open (secure === false).
  assert("public: router leaves POST open (secure=false)",
    routerSecure(defs, "POST", "/api/open_notes") === false);
  assert("public: router leaves PUT open (secure=false)",
    routerSecure(defs, "PUT", "/api/open_notes/1") === false);
  assert("public: router leaves DELETE open (secure=false)",
    routerSecure(defs, "DELETE", "/api/open_notes/1") === false);

  // GET routes must never be flipped to secure:false by the public flag — reads
  // are already public; the escape hatch only touches writes.
  const getDefs = defs.filter((d) => d.method === "GET");
  assert("public: GET defs are untouched (no secure:false)",
    getDefs.length === 2 && getDefs.every((d) => d.secure === undefined),
    `secure values: ${getDefs.map((d) => `${d.pattern}=${String(d.secure)}`).join(", ")}`);
}

// ── Test 3: class API threads `public` per-table through generateRoutes ─────
console.log("\n--- AutoCrud.register(..., { public }) per-table ---");
{
  AutoCrud.clear();
  AutoCrud.register(modelFor("open_items"), "/api", { public: true });
  AutoCrud.register(modelFor("secure_items")); // default → secure

  const defs = AutoCrud.generateRoutes();

  const openWrite = defs.filter((d) => WRITE_METHODS.has(d.method) && d.pattern.startsWith("/api/open_items"));
  const secWrite = defs.filter((d) => WRITE_METHODS.has(d.method) && d.pattern.startsWith("/api/secure_items"));

  assert("class API: public-registered writes are secure:false",
    openWrite.length === 3 && openWrite.every((d) => d.secure === false),
    `open: ${openWrite.map((d) => `${d.method}=${String(d.secure)}`).join(", ")}`);
  assert("class API: default-registered writes stay gated (not secure:false)",
    secWrite.length === 3 && secWrite.every((d) => d.secure !== false),
    `secure: ${secWrite.map((d) => `${d.method}=${String(d.secure)}`).join(", ")}`);
  AutoCrud.clear();
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

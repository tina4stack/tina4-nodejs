/**
 * Integration test — verifies the full Tina4 developer experience.
 * Run with: npx tsx test/integration.ts
 */
import { startServer, getToken } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/tina4-integration-test";
const PORT = 3399;

// Clean slate
try { rmSync(TEST_DIR, { recursive: true }); } catch {}

// 1. Create project structure (simulating what `tina4 init` does)
const dirs = [
  "src/routes/api/hello",
  "src/routes/api/health",
  "src/routes/api/users/[id]",
  "src/models",
  "src/templates",
  "public",
  "data",
];
for (const d of dirs) mkdirSync(join(TEST_DIR, d), { recursive: true });

writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');

// Route: GET /api/hello
writeFileSync(join(TEST_DIR, "src/routes/api/hello/get.ts"), `
export const meta = { summary: "Hello World", tags: ["Example"] };
export default async function(req: any, res: any) {
  res.json({ message: "Hello from Tina4!" });
}
`);

// Route: GET /api/health
writeFileSync(join(TEST_DIR, "src/routes/api/health/get.ts"), `
export default async function(req: any, res: any) {
  res.json({ status: "ok" });
}
`);

// Route: GET /api/users/:id (custom override of auto-CRUD)
writeFileSync(join(TEST_DIR, "src/routes/api/users/[id]/get.ts"), `
export default async function(req: any, res: any) {
  res.json({ custom: true, id: req.params.id });
}
`);

// Model: User
writeFileSync(join(TEST_DIR, "src/models/User.ts"), `
export default class User {
  static tableName = "users";
  // Opt into auto-CRUD route generation (the documented opt-in gate; default false).
  // This integration test exercises the generated /api/users CRUD endpoints.
  static autoCrud = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 100 },
    email: { type: "string" as const, required: true },
    age: { type: "integer" as const },
    createdAt: { type: "datetime" as const, default: "now" },
  };
}
`);

// Template
writeFileSync(join(TEST_DIR, "src/templates/test.html.twig"), `<h1>{{ title }}</h1>`);

// Static file
writeFileSync(join(TEST_DIR, "public/test.txt"), "static content");

// 2. Start server
// Set high rate limit so integration tests don't get throttled and prevent cluster mode
process.env.TINA4_RATE_LIMIT = "10000";
process.env.TINA4_DEBUG = "true";

// Set up auth secret and generate a test token for write operations
const TEST_SECRET = "integration-test-secret";
process.env.TINA4_SECRET = TEST_SECRET;
const testToken = getToken({ sub: "test-user", role: "admin" }, TEST_SECRET, 3600);

console.log("=== Starting Tina4 Integration Test ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  templatesDir: join(TEST_DIR, "src/templates"),
  staticDir: join(TEST_DIR, "public"),
  database: { type: "sqlite", path: join(TEST_DIR, "data/test.db") },
});

// Helper
function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const hdrs: Record<string, string | number> = {};
    if (bodyStr) {
      hdrs["Content-Type"] = "application/json";
      hdrs["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    // Include auth token for write methods (POST/PUT/PATCH/DELETE)
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      hdrs["Authorization"] = `Bearer ${testToken}`;
    }
    const opts = {
      hostname: "localhost", port: PORT, path, method,
      headers: hdrs,
    };
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode!, data, raw });
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

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

// 3. Run tests
console.log("\n--- File-Based Routing ---");

const hello = await request("GET", "/api/hello");
assert("GET /api/hello returns 200", hello.status === 200);
assert("GET /api/hello returns message", hello.data.message === "Hello from Tina4!");

const health = await request("GET", "/api/health");
assert("GET /api/health returns 200", health.status === 200);
assert("GET /api/health returns status ok", health.data.status === "ok");

console.log("\n--- Dynamic Params ---");

const customUser = await request("GET", "/api/users/42");
assert("Custom route overrides auto-CRUD", customUser.data.custom === true);
assert("Dynamic param [id] works", customUser.data.id === "42");

console.log("\n--- Auto-CRUD ---");

const create1 = await request("POST", "/api/users", { name: "Alice", email: "alice@test.com", age: 30 });
assert("POST /api/users creates user", create1.status === 201, `got ${create1.status}: ${JSON.stringify(create1.data)}`);
assert("Created user has id", create1.data?.data?.id === 1, `got: ${JSON.stringify(create1.data)}`);

const create2 = await request("POST", "/api/users", { name: "Bob", email: "bob@test.com", age: 25 });
assert("POST creates second user", create2.status === 201, `got ${create2.status}: ${JSON.stringify(create2.data)}`);

const list = await request("GET", "/api/users");
assert("GET /api/users lists users", list.status === 200);
assert("List returns 2 users", list.data?.data?.length === 2, `got: ${list.data?.data?.length}`);
assert("List has pagination meta", list.data?.meta?.total === 2, `got: ${list.data?.meta?.total}`);

const update = await request("PUT", "/api/users/1", { name: "Alice Updated" });
assert("PUT /api/users/1 updates", update.status === 200, `got ${update.status}: ${JSON.stringify(update.data)}`);
assert("Updated name", update.data?.data?.name === "Alice Updated", `got: ${update.data?.data?.name}`);

const del = await request("DELETE", "/api/users/2");
assert("DELETE /api/users/2 works", del.status === 200, `got ${del.status}: ${JSON.stringify(del.data)}`);

const afterDelete = await request("GET", "/api/users");
assert("After delete, 1 user remains", afterDelete.data?.data?.length === 1, `got: ${afterDelete.data?.data?.length}`);

console.log("\n--- Filtering & Pagination ---");

await request("POST", "/api/users", { name: "Charlie", email: "charlie@test.com", age: 35 });
await request("POST", "/api/users", { name: "Diana", email: "diana@test.com", age: 28 });

const filtered = await request("GET", "/api/users?filter[name]=Charlie");
assert("Filter by name works", filtered.data?.data?.length === 1, `got: ${filtered.data?.data?.length}`);
assert("Filtered result is Charlie", filtered.data?.data?.[0]?.name === "Charlie", `got: ${filtered.data?.data?.[0]?.name}`);

const sorted = await request("GET", "/api/users?sort=-name");
assert("Sort descending works", sorted.data?.data?.[0]?.name === "Diana", `got: ${sorted.data?.data?.[0]?.name}`);

const paged = await request("GET", "/api/users?page=1&limit=1");
assert("Pagination limit works", paged.data?.data?.length === 1, `got: ${paged.data?.data?.length}`);
assert("Pagination meta correct", paged.data?.meta?.totalPages === 3, `got: ${paged.data?.meta?.totalPages}`);

console.log("\n--- Validation ---");

const invalid = await request("POST", "/api/users", { email: "no-name@test.com" });
assert("Missing required field returns 422", invalid.status === 422, `got ${invalid.status}: ${JSON.stringify(invalid.data)}`);
assert("Validation error for name", invalid.data?.errors?.[0]?.field === "name", `got: ${JSON.stringify(invalid.data?.errors)}`);

console.log("\n--- Swagger ---");

const swaggerUI = await request("GET", "/swagger");
assert("GET /swagger returns HTML", swaggerUI.status === 200);
assert("Swagger UI HTML present", typeof swaggerUI.raw === "string" && swaggerUI.raw.includes("swagger-ui"));

const spec = await request("GET", "/swagger/openapi.json");
assert("GET /swagger/openapi.json returns spec", spec.status === 200);
assert("Spec has paths", Object.keys(spec.data.paths).length > 0);
assert("Spec has model schema", spec.data.components?.schemas?.users !== undefined);

console.log("\n--- Static Files ---");

const staticFile = await request("GET", "/test.txt");
assert("Static file served", staticFile.status === 200);
assert("Static content correct", staticFile.raw === "static content");

console.log("\n--- Health Check ---");

const healthCheck = await request("GET", "/health");
assert("GET /health returns 200", healthCheck.status === 200);
assert("Health status is ok", healthCheck.data.status === "ok");
assert("Health version is a string", typeof healthCheck.data.version === "string" && healthCheck.data.version.length > 0);
assert("Health framework is tina4-nodejs", healthCheck.data.framework === "tina4-nodejs");
assert("Health uptime is a number", typeof healthCheck.data.uptime === "number");

console.log("\n--- 404 Handling ---");

const notFound = await request("GET", "/does/not/exist");
assert("Unknown route returns 404", notFound.status === 404);
assert("404 has error message", notFound.data.error === "Not Found" || (typeof notFound.raw === "string" && notFound.raw.includes("Not Found")));

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

// Cleanup
server.close();
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_DEBUG;
delete process.env.TINA4_SECRET;
rmSync(TEST_DIR, { recursive: true });

process.exit(fail > 0 ? 1 : 0);

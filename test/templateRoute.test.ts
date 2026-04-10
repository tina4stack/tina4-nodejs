/**
 * Tests for template rendering in file-based routes and res.render().
 * Run with: npx tsx test/templateRoute.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/tina4-template-route-test";
const PORT = 3498;

// Clean slate
try { rmSync(TEST_DIR, { recursive: true }); } catch {}

// Create project structure
const dirs = [
  "src/routes/dashboard",
  "src/routes/inline",
  "src/routes/plain",
  "src/templates",
  "public",
];
for (const d of dirs) mkdirSync(join(TEST_DIR, d), { recursive: true });

writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');

// Template file
writeFileSync(join(TEST_DIR, "src/templates/dashboard.twig"), `<h1>{{ title }}</h1><ul>{% for item in items %}<li>{{ item }}</li>{% endfor %}</ul>`);

// Route: GET /dashboard — uses export const template
writeFileSync(join(TEST_DIR, "src/routes/dashboard/get.ts"), `
export const template = "dashboard.twig";
export default async function(req: any, res: any) {
  return { title: "My Dashboard", items: ["Alpha", "Beta", "Gamma"] };
}
`);

// Route: GET /inline — uses res.render() directly
writeFileSync(join(TEST_DIR, "src/routes/inline/get.ts"), `
export default async function(req: any, res: any) {
  return res.render("dashboard.twig", { title: "Inline Render", items: ["One", "Two"] });
}
`);

// Route: GET /plain — returns object without template export (should be JSON)
writeFileSync(join(TEST_DIR, "src/routes/plain/get.ts"), `
export default async function(req: any, res: any) {
  return { title: "No Template" };
}
`);

// Set high rate limit so tests don't get throttled and prevent cluster mode
process.env.TINA4_RATE_LIMIT = "10000";
process.env.TINA4_DEBUG = "true";

console.log("=== Template Route Tests ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  templatesDir: join(TEST_DIR, "src/templates"),
  staticDir: join(TEST_DIR, "public"),
});

// Helper
function request(method: string, path: string): Promise<{ status: number; data: any; raw: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const opts = { hostname: "localhost", port: PORT, path, method };
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k] = String(v);
        }
        resolve({ status: res.statusCode!, data, raw, headers });
      });
    });
    req.on("error", reject);
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

// --- export const template ---
console.log("--- File-based template (export const template) ---");

const dashboard = await request("GET", "/dashboard");
assert("GET /dashboard returns 200", dashboard.status === 200);
assert("Dashboard content-type is HTML", dashboard.headers["content-type"]?.includes("text/html") === true,
  `got: ${dashboard.headers["content-type"]}`);
assert("Dashboard renders title", dashboard.raw.includes("<h1>My Dashboard</h1>"),
  `got: ${dashboard.raw.slice(0, 200)}`);
assert("Dashboard renders list items", dashboard.raw.includes("<li>Alpha</li>") && dashboard.raw.includes("<li>Beta</li>") && dashboard.raw.includes("<li>Gamma</li>"),
  `got: ${dashboard.raw.slice(0, 300)}`);

// --- res.render() inline ---
console.log("\n--- Inline res.render() ---");

const inline = await request("GET", "/inline");
assert("GET /inline returns 200", inline.status === 200);
assert("Inline content-type is HTML", inline.headers["content-type"]?.includes("text/html") === true,
  `got: ${inline.headers["content-type"]}`);
assert("Inline renders title", inline.raw.includes("<h1>Inline Render</h1>"),
  `got: ${inline.raw.slice(0, 200)}`);
assert("Inline renders list items", inline.raw.includes("<li>One</li>") && inline.raw.includes("<li>Two</li>"),
  `got: ${inline.raw.slice(0, 300)}`);

// --- Plain object without template export stays JSON ---
console.log("\n--- Plain object without template stays JSON ---");

const plain = await request("GET", "/plain");
assert("GET /plain returns 200", plain.status === 200);
// The handler returns an object but the response was not ended by the handler,
// so the server just calls res.raw.end() — it won't auto-JSON the return value.
// This verifies that without the template export, the return value is NOT template-rendered.
assert("Plain response does not contain rendered HTML", !plain.raw.includes("<h1>"),
  `got: ${plain.raw.slice(0, 200)}`);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

// Cleanup
server.close();
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_DEBUG;
rmSync(TEST_DIR, { recursive: true });

process.exit(fail > 0 ? 1 : 0);

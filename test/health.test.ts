/**
 * Unit tests for the health check endpoint.
 * Run with: npx tsx test/health.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/tina4-health-test";
const PORT = 3396;
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

function request(method: string, path: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "localhost", port: PORT, path, method }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode!, data });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Clean slate
try { rmSync(TEST_DIR, { recursive: true }); } catch {}
mkdirSync(TEST_DIR, { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');

// Disable rate limiter for this test and prevent cluster mode
process.env.TINA4_RATE_LIMIT = "10000";
process.env.TINA4_DEBUG = "true";

console.log("=== Health Check Tests ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

// Small delay to ensure uptime > 0
await new Promise((r) => setTimeout(r, 50));

const health = await request("GET", "/health");

assert("GET /health returns 200", health.status === 200);
assert("Response has status 'ok'", health.data.status === "ok");
assert("Response has version string", typeof health.data.version === "string" && health.data.version.length > 0);
assert("Response has framework 'tina4-nodejs'", health.data.framework === "tina4-nodejs");
assert("Response has uptime as number", typeof health.data.uptime === "number");
assert("Uptime is positive", health.data.uptime > 0);

// Cleanup
server.close();
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_DEBUG;
rmSync(TEST_DIR, { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

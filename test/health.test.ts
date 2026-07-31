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

// [live-uptime] Prove the handler computes uptime LIVE — (Date.now() - startTime)/1000 —
// rather than returning a static body. Capture the first uptime, let real wall-clock
// time pass, request again, and assert the second reading strictly advanced. This folds
// the 200 status into a real behavioural check (a live, monotonically increasing handler).
const firstUptime = health.data.uptime;
await new Promise((r) => setTimeout(r, 60));
const health2 = await request("GET", "/health");
assert(
  "GET /health returns 200 with live, advancing uptime",
  health.status === 200 &&
    health2.status === 200 &&
    typeof firstUptime === "number" &&
    typeof health2.data.uptime === "number" &&
    health2.data.uptime > firstUptime,
  `first=${firstUptime} second=${health2.data.uptime}`,
);
assert("Response has status 'ok'", health.data.status === "ok");
assert("Response has version string", typeof health.data.version === "string" && health.data.version.length > 0);
assert("Response has framework 'tina4-nodejs'", health.data.framework === "tina4-nodejs");
assert("Response has uptime as number", typeof health.data.uptime === "number");
assert("Uptime is positive", health.data.uptime > 0);

// The wire contract: EXACTLY these four keys, identical in all four frameworks
// (ADR-0016, plan/v3/fixtures/health_contract.json). Kubernetes never reads the
// body - HTTPGetAction has no body-matching field and decides on the status code
// alone - so every extra key is weight on a probe path with no consumer. Python
// carried `errors`/`latest_error` until feature 8; this stops Node growing them.
{
  const keys = Object.keys(health.data).sort().join(",");
  assert(
    "the body is exactly the four contract keys",
    keys === "framework,status,uptime,version",
    `got: ${keys}`,
  );
}

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

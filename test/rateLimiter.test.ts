/**
 * Unit tests for the rate limiter middleware.
 * Run with: npx tsx test/rateLimiter.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/tina4-ratelimit-test";
const PORT = 3398;
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

function request(method: string, path: string): Promise<{
  status: number;
  data: any;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "localhost", port: PORT, path, method }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode!, data, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Clean slate
try { rmSync(TEST_DIR, { recursive: true }); } catch {}
mkdirSync(join(TEST_DIR, "src/routes/api/ping"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/api/ping/get.ts"), `
export default async function(req: any, res: any) {
  res.json({ pong: true });
}
`);

// Set a very low rate limit for testing
process.env.TINA4_RATE_LIMIT = "5";
process.env.TINA4_RATE_WINDOW = "60";

console.log("=== Rate Limiter Tests ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

console.log("--- Rate Limit Headers ---");

const first = await request("GET", "/api/ping");
assert("First request succeeds with 200", first.status === 200);
assert("X-RateLimit-Limit header present", first.headers["x-ratelimit-limit"] === "5");
assert("X-RateLimit-Remaining header present", first.headers["x-ratelimit-remaining"] !== undefined);
assert("X-RateLimit-Reset header present", first.headers["x-ratelimit-reset"] !== undefined);

console.log("\n--- Rate Limit Enforcement ---");

// Make 4 more requests to hit the limit (already made 1)
for (let i = 0; i < 4; i++) {
  await request("GET", "/api/ping");
}

const limited = await request("GET", "/api/ping");
assert("6th request returns 429", limited.status === 429);
assert("429 response has error message", limited.data.error === "Too Many Requests");
assert("Retry-After header present", limited.headers["retry-after"] !== undefined);
assert("X-RateLimit-Remaining is 0", limited.headers["x-ratelimit-remaining"] === "0");

// Cleanup
server.close();
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_RATE_WINDOW;
rmSync(TEST_DIR, { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

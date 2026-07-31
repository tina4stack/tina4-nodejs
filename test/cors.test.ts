/**
 * Unit tests for the CORS middleware upgrade.
 * Run with: npx tsx test/cors.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/tina4-cors-test";
const PORT = 3397;
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

function request(
  method: string,
  path: string,
  headers?: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "localhost",
      port: PORT,
      path,
      method,
      headers: headers ?? {},
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode!, headers: res.headers, data });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Clean slate
try { rmSync(TEST_DIR, { recursive: true }); } catch {}
mkdirSync(join(TEST_DIR, "src/routes/api/test"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/api/test/get.ts"), `
export default async function(req: any, res: any) {
  res.json({ ok: true });
}
`);

// Disable rate limiter for CORS testing and prevent cluster mode
process.env.TINA4_RATE_LIMIT = "10000";
process.env.TINA4_DEBUG = "true";
// ADR-0014 made the CORS default DENY. This suite asserts what the server
// EMITS for an allowed origin, which did not change, so it declares the
// wildcard policy it used to inherit from the old permissive default.
// No assertion below was altered.
process.env.TINA4_CORS_ORIGINS = "*";

console.log("=== CORS Tests ===\n");

console.log("--- Explicit Wildcard CORS ---");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

const normal = await request("GET", "/api/test");
assert("GET returns CORS Allow-Origin header", normal.headers["access-control-allow-origin"] === "*");

const preflight = await request("OPTIONS", "/api/test", { Origin: "http://example.com" });
assert("OPTIONS returns 204", preflight.status === 204);
const allowMethods = String(preflight.headers["access-control-allow-methods"] ?? "");
assert(
  "OPTIONS Allow-Methods advertises the real REST verbs",
  /GET/.test(allowMethods) && /POST/.test(allowMethods) && /PUT/.test(allowMethods) &&
    /DELETE/.test(allowMethods) && /PATCH/.test(allowMethods) && /OPTIONS/.test(allowMethods),
  `got "${allowMethods}"`
);

const allowHeaders = String(preflight.headers["access-control-allow-headers"] ?? "").toLowerCase();
assert(
  "OPTIONS Allow-Headers includes the default allowed headers",
  allowHeaders.includes("content-type") && allowHeaders.includes("authorization"),
  `got "${preflight.headers["access-control-allow-headers"]}"`
);

const maxAge = preflight.headers["access-control-max-age"];
assert(
  "OPTIONS Max-Age advertises a real positive cache lifetime",
  Number.isInteger(Number(maxAge)) && Number(maxAge) > 0,
  `got "${maxAge}"`
);

server.close();

// Cleanup
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_DEBUG;
rmSync(TEST_DIR, { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

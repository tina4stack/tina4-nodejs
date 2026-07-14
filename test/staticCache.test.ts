/**
 * No-mock tests for the static-file cache policy (packages/core/src/static.ts).
 *
 * Boots a REAL Tina4 server, serves a REAL file from a REAL temp public dir over
 * a REAL socket, and asserts the wire behaviour:
 *   - a served asset carries `Cache-Control: no-cache, must-revalidate` plus an
 *     ETag AND a Last-Modified validator;
 *   - a conditional request whose `If-None-Match` matches the ETag gets a bare
 *     304 (no body);
 *   - `If-Modified-Since >= Last-Modified` also yields a 304;
 *   - a NON-matching validator still returns the full 200 body (no false 304).
 *
 * No mocks — real files, real HTTP. Run with: npx tsx test/staticCache.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tina4-static-cache-test-" + Date.now());
const PUBLIC_DIR = join(TEST_DIR, "public");
const ASSET_BODY = "body { color: rebeccapurple; }";
const PORT = 3419;

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
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port: PORT, path, method: "GET", headers: headers ?? {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// --- Real temp project: a public dir with one real asset + an empty routes dir.
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
mkdirSync(PUBLIC_DIR, { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(PUBLIC_DIR, "app.css"), ASSET_BODY);

// Keep the run production-clean: no dev toolbar / AI dual-port, generous rate limit.
delete process.env.TINA4_DEBUG;
process.env.TINA4_RATE_LIMIT = "10000";

console.log("=== Static Cache Policy Tests ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: PUBLIC_DIR,
});

let exitCode = 0;
try {
  // 1) First load — full 200 with the cache policy + both validators.
  console.log("--- Fresh GET carries the cache policy + validators ---");
  const first = await request("/app.css");
  assert("serves the asset with 200", first.status === 200, `got ${first.status}`);
  assert("body is the real file contents", first.body === ASSET_BODY, `got "${first.body}"`);
  assert(
    "Cache-Control is no-cache, must-revalidate",
    first.headers["cache-control"] === "no-cache, must-revalidate",
    `got "${first.headers["cache-control"]}"`,
  );
  const etag = String(first.headers["etag"] ?? "");
  assert("ETag validator is present and non-empty", etag.length > 0, `got "${etag}"`);
  const lastModified = String(first.headers["last-modified"] ?? "");
  assert(
    "Last-Modified validator is present and a valid HTTP date",
    lastModified.length > 0 && !Number.isNaN(Date.parse(lastModified)),
    `got "${lastModified}"`,
  );

  // 2) Conditional request with the matching ETag → bare 304.
  console.log("\n--- If-None-Match on the current ETag → 304, no body ---");
  const notModified = await request("/app.css", { "If-None-Match": etag });
  assert("returns 304 Not Modified", notModified.status === 304, `got ${notModified.status}`);
  assert("304 has an empty body", notModified.body === "", `got "${notModified.body}"`);
  assert(
    "304 still echoes the ETag validator",
    String(notModified.headers["etag"] ?? "") === etag,
    `got "${notModified.headers["etag"]}"`,
  );

  // 3) If-Modified-Since >= Last-Modified → 304.
  console.log("\n--- If-Modified-Since >= Last-Modified → 304 ---");
  const ims = await request("/app.css", { "If-Modified-Since": lastModified });
  assert("If-Modified-Since match returns 304", ims.status === 304, `got ${ims.status}`);
  assert("If-Modified-Since 304 has no body", ims.body === "", `got "${ims.body}"`);

  // 4) NEGATIVE: a stale/non-matching validator must NOT produce a false 304.
  console.log("\n--- Non-matching validators still return the full 200 ---");
  const staleEtag = await request("/app.css", { "If-None-Match": 'W/"0-0"' });
  assert("non-matching ETag returns full 200", staleEtag.status === 200, `got ${staleEtag.status}`);
  assert("non-matching ETag re-sends the body", staleEtag.body === ASSET_BODY, `got "${staleEtag.body}"`);

  const oldSince = await request("/app.css", { "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT" });
  assert("older If-Modified-Since returns full 200", oldSince.status === 200, `got ${oldSince.status}`);
  assert("older If-Modified-Since re-sends the body", oldSince.body === ASSET_BODY, `got "${oldSince.body}"`);
} catch (err) {
  console.error(err);
  fail++;
  exitCode = 1;
} finally {
  server.close();
  delete process.env.TINA4_RATE_LIMIT;
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 || exitCode > 0 ? 1 : 0);

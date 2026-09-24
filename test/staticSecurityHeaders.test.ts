/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Static files carry the same security headers as route responses
 * (tina4-python#137 parity).
 *
 * THE DEFECT (found in tina4-python 3.13.137, CONFIRMED in Node): the
 * security-headers middleware ran only for a MATCHED route. Static assets are
 * resolved in the not-found fallback chain (ADR-0010, routes beat files), which
 * runs only the pre-match middleware pass, and SecurityHeadersMiddleware was a
 * post-match middleware. So the same HTML served from `public/` or `src/public/`
 * got no Content-Security-Policy, no X-Content-Type-Options and no
 * X-Frame-Options. Because "/" resolves to index.html (so SPAs Just Work), a
 * single-page app's front door was served frameable (clickjacking) and without
 * a CSP, with no warning.
 *
 * NO MOCKS: a REAL startServer() boots against a temp project with a real
 * public/ and src/public/ on disk, and REAL HTTP requests read the headers the
 * server actually emitted.
 *
 * Same case names in all four frameworks:
 *   - static_file_response_carries_security_headers
 *   - spa_index_at_root_carries_security_headers
 *   - src_public_file_carries_security_headers
 *   - hsts_stays_https_only_on_static_files
 *
 * Run with: npx tsx test/staticSecurityHeaders.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-static-sechdr-"));
const PORT = await freePort();
let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const WANTED: Record<string, string> = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
};

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function missing(headers: http.IncomingHttpHeaders): string {
  return Object.entries(WANTED)
    .filter(([name, value]) => headers[name] !== value)
    .map(([name, value]) => `[${name}=${String(headers[name])} want ${value}]`)
    .join(" ");
}

// A route and the same kind of HTML on disk, in both static roots.
mkdirSync(join(TEST_DIR, "src/routes/page"), { recursive: true });
mkdirSync(join(TEST_DIR, "public"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/public"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/page/get.ts"), `
export default async function (req: any, res: any) {
  return res.html("<!doctype html><title>route</title><p>hello</p>");
}
`);
writeFileSync(join(TEST_DIR, "public/index.html"), "<!doctype html><title>spa</title><div id=app></div>");
writeFileSync(join(TEST_DIR, "src/public/app.html"), "<!doctype html><title>src public</title><p>app</p>");

process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_DEBUG = "false";
for (const key of ["TINA4_HSTS", "TINA4_CSP", "TINA4_FRAME_OPTIONS", "TINA4_CSRF", "TINA4_PUBLIC_DIR"]) delete process.env[key];

console.log("=== Static files carry security headers (tina4-python#137 parity) ===\n");

const server = await startServer({ port: PORT, basePath: TEST_DIR });

// Control: a route response has the headers (it always did).
{
  const r = await get("/page");
  assert("control: a route response carries the security headers", r.status === 200 && missing(r.headers) === "",
    `status=${r.status} ${missing(r.headers)}`);
}

{
  const r = await get("/index.html");
  assert("static_file_response_carries_security_headers",
    r.status === 200 && r.body.includes("spa") && missing(r.headers) === "",
    `status=${r.status} ${missing(r.headers)}`);
}

{
  const r = await get("/");
  assert("spa_index_at_root_carries_security_headers",
    r.status === 200 && r.body.includes("spa") && missing(r.headers) === "",
    `status=${r.status} ${missing(r.headers)}`);
}

{
  const r = await get("/app.html");
  assert("src_public_file_carries_security_headers",
    r.status === 200 && r.body.includes("app") && missing(r.headers) === "",
    `status=${r.status} ${missing(r.headers)}`);
}

// NEGATIVE: moving the headers onto the static path must not leak HSTS onto
// plain HTTP. It stays HTTPS-only (SECHDR-DEC-02) there as on a route.
process.env.TINA4_HSTS = "31536000";
{
  const plain = await get("/index.html");
  const https = await get("/index.html", { "X-Forwarded-Proto": "https" });
  assert("hsts_stays_https_only_on_static_files",
    plain.headers["strict-transport-security"] === undefined &&
      https.headers["strict-transport-security"] === "max-age=31536000; includeSubDomains",
    `plain=${String(plain.headers["strict-transport-security"])} https=${String(https.headers["strict-transport-security"])}`);
}
delete process.env.TINA4_HSTS;

server.close();
delete process.env.TINA4_RATE_LIMIT;
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

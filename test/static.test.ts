/**
 * Unit tests for static file serving (packages/core/src/static.ts).
 * Run with: npx tsx test/static.test.ts
 */
import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tryServeStatic } from "../packages/core/src/static.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/types.ts";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePublicDir = resolve(__dirname, "../packages/core/public");

/** Build a minimal mock Tina4Request with the given URL. */
function mockReq(url: string): Tina4Request {
  return { url } as unknown as Tina4Request;
}

/** Build a minimal mock Tina4Response that captures headers and body. */
function mockRes(): any {
  const headers: Record<string, string | number> = {};
  const state = { body: null as Buffer | string | null, ended: false, headers };
  return {
    headers,
    body: null,
    ended: false,
    raw: {
      writableEnded: false,
      setHeader(name: string, value: string | number) {
        state.headers[name] = value;
      },
      end(data?: Buffer | string) {
        state.body = data ?? null;
        state.ended = true;
      },
    },
    get headersRef() { return state.headers; },
    get bodyRef() { return state.body; },
    get endedRef() { return state.ended; },
  };
}

console.log("=== Static File Serving Tests ===\n");

// --- MIME Type Detection ---
console.log("--- MIME types ---");

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/css/tina4.min.css"), res);
  assert("serves .css with text/css", served === true);
  assert("CSS content-type header", String(res.headersRef["Content-Type"]).includes("text/css"));
}

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/js/tina4.min.js"), res);
  assert("serves .js with application/javascript", served === true);
  assert("JS content-type header", String(res.headersRef["Content-Type"]).includes("application/javascript"));
}

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/nonexistent.html"), res);
  assert("returns false for missing .html", served === false);
}

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/nonexistent.json"), res);
  assert("returns false for missing .json", served === false);
}

{
  for (const ext of [".png", ".jpg", ".svg"]) {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq(`/img/test${ext}`), res);
    assert(`returns false for missing ${ext}`, served === false);
  }
}

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/fonts/test.woff2"), res);
  assert("returns false for missing .woff2", served === false);
}

// --- Framework Public Files ---
console.log("\n--- Framework public files ---");

{
  assert("tina4.min.css exists", existsSync(join(corePublicDir, "css/tina4.min.css")));
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/css/tina4.min.css"), res);
  assert("tina4.min.css is servable", served === true);
  assert("tina4.min.css has Content-Length", res.headersRef["Content-Length"] > 0);
}

{
  assert("tina4.min.js exists", existsSync(join(corePublicDir, "js/tina4.min.js")));
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/js/tina4.min.js"), res);
  assert("tina4.min.js is servable", served === true);
}

{
  assert("frond.min.js exists", existsSync(join(corePublicDir, "js/frond.min.js")));
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/js/frond.min.js"), res);
  assert("frond.min.js is servable", served === true);
}

{
  assert("tina4js.min.js exists", existsSync(join(corePublicDir, "js/tina4js.min.js")));
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/js/tina4js.min.js"), res);
  assert("tina4js.min.js is servable", served === true);
}

// --- Security ---
console.log("\n--- Directory traversal prevention ---");

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/../package.json"), res);
  assert("rejects path traversal with ..", served === false);
}

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/%2e%2e/package.json"), res);
  assert("rejects encoded traversal %2e%2e", served === false);
}

// --- 404 Handling ---
console.log("\n--- 404 for missing files ---");

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/does-not-exist.txt"), res);
  assert("returns false for non-existent file", served === false);
}

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/a/b/c/d/e.js"), res);
  assert("returns false for non-existent nested path", served === false);
}

// --- Response Headers ---
console.log("\n--- Response headers ---");

{
  const res = mockRes();
  tryServeStatic(corePublicDir, mockReq("/css/tina4.min.css"), res);
  assert("sets Content-Length header", res.headersRef["Content-Length"] !== undefined);
  assert("Content-Length is number", typeof res.headersRef["Content-Length"] === "number");
}

{
  const res = mockRes();
  tryServeStatic(corePublicDir, mockReq("/js/tina4.min.js"), res);
  assert("sets Content-Type header", res.headersRef["Content-Type"] !== undefined);
}

{
  const res = mockRes();
  const served = tryServeStatic(corePublicDir, mockReq("/css/tina4.min.css?v=123"), res);
  assert("strips query strings", served === true);
}

// --- Custom static directory ---
console.log("\n--- Custom static directory ---");

import { mkdirSync, writeFileSync, symlinkSync, rmSync as rmSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { startServer } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";
const customDir = join(tmpdir(), "tina4-static-test-" + Date.now());
mkdirSync(join(customDir, "images"), { recursive: true });
mkdirSync(join(customDir, "data"), { recursive: true });

writeFileSync(join(customDir, "index.html"), "<h1>Hello</h1>");
writeFileSync(join(customDir, "data/config.json"), '{"key":"value"}');
writeFileSync(join(customDir, "images/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header
writeFileSync(join(customDir, "style.css"), "body { color: red; }");
writeFileSync(join(customDir, "app.js"), "console.log('hello');");
writeFileSync(join(customDir, "readme.txt"), "Hello world");

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/index.html"), res);
  assert("serves custom index.html", served === true);
  assert("HTML content-type", String(res.headersRef["Content-Type"]).includes("text/html"));
}

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/data/config.json"), res);
  assert("serves nested JSON file", served === true);
  assert("JSON content-type", String(res.headersRef["Content-Type"]).includes("application/json"));
}

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/images/logo.png"), res);
  assert("serves PNG image", served === true);
  assert("PNG content-type", String(res.headersRef["Content-Type"]).includes("image/png"));
}

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/style.css"), res);
  assert("serves CSS file", served === true);
  assert("CSS content-type", String(res.headersRef["Content-Type"]).includes("text/css"));
}

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/app.js"), res);
  assert("serves JS file", served === true);
  assert("JS content-type", String(res.headersRef["Content-Type"]).includes("application/javascript"));
}

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/readme.txt"), res);
  assert("serves TXT file", served === true);
  assert("TXT content-type", String(res.headersRef["Content-Type"]).includes("text/plain"));
}

// --- Directory index.html ---
console.log("\n--- Directory index.html ---");

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/"), res);
  assert("serves index.html for root /", served === true);
}

// --- More security tests ---
console.log("\n--- Security Edge Cases ---");

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/../../etc/passwd"), res);
  assert("blocks deep traversal", served === false);
}

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/.hidden"), res);
  assert("returns false for nonexistent hidden file", served === false);
}

{
  const res = mockRes();
  const served = tryServeStatic(customDir, mockReq("/"), res);
  assert("root serves index.html", served === true);
  assert("root Content-Type is HTML", String(res.headersRef["Content-Type"]).includes("text/html"));
}

// --- Content-Length accuracy ---
console.log("\n--- Content-Length Accuracy ---");

{
  const res = mockRes();
  tryServeStatic(customDir, mockReq("/readme.txt"), res);
  assert("Content-Length matches file size", res.headersRef["Content-Length"] === 11); // "Hello world" = 11 bytes
}

{
  const res = mockRes();
  tryServeStatic(customDir, mockReq("/style.css"), res);
  // "body { color: red; }" is 20 bytes
  assert("CSS Content-Length is correct", res.headersRef["Content-Length"] === 20);
}

// --- Feature 41 shared contract (static_contract.json) ---
// ADR-0050 realpath + separator confinement, dotfile block, and TINA4_PUBLIC_DIR
// honoured — REAL files, a REAL symlink, and (for the env case) a REAL server.
console.log("\n--- Feature 41 static contract ---");

const c41 = join(tmpdir(), "tina4-static-c41-" + Date.now());
const c41Pub = join(c41, "pub");
mkdirSync(join(c41Pub, "css"), { recursive: true });
mkdirSync(join(c41Pub, ".git"), { recursive: true });
writeFileSync(join(c41Pub, "css", "app.css"), "body{color:green}");
writeFileSync(join(c41Pub, ".env"), "TINA4_SECRET=leaked");
writeFileSync(join(c41Pub, ".git", "config"), "[core]");
// A real secret OUTSIDE the public dir, reached by a real symlink placed INSIDE it.
writeFileSync(join(c41, "outside-secret.txt"), "SUPER SECRET");
symlinkSync(join(c41, "outside-secret.txt"), join(c41Pub, "leak.txt"));

{
  const res = mockRes();
  const served = tryServeStatic(c41Pub, mockReq("/css/app.css"), res);
  assert(
    "a legit asset is served with its content type",
    served === true && String(res.headersRef["Content-Type"]).includes("text/css"),
    `served=${served} ct=${res.headersRef["Content-Type"]}`,
  );
}

{
  const res = mockRes();
  const served = tryServeStatic(c41Pub, mockReq("/css/../../outside-secret.txt"), res);
  assert("a dot dot traversal path is refused", served === false, `served=${served}`);
}

{
  const res = mockRes();
  const served = tryServeStatic(c41Pub, mockReq("/leak.txt"), res);
  assert(
    "a symlink escaping the public dir is refused",
    served === false && res.bodyRef === null,
    `served=${served}`,
  );
}

{
  const res = mockRes();
  const served = tryServeStatic(c41Pub, mockReq("/.env"), res);
  assert("a dotenv file is refused", served === false, `served=${served}`);
}

{
  const res = mockRes();
  const served = tryServeStatic(c41Pub, mockReq("/.git/config"), res);
  assert("a dotgit file is refused", served === false, `served=${served}`);
}

// TINA4_PUBLIC_DIR honoured — driven through a REAL server (the env is read in
// server.ts, not in tryServeStatic), reaped in the finally.
{
  const envRoot = join(c41, "env-root");
  const appBase = join(c41, "app-base");
  mkdirSync(envRoot, { recursive: true });
  mkdirSync(join(appBase, "src/routes"), { recursive: true });
  writeFileSync(join(appBase, "package.json"), '{"type":"module"}');
  writeFileSync(join(envRoot, "brand.css"), ".brand{color:teal}");

  const prevDebug = process.env.TINA4_DEBUG;
  const prevPublic = process.env.TINA4_PUBLIC_DIR;
  const prevRate = process.env.TINA4_RATE_LIMIT;
  delete process.env.TINA4_DEBUG;
  process.env.TINA4_RATE_LIMIT = "10000";
  process.env.TINA4_PUBLIC_DIR = envRoot;

  const port = await freePort();
  const server = await startServer({
    port,
    basePath: appBase,
    routesDir: join(appBase, "src/routes"),
    modelsDir: join(appBase, "src/models"),
    staticDir: join(appBase, "public"), // deliberately absent — only the env root has the asset
  });
  try {
    const got = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request(
        { hostname: "localhost", port, path: "/brand.css", method: "GET" },
        (rs) => {
          let body = "";
          rs.on("data", (c) => (body += c));
          rs.on("end", () => resolve({ status: rs.statusCode!, body }));
        },
      );
      r.on("error", reject);
      r.end();
    });
    assert(
      "tina4 public dir env relocates the root",
      got.status === 200 && got.body === ".brand{color:teal}",
      `got ${got.status} "${got.body}"`,
    );
  } finally {
    server.close();
    if (prevDebug === undefined) delete process.env.TINA4_DEBUG;
    else process.env.TINA4_DEBUG = prevDebug;
    if (prevPublic === undefined) delete process.env.TINA4_PUBLIC_DIR;
    else process.env.TINA4_PUBLIC_DIR = prevPublic;
    if (prevRate === undefined) delete process.env.TINA4_RATE_LIMIT;
    else process.env.TINA4_RATE_LIMIT = prevRate;
  }
}

// Cleanup
try { rmSyncFs(customDir, { recursive: true, force: true }); } catch {}
try { rmSyncFs(c41, { recursive: true, force: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

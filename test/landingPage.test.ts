/**
 * Regression tests for issue #39 — landing page, template auto-routing,
 * SPA index serving, and the 404 status line.
 *
 * Mirrors tests/test_landing_page.py from tina4-python. Covers:
 *   A. Template auto-routing only fires from src/templates/pages/; partials,
 *      layouts, base.twig, errors, and _* files never auto-serve.
 *   B. TINA4_TEMPLATE_ROUTING=off|false|0|no|disabled is a hard kill switch.
 *   C. src/public/index.html auto-serves at /  (the SPA case), and
 *      src/public/foo/index.html auto-serves at /foo/.
 *   D. The framework landing page only renders when TINA4_DEBUG=true.
 *      In production /  with no static index and no pages/index.twig
 *      returns 404 — version, gallery, dev-admin link never leak.
 *   E. The HTTP/1.1 status line uses the canonical RFC reason phrase per
 *      code (no more "HTTP/1.1 404 OK").
 *
 * Run with: npx tsx test/landingPage.test.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import {
  resolveTemplate,
  resetTemplateCache,
  templateAutoRoutingEnabled,
  httpReason,
  startServer,
} from "../packages/core/src/index.ts";
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

function mockReq(url: string): Tina4Request {
  return { url } as unknown as Tina4Request;
}

function mockRes(): any {
  const headers: Record<string, string | number> = {};
  const state = { body: null as Buffer | string | null, ended: false, headers };
  return {
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

const TEST_DIR = join("/tmp", "tina4-landing-test-" + Date.now());

function setupProject() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "src/templates/pages"), { recursive: true });
  mkdirSync(join(TEST_DIR, "src/templates/partials"), { recursive: true });
  mkdirSync(join(TEST_DIR, "src/templates/layouts"), { recursive: true });
  mkdirSync(join(TEST_DIR, "src/templates/errors"), { recursive: true });
  mkdirSync(join(TEST_DIR, "src/public"), { recursive: true });
  resetTemplateCache();
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  resetTemplateCache();
}

console.log("=== Landing Page / Template Auto-Routing / 404 Status Line Tests ===\n");

const origCwd = process.cwd();
const origDebug = process.env.TINA4_DEBUG;
const origRouting = process.env.TINA4_TEMPLATE_ROUTING;

// ── A. Template auto-routing scope ────────────────────────────
console.log("--- A. Template auto-routing scope (pages/ only) ---");

{
  setupProject();
  process.env.TINA4_DEBUG = "true";
  delete process.env.TINA4_TEMPLATE_ROUTING;
  process.chdir(TEST_DIR);

  const tplDir = join(TEST_DIR, "src/templates");

  writeFileSync(join(tplDir, "pages/index.twig"), "ok");
  assert("pages/index.twig serves at /", resolveTemplate("/", tplDir) === "pages/index.twig");

  writeFileSync(join(tplDir, "pages/about.twig"), "ok");
  assert("pages/about.twig serves at /about", resolveTemplate("/about", tplDir) === "pages/about.twig");

  mkdirSync(join(tplDir, "pages/products"), { recursive: true });
  writeFileSync(join(tplDir, "pages/products/list.twig"), "ok");
  assert("pages/products/list.twig serves at /products/list",
    resolveTemplate("/products/list", tplDir) === "pages/products/list.twig");

  // Partials NEVER serve standalone
  writeFileSync(join(tplDir, "partials/nav.twig"), "partial");
  assert("partials/nav.twig never serves at /partials/nav",
    resolveTemplate("/partials/nav", tplDir) === null);

  // Layouts NEVER serve
  writeFileSync(join(tplDir, "layouts/main.twig"), "layout");
  assert("layouts/main.twig never serves at /layouts/main",
    resolveTemplate("/layouts/main", tplDir) === null);

  // base.twig at root NEVER serves
  writeFileSync(join(tplDir, "base.twig"), "base");
  assert("src/templates/base.twig never serves at /base",
    resolveTemplate("/base", tplDir) === null);

  // errors/ NEVER serves
  writeFileSync(join(tplDir, "errors/404.twig"), "err");
  assert("errors/404.twig never serves at /errors/404",
    resolveTemplate("/errors/404", tplDir) === null);

  // Underscore-prefixed in pages/ is private
  writeFileSync(join(tplDir, "pages/_helper.twig"), "private");
  assert("pages/_helper.twig (underscore-prefixed) never serves",
    resolveTemplate("/_helper", tplDir) === null);

  process.chdir(origCwd);
  teardown();
}

// ── A (production cache) ──────────────────────────────────────
console.log("\n--- A. Production cache only indexes pages/ ---");

{
  setupProject();
  delete process.env.TINA4_DEBUG;
  delete process.env.TINA4_TEMPLATE_ROUTING;
  process.chdir(TEST_DIR);
  resetTemplateCache();

  const tplDir = join(TEST_DIR, "src/templates");
  writeFileSync(join(tplDir, "pages/about.twig"), "page");
  writeFileSync(join(tplDir, "partials/nav.twig"), "partial");
  writeFileSync(join(tplDir, "base.twig"), "base");
  writeFileSync(join(tplDir, "pages/_helper.twig"), "private");

  // Trigger cache build
  const aboutRes = resolveTemplate("/about", tplDir);
  assert("prod cache: /about resolves to pages/about.twig",
    aboutRes === "pages/about.twig");

  // None of these should ever resolve in production either
  assert("prod cache: /partials/nav never resolves",
    resolveTemplate("/partials/nav", tplDir) === null);
  assert("prod cache: /base never resolves",
    resolveTemplate("/base", tplDir) === null);
  assert("prod cache: /_helper never resolves (private file)",
    resolveTemplate("/_helper", tplDir) === null);

  process.chdir(origCwd);
  teardown();
}

// ── B. TINA4_TEMPLATE_ROUTING kill switch ─────────────────────
console.log("\n--- B. TINA4_TEMPLATE_ROUTING kill switch ---");

{
  setupProject();
  process.env.TINA4_DEBUG = "true";
  process.chdir(TEST_DIR);

  const tplDir = join(TEST_DIR, "src/templates");
  writeFileSync(join(tplDir, "pages/about.twig"), "ok");

  for (const value of ["off", "OFF", "false", "FALSE", "0", "no", "disabled"]) {
    process.env.TINA4_TEMPLATE_ROUTING = value;
    resetTemplateCache();
    assert(`kill switch '${value}' disables auto-routing`,
      resolveTemplate("/about", tplDir) === null);
    assert(`kill switch '${value}' templateAutoRoutingEnabled() == false`,
      templateAutoRoutingEnabled() === false);
  }

  for (const value of ["on", "true", "1", "yes"]) {
    process.env.TINA4_TEMPLATE_ROUTING = value;
    resetTemplateCache();
    assert(`truthy '${value}' keeps auto-routing on`,
      resolveTemplate("/about", tplDir) === "pages/about.twig");
    assert(`truthy '${value}' templateAutoRoutingEnabled() == true`,
      templateAutoRoutingEnabled() === true);
  }

  // Default (unset) is on
  delete process.env.TINA4_TEMPLATE_ROUTING;
  resetTemplateCache();
  assert("default (unset) keeps auto-routing on",
    resolveTemplate("/about", tplDir) === "pages/about.twig");

  process.chdir(origCwd);
  teardown();
}

// ── C. src/public/index.html SPA auto-serve ────────────────────
console.log("\n--- C. src/public/index.html SPA auto-serve ---");

{
  setupProject();
  const publicDir = join(TEST_DIR, "src/public");

  writeFileSync(join(publicDir, "index.html"), "<!doctype html><h1>SPA</h1>");

  {
    const res = mockRes();
    const served = tryServeStatic(publicDir, mockReq("/"), res);
    // Prove the SPA index file content was actually emitted, not just that
    // the call returned true: the bytes written to res must be the exact
    // index.html we wrote, served as text/html.
    assert("root '/' serves src/public/index.html body (not just returns true)",
      served === true
        && res.endedRef === true
        && String(res.bodyRef).includes("<h1>SPA</h1>")
        && String(res.headersRef["Content-Type"]).includes("text/html"),
      `served=${served} body=${String(res.bodyRef)} ct=${res.headersRef["Content-Type"]}`);
  }

  // Subdirectory index — /admin/ -> src/public/admin/index.html
  mkdirSync(join(publicDir, "admin"), { recursive: true });
  writeFileSync(join(publicDir, "admin/index.html"), "admin");
  {
    const res = mockRes();
    const served = tryServeStatic(publicDir, mockReq("/admin/"), res);
    // Prove the correct subdirectory index body was emitted: the bytes must be
    // exactly the "admin" content of src/public/admin/index.html, served as
    // text/html — not the root index.html and not merely a true return.
    assert("/admin/ serves src/public/admin/index.html body (correct subdir index)",
      served === true
        && res.endedRef === true
        && String(res.bodyRef) === "admin"
        && String(res.headersRef["Content-Type"]).includes("text/html"),
      `served=${served} body=${String(res.bodyRef)} ct=${res.headersRef["Content-Type"]}`);
  }

  // No index.html → returns false
  rmSync(join(publicDir, "index.html"));
  {
    const res = mockRes();
    const served = tryServeStatic(publicDir, mockReq("/"), res);
    assert("no index.html → tryServeStatic returns false", served === false);
  }

  teardown();
}

// ── D. Landing page hidden in production (live HTTP) ──────────
console.log("\n--- D. Landing page only in dev mode (live HTTP) ---");

// We need to flip TINA4_DEBUG between server starts. Each pass uses a
// distinct port to avoid the "kill the existing process on this port"
// behaviour stomping on our own server.
const PORT_DEV = 3501;
const PORT_PROD = 3502;

async function httpGet(port: number, path: string): Promise<{
  status: number;
  rawStatusLine: string | null;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    // Build the request via the low-level socket so we can capture the raw
    // status line — http.get hides it behind statusCode/statusMessage.
    const req = http.request({ hostname: "localhost", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({
        status: res.statusCode!,
        rawStatusLine: `HTTP/1.1 ${res.statusCode} ${res.statusMessage}`,
        body,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Dev mode: TINA4_DEBUG=true → landing page renders
{
  setupProject();
  process.env.TINA4_DEBUG = "true";
  process.env.TINA4_OVERRIDE_CLIENT = "true";
  process.env.TINA4_RATE_LIMIT = "10000";
  process.env.TINA4_NO_AI_PORT = "true";
  process.env.TINA4_NO_BROWSER = "true";
  delete process.env.TINA4_TEMPLATE_ROUTING;
  resetTemplateCache();

  const server = await startServer({
    port: PORT_DEV,
    basePath: TEST_DIR,
  });

  const r = await httpGet(PORT_DEV, "/");
  assert("dev mode: GET / returns 200", r.status === 200);
  assert("dev mode: GET / contains landing page (Tina4 banner)",
    r.body.includes("Tina4NodeJs") || r.body.includes("tina4"),
    `body: ${r.body.slice(0, 120)}`);

  // 404 status line is canonical
  const r404 = await httpGet(PORT_DEV, "/this-does-not-exist-anywhere");
  assert("dev mode: missing path returns 404", r404.status === 404);
  assert("dev mode: 404 status message is 'Not Found' not 'OK'",
    r404.rawStatusLine === "HTTP/1.1 404 Not Found",
    `got: ${r404.rawStatusLine}`);

  server.close();
  teardown();
}

// Production mode: TINA4_DEBUG=false → landing page hidden, "/" is 404
{
  setupProject();
  process.env.TINA4_DEBUG = "false";
  process.env.TINA4_OVERRIDE_CLIENT = "true";
  process.env.TINA4_RATE_LIMIT = "10000";
  process.env.TINA4_NO_AI_PORT = "true";
  process.env.TINA4_NO_BROWSER = "true";
  delete process.env.TINA4_TEMPLATE_ROUTING;
  resetTemplateCache();

  const server = await startServer({
    port: PORT_PROD,
    basePath: TEST_DIR,
  });

  const r = await httpGet(PORT_PROD, "/");
  assert("prod mode: GET / does NOT show landing page", r.status === 404,
    `expected 404, got ${r.status}`);
  assert("prod mode: GET / body does not contain Tina4NodeJs banner",
    !r.body.includes("Tina4NodeJs"),
    `body: ${r.body.slice(0, 120)}`);

  // SPA case in prod: a real index.html serves at /
  writeFileSync(join(TEST_DIR, "src/public/index.html"), "<!doctype html><h1>SPA prod</h1>");
  const rSpa = await httpGet(PORT_PROD, "/");
  assert("prod mode: GET / serves src/public/index.html when present",
    rSpa.status === 200 && rSpa.body.includes("SPA prod"),
    `got status=${rSpa.status} body=${rSpa.body.slice(0, 60)}`);

  server.close();
  teardown();
}

// ── E. HTTP/1.1 status reason phrases ─────────────────────────
console.log("\n--- E. HTTP/1.1 status reason phrases ---");

assert("httpReason(200) === 'OK'", httpReason(200) === "OK");
assert("httpReason(404) === 'Not Found'", httpReason(404) === "Not Found");
assert("httpReason(500) === 'Internal Server Error'",
  httpReason(500) === "Internal Server Error");
assert("httpReason(302) === 'Found'", httpReason(302) === "Found");
assert("httpReason(401) === 'Unauthorized'", httpReason(401) === "Unauthorized");
assert("httpReason(403) === 'Forbidden'", httpReason(403) === "Forbidden");
assert("httpReason(429) === 'Too Many Requests'",
  httpReason(429) === "Too Many Requests");
assert("httpReason(299) (unknown 2xx) falls back to 'OK'",
  httpReason(299) === "OK");
assert("httpReason(599) (unknown 5xx) falls back to 'Error'",
  httpReason(599) === "Error");

let allNonEmpty = true;
for (let code = 200; code < 600; code++) {
  if (!httpReason(code)) { allNonEmpty = false; break; }
}
assert("httpReason() never returns empty string for 200..599", allNonEmpty);

// Restore env
if (origDebug !== undefined) process.env.TINA4_DEBUG = origDebug;
else delete process.env.TINA4_DEBUG;
if (origRouting !== undefined) process.env.TINA4_TEMPLATE_ROUTING = origRouting;
else delete process.env.TINA4_TEMPLATE_ROUTING;
delete process.env.TINA4_OVERRIDE_CLIENT;
delete process.env.TINA4_RATE_LIMIT;
delete process.env.TINA4_NO_AI_PORT;
delete process.env.TINA4_NO_BROWSER;

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

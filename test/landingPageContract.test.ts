/**
 * Default landing page — dev-only welcome page, 404-in-prod info-leak guard.
 *
 * Feature 46. See LAND-DEC-01/LAND-DEC-02 and
 * tina4-documentation/plan/v3/fixtures/landing_page_contract.json.
 *
 * Driven through a REAL server (startServer) over a REAL socket - NO mocks.
 * Real GET /, TINA4_DEBUG toggled for real.
 *
 * Cases (shared names, all four):
 *   1. dev_mode_serves_the_branded_landing_page - TINA4_DEBUG on, no user /
 *      route -> 200 + the branded banner.
 *   2. production_returns_404_and_leaks_nothing - TINA4_DEBUG off -> 404, and
 *      the body carries NO framework version, NO /__dev link, NO gallery (the
 *      SECURITY case - LAND-PROD-DECIDED).
 *   3. a_user_root_route_always_wins - a registered GET / handler wins in
 *      BOTH dev and prod.
 *   4. a_pages_index_template_suppresses_the_landing - a
 *      src/templates/pages/index.* is served at / instead of the landing.
 *
 * Same case names in all four:
 *   tina4-python/tests/test_landing_page_contract.py
 *   tina4-php/tests/LandingPageContractTest.php
 *   tina4-ruby/spec/landing_page_contract_spec.rb
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { startServer, resetTemplateCache } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

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

function req(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", agent: false },
      (rs) => {
        let body = "";
        rs.on("data", (c) => (body += c));
        rs.on("end", () => resolve({ status: rs.statusCode ?? 0, body }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function freshDir(tag: string): string {
  const dir = join("/tmp", `tina4-landing-contract-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src/routes"), { recursive: true });
  mkdirSync(join(dir, "src/templates/pages"), { recursive: true });
  return dir;
}

async function boot(dir: string, dev: boolean, port: number) {
  process.env.TINA4_DEBUG = dev ? "true" : "false";
  process.env.TINA4_OVERRIDE_CLIENT = "true";
  process.env.TINA4_RATE_LIMIT = "10000";
  process.env.TINA4_NO_AI_PORT = "true";
  process.env.TINA4_NO_BROWSER = "true";
  delete process.env.TINA4_TEMPLATE_ROUTING;
  resetTemplateCache();
  return startServer({ port, basePath: dir });
}

async function main() {
  const origDebug = process.env.TINA4_DEBUG;

  // ---------------------------------------------- 1. dev shows the banner
  {
    const dir = freshDir("dev");
    const port = await freePort();
    const server = await boot(dir, true, port);
    const r = await req(port, "/");
    assert("dev_mode_serves_the_branded_landing_page: status", r.status === 200, String(r.status));
    assert("dev_mode_serves_the_branded_landing_page: banner", r.body.includes("Tina4NodeJs"));
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // ----------------------------------------- 2. prod 404s and leaks nothing
  {
    const dir = freshDir("prod");
    const port = await freePort();
    const server = await boot(dir, false, port);
    const r = await req(port, "/");
    assert("production_returns_404_and_leaks_nothing: status", r.status === 404, String(r.status));
    assert("production_returns_404_and_leaks_nothing: no banner", !r.body.includes("Tina4NodeJs"));
    assert("production_returns_404_and_leaks_nothing: no dev link", !r.body.includes("/__dev"));
    assert("production_returns_404_and_leaks_nothing: no gallery", !r.body.includes('id="gallery"'));
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // ------------------------------------------- 3. a user / route always wins
  for (const dev of [true, false]) {
    const dir = freshDir("userwins-" + dev);
    writeFileSync(
      join(dir, "src/routes/get.ts"),
      `export default async function (req: unknown, res: any) { return res.html("USER-ROOT-MARKER-NODE"); }\n`,
    );
    const port = await freePort();
    const server = await boot(dir, dev, port);
    const r = await req(port, "/");
    assert(`a_user_root_route_always_wins (dev=${dev}): status`, r.status === 200, String(r.status));
    assert(`a_user_root_route_always_wins (dev=${dev}): marker`, r.body.includes("USER-ROOT-MARKER-NODE"));
    assert(`a_user_root_route_always_wins (dev=${dev}): no banner`, !r.body.includes("Tina4NodeJs"));
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // ----------------------------------- 4. pages/index beats the landing
  {
    const dir = freshDir("pagesindex");
    writeFileSync(join(dir, "src/templates/pages/index.twig"), "PAGES-INDEX-MARKER-NODE");
    const port = await freePort();
    const server = await boot(dir, true, port);
    const r = await req(port, "/");
    assert("a_pages_index_template_suppresses_the_landing: status", r.status === 200, String(r.status));
    assert("a_pages_index_template_suppresses_the_landing: marker", r.body.includes("PAGES-INDEX-MARKER-NODE"));
    assert("a_pages_index_template_suppresses_the_landing: no banner", !r.body.includes("Tina4NodeJs"));
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  if (origDebug !== undefined) process.env.TINA4_DEBUG = origDebug;
  else delete process.env.TINA4_DEBUG;
  delete process.env.TINA4_OVERRIDE_CLIENT;
  delete process.env.TINA4_RATE_LIMIT;
  delete process.env.TINA4_NO_AI_PORT;
  delete process.env.TINA4_NO_BROWSER;

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);

  if (fail > 0) process.exitCode = 1;
}

void main();

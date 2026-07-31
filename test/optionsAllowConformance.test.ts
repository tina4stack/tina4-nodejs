/**
 * Every successful OPTIONS response carries Allow (RFC 9110 s9.3.7).
 *
 * There are TWO OPTIONS paths and they used to answer different questions:
 *
 *   bare OPTIONS  (no Origin)  - protocol introspection. Link checkers,
 *                                monitoring probes, `curl -X OPTIONS`.
 *   CORS preflight (Origin)    - a browser asking "may I send this?".
 *
 * A preflight IS an OPTIONS response, so it should carry Allow too. Measured
 * 2026-07-31: Ruby, Python and Node all dropped it on a preflight, and PHP
 * dropped it on BOTH as soon as CorsMiddleware was registered.
 *
 * Allow and Access-Control-Allow-Methods are NOT interchangeable and this
 * suite asserts both: Allow is what the RESOURCE supports (derived from the
 * router), ACAM is what the CORS POLICY permits cross-origin (a configured
 * static list, as in every mainstream CORS library). A policy naming DELETE on
 * a GET-only route is still a 405, so a client reading only ACAM is misled.
 *
 * NO MOCKS: a real server over a real socket, reaped in a finally.
 *
 * Same case names in all four frameworks:
 *   tina4-ruby/spec/options_allow_conformance_spec.rb
 *   tina4-python/tests/test_options_allow_conformance.py
 *   tina4-php/tests/OptionsAllowConformanceTest.php
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const root = mkdtempSync(join(tmpdir(), "tina4-optallow-"));
const routesDir = join(root, "src", "routes");
mkdirSync(join(routesDir, "only-get"), { recursive: true });
writeFileSync(join(routesDir, "only-get", "get.ts"),
  'export default async function (_q: any, r: any) { return r("ok", 200); }\n');
writeFileSync(join(routesDir, "only-get", "post.ts"),
  'export default async function (_q: any, r: any) { return r("ok", 200); }\n');

const PREFLIGHT = {
  Origin: "https://example.com",
  "Access-Control-Request-Method": "POST",
};

const PORT = await freePort();
let server: any;

async function options(headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/only-get`, { method: "OPTIONS", headers });
  return { status: r.status, headers: r.headers };
}

console.log("=== OPTIONS Allow conformance (Node) ===\n");

try {
  server = await startServer({ port: PORT, routesDir } as never);

  {
    // A bare OPTIONS must reach the RFC 9110 handler, not be eaten by CORS.
    const r = await options();
    assert("a bare options carries allow",
      r.status === 204 && r.headers.get("allow") === "GET, POST, HEAD, OPTIONS",
      `${r.status} allow=${r.headers.get("allow")}`);
  }

  {
    // The gap this suite was written for.
    const r = await options(PREFLIGHT);
    assert("a cors preflight also carries allow",
      r.status === 204 && r.headers.get("allow") === "GET, POST, HEAD, OPTIONS",
      `${r.status} allow=${r.headers.get("allow")} - a preflight returned 204 without Allow`);
  }

  {
    // NEGATIVE: the fix must not break CORS itself.
    const r = await options(PREFLIGHT);
    assert("a real preflight is still answered by cors",
      r.headers.get("access-control-allow-origin") !== null &&
      r.headers.get("access-control-allow-methods") !== null,
      `origin=${r.headers.get("access-control-allow-origin")}`);
  }

  {
    // Allow describes the RESOURCE; ACAM describes the POLICY. Different
    // values on purpose - conflating them is the bug this pins.
    const r = await options(PREFLIGHT);
    const allow = r.headers.get("allow") ?? "";
    const acam = r.headers.get("access-control-allow-methods") ?? "";
    assert("allow describes the resource not the policy",
      !allow.includes("DELETE") && acam.includes("DELETE") && allow !== acam,
      `allow=${allow} acam=${acam}`);
  }
} finally {
  // We started it, we own its death - a leaked listener holds the port forever.
  try { server?.close?.(); } catch { /* already down */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

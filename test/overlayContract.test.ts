/**
 * Error-overlay conformance — dead-code removal, redaction, frame cap, self-throw guard.
 *
 * Feature 126. See OVERLAY-DEC-01..04 and
 * tina4-documentation/plan/v3/fixtures/overlay_contract.json.
 *
 * Four rules, driven through the REAL server (a real HTTP request to a started
 * server / a real thrown 500). NO MOCKS.
 *
 *   1. WIRED PRODUCTION NO-LEAK (OVERLAY-DEC-01). renderProductionError is deleted;
 *      the real production 500 renders errors/500.twig with an empty error_message
 *      (CWE-209). A real production 500 leaks neither the message nor a stack.
 *   2. REDACTION (OVERLAY-DEC-02). The dev overlay masks Authorization/Cookie headers
 *      and password-like param keys.
 *   3. FRAME CAP (OVERLAY-DEC-03). A 5000-deep recursive stack renders a bounded page.
 *   4. SELF-THROW GUARD (OVERLAY-DEC-03). If the overlay render throws (an
 *      unrenderable request value), the dispatch still returns a safe 500.
 *
 * Mutation-proved: make redact() return the value and case 2 goes RED; drop the
 * MAX_FRAMES slice and case 3 goes RED; drop the try/catch around the overlay in
 * renderDispatchError and case 4 goes RED (the overlay throw double-faults the socket).
 *
 * Same case names in all four:
 *   tina4-python/tests/test_overlay_contract.py
 *   tina4-php/tests/OverlayContractTest.php
 *   tina4-ruby/spec/overlay_contract_spec.rb
 */

import { startServer, defaultRouter, get, post, renderErrorOverlay } from "../packages/core/src/index.ts";
import { request as httpRequest } from "node:http";
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

// Secret VALUES as named constants, referenced below, so the literal never sits in a
// rendered source window; the redaction under test is the REQUEST table.
const LEAK_MARKER = "SECRET-MARKER-do-not-leak-9f3a";
const AUTH_SECRET = "sekret-auth-71c2";
const COOKIE_SECRET = "sekret-cookie-4d8e";
const PASSWORD_SECRET = "hunter2-9a1f";

function httpReq(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  payload?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ method, host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const httpGet = (port: number, path: string, headers: Record<string, string> = {}) =>
  httpReq(port, "GET", path, headers);

async function run(): Promise<void> {
  console.log("=== Error overlay contract (feature 126) ===\n");

  const savedDebug = process.env.TINA4_DEBUG;
  delete process.env.TINA4_DEBUG;
  process.env.TINA4_NO_BANNER = "true";
  process.env.TINA4_NO_BROWSER = "true";
  process.env.TINA4_NO_AI_PORT = "true";

  defaultRouter.clear();

  get("/overlay-boom", () => { throw new Error(LEAK_MARKER); });
  // Public POST so the real client-sent JSON body reaches req.body (Node only parses
  // bodies for non-GET methods); the overlay then renders + redacts body.password.
  post("/overlay-secret", () => { throw new Error("handler exploded"); }).noAuth();
  get("/overlay-poison", (request: any, response: any) => {
    // A real request value whose String() raises — the "malformed edge" the overlay
    // guard exists for. NOT a mock: the real overlay really fails on it. (args are
    // resolved BY NAME, so this handler must name `request`.)
    void response;
    request.body = { note: { toString() { throw new Error("poison toString exploded"); } } };
    throw new Error("handler boom marker");
  });

  const port = await freePort();
  const server = await startServer({ port, host: "127.0.0.1", autoDiscover: false });

  try {
    // ── 1. wired production no-leak ────────────────────────────────
    console.log("--- 1. a wired production 500 does not leak the exception ---");
    delete process.env.TINA4_DEBUG;
    const r1 = await httpGet(port, "/overlay-boom");
    assert("a wired production 500 does not leak the exception: status 500", r1.status === 500, `got ${r1.status}`);
    for (const marker of [LEAK_MARKER, "Error:", "at ", "server.ts", "errorOverlay"]) {
      assert(`production body does not leak '${marker}'`, !r1.body.includes(marker),
        `CWE-209 regression: ${r1.body.slice(0, 300)}`);
    }

    // ── 2. redaction (dev) ─────────────────────────────────────────
    console.log("\n--- 2. the dev overlay redacts authorization and secret body fields ---");
    process.env.TINA4_DEBUG = "true";
    const secretBody = JSON.stringify({ password: PASSWORD_SECRET, username: "alice" });
    const r2 = await httpReq(port, "POST", "/overlay-secret", {
      Authorization: `Bearer ${AUTH_SECRET}`,
      Cookie: `session=${COOKIE_SECRET}`,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(secretBody)),
    }, secretBody);
    assert("the dev overlay redacts authorization and secret body fields: status 500", r2.status === 500, `got ${r2.status}`);
    // The overlay DID render the request section (redaction masks, not hides):
    assert("dev overlay renders the request section", r2.body.includes("Request Details"));
    assert("dev overlay shows a non-sensitive value verbatim", r2.body.includes("alice"));
    assert("dev overlay emits the redaction placeholder", r2.body.includes("[redacted]"));
    for (const secret of [AUTH_SECRET, COOKIE_SECRET, PASSWORD_SECRET]) {
      assert(`dev overlay masks the secret '${secret}'`, !r2.body.includes(secret),
        `leaked: ${r2.body.slice(0, 300)}`);
    }
    delete process.env.TINA4_DEBUG;

    // ── 3. frame cap ───────────────────────────────────────────────
    console.log("\n--- 3. a deep recursive stack renders a frame capped page ---");
    const deepErr = makeDeepError(5000);
    const html = renderErrorOverlay(deepErr);
    const frameBlocks = html.split('<div style="margin-bottom:16px;">').length - 1;
    assert("a deep recursive stack renders a frame capped page: bounded",
      frameBlocks <= 50, `frame count ${frameBlocks} exceeds the cap 50 — unbounded render`);
    assert("deep-stack overlay notes the truncation", html.includes("more stack frames hidden"));

    // ── 4. self-throw guard ────────────────────────────────────────
    console.log("\n--- 4. a throwing overlay render still returns a safe 500 ---");
    process.env.TINA4_DEBUG = "true";
    const r4 = await httpGet(port, "/overlay-poison");
    assert("a throwing overlay render still returns a safe 500: status 500", r4.status === 500, `got ${r4.status}`);
    assert("guarded 500 does not leak the poison error", !r4.body.includes("poison toString exploded"));
    assert("guarded 500 does not leak the handler message", !r4.body.includes("handler boom marker"));
    delete process.env.TINA4_DEBUG;
  } finally {
    server.close();
    defaultRouter.clear();
    if (savedDebug !== undefined) process.env.TINA4_DEBUG = savedDebug; else delete process.env.TINA4_DEBUG;
    delete process.env.TINA4_NO_BANNER;
    delete process.env.TINA4_NO_BROWSER;
    delete process.env.TINA4_NO_AI_PORT;
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

function makeDeepError(depth: number): Error {
  function deepRecurse(n: number): number {
    if (n <= 0) throw new Error("deep stack marker");
    return deepRecurse(n - 1);
  }
  const savedLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = depth + 1000; // capture the full deep stack (default is 10)
  try {
    deepRecurse(depth);
    throw new Error("expected the deep recursion to throw");
  } catch (e) {
    return e as Error;
  } finally {
    Error.stackTraceLimit = savedLimit;
  }
}

run().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});

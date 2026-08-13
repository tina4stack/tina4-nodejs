/**
 * Tina4 Node.js — v3.13.7 router error handling (DevProx brief PLATFORM-2159).
 *
 * Three contracts:
 *
 *   1. `tina4.request.error` event fires before the 500 is rendered, so
 *      observability consumers see route failures even though the
 *      framework caught them. Payload is `{ exception, request }` — same
 *      shape mirrored by Python / PHP / Ruby.
 *
 *   2. In non-debug mode the 500 response body never contains a stack
 *      trace (CWE-209). Debug mode keeps the ErrorOverlay path intact.
 *
 *   3. Listener exceptions MUST NOT break the 500 render. A broken
 *      listener gets logged via `Log.warning` and the framework proceeds.
 */

import { startServer, defaultRouter, Events, get } from "../packages/core/src/index.ts";
import { request as httpRequest } from "node:http";
import { freePort } from "./freePort.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    // eslint-disable-next-line no-console
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    // eslint-disable-next-line no-console
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function get500(port: number, path = "/api/widgets"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { method: "GET", host: "127.0.0.1", port, path },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function run(): Promise<void> {
  console.log("=== Router error event (v3.13.7) ===\n");

  // Force production mode so we exercise the safe-render path (CWE-209 fix).
  const savedDebug = process.env.TINA4_DEBUG;
  delete process.env.TINA4_DEBUG;
  // Disable banner, browser, and dual-port so the test runner stays quiet
  // and we don't try to bind two ports.
  process.env.TINA4_NO_BANNER = "true";
  process.env.TINA4_NO_BROWSER = "true";
  process.env.TINA4_NO_AI_PORT = "true";

  // Clean event registry between tests so listeners don't leak.
  defaultRouter.clear();
  Events.clear();

  // Register routes that throw at predictable paths.
  get("/api/widgets", () => {
    throw new Error("simulated explosion inside route");
  });
  get("/api/leak-test", () => {
    throw new Error("simulated explosion inside route");
  });

  // Pick a deterministic high port to avoid the "startServer returns
  // configured port not bound port" quirk when port=0.
  const port = await freePort();
  const server = await startServer({ port, host: "127.0.0.1", autoDiscover: false });

  try {
    // ── Contract 1: event payload ─────────────────────────────────────
    console.log("--- Contract 1: event fires with the right payload ---");
    const captured: any[] = [];
    Events.on("tina4.request.error", (payload: any) => { captured.push(payload); });

    const r1 = await get500(port, "/api/widgets");
    assert("response status is 500", r1.status === 500, `got ${r1.status}`);
    assert("listener fired exactly once", captured.length === 1, `fired ${captured.length} times`);
    const payload = captured[0] ?? {};
    assert("payload has exception", payload.exception instanceof Error, "exception missing or not Error");
    assert(
      "payload exception has expected message",
      payload.exception?.message === "simulated explosion inside route",
      `got: ${payload.exception?.message}`,
    );
    assert("payload has request", payload.request != null && typeof payload.request.path === "string");

    Events.clear();

    // ── Contract 2: no stack trace in production body (CWE-209) ───────
    console.log("\n--- Contract 2: production body has no stack trace ---");
    const r2 = await get500(port, "/api/leak-test");
    assert("response status is 500", r2.status === 500);
    const forbidden = [
      "simulated explosion inside route",   // exception message
      "Error:",                              // exception class prefix
      "at ",                                  // V8 stack frame marker
      "server.ts",                            // framework path
      "router.ts",                            // framework path
    ];
    for (const marker of forbidden) {
      assert(
        `body does not leak '${marker}'`,
        !r2.body.includes(marker),
        `CWE-209 regression: body contains ${marker}\n--- body ---\n${r2.body.slice(0, 500)}`,
      );
    }
    assert("body still contains a request_id-shaped token", /[a-z0-9]{4,}/i.test(r2.body));

    // ── Contract 3: listener errors don't break the 500 render ────────
    console.log("\n--- Contract 3: listener safety ---");
    Events.on("tina4.request.error", () => { throw new Error("listener is broken"); });
    const r3 = await get500(port, "/api/widgets");
    assert("500 still renders despite listener throwing", r3.status === 500);

    Events.clear();

    // ── Contract 4: multiple listeners all fire in priority order ─────
    console.log("\n--- Contract 4: multiple listeners (priority order) ---");
    const calls: string[] = [];
    Events.on("tina4.request.error", () => { calls.push("first"); }, 10);
    Events.on("tina4.request.error", () => { calls.push("second"); }, 0);
    await get500(port, "/api/widgets");
    assert(
      "listeners fire in priority order (higher first)",
      JSON.stringify(calls) === JSON.stringify(["first", "second"]),
      `calls=${JSON.stringify(calls)}`,
    );
  } finally {
    server.close();
    Events.clear();
    defaultRouter.clear();
    if (savedDebug !== undefined) process.env.TINA4_DEBUG = savedDebug;
    delete process.env.TINA4_NO_BANNER;
    delete process.env.TINA4_NO_BROWSER;
    delete process.env.TINA4_NO_AI_PORT;
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});

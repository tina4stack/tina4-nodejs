/**
 * Tests for the customer feedback widget (Tier 4).
 *
 * Mirrors the python parity tests at tina4_python/tests/test_feedback.py
 * and the Tier-3 supervisor proxy pattern in test/devAdmin.test.ts.
 *
 * Run with: npx tsx test/feedback.test.ts
 */

import {
  feedbackEnabled,
  feedbackWhitelist,
  injectFeedbackWidget,
  handleFeedbackTurn,
  handleFeedbackWidgetJs,
  Router,
  DevAdmin,
} from "../packages/core/src/index.ts";
import { _resetFeedbackRateLimit } from "../packages/core/src/feedback.ts";
import type { Tina4Request } from "../packages/core/src/index.ts";

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

console.log("=== Customer Feedback Widget Tests ===\n");

// ── Helpers ─────────────────────────────────────────────────────

function mockReq(path = "/", headers: Record<string, string> = {}, body?: unknown): Tina4Request {
  return {
    url: path,
    path,
    method: "GET",
    headers,
    body,
  } as unknown as Tina4Request;
}

function mockRes() {
  let json: unknown = undefined;
  let status: number | undefined = undefined;
  let rawWriteHeadStatus: number | undefined = undefined;
  let rawHeaders: Record<string, string | number | string[]> = {};
  let rawBody: Buffer | undefined = undefined;
  const chunks: Buffer[] = [];
  return {
    json(data: unknown, s?: number) {
      json = data;
      status = s;
    },
    html(_: unknown, s?: number) {
      status = s;
    },
    raw: {
      writeHead(code: number, h?: Record<string, string | number | string[]>) {
        rawWriteHeadStatus = code;
        if (h) rawHeaders = h;
      },
      end(buf?: Buffer | string) {
        if (buf !== undefined) {
          const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
          chunks.push(b);
          rawBody = b;
        }
      },
      write(buf: Buffer | string) {
        chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
      },
    },
    get result() {
      return json;
    },
    get status() {
      return status;
    },
    get rawStatus() {
      return rawWriteHeadStatus;
    },
    get rawHeaders() {
      return rawHeaders;
    },
    get rawBody() {
      return rawBody?.toString("utf-8") ?? "";
    },
  };
}

// Snapshot + clean env before each section
function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prior[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof (out as Promise<void>).then === "function") {
      return (out as Promise<void>).finally(restore);
    }
    restore();
    return Promise.resolve();
  } catch (e) {
    restore();
    throw e;
  }
}

const SAMPLE_HTML =
  "<!doctype html><html><head><title>x</title></head><body><h1>Hi</h1></body></html>";

// ── feedbackEnabled / feedbackWhitelist ─────────────────────────

console.log("--- env gating ---");

await withEnv({ TINA4_ENABLE_FEEDBACK: undefined, TINA4_FEEDBACK_WHITELIST: undefined }, () => {
  assert("disabled when env unset", feedbackEnabled() === false);
  assert("whitelist empty when env unset", feedbackWhitelist().length === 0);
});

await withEnv({ TINA4_ENABLE_FEEDBACK: "true", TINA4_FEEDBACK_WHITELIST: "Alice@Example.com, bob@x.io" }, () => {
  assert("enabled when env=true", feedbackEnabled() === true);
  const wl = feedbackWhitelist();
  assert("whitelist lowercased + trimmed", wl.length === 2 && wl[0] === "alice@example.com" && wl[1] === "bob@x.io");
});

await withEnv({ TINA4_ENABLE_FEEDBACK: "false", TINA4_FEEDBACK_WHITELIST: "alice@x" }, () => {
  assert("whitelist empty when master switch off", feedbackWhitelist().length === 0);
});

// ── injectFeedbackWidget ────────────────────────────────────────

console.log("\n--- injectFeedbackWidget ---");

// 1. "skips injection when disabled" — master switch off → html unchanged
await withEnv({ TINA4_ENABLE_FEEDBACK: undefined, TINA4_FEEDBACK_WHITELIST: "alice@x.io", TINA4_FEEDBACK_DEV_USER: "alice@x.io" }, () => {
  const out = injectFeedbackWidget(mockReq("/"), SAMPLE_HTML);
  assert("skips injection when disabled", out === SAMPLE_HTML);
});

// 2. "skips injection on /__dev paths" — even when fully enabled
await withEnv({
  TINA4_ENABLE_FEEDBACK: "true",
  TINA4_FEEDBACK_WHITELIST: "alice@x.io",
  TINA4_FEEDBACK_DEV_USER: "alice@x.io",
}, () => {
  const out = injectFeedbackWidget(mockReq("/__dev/whatever"), SAMPLE_HTML);
  assert("skips injection on /__dev paths", out === SAMPLE_HTML);
  const out2 = injectFeedbackWidget(mockReq("/__feedback/widget.js"), SAMPLE_HTML);
  assert("skips injection on /__feedback paths", out2 === SAMPLE_HTML);
});

// 3. "injects for whitelisted user"
await withEnv({
  TINA4_ENABLE_FEEDBACK: "true",
  TINA4_FEEDBACK_WHITELIST: "alice@x.io",
  TINA4_FEEDBACK_DEV_USER: "alice@x.io",
}, () => {
  const out = injectFeedbackWidget(mockReq("/page"), SAMPLE_HTML);
  assert("injects for whitelisted user", out.includes('data-tina4-feedback') && out.includes('/__feedback/widget.js'));
  assert("script inserted before last </body>", out.indexOf("data-tina4-feedback") < out.lastIndexOf("</body>"));
});

// 4. "is idempotent on re-injection" — second pass doesn't double the tag
await withEnv({
  TINA4_ENABLE_FEEDBACK: "true",
  TINA4_FEEDBACK_WHITELIST: "alice@x.io",
  TINA4_FEEDBACK_DEV_USER: "alice@x.io",
}, () => {
  const once = injectFeedbackWidget(mockReq("/page"), SAMPLE_HTML);
  const twice = injectFeedbackWidget(mockReq("/page"), once);
  const occurrences = (twice.match(/data-tina4-feedback/g) ?? []).length;
  assert("idempotent on re-injection", occurrences === 1);
});

// Edge: user not in whitelist
await withEnv({
  TINA4_ENABLE_FEEDBACK: "true",
  TINA4_FEEDBACK_WHITELIST: "someone@else.io",
  TINA4_FEEDBACK_DEV_USER: "alice@x.io",
}, () => {
  const out = injectFeedbackWidget(mockReq("/page"), SAMPLE_HTML);
  assert("non-whitelisted user gets no widget", out === SAMPLE_HTML);
});

// Edge: html without </body>
await withEnv({
  TINA4_ENABLE_FEEDBACK: "true",
  TINA4_FEEDBACK_WHITELIST: "alice@x.io",
  TINA4_FEEDBACK_DEV_USER: "alice@x.io",
}, () => {
  const fragment = "<div>partial</div>";
  const out = injectFeedbackWidget(mockReq("/page"), fragment);
  assert("html with no </body> is returned unchanged", out === fragment);
});

// ── handleFeedbackTurn (POST /__feedback/api/turn) ──────────────

console.log("\n--- POST /__feedback/api/turn ---");

// 5. "rejects non-whitelisted turn POST"
await withEnv({
  TINA4_ENABLE_FEEDBACK: "true",
  TINA4_FEEDBACK_WHITELIST: "alice@x.io",
  TINA4_FEEDBACK_DEV_USER: undefined,
}, async () => {
  _resetFeedbackRateLimit();
  const res = mockRes();
  await handleFeedbackTurn(mockReq("/__feedback/api/turn", {}, { message: "hi" }) as Tina4Request, res as any);
  assert("rejects non-whitelisted turn POST", res.status === 403);
});

// 6. "rate limits at 5/hour"
await withEnv({
  TINA4_ENABLE_FEEDBACK: "true",
  TINA4_FEEDBACK_WHITELIST: "alice@x.io",
  TINA4_FEEDBACK_DEV_USER: "alice@x.io",
}, async () => {
  // Spin up a stub that accepts every turn so we can exercise the rate limit
  // without it tripping on the upstream call.
  const { createServer } = await import("node:http");
  const stub = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as import("node:net").AddressInfo).port;
  const priorSupervisor = process.env.TINA4_SUPERVISOR_URL;
  process.env.TINA4_SUPERVISOR_URL = `http://127.0.0.1:${port}`;

  try {
    _resetFeedbackRateLimit();
    const statuses: Array<number | undefined> = [];
    for (let i = 0; i < 6; i++) {
      const res = mockRes();
      await handleFeedbackTurn(
        mockReq("/__feedback/api/turn", {}, { message: `turn ${i}` }) as Tina4Request,
        res as any,
      );
      statuses.push(res.status);
    }
    const finalStatus = statuses[5];
    assert(
      "first 5 turns accepted (status undefined or 200)",
      statuses.slice(0, 5).every((s) => s === undefined || s === 200),
    );
    assert("6th turn is rate-limited with 429", finalStatus === 429);
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (priorSupervisor === undefined) delete process.env.TINA4_SUPERVISOR_URL;
    else process.env.TINA4_SUPERVISOR_URL = priorSupervisor;
  }
});

// 7. "forwards turn to supervisor" with server-stamped sender
await withEnv({
  TINA4_ENABLE_FEEDBACK: "true",
  TINA4_FEEDBACK_WHITELIST: "alice@x.io",
  TINA4_FEEDBACK_DEV_USER: "alice@x.io",
}, async () => {
  const { createServer } = await import("node:http");

  type Captured = { method: string; url: string; body: string };
  const captured: Captured[] = [];
  const stub = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, echo: JSON.parse(body || "{}") }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as import("node:net").AddressInfo).port;
  const priorSupervisor = process.env.TINA4_SUPERVISOR_URL;
  process.env.TINA4_SUPERVISOR_URL = `http://127.0.0.1:${port}`;

  try {
    _resetFeedbackRateLimit();
    const res = mockRes();
    // Client attempts to spoof `sender` — handler must overwrite it.
    await handleFeedbackTurn(
      mockReq(
        "/__feedback/api/turn",
        {},
        { message: "first thoughts", sender: "evil@attacker.io" },
      ) as Tina4Request,
      res as any,
    );

    assert("outbound POST reached the stub", captured.length === 1);
    assert("outbound path is /feedback/intake", captured[0]?.url === "/feedback/intake");
    assert("outbound method is POST", captured[0]?.method === "POST");
    let body: any = {};
    try { body = JSON.parse(captured[0]?.body ?? "{}"); } catch { /* keep default */ }
    assert("sender is server-stamped from whitelist identity", body.sender === "alice@x.io");
    assert("client-supplied sender is overwritten", body.sender !== "evil@attacker.io");
    assert("message body forwarded verbatim", body.message === "first thoughts");
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (priorSupervisor === undefined) delete process.env.TINA4_SUPERVISOR_URL;
    else process.env.TINA4_SUPERVISOR_URL = priorSupervisor;
  }
});

// ── handleFeedbackWidgetJs (GET /__feedback/widget.js) ──────────

console.log("\n--- GET /__feedback/widget.js ---");

// 8. "serves widget.js with no-cache headers"
{
  const res = mockRes();
  await handleFeedbackWidgetJs(mockReq("/__feedback/widget.js") as Tina4Request, res as any);
  assert("returns 200", res.rawStatus === 200);
  const headers = res.rawHeaders as Record<string, string>;
  const cacheCtrl = String(headers["Cache-Control"] ?? headers["cache-control"] ?? "").toLowerCase();
  assert("Cache-Control header present", cacheCtrl.length > 0);
  assert("Cache-Control marks no-cache", cacheCtrl.includes("no-cache"));
  assert("Cache-Control marks must-revalidate", cacheCtrl.includes("must-revalidate"));
  const ct = String(headers["Content-Type"] ?? headers["content-type"] ?? "").toLowerCase();
  assert("Content-Type is application/javascript", ct.includes("application/javascript"));
  assert("body is non-empty", res.rawBody.length > 0);
}

// ── route registration smoke ────────────────────────────────────

console.log("\n--- route registration ---");

{
  // The DevAdmin.register call also registers the feedback routes via
  // registerFeedbackRoutes(router). Sanity-check both endpoints exist.
  process.env.TINA4_DEBUG = "true";
  const router = new Router();
  DevAdmin.register(router);
  const routes = router.getRoutes();
  const turn = routes.find((r) => r.method === "POST" && r.pattern === "/__feedback/api/turn");
  const widget = routes.find((r) => r.method === "GET" && r.pattern === "/__feedback/widget.js");
  assert("POST /__feedback/api/turn registered", turn !== undefined);
  assert("GET /__feedback/widget.js registered", widget !== undefined);
}

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

if (fail > 0) process.exit(1);

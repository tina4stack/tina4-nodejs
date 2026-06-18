/**
 * Lock-in tests for E1 (event listener isolation) + M1 (middleware
 * ordering / no-skip) + M2 (middleware-throw 500 / after-on-4xx rule).
 *
 * These are the regression guards for the "visible-but-resilient"
 * philosophy: an event bus never lets one listener break the others, and
 * the middleware chain is deterministic (registration/definition order),
 * never silently skips a middleware, and a throwing middleware yields a
 * logged clean 500 instead of crashing the worker.
 *
 * Mirrors tina4-python's tests/test_middleware_events.py — same contract is
 * shared across tina4-python, tina4-php, tina4-ruby, tina4-nodejs.
 *
 * Run with: npx tsx test/middlewareEvents.test.ts
 */
import {
  Events,
  MiddlewareChain,
  MiddlewareRunner,
  Log,
} from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";

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

// Capture Log output (everything routes through console.log/console.error).
function captureLogs<T>(fn: () => T): { out: string; value: T } {
  let out = "";
  const log = console.log;
  const err = console.error;
  const warn = console.warn;
  const sink = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  console.log = sink as typeof console.log;
  console.error = sink as typeof console.error;
  console.warn = sink as typeof console.warn;
  try {
    const value = fn();
    return { out, value };
  } finally {
    console.log = log;
    console.error = err;
    console.warn = warn;
  }
}

async function captureLogsAsync<T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> {
  let out = "";
  const log = console.log;
  const err = console.error;
  const warn = console.warn;
  const sink = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  console.log = sink as typeof console.log;
  console.error = sink as typeof console.error;
  console.warn = sink as typeof console.warn;
  try {
    const value = await fn();
    return { out, value };
  } finally {
    console.log = log;
    console.error = err;
    console.warn = warn;
  }
}

// ── Mocks (no external services) ─────────────────────────────────
function mockReq(): Tina4Request {
  return {
    method: "GET",
    url: "/test",
    headers: {},
    params: {},
    query: {},
    body: undefined,
    ip: "127.0.0.1",
    files: {},
  } as unknown as Tina4Request;
}

function mockRes(): Tina4Response & {
  _headers: Record<string, string>;
  _status: number;
  _ended: boolean;
  _body: unknown;
} {
  const headers: Record<string, string> = {};
  const obj: any = {
    _headers: headers,
    _status: 200,
    _ended: false,
    _body: undefined,
    raw: { writableEnded: false, statusCode: 200, getHeader: (n: string) => headers[n.toLowerCase()], on: () => {} },
    header: (name: string, value: string) => { headers[name.toLowerCase()] = String(value); return obj; },
    status: (code: number) => { obj._status = code; obj.raw.statusCode = code; return obj; },
    json: (data: unknown, statusCode?: number) => {
      obj._ended = true;
      obj.raw.writableEnded = true;
      if (statusCode) { obj._status = statusCode; obj.raw.statusCode = statusCode; }
      obj._body = data;
      return obj;
    },
  };
  return obj as any;
}

// Make sure listener errors surface to stdout for the "never silent" assert.
Log.configure({});
process.env.TINA4_LOG_LEVEL = "WARNING";

console.log("=== Middleware + Events Lock-in Tests ===\n");

// ────────────────────────────────────────────────────────────────
// E1 — TestEventListenerIsolation
// ────────────────────────────────────────────────────────────────
console.log("--- E1: Event listener isolation ---");

// test_middle_listener_throws_others_still_run
{
  Events.clear();
  const ran: string[] = [];
  Events.on("evt", () => { ran.push("first"); return "r1"; }, 30);
  Events.on("evt", () => { ran.push("boom"); throw new Error("listener exploded"); }, 20);
  Events.on("evt", () => { ran.push("third"); return "r3"; }, 10);

  let results: unknown[] = [];
  let threw = false;
  const { } = captureLogs(() => {
    try { results = Events.emit("evt", "payload"); } catch { threw = true; }
  });

  assert("middle listener throws: 1st + 3rd still ran", JSON.stringify(ran) === JSON.stringify(["first", "boom", "third"]), `ran=${JSON.stringify(ran)}`);
  assert("emit did NOT raise", threw === false);
  assert("N listeners → N result slots, failed = null", JSON.stringify(results) === JSON.stringify(["r1", null, "r3"]), `results=${JSON.stringify(results)}`);
  Events.clear();
}

// test_error_is_logged_never_silent
{
  Events.clear();
  Events.on("evt.logged", () => { throw new Error("kaboom"); });
  const { out } = captureLogs(() => Events.emit("evt.logged"));
  assert("listener error logs the event name", out.includes("evt.logged"), `out=${out.trim()}`);
  assert("listener error logs the error (message or type)", out.includes("kaboom") || out.includes("Error"), `out=${out.trim()}`);
  Events.clear();
}

// test_strict_reraises_on_first_error
{
  Events.clear();
  const ran: string[] = [];
  Events.on("evt.strict", () => { ran.push("boom"); throw new Error("strict boom"); }, 20);
  Events.on("evt.strict", () => { ran.push("after"); }, 10);

  let threw = false;
  let msg = "";
  try {
    Events.emit("evt.strict", { strict: true });
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  assert("strict=true re-raises", threw === true);
  assert("strict re-raises the original error", msg === "strict boom", `msg=${msg}`);
  assert("strict stops at the first error (later listener did NOT run)", JSON.stringify(ran) === JSON.stringify(["boom"]), `ran=${JSON.stringify(ran)}`);
  Events.clear();
}

// test_non_throwing_listeners_unchanged
{
  Events.clear();
  Events.on("evt.ok", () => 1, 10);
  Events.on("evt.ok", () => 2, 5);
  assert("non-throwing listeners unchanged → [1, 2]", JSON.stringify(Events.emit("evt.ok")) === JSON.stringify([1, 2]));
  Events.clear();
}

// test_emit_async_isolates_each_listener (async + sync mix)
{
  Events.clear();
  Events.on("evt.async", async () => "a1", 30);
  Events.on("evt.async", () => { throw new Error("async boom"); }, 20);
  Events.on("evt.async", async () => "a3", 10);

  let results: unknown[] = [];
  let threw = false;
  await captureLogsAsync(async () => {
    try { results = await Events.emitAsync("evt.async"); } catch { threw = true; }
  });
  assert("emitAsync did NOT raise", threw === false);
  assert("emitAsync isolates each listener → ['a1', null, 'a3']", JSON.stringify(results) === JSON.stringify(["a1", null, "a3"]), `results=${JSON.stringify(results)}`);
  Events.clear();
}

// test_emit_async_strict_reraises
{
  Events.clear();
  const ran: string[] = [];
  Events.on("evt.async.strict", async () => { ran.push("boom"); throw new Error("async strict boom"); }, 20);
  Events.on("evt.async.strict", async () => { ran.push("after"); }, 10);

  let threw = false;
  try {
    await Events.emitAsync("evt.async.strict", { strict: true });
  } catch {
    threw = true;
  }
  assert("emitAsync strict=true re-raises", threw === true);
  assert("emitAsync strict stops at first error", JSON.stringify(ran) === JSON.stringify(["boom"]), `ran=${JSON.stringify(ran)}`);
  Events.clear();
}

// ────────────────────────────────────────────────────────────────
// M1 — TestMiddlewareDefinitionOrder + RegistrationOrder
// ────────────────────────────────────────────────────────────────
console.log("\n--- M1: Middleware ordering (definition + registration) ---");

// test_within_class_is_definition_order_not_alphabetical
{
  const trace: string[] = [];
  class OrderMw {
    static beforeZulu(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("zulu"); return [req, res]; }
    static beforeMike(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("mike"); return [req, res]; }
    static beforeAlpha(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("alpha"); return [req, res]; }
  }
  MiddlewareRunner.reset();
  await MiddlewareRunner.runBefore([OrderMw], mockReq(), mockRes());
  assert("within-class before_* run in DEFINITION order (zulu, mike, alpha)", JSON.stringify(trace) === JSON.stringify(["zulu", "mike", "alpha"]), `trace=${JSON.stringify(trace)}`);
  const sorted = [...trace].sort();
  assert("definition order is NOT alphabetical", JSON.stringify(trace) !== JSON.stringify(sorted), `trace=${JSON.stringify(trace)} sorted=${JSON.stringify(sorted)}`);
}

// test_after_methods_also_definition_order
{
  const trace: string[] = [];
  class AfterOrderMw {
    static afterZulu(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("zulu"); return [req, res]; }
    static afterMike(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("mike"); return [req, res]; }
    static afterAlpha(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("alpha"); return [req, res]; }
  }
  await MiddlewareRunner.runAfter([AfterOrderMw], mockReq(), mockRes());
  assert("within-class after_* run in DEFINITION order", JSON.stringify(trace) === JSON.stringify(["zulu", "mike", "alpha"]), `trace=${JSON.stringify(trace)}`);
}

// test_dispatch_runs_before_in_registration_order (cross-class)
{
  const trace: string[] = [];
  class A { static beforeA(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("A"); return [req, res]; } }
  class B { static beforeB(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("B"); return [req, res]; } }
  class C { static beforeC(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] { trace.push("C"); return [req, res]; } }
  // Registration order B, A, C must be honoured (not alphabetical A, B, C).
  await MiddlewareRunner.runBefore([B, A, C], mockReq(), mockRes());
  assert("cross-class before_* run in REGISTRATION order (B, A, C)", JSON.stringify(trace) === JSON.stringify(["B", "A", "C"]), `trace=${JSON.stringify(trace)}`);
}

// test_n_middleware_all_run_exactly_once_in_order (Node index-skip guard)
{
  const N = 5;
  const chain = new MiddlewareChain();
  const trace: string[] = [];
  const expected = Array.from({ length: N }, (_, i) => `mw${i}`);
  for (let i = 0; i < N; i++) {
    const label = `mw${i}`;
    chain.use((req, res, next) => { trace.push(label); next(); });
  }
  await chain.run(mockReq(), mockRes());
  assert("N=5 middleware all run, in order (no index-skip)", JSON.stringify(trace) === JSON.stringify(expected), `trace=${JSON.stringify(trace)}`);
  assert("each middleware runs exactly once", trace.length === new Set(trace).size && trace.length === N);
}

// ────────────────────────────────────────────────────────────────
// M2 — TestMiddlewareThrow + TestAfterOn4xxRule
// ────────────────────────────────────────────────────────────────
console.log("\n--- M2: Middleware throw → clean 500 + after-on-4xx ---");

// test_before_throw_yields_clean_500_and_skips_handler
{
  class BoomMw {
    static beforeBoom(_req: Tina4Request, _res: Tina4Response): [Tina4Request, Tina4Response] {
      throw new Error("before exploded");
    }
  }
  const res = mockRes();
  let result: [unknown, unknown, boolean];
  const { out } = await captureLogsAsync(async () => {
    result = await MiddlewareRunner.runBefore([BoomMw], mockReq(), res);
    return result;
  });
  assert("before throw → clean 500 status", res._status === 500, `status=${res._status}`);
  assert("before throw → clean 500 body shape", JSON.stringify(res._body) === JSON.stringify({ error: "Internal Server Error", status: 500 }), `body=${JSON.stringify(res._body)}`);
  assert("before throw → handler skipped (shouldContinue=false)", result![2] === false);
  assert("before throw → logged (never silent)", out.includes("BoomMw") && (out.includes("before exploded") || out.includes("Error")), `out=${out.trim()}`);
}

// test_after_throw_yields_clean_500_and_continues
{
  const ran: string[] = [];
  class AfterBoomMw {
    static afterBoom(_req: Tina4Request, _res: Tina4Response): [Tina4Request, Tina4Response] {
      ran.push("boom");
      throw new Error("after exploded");
    }
    static afterLog(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
      ran.push("log");
      return [req, res];
    }
  }
  const res = mockRes();
  const { out } = await captureLogsAsync(async () => {
    await MiddlewareRunner.runAfter([AfterBoomMw], mockReq(), res);
  });
  assert("after throw → throwing + later after_* both ran (continue)", JSON.stringify(ran) === JSON.stringify(["boom", "log"]), `ran=${JSON.stringify(ran)}`);
  assert("after throw → clean 500 status", res._status === 500, `status=${res._status}`);
  assert("after throw → logged", out.includes("AfterBoomMw"), `out=${out.trim()}`);
}

// test_after_runs_even_when_before_short_circuits (after-on-4xx rule)
{
  const ran: string[] = [];
  class GateMw {
    static beforeGate(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
      ran.push("before.gate");
      res.status(403);
      return [req, res];
    }
    static afterHeaders(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
      ran.push("after.headers");
      res.header("x-audited", "yes");
      return [req, res];
    }
  }
  const res = mockRes();
  // Mirror the server dispatch: before short-circuits (403), then after STILL runs.
  const [, , proceed] = await MiddlewareRunner.runBefore([GateMw], mockReq(), res);
  assert("before_gate short-circuits on 403", proceed === false);
  await MiddlewareRunner.runAfter([GateMw], mockReq(), res);
  assert("after_* run even when before short-circuited with 4xx", ran.includes("after.headers"), `ran=${JSON.stringify(ran)}`);
  assert("after_* added its header on the short-circuit path", res._headers["x-audited"] === "yes");
}

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

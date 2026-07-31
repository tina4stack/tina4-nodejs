/**
 * Middleware pipeline characterisation — the approved feature-7 contract.
 *
 * ONE return-value table, for EVERY beforeX/afterX hook, at EVERY scope
 * (global and per-route):
 *
 *   a Response object   SHORT-CIRCUIT. That object IS the response, at ANY
 *                       status - the only return that can express a 302.
 *   the [req, res] pair rebind both, continue
 *   false               SHORT-CIRCUIT. Send the response as set; a still
 *                       default + unwritten response becomes a 403.
 *   undefined / null    continue
 *
 * Plus the RETAINED LEGACY COMPAT path: a before hook that returns nothing but
 * leaves a status >= 400 also short-circuits.
 *
 * Discovery walks the prototype chain, so a hook inherited from a base class is
 * found, and base-class hooks run BEFORE the subclass's own - matching Python's
 * `Middleware._discover_methods` (reversed __mro__ over __dict__) and Ruby's
 * `discover_methods`.
 *
 * NO MOCKS: one REAL server over a REAL socket, real middleware classes, the
 * real Request/Response, reaped in a finally. The case names are identical in
 * all four frameworks so the suites grep the same.
 *
 * Run with: npx tsx test/middlewarePipelineCharacterisation.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, MiddlewareRunner, get } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

/** Path gate: every global class is registered for the whole file, so each hook
 *  only acts on its own path and leaves the other cases untouched.
 *  `req.path` is the path alone - `req.url` is the FULL absolute URL. */
const on = (req: Tina4Request, path: string): boolean => req.path === path;

/** Per-REQUEST hook trace, carried on the request itself (no shared state). */
const trace = (req: Tina4Request, name: string): void => {
  const r = req as unknown as { _trace?: string[] };
  (r._trace ??= []).push(name);
};

/** After hooks that run once the response is already flushed cannot stamp a
 *  header, so those record here and are read in-process after the request. */
const afterRuns: string[] = [];

// ── Global middleware classes ────────────────────────────────────────
//
// Registration order below IS the expected cross-class execution order.

/** 1: a before hook runs, and its header reaches the client. */
class BeforeStampMw {
  static beforeStamp(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/before")) res.header("X-Before-Ran", "yes");
    return [req, res];
  }
}

/** 2: an after hook runs. The handler for /g/after deliberately does NOT end
 *  the response, so an after hook can still stamp a header that is really
 *  sent - proof over the wire, with no race. */
class AfterStampMw {
  static afterStamp(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/after")) res.header("X-After-Ran", "yes");
    return [req, res];
  }
}

/** 3: within one class, hooks run in DEFINITION order - never alphabetical.
 *  Declared zulu-then-alpha precisely so the two orders disagree. */
class DefinitionOrderMw {
  static beforeZulu(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/order")) trace(req, "zulu");
    return [req, res];
  }
  static beforeAlpha(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/order")) trace(req, "alpha");
    return [req, res];
  }
}

/** 4: across classes it is REGISTRATION order. Zebra is registered before
 *  Apple, so registration and alphabetical disagree here too. */
class ZebraMw {
  static beforeZebra(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/order")) trace(req, "zebra");
    return [req, res];
  }
}
class AppleMw {
  static beforeApple(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/order")) trace(req, "apple");
    return [req, res];
  }
}

/** 10 + 11: discovery must find a hook inherited from a base class, and the
 *  base's hooks must run BEFORE the subclass's own. */
class BaseHookMw {
  static beforeBase(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/inherited")) trace(req, "base");
    return [req, res];
  }
}
class DerivedHookMw extends BaseHookMw {
  static beforeSub(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/inherited")) trace(req, "sub");
    return [req, res];
  }
}

/** 5: returns the [req, res] pair carrying a 4xx. */
class PairGateMw {
  static beforePair(req: Tina4Request, res: Tina4Response) {
    if (!on(req, "/g/pair4xx")) return [req, res];
    res.status(403);
    return [req, res];
  }
}

/** 6 + 7: sets a 4xx and returns NOTHING (the retained legacy compat path),
 *  and its after hook must still run. The before hook does not write a body,
 *  so the after hook's header is really sent. */
class SilentGateMw {
  static beforeSilent(req: Tina4Request, res: Tina4Response) {
    if (!on(req, "/g/silent4xx")) return;
    res.status(422);
    return;
  }
  static afterSilent(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/silent4xx")) res.header("X-After-On-Short", "yes");
    return [req, res];
  }
}

/** 8: a throwing before hook is a clean, logged 500 - never an unhandled
 *  exception, never a crashed worker. */
class ThrowingBeforeMw {
  static beforeBoom(req: Tina4Request, _res: Tina4Response) {
    if (on(req, "/g/throw-before")) throw new Error("before hook exploded");
    return;
  }
}

/** 9: a throwing AFTER hook must not stop the after hooks behind it.
 *  afterBoom is declared first so afterSurvivor runs strictly after it. */
class ThrowingAfterMw {
  static afterBoom(req: Tina4Request, _res: Tina4Response) {
    if (on(req, "/g/throw-after")) throw new Error("after hook exploded");
    return;
  }
  static afterSurvivor(req: Tina4Request, res: Tina4Response) {
    if (on(req, "/g/throw-after")) afterRuns.push("survivor");
    return [req, res];
  }
}

/** 14: returns the Response OBJECT - the primary short-circuit rule. The
 *  status is deliberately 2xx and the response deliberately NOT ended, so
 *  neither the >= 400 legacy path nor a writableEnded check can explain a
 *  pass: only the Response-object rule can. */
class ResponseObjectMw {
  static beforeRespond(req: Tina4Request, res: Tina4Response) {
    if (!on(req, "/g/response-object")) return;
    res.header("X-Short-Circuit", "yes");
    return res.status(299);
  }
}

/** 15: the load-bearing case. A 302 is the exact thing the >= 400 rule cannot
 *  express, and the response is not ended, so nothing but the Response-object
 *  rule can short-circuit it. */
class RedirectResponseMw {
  static beforeRedirect(req: Tina4Request, res: Tina4Response) {
    if (!on(req, "/g/redirect")) return;
    return res.status(302).header("Location", "/somewhere-else");
  }
}

/** 16: a bare `false` is a deny. Nothing is set, so it becomes a 403. */
class FalseGateMw {
  static beforeFalse(req: Tina4Request, _res: Tina4Response) {
    if (!on(req, "/g/false")) return;
    return false;
  }
}

/** 17: returning nothing continues to the handler. */
class ContinueMw {
  static beforeContinue(req: Tina4Request, _res: Tina4Response) {
    if (on(req, "/g/continue")) trace(req, "continued");
    return;
  }
}

// ── Per-route middleware class (12 + 13) ─────────────────────────────
//
// Attached with .middleware(RouteScopedMw) - a CLASS, not a function.

class RouteScopedMw {
  static beforeRoute(req: Tina4Request, res: Tina4Response) {
    res.header("X-Route-Before", "yes");
    trace(req, "route-before");
    return [req, res];
  }
  static afterRoute(req: Tina4Request, res: Tina4Response) {
    res.header("X-Route-After", "yes");
    afterRuns.push("route-after");
    return [req, res];
  }
}

// ── Routes ───────────────────────────────────────────────────────────

const HANDLER_MARK = "handler-ran";

/** Reports the per-request hook trace, so before-hook order is asserted over
 *  the wire rather than from shared state. */
const traceHandler = (req: Tina4Request, res: Tina4Response) =>
  res.json({ mark: HANDLER_MARK, trace: (req as unknown as { _trace?: string[] })._trace ?? [] });

/** Ends nothing: leaves the response open so an after hook can still stamp a
 *  header the client really receives. */
const openHandler = (req: Tina4Request, res: Tina4Response) => {
  res.header("X-Handler-Ran", "yes");
  void req;
};

get("/g/before", traceHandler);
get("/g/after", openHandler);
get("/g/order", traceHandler);
get("/g/inherited", traceHandler);
get("/g/pair4xx", traceHandler);
get("/g/silent4xx", traceHandler);
get("/g/throw-before", traceHandler);
get("/g/throw-after", traceHandler);
get("/g/response-object", traceHandler);
get("/g/redirect", traceHandler);
get("/g/false", traceHandler);
get("/g/continue", traceHandler);
get("/r/before", traceHandler).middleware(RouteScopedMw);
get("/r/after", openHandler).middleware(RouteScopedMw);

// ── Harness ──────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), "tina4-mwpipe-"));
const routesDir = join(root, "src", "routes");
const publicDir = join(root, "public");
mkdirSync(routesDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const PORT = 7930 + (process.pid % 8);
let server: { close?: () => void } | undefined;

async function hit(path: string, init?: RequestInit) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { redirect: "manual", ...init });
  const body = await r.text();
  return { status: r.status, headers: r.headers, body };
}

/** Let the server finish the continuation that runs AFTER the response was
 *  flushed (the after pass on an already-ended response). */
const settle = () => new Promise((r) => setTimeout(r, 25));

console.log("=== Middleware pipeline characterisation (Node) ===\n");

try {
  // Registration order IS execution order across classes.
  for (const mw of [
    BeforeStampMw, AfterStampMw, DefinitionOrderMw, ZebraMw, AppleMw,
    DerivedHookMw, PairGateMw, SilentGateMw, ThrowingBeforeMw, ThrowingAfterMw,
    ResponseObjectMw, RedirectResponseMw, FalseGateMw, ContinueMw,
  ]) {
    MiddlewareRunner.use(mw);
  }

  server = await startServer({ port: PORT, routesDir, staticDir: publicDir } as never);

  // 1
  {
    const r = await hit("/g/before");
    assert("global class middleware runs its before hook",
      r.status === 200 && r.headers.get("x-before-ran") === "yes",
      `${r.status} stamp=${r.headers.get("x-before-ran")}`);
  }

  // 2
  {
    const r = await hit("/g/after");
    assert("global class middleware runs its after hook",
      r.status === 200 && r.headers.get("x-after-ran") === "yes"
        && r.headers.get("x-handler-ran") === "yes",
      `${r.status} after=${r.headers.get("x-after-ran")} handler=${r.headers.get("x-handler-ran")}`);
  }

  // 3 + 4 — one request, two orderings.
  {
    const r = await hit("/g/order");
    const t: string[] = JSON.parse(r.body).trace ?? [];
    assert("hooks within one class run in definition order",
      t.indexOf("zulu") >= 0 && t.indexOf("zulu") < t.indexOf("alpha"),
      `trace=${JSON.stringify(t)} - alphabetical would put alpha first`);
    assert("classes run in registration order",
      t.indexOf("zebra") >= 0 && t.indexOf("zebra") < t.indexOf("apple"),
      `trace=${JSON.stringify(t)} - alphabetical would put apple first`);
  }

  // 5
  {
    const r = await hit("/g/pair4xx");
    assert("a before hook that returns a 4xx pair skips the handler",
      r.status === 403 && !r.body.includes(HANDLER_MARK),
      `${r.status} body=${r.body.slice(0, 120)}`);
  }

  // 6 + 7 — one request: the legacy compat path, and the after hook behind it.
  {
    const r = await hit("/g/silent4xx");
    assert("a before hook that sets 4xx and returns nothing skips the handler",
      r.status === 422 && !r.body.includes(HANDLER_MARK),
      `${r.status} body=${r.body.slice(0, 120)}`);
    assert("after hooks still run when a before hook short circuits",
      r.headers.get("x-after-on-short") === "yes",
      `after=${r.headers.get("x-after-on-short")} status=${r.status}`);
  }

  // 8
  {
    const r = await hit("/g/throw-before");
    assert("a throwing before hook becomes a clean 500",
      r.status === 500 && !r.body.includes(HANDLER_MARK) && r.body.includes("Internal Server Error"),
      `${r.status} body=${r.body.slice(0, 160)}`);
  }

  // 9
  {
    afterRuns.length = 0;
    await hit("/g/throw-after");
    await settle();
    assert("a throwing after hook does not stop the remaining after hooks",
      afterRuns.includes("survivor"),
      `afterRuns=${JSON.stringify(afterRuns)} - the hook behind the throwing one never ran`);
  }

  // 10 + 11 — one request, both halves of the inheritance contract.
  {
    const r = await hit("/g/inherited");
    const t: string[] = JSON.parse(r.body).trace ?? [];
    assert("hook discovery includes hooks inherited from a base class",
      t.includes("base"),
      `trace=${JSON.stringify(t)} - the inherited hook was dropped by discovery`);
    assert("inherited before hooks run before the subclass own hooks",
      t.indexOf("base") >= 0 && t.indexOf("base") < t.indexOf("sub"),
      `trace=${JSON.stringify(t)}`);
  }

  // 12
  {
    const r = await hit("/r/before");
    assert("route class middleware runs its before hook",
      r.status === 200 && r.headers.get("x-route-before") === "yes",
      `${r.status} stamp=${r.headers.get("x-route-before")} body=${r.body.slice(0, 120)}`);
  }

  // 13
  {
    afterRuns.length = 0;
    const r = await hit("/r/after");
    assert("route class middleware runs its after hook",
      r.status === 200 && r.headers.get("x-route-after") === "yes",
      `${r.status} stamp=${r.headers.get("x-route-after")}`);
  }

  // 14
  {
    const r = await hit("/g/response-object");
    assert("a before hook that returns a response object short circuits",
      r.status === 299 && !r.body.includes(HANDLER_MARK)
        && r.headers.get("x-short-circuit") === "yes",
      `${r.status} body=${r.body.slice(0, 120)} - a returned Response IS the response`);
  }

  // 15 — the case the >= 400 rule cannot express.
  {
    const r = await hit("/g/redirect");
    assert("a before hook that returns a redirect response short circuits",
      r.status === 302 && r.headers.get("location") === "/somewhere-else"
        && !r.body.includes(HANDLER_MARK),
      `${r.status} location=${r.headers.get("location")} body=${r.body.slice(0, 120)}`);
  }

  // 16
  {
    const r = await hit("/g/false");
    assert("a before hook that returns false short circuits with 403",
      r.status === 403 && !r.body.includes(HANDLER_MARK),
      `${r.status} body=${r.body.slice(0, 120)} - a returned false was ignored`);
  }

  // 17
  {
    const r = await hit("/g/continue");
    const parsed = JSON.parse(r.body);
    assert("a before hook that returns nothing continues to the handler",
      r.status === 200 && parsed.mark === HANDLER_MARK && (parsed.trace ?? []).includes("continued"),
      `${r.status} body=${r.body.slice(0, 120)}`);
  }
} finally {
  try { server?.close?.(); } catch { /* already down */ }
  MiddlewareRunner.reset();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

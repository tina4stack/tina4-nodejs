import type { Tina4Request, Tina4Response, Middleware } from "./types.js";
import { HTTP_OK, HTTP_FORBIDDEN } from "./constants.js";
import { validToken, getPayload } from "./auth.js";
import { Log } from "./logger.js";
import { isTruthy } from "./dotenv.js";
import { defaultRouter, type Router } from "./router.js";
import { resolveClientIp } from "./trustedProxy.js";

/**
 * Whether to emit a per-request log line (v3.13.14). TINA4_LOG_REQUESTS is
 * the explicit control (true/false); when unset, request logging follows
 * dev mode (on under TINA4_DEBUG, off in production). Same contract across
 * all four frameworks.
 */
function requestLoggingEnabled(): boolean {
  const val = process.env.TINA4_LOG_REQUESTS;
  if (val !== undefined && val !== "") return isTruthy(val);
  return isTruthy(process.env.TINA4_DEBUG);
}

export class MiddlewareChain {
  private middlewares: Middleware[] = [];

  use(fn: Middleware): void {
    this.middlewares.push(fn);
  }

  /**
   * Run the chain in REGISTRATION order — each middleware runs exactly once,
   * in the order it was attached via use(). The chain advances from ONE
   * source only: `next()`. (The old runner double-advanced — a for-loop index
   * AND next() both incremented — so every other middleware was silently
   * skipped. Fixed by driving the chain purely by next(), mirroring Python's
   * _make_mw_continuation Russian-doll continuation.)
   *
   * A middleware may stop the chain by:
   *   - not calling next() (it owns the response), or
   *   - ending the response (res.raw.writableEnded).
   * Returns true when the whole chain ran to completion (handler may proceed),
   * false when it was short-circuited.
   */
  async run(req: Tina4Request, res: Tina4Response): Promise<boolean> {
    const dispatch = async (i: number): Promise<void> => {
      if (i >= this.middlewares.length) return;
      let advanced = false;

      const next = (): void => {
        advanced = true;
      };

      await this.middlewares[i](req, res, next);

      // The middleware owns the response — stop the chain.
      if (res.raw.writableEnded) return;

      // next() was called → advance to the following middleware (exactly one
      // step). next() not called → the middleware short-circuited; stop here.
      if (advanced) {
        await dispatch(i + 1);
      }
    };

    await dispatch(0);

    // Completed (handler may proceed) iff no middleware ended the response.
    return !res.raw.writableEnded;
  }
}

// ── Class-based middleware runner ────────────────────────────────
//
// Class-based middleware follows the beforeX / afterX naming convention:
// statics named before* run before the route handler (MiddlewareRunner.runBefore),
// statics named after* run once it is done (runAfter). Each hook receives
// (req, res); what it RETURNS is interpreted by the one table in
// interpretHookResult below.

/**
 * True when a middleware spec is a CLASS (the beforeX/afterX convention)
 * rather than a plain `(req, res, next)` middleware function.
 *
 * A class's `prototype` property is non-writable by the language spec
 * (ClassDefinitionEvaluation); an ordinary function's is writable, and an
 * arrow function, async function or bound function has no `prototype` at all.
 * That is a language-level distinction rather than a name or source-string
 * sniff, so a class named `cors` and a function named `Cors` both classify
 * correctly.
 */
export function isMiddlewareClass(spec: unknown): boolean {
  if (typeof spec !== "function") return false;
  const proto = Object.getOwnPropertyDescriptor(spec, "prototype");
  return proto !== undefined && proto.writable === false;
}

/**
 * The Tina4 response object — callable, and carrying the raw ServerResponse.
 * Structural, so a rebound response is recognised too.
 */
function isResponse(value: unknown): value is Tina4Response {
  return typeof value === "function"
    && typeof (value as Tina4Response).raw?.end === "function";
}

/**
 * ONE return-value table, for EVERY beforeX/afterX hook, at EVERY scope
 * (global and per-route):
 *
 *   a Response object   SHORT-CIRCUIT. That object IS the response, at ANY
 *                       status. This is the PRIMARY rule and the only return
 *                       that can express a 302 redirect.
 *   the [req, res] pair rebind both, continue (length >= 2, mirroring Python's
 *                       `isinstance(result, tuple) and len(result) >= 2`)
 *   false               SHORT-CIRCUIT. Send the response AS SET; a still
 *                       default and still unwritten response becomes a 403,
 *                       because a bare `return false` is a deny.
 *   undefined / null    continue
 *
 * Returns [req, res, stop].
 */
function interpretHookResult(
  result: unknown,
  req: Tina4Request,
  res: Tina4Response,
): [Tina4Request, Tina4Response, boolean] {
  if (Array.isArray(result)) {
    return result.length >= 2
      ? [result[0] as Tina4Request, result[1] as Tina4Response, false]
      : [req, res, false];
  }
  if (isResponse(result)) return [req, result, true];
  if (result === false) {
    if (!res.raw.writableEnded && res.raw.statusCode === HTTP_OK) {
      res.raw.statusCode = HTTP_FORBIDDEN;
    }
    return [req, res, true];
  }
  return [req, res, false];
}

/**
 * Produce the deterministic clean 500 for a throwing class-based middleware
 * (M2): LOG via Log.error (class + method + error type + message — never
 * silent) then return a 500 with the exact JSON body shape shared across all
 * four frameworks. The worker never crashes and no unhandled exception leaks.
 *
 * The counterpart is Python's `Middleware.middleware_500`
 * (tina4_python/core/middleware.py), called from its own run_before/run_after.
 * This used to cite `_middleware_500`, which is not a symbol in tina4-python at
 * all — that name belonged to its dispatcher, back when its orchestrator had no
 * exception handling to mirror.
 */
function middleware500(
  res: Tina4Response,
  mwClass: any,
  methodName: string,
  error: unknown,
): Tina4Response {
  const clsName = mwClass?.name ?? mwClass?.constructor?.name ?? "Middleware";
  const err = error as { name?: string; message?: string };
  const type = err?.name ?? (error as object)?.constructor?.name ?? "Error";
  const message = err?.message ?? String(error);
  try {
    Log.error(`Middleware ${clsName}.${methodName} raised ${type}: ${message}`);
  } catch {
    /* never let a broken logger swallow the 500 */
  }
  // res is callable (json) in real Response; tolerate either shape.
  if (typeof (res as any).json === "function") {
    (res as any).json({ error: "Internal Server Error", status: 500 }, 500);
  } else if (typeof (res as any) === "function") {
    (res as any)({ error: "Internal Server Error", status: 500 }, 500);
  } else if (typeof (res as any).status === "function") {
    (res as any).status(500);
  }
  return res;
}

export class MiddlewareRunner {
  /** Globally registered middleware classes (parity with PHP/Ruby/Python orchestrators). */
  private static globalMiddleware: any[] = [];

  /**
   * Register a middleware class to run on every request.
   * Mirrors Tina4\Middleware::use (PHP), Tina4::Middleware.use (Ruby),
   * and Middleware.use (Python).
   */
  static use(cls: any): void {
    if (!MiddlewareRunner.globalMiddleware.includes(cls)) {
      MiddlewareRunner.globalMiddleware.push(cls);
    }
  }

  /** Return the list of globally registered middleware classes. */
  /**
   * Global middleware that runs BEFORE route matching.
   *
   * A middleware opts in with `static preMatch = true`. Everything else stays
   * where it has always run - after matching - so this is additive and no
   * existing middleware changes behaviour.
   *
   * The two groups need opposite things. CORS must run before matching so its
   * headers survive a short-circuited 401/403; a browser shown a 401 without
   * them reports a CORS error and the real status never reaches the developer.
   * CSRF must run AFTER, because it reads the matched route's metadata to
   * honour a route marked noAuth - PHP shipped exactly that bypass as dead
   * code once, because the metadata was not assigned yet.
   *
   * NOT named `beforeMatch` - hook discovery treats every `before*` static as
   * a middleware hook and would call the flag itself with (req, res).
   */
  static partitionByMatchPhase(all: any[]): { pre: any[]; post: any[] } {
    const pre: any[] = [];
    const post: any[] = [];
    for (const m of all) {
      if (m && m.preMatch === true) pre.push(m);
      else post.push(m);
    }
    return { pre, post };
  }

  static getGlobal(): any[] {
    return [...MiddlewareRunner.globalMiddleware];
  }

  /** Clear all globally registered middleware (primarily for tests). */
  static reset(): void {
    MiddlewareRunner.globalMiddleware = [];
  }

  /**
   * Discover the before-prefixed / after-prefixed hook names on a middleware
   * class, INHERITED HOOKS INCLUDED, base class first (M1).
   *
   * `Object.getOwnPropertyNames` returns a class's OWN statics only, in
   * source-declaration order. On its own that silently DROPPED every hook a
   * subclass inherited: for `class Sub extends Base` with `static beforeBase`
   * on the base, discovery returned only ["beforeSub"] even though
   * `Sub.beforeBase` is a live function — so a shared base middleware simply
   * never ran, with no error. Python returns ['before_base','before_sub'] and
   * Ruby [:before_base,:before_sub]; Node was the only one of the four that
   * lost hooks.
   *
   * So walk the prototype chain (the STATIC side: Sub -> Base -> ...) and emit
   * base-class hooks BEFORE the subclass's own, de-duping an override to its
   * first (base) position. That is exactly Python's `_discover_methods`
   * walking `reversed(__mro__)` over each `__dict__`, and Ruby's
   * `discover_methods` walking `ancestors.reverse_each`.
   *
   * Within one class the order is still source-declaration order — we
   * deliberately do NOT sort(), so hooks run in the order they were written
   * (parity with Python walking __dict__, PHP get_class_methods, Ruby
   * instance_methods(false)). Cross-class order is the natural iteration of
   * the registered classes = REGISTRATION order.
   *
   * The chain walk stops at Function.prototype / Object.prototype, so the
   * built-in members are never scanned. A plain object registered as
   * middleware still works: its own keys are level 0.
   */
  private static methodNames(cls: any, prefix: string): string[] {
    const levels: string[][] = [];
    for (
      let level: any = cls;
      level && level !== Function.prototype && level !== Object.prototype;
      level = Object.getPrototypeOf(level)
    ) {
      levels.push(
        Object.getOwnPropertyNames(level).filter(
          (name) => name.startsWith(prefix) && typeof cls[name] === "function",
        ),
      );
    }

    const seen = new Set<string>();
    const names: string[] = [];
    // Reverse the levels: base class first, then each derived class.
    for (let i = levels.length - 1; i >= 0; i--) {
      for (const name of levels[i]) {
        if (seen.has(name)) continue;
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }

  /**
   * Execute every beforeX static method found on the supplied classes.
   *
   * ORDER (M1): cross-class = REGISTRATION order (the order classes were
   * attached via Router.use / MiddlewareRunner.use); within a class =
   * DEFINITION order (source order, never alphabetical). before_* run before
   * the handler.
   *
   * THROW (M2): each before* call is wrapped — a throwing middleware is
   * LOGGED and produces a deterministic clean 500 (it never crashes the
   * worker / leaks an unhandled exception), and the chain short-circuits
   * (skip = true, handler skipped).
   *
   * Short-circuits (skip = true, handler skipped) when a before* sets a
   * status >= 400 or ends/500s the response.
   *
   * ASYNC — each hook is awaited so middleware can perform async work (e.g.
   * the distributed responseCache before-hook awaiting `backend.get`). Awaiting
   * a synchronous hook that returns an array is harmless (the array resolves
   * immediately), so existing sync hooks keep working unchanged.
   *
   * RETURN VALUE — see `interpretHookResult` for the one table every hook at
   * every scope obeys. A returned Response object is the PRIMARY
   * short-circuit; `false` is a deny.
   *
   * Returns [req, res, shouldContinue].
   */
  static async runBefore(
    classes: any[],
    req: Tina4Request,
    res: Tina4Response,
  ): Promise<[Tina4Request, Tina4Response, boolean]> {
    for (const cls of classes) {
      for (const method of MiddlewareRunner.methodNames(cls, "before")) {
        try {
          const [nextReq, nextRes, stop] =
            interpretHookResult(await cls[method](req, res), req, res);
          req = nextReq;
          res = nextRes;
          if (stop) return [req, res, false];
        } catch (error) {
          // Throw → logged clean 500, skip the handler (deterministic).
          res = middleware500(res, cls, method, error);
          return [req, res, false];
        }
        // LEGACY COMPAT PATH — retained, but NOT the main mechanism. A hook
        // that returns nothing and merely leaves an error status (or an ended
        // response) still short-circuits, so middleware written before the
        // return-value contract keeps working. It cannot express a 3xx
        // redirect, which is exactly why a returned Response is the primary
        // rule above.
        if (res.raw.statusCode >= 400 || res.raw.writableEnded) {
          return [req, res, false];
        }
      }
    }
    return [req, res, true];
  }

  /**
   * Execute every afterX static method found on the supplied classes.
   *
   * ORDER (M1): cross-class = REGISTRATION order; within a class = DEFINITION
   * order. after_* run after the handler.
   *
   * THROW (M2): each after* call is wrapped — a throwing after middleware is
   * LOGGED and produces a clean 500, then the remaining after* STILL run
   * (they may add headers / logging). No unhandled exception leaks.
   *
   * AFTER-ON-4xx RULE (M2): after_* ALWAYS run, even when a before_*
   * short-circuited with status >= 400 and the handler was skipped — so they
   * can still add headers / logging. The dispatcher calls runAfter
   * unconditionally after the before/handler block (see server.ts).
   *
   * ASYNC — each hook is awaited (e.g. the responseCache after-hook awaiting
   * `backend.set`). Awaiting a synchronous hook is harmless, so existing sync
   * after-hooks keep working unchanged.
   *
   * RETURN VALUE — the SAME table as runBefore (`interpretHookResult`): the
   * contract is one table for every hook at every scope. There is nothing left
   * to skip after the handler, so a short-circuit here ends the after chain.
   * A THROW is different and unchanged: it is logged, becomes a clean 500, and
   * the remaining after hooks still run.
   */
  static async runAfter(
    classes: any[],
    req: Tina4Request,
    res: Tina4Response,
  ): Promise<[Tina4Request, Tina4Response]> {
    for (const cls of classes) {
      for (const method of MiddlewareRunner.methodNames(cls, "after")) {
        try {
          const [nextReq, nextRes, stop] =
            interpretHookResult(await cls[method](req, res), req, res);
          req = nextReq;
          res = nextRes;
          if (stop) return [req, res];
        } catch (error) {
          // Throw → logged clean 500, but remaining after* STILL run.
          res = middleware500(res, cls, method, error);
          continue;
        }
      }
    }
    return [req, res];
  }
}

// ── Built-in class-based middleware ─────────────────────────────

/** Configuration for the CORS middleware */
export interface CorsConfig {
  /** Allowed origins. Default: NONE (deny) — or TINA4_CORS_ORIGINS env, comma-separated. "*" allows any. */
  origins?: string | string[];
  /** Allowed methods. Default: standard REST methods (or TINA4_CORS_METHODS env) */
  methods?: string | string[];
  /** Allowed headers. Default: Content-Type, Authorization (or TINA4_CORS_HEADERS env) */
  headers?: string | string[];
  /** Access-Control-Max-Age in seconds. Default: 86400 (or TINA4_CORS_MAX_AGE env) */
  maxAge?: number;
  /** Send Access-Control-Allow-Credentials. Default: false (or TINA4_CORS_CREDENTIALS env). Never sent with a wildcard origin. */
  credentials?: boolean;
}

/** Warn-once ledger so a scripted probe cannot flood the log. */
const corsWarned = new Set<string>();

/** Reset the CORS warn-once ledger. Test seam. */
export function resetCorsWarnings(): void {
  corsWarned.clear();
}

function corsWarnOnce(key: string, message: string): void {
  if (corsWarned.has(key)) return;
  corsWarned.add(key);
  Log.warning(message);
}

/**
 * The resolved CORS policy — ONE implementation of the rules.
 *
 * Both the function middleware `cors()` and the class middleware
 * `CorsMiddleware` build one of these and apply what it returns. They used to
 * be two independent implementations that had already drifted: `cors()` never
 * read TINA4_CORS_CREDENTIALS at all, so the DEFAULT always-on pipeline
 * silently ignored a documented env var (measured 2026-07-31). One feature,
 * one code path.
 *
 * DENY BY DEFAULT (ADR-0018). With no origins configured, NO
 * Access-Control-Allow-Origin is emitted and the browser's own CORS check
 * blocks the cross-origin request. "*" still works, it just has to be asked for.
 *
 * CREDENTIALS AND THE WILDCARD ARE MUTUALLY EXCLUSIVE. The Fetch Standard's
 * CORS check treats "*" as a literal (not a wildcard) once the request's
 * credentials mode is "include", so ACAO: * with
 * Access-Control-Allow-Credentials: true is rejected by every browser.
 *
 * VARY: ORIGIN whenever the ACAO value is COMPUTED from the request's Origin,
 * i.e. whenever an allow-list is configured — on a MISS as well as a match.
 * RFC 9110 s12.5.5: a Vary field name list tells cache recipients they "MUST
 * NOT use this response to satisfy a later request unless the later request
 * has the same values for the listed header fields as the original request".
 * The miss case matters most: without it a shared cache can store the no-ACAO
 * response for origin B and serve it to origin A. A constant "*" genuinely
 * does not vary and gets no Vary, which would only fragment a CDN's cache.
 *
 * Access-Control-Allow-Methods / -Allow-Headers are static configured lists
 * here, never derived from the request's Access-Control-Request-* headers, so
 * those field names do NOT belong in Vary.
 */
export class CorsPolicy {
  readonly allowedOrigins: string[];
  readonly allowedMethods: string;
  readonly allowedHeaders: string;
  readonly maxAge: number;
  readonly credentials: boolean;

  constructor(config?: CorsConfig) {
    // Default is EMPTY, not "*" — deny by default (ADR-0018).
    const originsRaw = config?.origins ?? process.env.TINA4_CORS_ORIGINS ?? "";
    const list = Array.isArray(originsRaw) ? originsRaw : originsRaw.split(",");
    this.allowedOrigins = list.map((o) => o.trim()).filter((o) => o !== "");

    const methodsRaw = config?.methods
      ?? process.env.TINA4_CORS_METHODS
      ?? "GET, POST, PUT, DELETE, PATCH, OPTIONS";
    this.allowedMethods = Array.isArray(methodsRaw) ? methodsRaw.join(", ") : methodsRaw;

    const headersRaw = config?.headers
      ?? process.env.TINA4_CORS_HEADERS
      ?? "Content-Type,Authorization,X-Request-ID";
    this.allowedHeaders = Array.isArray(headersRaw) ? headersRaw.join(", ") : headersRaw;

    this.maxAge = config?.maxAge
      ?? (process.env.TINA4_CORS_MAX_AGE ? parseInt(process.env.TINA4_CORS_MAX_AGE, 10) : 86400);

    this.credentials = config?.credentials
      ?? ["true", "1", "yes"].includes((process.env.TINA4_CORS_CREDENTIALS ?? "false").toLowerCase());
  }

  /** Whether an operator has actually declared a CORS policy. */
  isConfigured(): boolean {
    return this.allowedOrigins.length > 0;
  }

  /** The origin to send in Access-Control-Allow-Origin, or undefined for none. */
  resolveOrigin(requestOrigin: string): string | undefined {
    if (this.allowedOrigins.length === 0) return undefined;
    if (this.allowedOrigins.includes("*")) return "*";
    if (requestOrigin && this.allowedOrigins.includes(requestOrigin)) return requestOrigin;
    return undefined;
  }

  /**
   * The CORS headers for a request origin. `isPreflight` adds Max-Age, which
   * the Fetch Standard only defines for a preflight response.
   */
  headersFor(requestOrigin: string, isPreflight: boolean): Record<string, string> {
    if (this.allowedOrigins.length === 0) {
      if (requestOrigin) {
        corsWarnOnce("unconfigured",
          `CORS: refused cross-origin request from ${requestOrigin} — no policy is configured. `
          + "Set TINA4_CORS_ORIGINS to the origins you want to allow, e.g. "
          + "TINA4_CORS_ORIGINS=https://app.example.com (or '*' to allow any origin).");
      }
      return {};
    }

    const out: Record<string, string> = {};
    if (!this.allowedOrigins.includes("*")) {
      out["Vary"] = "Origin";
    }

    const origin = this.resolveOrigin(requestOrigin);
    if (origin === undefined) {
      if (requestOrigin) {
        corsWarnOnce(`denied:${requestOrigin}`,
          `CORS: origin ${requestOrigin} is not in TINA4_CORS_ORIGINS `
          + `(${this.allowedOrigins.join(",")}) — the browser will block this response.`);
      }
      return out;
    }

    out["Access-Control-Allow-Origin"] = origin;
    out["Access-Control-Allow-Methods"] = this.allowedMethods;
    out["Access-Control-Allow-Headers"] = this.allowedHeaders;
    if (isPreflight) out["Access-Control-Max-Age"] = String(this.maxAge);

    if (this.credentials) {
      if (origin === "*") {
        corsWarnOnce("wildcard-credentials",
          "CORS: TINA4_CORS_CREDENTIALS is true but TINA4_CORS_ORIGINS is '*'. The Fetch Standard "
          + "forbids Access-Control-Allow-Origin: * with credentials, so credentials are NOT being "
          + "sent. Credentialed CORS requires an explicit origin list, e.g. "
          + "TINA4_CORS_ORIGINS=https://app.example.com.");
      } else {
        out["Access-Control-Allow-Credentials"] = "true";
      }
    }
    return out;
  }
}

/** Fold a Vary field name into whatever Vary the response already carries. */
function applyCorsHeaders(res: Tina4Response, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (name === "Vary") {
      const current = String((res as { raw?: { getHeader?(n: string): unknown } }).raw?.getHeader?.("Vary") ?? "");
      const parts = current.split(",").map((p) => p.trim()).filter((p) => p !== "");
      if (!parts.some((p) => p.toLowerCase() === value.toLowerCase())) parts.push(value);
      res.header(name, parts.join(", "));
      continue;
    }
    res.header(name, value);
  }
}

/**
 * Is this a REAL CORS preflight (as opposed to a bare protocol-introspection
 * OPTIONS)? A preflight carries an Origin — browsers always send one. A bare
 * OPTIONS does not, and belongs to the RFC 9110 s9.3.7 handler in dispatch.
 */
function isCorsPreflight(method: string | undefined, requestOrigin: string): boolean {
  return method === "OPTIONS" && requestOrigin !== "";
}

/** The Allow header for a path, from the LIVE router. */
function allowHeaderForUrl(url: string | undefined): string {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  // startServer builds its own Router and publishes it on globalThis;
  // defaultRouter is the module-level instance used by the standalone
  // get()/post() helpers. A file-routed app registers nothing in the latter,
  // so reading it alone returned an empty method set and stamped Allow: "".
  const liveRouter = (globalThis as { __tina4_router?: Router }).__tina4_router ?? defaultRouter;
  return liveRouter.methodsAllowedForPath(pathname).join(", ");
}

/**
 * Built-in CORS middleware (function form).
 *
 * A thin adapter over CorsPolicy — see that class for the rules and the
 * standards behind them. Reads configuration from env vars when not provided:
 *   TINA4_CORS_ORIGINS — comma-separated list of allowed origins, or "*"
 *   TINA4_CORS_METHODS — comma-separated list of allowed methods
 *   TINA4_CORS_HEADERS — comma-separated list of allowed headers
 *   TINA4_CORS_MAX_AGE — preflight cache duration in seconds
 *   TINA4_CORS_CREDENTIALS — send Access-Control-Allow-Credentials
 *
 * A real preflight is answered 204. The status is the same whether the origin
 * was allowed or denied — the browser does the blocking.
 */
export function cors(config?: CorsConfig): Middleware {
  const policy = new CorsPolicy(config);

  return (req, res, next) => {
    const requestOrigin = req.headers.origin ?? "";
    const preflight = isCorsPreflight(req.method, requestOrigin);

    applyCorsHeaders(res as Tina4Response, policy.headersFor(requestOrigin, preflight));

    if (preflight) {
      // Carry the resource's REAL method set as Allow (RFC 9110 s9.3.7): a
      // preflight IS an OPTIONS response, so it answers the same question a
      // bare OPTIONS does, on top of the CORS policy headers. This is
      // CONFORMANCE, not a deviation — Django's View.options() and Express's
      // router already emit Allow; the add-on CORS libraries lose it only
      // because they short-circuit ahead of the framework. See ADR-0013.
      //
      // Allow and Access-Control-Allow-Methods are NOT interchangeable: Allow
      // is what the resource supports, ACAM is what the CORS policy permits
      // cross-origin. A policy allowing DELETE on a GET-only route still 405s.
      res.header("Allow", allowHeaderForUrl(req.url));
      res(null, 204);
      return;
    }

    next();
  };
}

/**
 * Class-based CORS middleware using the before/after convention.
 *
 * The same CorsPolicy as `cors()` — one implementation, one set of semantics.
 *
 * Usage:
 *   Router.use(CorsMiddleware);
 */
export class CorsMiddleware {
  static beforeCors(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    const requestOrigin = req.headers.origin ?? "";
    const preflight = isCorsPreflight(req.method, requestOrigin);

    applyCorsHeaders(res, new CorsPolicy().headersFor(requestOrigin, preflight));

    if (preflight) {
      res.header("Allow", allowHeaderForUrl(req.url));
      res(null, 204);
    }

    return [req, res];
  }

  /**
   * Check if a request is an OPTIONS preflight.
   *
   * NOTE: returns true for ANY OPTIONS, with no Origin check, so the name
   * overstates what it tests. The real short-circuit uses isCorsPreflight().
   * Kept because existing tests pin this meaning.
   */
  static isPreflight(method: string): boolean {
    return method?.toUpperCase() === "OPTIONS";
  }
}

/**
 * Class-based rate limiter middleware using the before/after convention.
 * Uses the same sliding-window algorithm as the `rateLimiter()` function.
 *
 * Reads configuration from env vars:
 *   TINA4_RATE_LIMIT  — max requests per window (default 100)
 *   TINA4_RATE_WINDOW — window duration in seconds (default 60)
 *
 * Usage:
 *   Router.use(RateLimiterMiddleware);
 */
export class RateLimiterMiddleware {
  private static store = new Map<string, { timestamps: number[] }>();
  private static cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private static ensureCleanup(windowMs: number): void {
    if (RateLimiterMiddleware.cleanupTimer) return;
    RateLimiterMiddleware.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const cutoff = now - windowMs;
      for (const [ip, entry] of RateLimiterMiddleware.store) {
        entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
        if (entry.timestamps.length === 0) {
          RateLimiterMiddleware.store.delete(ip);
        }
      }
    }, 60_000);
    if (RateLimiterMiddleware.cleanupTimer.unref) {
      RateLimiterMiddleware.cleanupTimer.unref();
    }
  }

  static beforeRateLimit(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    const limit = process.env.TINA4_RATE_LIMIT
      ? parseInt(process.env.TINA4_RATE_LIMIT, 10)
      : 100;
    const windowSeconds = process.env.TINA4_RATE_WINDOW
      ? parseInt(process.env.TINA4_RATE_WINDOW, 10)
      : 60;
    const windowMs = windowSeconds * 1000;

    RateLimiterMiddleware.ensureCleanup(windowMs);

    const now = Date.now();
    const cutoff = now - windowMs;

    // Client key. X-Forwarded-For is honoured ONLY when the socket peer is a
    // declared trusted proxy (TINA4_TRUSTED_PROXIES). ADR-0019.
    const ip = resolveClientIp(req.headers, req.socket?.remoteAddress ?? "") || "unknown";

    let entry = RateLimiterMiddleware.store.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      RateLimiterMiddleware.store.set(ip, entry);
    }

    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    const resetTimestamp = entry.timestamps.length > 0
      ? Math.ceil((entry.timestamps[0] + windowMs) / 1000)
      : Math.ceil((now + windowMs) / 1000);

    const remaining = Math.max(0, limit - entry.timestamps.length);

    res.header("X-RateLimit-Limit", String(limit));
    res.header("X-RateLimit-Remaining", String(Math.max(0, remaining - 1)));
    res.header("X-RateLimit-Reset", String(resetTimestamp));

    if (entry.timestamps.length >= limit) {
      const retryAfter = Math.max(1, resetTimestamp - Math.ceil(now / 1000));
      res.header("Retry-After", String(retryAfter));
      res.header("X-RateLimit-Remaining", "0");
      res({
        error: "Too Many Requests",
        statusCode: 429,
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      }, 429);
      return [req, res];
    }

    entry.timestamps.push(now);
    return [req, res];
  }

  /**
   * Check if an IP is within rate limits without recording a request.
   * Returns [allowed, info] matching Python/Ruby API.
   */
  static check(ip: string): [boolean, { limit: number; remaining: number; reset: number; window: number }] {
    const limit = process.env.TINA4_RATE_LIMIT ? parseInt(process.env.TINA4_RATE_LIMIT, 10) : 100;
    const windowSeconds = process.env.TINA4_RATE_WINDOW ? parseInt(process.env.TINA4_RATE_WINDOW, 10) : 60;
    const windowMs = windowSeconds * 1000;
    const now = Date.now();
    const cutoff = now - windowMs;

    let entry = RateLimiterMiddleware.store.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      RateLimiterMiddleware.store.set(ip, entry);
    }
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    const remaining = Math.max(0, limit - entry.timestamps.length);
    const reset = entry.timestamps.length > 0
      ? Math.ceil((entry.timestamps[0] + windowMs - now) / 1000)
      : windowSeconds;

    if (entry.timestamps.length >= limit) {
      return [false, { limit, remaining: 0, reset, window: windowSeconds }];
    }

    return [true, { limit, remaining: remaining - 1, reset: windowSeconds, window: windowSeconds }];
  }
}

/**
 * Class-based request logger middleware using the before/after convention.
 * `beforeLog` stamps the request start time.
 * `afterLog` prints the coloured status line.
 *
 * Usage:
 *   Router.use(RequestLogger);
 */
export class RequestLogger {
  static beforeLog(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    (req as any).startTime = Date.now();
    return [req, res];
  }

  static afterLog(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    const duration = Date.now() - ((req as any).startTime ?? Date.now());
    const status = res.raw.statusCode;
    const method = req.method ?? "?";
    const url = req.url ?? "/";
    const color = status >= 400 ? "\x1b[31m" : status >= 300 ? "\x1b[33m" : "\x1b[32m";
    console.log(`  ${color}${status}\x1b[0m ${method} ${url} \x1b[90m${duration}ms\x1b[0m`);
    return [req, res];
  }
}

/**
 * Class-based security headers middleware using the before/after convention.
 * Auto-injects security headers on every response.
 *
 * Configuration via env vars:
 *   TINA4_FRAME_OPTIONS       — X-Frame-Options (default: "SAMEORIGIN")
 *   TINA4_HSTS                — Strict-Transport-Security max-age value
 *                                (default: "" = off; set to "31536000" to enable)
 *   TINA4_CSP                 — Content-Security-Policy (default: "default-src 'self'")
 *   TINA4_REFERRER_POLICY     — Referrer-Policy (default: "strict-origin-when-cross-origin")
 *   TINA4_PERMISSIONS_POLICY  — Permissions-Policy (default: "camera=(), microphone=(), geolocation=()")
 *
 * Usage:
 *   Router.use(SecurityHeadersMiddleware);
 */
export class SecurityHeadersMiddleware {
  static beforeSecurity(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    res.header(
      "X-Frame-Options",
      process.env.TINA4_FRAME_OPTIONS ?? "SAMEORIGIN",
    );

    res.header("X-Content-Type-Options", "nosniff");

    const hsts = process.env.TINA4_HSTS ?? "";
    if (hsts) {
      res.header(
        "Strict-Transport-Security",
        `max-age=${hsts}; includeSubDomains`,
      );
    }

    res.header(
      "Content-Security-Policy",
      process.env.TINA4_CSP ?? "default-src 'self'",
    );

    res.header(
      "Referrer-Policy",
      process.env.TINA4_REFERRER_POLICY ?? "strict-origin-when-cross-origin",
    );

    res.header("X-XSS-Protection", "0");

    res.header(
      "Permissions-Policy",
      process.env.TINA4_PERMISSIONS_POLICY ?? "camera=(), microphone=(), geolocation=()",
    );

    return [req, res];
  }
}

/**
 * Class-based CSRF middleware using the before/after convention.
 * Validates form tokens on state-changing requests (POST, PUT, PATCH, DELETE).
 *
 * OFF by default — a default app has NO CSRF gate because the middleware is
 * NOT attached. Set TINA4_CSRF=true (or 1/yes/on) and the framework
 * auto-attaches it at boot (see attachCsrfFromEnv); or register it explicitly
 * via Router.use(CsrfMiddleware). Once attached, TINA4_CSRF=false (or 0/no) is
 * the kill switch that disables enforcement again.
 *
 * Behaviour (identical to the Python master, feature 37):
 *   - Skips GET, HEAD, OPTIONS requests.
 *   - Skips routes marked .noAuth().
 *   - Fails CLOSED: with TINA4_SECRET unset the signing secret resolves to
 *     blank (there is NO built-in default), and a blank HMAC key is publicly
 *     reproducible — so no token can be trusted and every write is rejected
 *     (403). This is the SEC-01 / CSRF-DEC-01 no-default-secret guarantee.
 *   - Skips requests with a valid Authorization: Bearer header (API clients).
 *   - Checks request body formToken then X-Form-Token header.
 *   - Rejects if token found in query string formToken (log warning, 403).
 *   - Validates token with validToken using the resolved SECRET, and enforces
 *     that the token's `type` claim is "form" — a non-form JWT presented in the
 *     formToken slot is rejected (CSRF-DEC-02).
 *   - If token payload has session_id, verifies it matches request session.
 *   - Every rejection is 403 with the CSRF_INVALID envelope
 *     { error: true, code: "CSRF_INVALID", message, status: 403 }.
 *
 * Usage:
 *   Router.use(CsrfMiddleware);
 */
export class CsrfMiddleware {
  static beforeCsrf(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    // Every CSRF rejection carries the SAME 403 envelope across all four
    // frameworks (Python master's shape): a real client recognises a CSRF
    // failure by one stable code + status regardless of the framework.
    const reject = (message: string): [Tina4Request, Tina4Response] => {
      res({ error: true, code: "CSRF_INVALID", message, status: HTTP_FORBIDDEN }, HTTP_FORBIDDEN);
      return [req, res];
    };

    // TINA4_CSRF=false (or 0/no) disables all CSRF checks, even when the
    // middleware is attached — the documented kill switch. Unset defaults to
    // enabled (the middleware only runs at all once attached).
    const csrfEnv = process.env.TINA4_CSRF;
    if (csrfEnv === "false" || csrfEnv === "0" || csrfEnv === "no") {
      return [req, res];
    }

    // Skip safe HTTP methods
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return [req, res];
    }

    // Skip routes marked noAuth
    const route = (req as any)._route ?? (req as any).route;
    if (route?.noAuth) {
      return [req, res];
    }

    // Resolve the signing secret ONCE, fail-closed — IDENTICAL to the validator
    // (auth.ts validToken: `secret ?? process.env.TINA4_SECRET ?? ""`). Blank
    // when TINA4_SECRET is unset; there is NO built-in default.
    const secret = process.env.TINA4_SECRET ?? "";

    // BLANK-SECRET HARD-FAIL (SEC-01 / CSRF-DEC-01): a blank HMAC key is
    // publicly reproducible, so a token signed with it (or with the retired
    // public 'tina4-default-secret') is a forgery. Reject every write rather
    // than validate against a guessable key — fail closed, hard.
    if (secret === "") {
      return reject("CSRF token cannot be validated: TINA4_SECRET is not set");
    }

    // Skip requests with a valid Bearer token (API clients). Pass the resolved
    // secret so the Bearer check uses the SAME key as the form-token check.
    const authHeader = req.headers.authorization ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const bearerToken = authHeader.slice(7).trim();
      if (bearerToken && validToken(bearerToken, secret)) {
        return [req, res];
      }
    }

    // Reject if token is in query string (security risk — a URL leaks through
    // logs, referers and history).
    const query = (req as any).query ?? {};
    if (query.formToken) {
      console.warn("[Tina4 CSRF] Token found in query string — rejected for security");
      return reject("Form token must not be sent in the URL query string");
    }

    // Extract token: body first, then header
    let token: string | undefined;
    const body = (req as any).body;
    if (body && typeof body === "object" && body.formToken) {
      token = String(body.formToken);
    }

    if (!token) {
      token = (req.headers["x-form-token"] as string) ?? "";
    }

    if (!token) {
      return reject("Invalid or missing form token");
    }

    // Validate the token signature / expiry against the resolved secret.
    if (!validToken(token, secret)) {
      return reject("Invalid or missing form token");
    }

    const payload = getPayload(token) ?? {};

    // TYPE ENFORCEMENT (CSRF-DEC-02): a valid signature is not enough. A
    // non-form JWT (e.g. an auth/session token) must never be accepted in the
    // formToken slot — the token's `type` claim MUST be "form".
    if (payload.type !== "form") {
      return reject("Invalid or missing form token");
    }

    // Session binding — if token has session_id, verify it matches the request
    // session. A token minted for one session cannot be replayed against another.
    const tokenSessionId = payload.session_id as string | undefined;
    if (tokenSessionId) {
      const session = (req as any).session;
      let currentSessionId: string | undefined;
      if (session) {
        currentSessionId = session.session_id ?? session.sessionId ?? session.id;
        if (typeof currentSessionId === "function") {
          currentSessionId = undefined;
        }
      }

      if (currentSessionId && tokenSessionId !== currentSessionId) {
        return reject("Invalid or missing form token");
      }
    }

    return [req, res];
  }
}

/**
 * Auto-attach CsrfMiddleware when TINA4_CSRF is enabled in the environment.
 *
 * CSRF is OFF by default: with TINA4_CSRF unset the middleware is never
 * attached, so a default app has no CSRF gate. Setting TINA4_CSRF to a truthy
 * value (true/1/yes/on, case-insensitive, trimmed) attaches it globally at boot
 * so every state-changing route is gated — the env flag is the switch, no code
 * change needed. Idempotent (MiddlewareRunner.use de-dupes). Returns true when
 * the middleware is now attached.
 *
 * The framework calls this once during startServer (after route discovery,
 * before listen); a false/0/no value still lets an explicit Router.use opt-in
 * be disabled at runtime by the kill switch in beforeCsrf. Mirrors Python's
 * attach_csrf_from_env.
 */
export function attachCsrfFromEnv(): boolean {
  const value = (process.env.TINA4_CSRF ?? "").trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes" || value === "on") {
    MiddlewareRunner.use(CsrfMiddleware);
    return true;
  }
  return false;
}

// Built-in request logger middleware.
//
// v3.13.14: routes through the Tina4 Log (was a bare console.log) so the
// line gets the same timestamp/level treatment as every other log — human
// in dev, structured JSON in production — and is gated by
// requestLoggingEnabled() (on by default in dev, opt-in in prod via
// TINA4_LOG_REQUESTS). Line format matches Python/PHP/Ruby:
//   METHOD /path -> STATUS (Nms)
export function requestLogger(): Middleware {
  return (req, res, next) => {
    const start = Date.now();

    res.raw.on("finish", () => {
      if (!requestLoggingEnabled()) return;
      const duration = Date.now() - start;
      const status = res.raw.statusCode;
      const method = req.method ?? "?";
      const url = req.url ?? "/";
      Log.info(`${method} ${url} -> ${status} (${duration}ms)`);
    });

    next();
  };
}

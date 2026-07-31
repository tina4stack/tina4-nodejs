import type { Tina4Request, Tina4Response, Middleware } from "./types.js";
import { validToken, getPayload } from "./auth.js";
import { Log } from "./logger.js";
import { isTruthy } from "./dotenv.js";
import { defaultRouter } from "./router.js";

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

/**
 * Runs class-based middleware that follows the beforeX / afterX naming convention.
 *
 * Static methods whose names start with "before" are executed by runBefore
 * (prior to the route handler). Static methods starting with "after" are
 * executed by runAfter (after the handler).
 *
 * Each static method receives (req, res) and returns [req, res].
 * If a "before" method returns a response whose status code is >= 400
 * the chain short-circuits and runBefore returns shouldContinue = false.
 */
/**
 * Produce the deterministic clean 500 for a throwing class-based middleware
 * (M2). Mirrors Python's _middleware_500: LOG via Log.error (class + method +
 * error type + message — never silent) then return a 500 with the exact JSON
 * body shape shared across all four frameworks. The worker never crashes and
 * no unhandled exception leaks.
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
   * Discover the before-prefixed / after-prefixed method names on a
   * middleware class in DEFINITION order (M1).
   * `Object.getOwnPropertyNames` returns a class's own
   * static method names in source-declaration order — we deliberately do NOT
   * sort() them, so within a class the hooks run in the order they were
   * written (parity with Python walking __dict__, PHP get_class_methods, Ruby
   * instance_methods(false)). Cross-class order is the natural iteration of
   * the registered classes = REGISTRATION order.
   */
  private static methodNames(cls: any, prefix: string): string[] {
    return Object.getOwnPropertyNames(cls).filter(
      (name) => typeof cls[name] === "function" && name.startsWith(prefix),
    );
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
          const result = await cls[method](req, res);
          if (Array.isArray(result)) {
            [req, res] = result as [Tina4Request, Tina4Response];
          }
        } catch (error) {
          // Throw → logged clean 500, skip the handler (deterministic).
          res = middleware500(res, cls, method, error);
          return [req, res, false];
        }
        // Short-circuit if the middleware set an error status
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
   */
  static async runAfter(
    classes: any[],
    req: Tina4Request,
    res: Tina4Response,
  ): Promise<[Tina4Request, Tina4Response]> {
    for (const cls of classes) {
      for (const method of MiddlewareRunner.methodNames(cls, "after")) {
        try {
          const result = await cls[method](req, res);
          if (Array.isArray(result)) {
            [req, res] = result as [Tina4Request, Tina4Response];
          }
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
  /** Allowed origins. Default: "*" (or TINA4_CORS_ORIGINS env, comma-separated) */
  origins?: string | string[];
  /** Allowed methods. Default: standard REST methods (or TINA4_CORS_METHODS env) */
  methods?: string | string[];
  /** Allowed headers. Default: Content-Type, Authorization (or TINA4_CORS_HEADERS env) */
  headers?: string | string[];
  /** Access-Control-Max-Age in seconds. Default: 86400 (or TINA4_CORS_MAX_AGE env) */
  maxAge?: number;
}

/**
 * Built-in CORS middleware (function form).
 * Reads configuration from env vars if not provided:
 *   TINA4_CORS_ORIGINS — comma-separated list of allowed origins, or "*"
 *   TINA4_CORS_METHODS — comma-separated list of allowed methods
 *   TINA4_CORS_HEADERS — comma-separated list of allowed headers
 *   TINA4_CORS_MAX_AGE — preflight cache duration in seconds
 *
 * Preflight (OPTIONS) returns 204 with appropriate headers.
 * Supports wildcard ("*") and specific origin matching.
 */
export function cors(config?: CorsConfig): Middleware {
  const originsRaw = config?.origins
    ?? process.env.TINA4_CORS_ORIGINS
    ?? "*";
  const allowedOrigins = Array.isArray(originsRaw)
    ? originsRaw
    : originsRaw.split(",").map((o) => o.trim());

  const methodsRaw = config?.methods
    ?? process.env.TINA4_CORS_METHODS
    ?? "GET, POST, PUT, DELETE, PATCH, OPTIONS";
  const allowedMethods = Array.isArray(methodsRaw)
    ? methodsRaw.join(", ")
    : methodsRaw;

  const headersRaw = config?.headers
    ?? process.env.TINA4_CORS_HEADERS
    ?? "Content-Type,Authorization,X-Request-ID";
  const allowedHeaders = Array.isArray(headersRaw)
    ? headersRaw.join(", ")
    : headersRaw;

  const maxAge = config?.maxAge
    ?? (process.env.TINA4_CORS_MAX_AGE ? parseInt(process.env.TINA4_CORS_MAX_AGE, 10) : 86400);

  return (req, res, next) => {
    const requestOrigin = req.headers.origin ?? "";

    // Determine the correct origin header value
    let originHeader: string;
    if (allowedOrigins.includes("*")) {
      originHeader = "*";
    } else if (allowedOrigins.includes(requestOrigin)) {
      originHeader = requestOrigin;
      // When responding with a specific origin, add Vary: Origin
      res.header("Vary", "Origin");
    } else {
      // Origin not allowed - no CORS headers. A preflight from a disallowed
      // origin is still answered 204 (the browser rejects it for the missing
      // headers); a bare OPTIONS falls through to the RFC 9110 handler.
      if (req.method === "OPTIONS" && requestOrigin !== "") {
        res(null, 204);
        return;
      }
      next();
      return;
    }

    res.header("Access-Control-Allow-Origin", originHeader);
    res.header("Access-Control-Allow-Methods", allowedMethods);
    res.header("Access-Control-Allow-Headers", allowedHeaders);

    // Only a REAL preflight short-circuits here. A preflight carries an Origin
    // (browsers always send one); a bare OPTIONS does not, and belongs to the
    // RFC 9110 s9.3.7 handler in dispatch, which answers 204 WITH an Allow
    // header listing the path's method set.
    //
    // The default origin list is "*", so this used to fire on EVERY OPTIONS
    // request including ones with no Origin at all - swallowing the RFC 9110
    // path entirely and returning a 204 that told the client nothing. Node was
    // the only framework of the four that did this; Ruby, Python and PHP all
    // answer a bare OPTIONS with Allow.
    if (req.method === "OPTIONS" && requestOrigin !== "") {
      res.header("Access-Control-Max-Age", String(maxAge));
      // Carry the resource's REAL method set as Allow (RFC 9110 s9.3.7): a
      // preflight IS an OPTIONS response, so it should answer the same
      // question a bare OPTIONS does, on top of the CORS policy headers.
      //
      // This is CONFORMANCE, not a deviation. The frameworks' own OPTIONS
      // handlers already do it - Django's View.options() sets Allow from
      // _allowed_methods(), Express's router auto-answers OPTIONS with Allow.
      // The add-on CORS libraries (cors npm, django-cors-headers, rack-cors,
      // stack-cors, ASP.NET CORS) omit it, but that is a LAYERING artifact:
      // each sits ahead of the framework, so short-circuiting the preflight
      // also skips the framework's OPTIONS handler and the header it would
      // have produced. Tina4 owns both paths. See ADR-0013.
      //
      // Allow and Access-Control-Allow-Methods are NOT interchangeable: Allow
      // is what the resource supports, ACAM is what the CORS policy permits
      // cross-origin. A policy allowing DELETE on a GET-only route still 405s.
      // An unknown path yields "", matching the bare-OPTIONS branch, so a
      // client can tell "nothing here" from "not told".
      //
      // Resolve the LIVE router the same way mcp.ts and devAdmin.ts do:
      // startServer builds its own Router and publishes it on globalThis.
      // defaultRouter is the module-level instance used by the standalone
      // get()/post() helpers, and a file-routed app registers nothing in it -
      // reading it here returned an empty method set and stamped Allow: "".
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const liveRouter = (globalThis as any).__tina4_router ?? defaultRouter;
      res.header("Allow", liveRouter.methodsAllowedForPath(pathname).join(", "));
      res(null, 204);
      return;
    }

    next();
  };
}

/**
 * Class-based CORS middleware using the before/after convention.
 * Wraps the same CORS logic as the `cors()` function middleware.
 *
 * Usage:
 *   Router.use(CorsMiddleware);
 */
export class CorsMiddleware {
  static beforeCors(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    const originsRaw = process.env.TINA4_CORS_ORIGINS ?? "*";
    const allowedOrigins = originsRaw.split(",").map((o) => o.trim());

    const allowedMethods = process.env.TINA4_CORS_METHODS
      ?? "GET, POST, PUT, DELETE, PATCH, OPTIONS";

    const allowedHeaders = process.env.TINA4_CORS_HEADERS
      ?? "Content-Type,Authorization,X-Request-ID";

    const credentials = process.env.TINA4_CORS_CREDENTIALS ?? "false";

    const maxAge = process.env.TINA4_CORS_MAX_AGE
      ? parseInt(process.env.TINA4_CORS_MAX_AGE, 10)
      : 86400;

    const requestOrigin = req.headers.origin ?? "";

    let originHeader: string | undefined;
    if (allowedOrigins.includes("*")) {
      originHeader = "*";
    } else if (allowedOrigins.includes(requestOrigin)) {
      originHeader = requestOrigin;
      res.header("Vary", "Origin");
    }

    if (originHeader) {
      res.header("Access-Control-Allow-Origin", originHeader);
      res.header("Access-Control-Allow-Methods", allowedMethods);
      res.header("Access-Control-Allow-Headers", allowedHeaders);

      // Add credentials header when enabled and origin is not wildcard
      if (credentials === "true" && originHeader !== "*") {
        res.header("Access-Control-Allow-Credentials", "true");
      }

      if (req.method === "OPTIONS") {
        res.header("Access-Control-Max-Age", String(maxAge));
        res(null, 204);
      }
    } else if (req.method === "OPTIONS") {
      res(null, 204);
    }

    return [req, res];
  }

  /**
   * Check if a request is an OPTIONS preflight.
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

    const forwarded = req.headers["x-forwarded-for"];
    const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : undefined)
      ?? req.socket?.remoteAddress
      ?? "unknown";

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
 * Off by default — only active when TINA4_CSRF=true in .env or when
 * registered explicitly via Router.use(CsrfMiddleware).
 *
 * Behaviour:
 *   - Skips GET, HEAD, OPTIONS requests.
 *   - Skips routes marked .noAuth().
 *   - Skips requests with a valid Authorization: Bearer header (API clients).
 *   - Checks request body formToken then X-Form-Token header.
 *   - Rejects if token found in query string formToken (log warning, 403).
 *   - Validates token with validToken using SECRET env var.
 *   - If token payload has session_id, verifies it matches request session.
 *   - Returns 403 on failure.
 *
 * Usage:
 *   Router.use(CsrfMiddleware);
 */
export class CsrfMiddleware {
  static beforeCsrf(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
    // Skip CSRF validation entirely if disabled via env
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

    // Skip requests with valid Bearer token (API clients)
    const authHeader = req.headers.authorization ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const bearerToken = authHeader.slice(7).trim();
      if (bearerToken) {
        if (validToken(bearerToken)) {
          return [req, res];
        }
      }
    }

    // Reject if token is in query string (security risk)
    const query = (req as any).query ?? {};
    if (query.formToken) {
      console.warn("[Tina4 CSRF] Token found in query string — rejected for security");
      res({
        error: "CSRF_INVALID",
        message: "Form token must not be sent in the URL query string",
      }, 403);
      return [req, res];
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
      res({
        error: "CSRF_INVALID",
        message: "Invalid or missing form token",
      }, 403);
      return [req, res];
    }

    // Validate the token
    if (!validToken(token)) {
      res({
        error: "CSRF_INVALID",
        message: "Invalid or missing form token",
      }, 403);
      return [req, res];
    }

    const payload = getPayload(token) ?? {};

    // Session binding — if token has session_id, verify it matches
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
        res({
          error: "CSRF_INVALID",
          message: "Invalid or missing form token",
        }, 403);
        return [req, res];
      }
    }

    return [req, res];
  }
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

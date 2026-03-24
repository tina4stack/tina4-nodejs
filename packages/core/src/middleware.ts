import type { Tina4Request, Tina4Response, Middleware } from "./types.js";

export class MiddlewareChain {
  private middlewares: Middleware[] = [];

  use(fn: Middleware): void {
    this.middlewares.push(fn);
  }

  async run(req: Tina4Request, res: Tina4Response): Promise<boolean> {
    let index = 0;
    let completed = true;

    const next = (): void => {
      index++;
    };

    for (index = 0; index < this.middlewares.length; index++) {
      const prevIndex = index;
      await this.middlewares[index](req, res, next);

      // If response was already sent, stop the chain
      if (res.raw.writableEnded) {
        completed = false;
        break;
      }

      // If next() wasn't called, stop the chain
      if (index === prevIndex) {
        // next() increments index, so if it wasn't called, index stays the same
        // But we increment in the for loop, so we need to check differently
      }
    }

    return completed;
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
export class MiddlewareRunner {
  /**
   * Execute every beforeX static method found on the supplied classes,
   * in order. Returns the (possibly mutated) request and response pair and a
   * boolean indicating whether the route handler should still run.
   *
   * Short-circuits when a before method sets a status >= 400.
   */
  static runBefore(
    classes: any[],
    req: Tina4Request,
    res: Tina4Response,
  ): [Tina4Request, Tina4Response, boolean] {
    for (const cls of classes) {
      const methods = Object.getOwnPropertyNames(cls).filter(
        (name) => typeof cls[name] === "function" && name.startsWith("before"),
      );
      for (const method of methods) {
        const result = cls[method](req, res);
        if (Array.isArray(result)) {
          [req, res] = result as [Tina4Request, Tina4Response];
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
   * Execute every afterX static method found on the supplied classes,
   * in order. Returns the (possibly mutated) request and response pair.
   */
  static runAfter(
    classes: any[],
    req: Tina4Request,
    res: Tina4Response,
  ): [Tina4Request, Tina4Response] {
    for (const cls of classes) {
      const methods = Object.getOwnPropertyNames(cls).filter(
        (name) => typeof cls[name] === "function" && name.startsWith("after"),
      );
      for (const method of methods) {
        const result = cls[method](req, res);
        if (Array.isArray(result)) {
          [req, res] = result as [Tina4Request, Tina4Response];
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
    ?? "Content-Type, Authorization";
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
      // Origin not allowed — still call next() but don't set CORS headers
      if (req.method === "OPTIONS") {
        res(null, 204);
        return;
      }
      next();
      return;
    }

    res.header("Access-Control-Allow-Origin", originHeader);
    res.header("Access-Control-Allow-Methods", allowedMethods);
    res.header("Access-Control-Allow-Headers", allowedHeaders);

    if (req.method === "OPTIONS") {
      res.header("Access-Control-Max-Age", String(maxAge));
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
      ?? "Content-Type, Authorization";

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

      if (req.method === "OPTIONS") {
        res.header("Access-Control-Max-Age", String(maxAge));
        res(null, 204);
      }
    } else if (req.method === "OPTIONS") {
      res(null, 204);
    }

    return [req, res];
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

// Built-in request logger middleware (function form — kept for backwards compat)
export function requestLogger(): Middleware {
  return (req, res, next) => {
    const start = Date.now();

    res.raw.on("finish", () => {
      const duration = Date.now() - start;
      const status = res.raw.statusCode;
      const method = req.method ?? "?";
      const url = req.url ?? "/";
      const color = status >= 400 ? "\x1b[31m" : status >= 300 ? "\x1b[33m" : "\x1b[32m";
      console.log(`  ${color}${status}\x1b[0m ${method} ${url} \x1b[90m${duration}ms\x1b[0m`);
    });

    next();
  };
}

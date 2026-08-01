import type { Middleware, Tina4Request, Tina4Response } from "./types.js";
import { resolveClientIp } from "./trustedProxy.js";

/** Per-IP sliding window entry */
interface RateLimitEntry {
  /** Timestamps of requests within the current window */
  timestamps: number[];
}

/** Configuration for the rate limiter */
export interface RateLimiterConfig {
  /** Maximum number of requests per window. Default: 100 (or TINA4_RATE_LIMIT env) */
  limit?: number;
  /** Window duration in seconds. Default: 60 (or TINA4_RATE_WINDOW env) */
  windowSeconds?: number;
  /** Cleanup interval in milliseconds. Default: 60000 (1 minute) */
  cleanupIntervalMs?: number;
}

/**
 * Create a rate limiter middleware using a sliding window algorithm.
 * Tracks requests per IP in an in-memory Map.
 *
 * Response headers:
 *   X-RateLimit-Limit     — Maximum requests per window
 *   X-RateLimit-Remaining — Requests remaining in the current window
 *   X-RateLimit-Reset     — Unix timestamp (seconds) when the window resets
 *   Retry-After           — Seconds to wait (only when rate limited)
 *
 * Returns 429 Too Many Requests when the limit is exceeded.
 */
export function rateLimiter(config?: RateLimiterConfig): Middleware {
  const limit = config?.limit
    ?? (process.env.TINA4_RATE_LIMIT ? parseInt(process.env.TINA4_RATE_LIMIT, 10) : 100);
  const windowSeconds = config?.windowSeconds
    ?? (process.env.TINA4_RATE_WINDOW ? parseInt(process.env.TINA4_RATE_WINDOW, 10) : 60);
  const cleanupIntervalMs = config?.cleanupIntervalMs ?? 60_000;

  const windowMs = windowSeconds * 1000;
  const store = new Map<string, RateLimitEntry>();

  // Periodic cleanup of expired entries
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    const cutoff = now - windowMs;
    for (const [ip, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        store.delete(ip);
      }
    }
  }, cleanupIntervalMs);

  // Don't let the cleanup timer keep the process alive
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  return (req, res, next) => {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Client key. X-Forwarded-For is honoured ONLY when the socket peer is a
    // declared trusted proxy (TINA4_TRUSTED_PROXIES) - otherwise any client
    // could pick its own bucket, and pick someone else's. ADR-0019.
    //
    // This derived the key itself rather than reading req.ip, and its
    // `typeof forwarded === "string"` test meant a REPEATED header (which
    // arrives as an array) silently fell through to the socket address -
    // inconsistent with req.ip, which did read the array.
    const ip = resolveClientIp(req.headers, req.socket?.remoteAddress ?? "") || "unknown";

    // Get or create entry
    let entry = store.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(ip, entry);
    }

    // Prune old timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    // Calculate reset time (end of window from the oldest request, or now + window)
    const resetTimestamp = entry.timestamps.length > 0
      ? Math.ceil((entry.timestamps[0] + windowMs) / 1000)
      : Math.ceil((now + windowMs) / 1000);

    const remaining = Math.max(0, limit - entry.timestamps.length);

    // Set rate limit headers
    res.header("X-RateLimit-Limit", String(limit));
    res.header("X-RateLimit-Remaining", String(Math.max(0, remaining - 1)));
    res.header("X-RateLimit-Reset", String(resetTimestamp));

    if (entry.timestamps.length >= limit) {
      // Rate limited
      const retryAfter = Math.max(1, resetTimestamp - Math.ceil(now / 1000));
      res.header("Retry-After", String(retryAfter));
      res.header("X-RateLimit-Remaining", "0");
      res({
        error: "Too Many Requests",
        statusCode: 429,
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      }, 429);
      return;
    }

    // Record this request
    entry.timestamps.push(now);
    next();
  };
}

/** Rate limit check result */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

/**
 * Class-based rate limiter with check/reset/apply methods.
 * Matches the Python/PHP/Ruby API surface.
 */
export class RateLimiter {
  readonly limit: number;
  readonly window: number;
  private store = new Map<string, number[]>();

  constructor(config?: RateLimiterConfig) {
    this.limit = config?.limit
      ?? (process.env.TINA4_RATE_LIMIT ? parseInt(process.env.TINA4_RATE_LIMIT, 10) : 100);
    this.window = config?.windowSeconds
      ?? (process.env.TINA4_RATE_WINDOW ? parseInt(process.env.TINA4_RATE_WINDOW, 10) : 60);
  }

  /** Check if a request from the given IP is allowed. */
  check(ip: string): RateLimitResult {
    const now = Date.now();
    const windowMs = this.window * 1000;
    const cutoff = now - windowMs;

    let timestamps = this.store.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.store.set(ip, timestamps);
    }

    // Prune expired
    const filtered = timestamps.filter((t) => t > cutoff);
    this.store.set(ip, filtered);

    const resetTime = filtered.length > 0
      ? Math.ceil((filtered[0] + windowMs) / 1000)
      : Math.ceil((now + windowMs) / 1000);

    if (filtered.length >= this.limit) {
      const retryAfter = Math.max(1, resetTime - Math.ceil(now / 1000));
      return { allowed: false, limit: this.limit, remaining: 0, reset: resetTime, retryAfter };
    }

    filtered.push(now);
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - filtered.length,
      reset: resetTime,
    };
  }

  /** Clear all tracked request data. */
  reset(): void {
    this.store.clear();
  }

  /** Apply rate limiting to a request/response pair. Sets headers and 429 if exceeded. */
  apply(request: Tina4Request, response: Tina4Response): [Tina4Request, Tina4Response] {
    const ip = request.ip ?? "unknown";
    const result = this.check(ip);

    response.header("X-RateLimit-Limit", String(result.limit));
    response.header("X-RateLimit-Remaining", String(result.remaining));
    response.header("X-RateLimit-Reset", String(result.reset));

    if (!result.allowed) {
      response.header("Retry-After", String(result.retryAfter ?? 1));
      response({ error: "Too Many Requests", retryAfter: result.retryAfter }, 429);
    }

    return [request, response];
  }

  /** Middleware hook — enforces rate limiting before the route handler. */
  beforeRateLimit(request: Tina4Request, response: Tina4Response): [Tina4Request, Tina4Response] {
    return this.apply(request, response);
  }
}

/**
 * In-memory response cache for GET requests.
 * Caches serialized responses by URL + query string.
 *
 * Usage:
 *   import { responseCache } from "./cache.js";
 *
 *   // As middleware — caches GET responses for ttl seconds
 *   middleware.use(responseCache({ ttl: 60 }));
 *
 *   // Per-route cache via meta
 *   export const meta = { cache: 30 }; // cache 30 seconds
 *
 * Environment:
 *   TINA4_CACHE_TTL — default TTL in seconds (default: 0 = disabled)
 */

import type { Middleware } from "./types.js";

interface CacheEntry {
  body: string;
  contentType: string;
  statusCode: number;
  expiresAt: number;
}

export interface ResponseCacheConfig {
  /** Default TTL in seconds. 0 = disabled. Default: 60 */
  ttl?: number;
  /** Maximum cache entries. Default: 1000 */
  maxEntries?: number;
  /** Only cache these status codes. Default: [200] */
  statusCodes?: number[];
}

const store = new Map<string, CacheEntry>();

/**
 * Response cache middleware for GET requests.
 * Caches the full response body, content-type, and status code.
 * Cache key is method + url (including query string).
 */
export function responseCache(config?: ResponseCacheConfig): Middleware {
  const ttl = config?.ttl
    ?? (process.env.TINA4_CACHE_TTL ? parseInt(process.env.TINA4_CACHE_TTL, 10) : 60);
  const maxEntries = config?.maxEntries ?? 1000;
  const allowedCodes = new Set(config?.statusCodes ?? [200]);

  if (ttl <= 0) {
    // Cache disabled — pass through
    return (_req, _res, next) => next();
  }

  // Periodic cleanup
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.expiresAt) store.delete(key);
    }
  }, 30_000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== "GET") {
      next();
      return;
    }

    const cacheKey = `GET:${req.url}`;
    const cached = store.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      // Cache HIT
      res.header("X-Cache", "HIT");
      res.header("Content-Type", cached.contentType);
      res(cached.body, cached.statusCode, cached.contentType);
      return;
    }

    // Cache MISS — intercept the response to capture it
    const originalEnd = res.raw.end.bind(res.raw);
    let captured = false;

    res.raw.end = function (chunk?: any, ...args: any[]) {
      if (!captured && allowedCodes.has(res.raw.statusCode)) {
        captured = true;
        const body = typeof chunk === "string" ? chunk : chunk?.toString() ?? "";
        const contentType = String(res.raw.getHeader("Content-Type") ?? "application/octet-stream");

        // Evict oldest if at capacity
        if (store.size >= maxEntries) {
          const firstKey = store.keys().next().value;
          if (firstKey) store.delete(firstKey);
        }

        store.set(cacheKey, {
          body,
          contentType,
          statusCode: res.raw.statusCode,
          expiresAt: Date.now() + ttl * 1000,
        });
      }

      res.header("X-Cache", "MISS");
      return originalEnd(chunk, ...args);
    } as any;

    next();
  };
}

/** Clear all cached responses */
export function clearCache(): void {
  store.clear();
}

/** Get cache stats */
export function cacheStats(): { size: number; keys: string[] } {
  return { size: store.size, keys: [...store.keys()] };
}

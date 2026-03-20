# Response Cache

Tina4 includes an in-memory response cache middleware for GET requests. It stores serialized responses by URL and replays them for subsequent identical requests within the TTL window.

## Basic Usage

```typescript
import { responseCache } from "@tina4/core";
import { MiddlewareChain } from "@tina4/core";

const middleware = new MiddlewareChain();

// Cache GET responses for 60 seconds
middleware.use(responseCache({ ttl: 60 }));
```

## Configuration

```typescript
import { responseCache } from "@tina4/core";
import type { ResponseCacheConfig } from "@tina4/core";

const cache = responseCache({
  ttl: 120,               // Cache lifetime in seconds (default: 60)
  maxEntries: 500,         // Maximum cache entries (default: 1000)
  statusCodes: [200, 301], // Only cache these status codes (default: [200])
});
```

### Environment Variable

```bash
# .env
TINA4_CACHE_TTL=120   # Default TTL in seconds. Set to 0 to disable.
```

When `TINA4_CACHE_TTL=0` or `ttl: 0`, the cache middleware becomes a pass-through.

## Cache Headers

The middleware adds an `X-Cache` response header:

| Value | Meaning |
|-------|---------|
| `HIT` | Response served from cache |
| `MISS` | Response was not cached; it has now been stored |

## What Gets Cached

- Only `GET` requests are cached.
- The cache key is `GET:{full URL including query string}`.
- Only responses with status codes in the `statusCodes` list are stored (default: 200 only).
- The full response body, content type, and status code are cached.

## Cache Management

```typescript
import { clearCache, cacheStats } from "@tina4/core";

// Clear all cached responses
clearCache();

// Get cache statistics
const stats = cacheStats();
// { size: 42, keys: ["GET:/api/users", "GET:/api/products?page=1", ...] }
```

## Automatic Cleanup

A background timer runs every 30 seconds to evict expired entries. The timer is unreffed so it doesn't prevent the Node.js process from exiting.

When the cache reaches `maxEntries`, the oldest entry is evicted to make room.

## Notes

- The cache is in-memory and does not persist across server restarts.
- POST, PUT, DELETE, and other non-GET requests bypass the cache entirely.
- Different query strings produce different cache keys, so `?page=1` and `?page=2` are cached separately.

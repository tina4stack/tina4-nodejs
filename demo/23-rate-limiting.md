# Rate Limiting

Tina4 includes a built-in sliding-window rate limiter that tracks requests per IP address. It is automatically registered as middleware on server startup.

## Default Configuration

- **Limit:** 100 requests per window
- **Window:** 60 seconds
- **Applies to:** All requests

## Response Headers

Every response includes rate limit headers:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed per window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |
| `Retry-After` | Seconds to wait (only present when rate limited) |

## Rate Limited Response

When the limit is exceeded, a 429 response is returned:

```json
{
  "error": "Too Many Requests",
  "statusCode": 429,
  "message": "Rate limit exceeded. Try again in 45 seconds."
}
```

## Configuration

### Via Code

```typescript
import { rateLimiter } from "@tina4/core";
import type { RateLimiterConfig } from "@tina4/core";

const limiter = rateLimiter({
  limit: 50,               // Max requests per window (default: 100)
  windowSeconds: 30,        // Window duration in seconds (default: 60)
  cleanupIntervalMs: 60000, // How often to clean up expired entries (default: 60000)
});
```

### Via Environment Variables

```bash
# .env
TINA4_RATE_LIMIT=50     # Max requests per window
TINA4_RATE_WINDOW=30    # Window duration in seconds
```

## How the Sliding Window Works

The rate limiter uses a sliding window algorithm:

1. Each IP address has a list of request timestamps.
2. On each request, timestamps older than `windowSeconds` are pruned.
3. If the remaining count is at or above the limit, the request is rejected with 429.
4. Otherwise, the current timestamp is added and the request proceeds.

This provides smoother rate limiting compared to fixed windows, as there are no sudden resets at window boundaries.

## IP Detection

The rate limiter extracts client IP from:

1. `X-Forwarded-For` header (first IP in the list) -- for requests behind a proxy
2. `req.socket.remoteAddress` -- direct connection fallback
3. `"unknown"` -- if neither is available

## Cleanup

A background timer runs every `cleanupIntervalMs` to remove expired entries from the in-memory store. The timer is unreffed so it doesn't prevent process exit.

## Custom Rate Limiter

For per-route rate limiting or different limits for different endpoints:

```typescript
import { get } from "@tina4/core";
import { rateLimiter } from "@tina4/core";

// Strict rate limit for login endpoint
get("/api/login", async (req, res) => {
  res.json({ token: "..." });
}, [rateLimiter({ limit: 5, windowSeconds: 300 })]);  // 5 attempts per 5 minutes

// Relaxed limit for public endpoints
get("/api/public", async (req, res) => {
  res.json({ data: [] });
}, [rateLimiter({ limit: 1000, windowSeconds: 60 })]);
```

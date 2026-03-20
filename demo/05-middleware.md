# Middleware

Tina4 has a middleware chain that runs before every request reaches a route handler. Built-in middleware includes CORS handling, request logging, and rate limiting. You can also attach middleware to individual routes or route groups.

## Built-In Middleware

The server automatically registers these middleware on startup:

1. **CORS** -- handles cross-origin requests and preflight (OPTIONS)
2. **Request Logger** -- logs method, URL, status code, and response time
3. **Rate Limiter** -- sliding-window per-IP rate limiting

## How Middleware Works

Each middleware receives `(req, res, next)`. Call `next()` to continue to the next middleware or the route handler. If you don't call `next()`, the chain stops.

```typescript
import type { Middleware } from "@tina4/core";

const myMiddleware: Middleware = (req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();  // Continue to next middleware/handler
};
```

## CORS Configuration

CORS is configured via code or environment variables.

### Via Code

```typescript
import { cors } from "@tina4/core";
import type { CorsConfig } from "@tina4/core";

const corsMiddleware = cors({
  origins: ["https://myapp.com", "https://staging.myapp.com"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  headers: ["Content-Type", "Authorization"],
  maxAge: 86400,  // Preflight cache in seconds
});
```

### Via Environment Variables

```bash
# .env
TINA4_CORS_ORIGINS=https://myapp.com,https://staging.myapp.com
TINA4_CORS_METHODS=GET,POST,PUT,DELETE
TINA4_CORS_HEADERS=Content-Type,Authorization
TINA4_CORS_MAX_AGE=86400
```

### CORS Behavior

- **Wildcard (`*`)**: Allows all origins (default).
- **Specific origins**: Returns the matching origin in `Access-Control-Allow-Origin` with a `Vary: Origin` header.
- **Preflight**: OPTIONS requests get a 204 response with CORS headers.
- **Non-matching origin**: No CORS headers are set; the request continues normally.

## Request Logger

The built-in logger prints colorized output to the console:

```
  200 GET /api/users 12ms
  201 POST /api/users 8ms
  404 GET /api/missing 2ms
```

- Green for 2xx, yellow for 3xx, red for 4xx/5xx.

## Custom Global Middleware

Use the `MiddlewareChain` class to build custom chains:

```typescript
import { MiddlewareChain } from "@tina4/core";
import type { Middleware } from "@tina4/core";

const chain = new MiddlewareChain();

// Add timing header
const timing: Middleware = (req, res, next) => {
  const start = Date.now();
  res.raw.on("finish", () => {
    res.header("X-Response-Time", `${Date.now() - start}ms`);
  });
  next();
};

chain.use(timing);
```

## Per-Route Middleware

Attach middleware to specific routes. They run after global middleware but before the handler.

```typescript
import { get } from "@tina4/core";
import type { Middleware } from "@tina4/core";

const requireApiKey: Middleware = (req, res, next) => {
  if (req.headers["x-api-key"] !== "secret-key") {
    res({ error: "Invalid API key" }, 401);
    return;  // Don't call next() -- stops the chain
  }
  next();
};

get("/api/protected", async (req, res) => {
  res.json({ data: "secret stuff" });
}, [requireApiKey]);
```

## Route Group Middleware

Apply middleware to a group of routes sharing a prefix:

```typescript
import { Router } from "@tina4/core";
import { authMiddleware } from "@tina4/core";

const router = new Router();

router.group("/api/admin", (group) => {
  group.get("/users", async (req, res) => {
    res.json({ users: [] });
  });

  group.get("/stats", async (req, res) => {
    res.json({ stats: {} });
  });
}, [authMiddleware("my-secret")]);  // All routes in this group require auth
```

## Middleware Execution Order

1. Global middleware (CORS, logger, rate limiter, custom)
2. Route group middleware (if any)
3. Per-route middleware (if any)
4. Route handler

If any middleware sends a response without calling `next()`, the chain stops and the handler is never reached.

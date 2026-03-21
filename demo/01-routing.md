# Routing

Tina4 uses the file system as the source of truth for routing. Drop a `get.ts` or `post.ts` in a directory under `src/routes/`, and the directory path becomes the URL. You can also register routes programmatically using top-level functions or the Router class.

## File-Based Routing

The file name is the HTTP method; the directory path is the URL path.

### Basic Route

```
src/routes/api/hello/get.ts  -->  GET /api/hello
```

```typescript
// src/routes/api/hello/get.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  res.json({ message: "Hello from Tina4!" });
}
```

### Supported Method Files

| File name    | HTTP Method |
|-------------|-------------|
| `get.ts`    | GET         |
| `post.ts`   | POST        |
| `put.ts`    | PUT         |
| `delete.ts` | DELETE      |
| `patch.ts`  | PATCH       |

### Dynamic Parameters with `[id]`

Bracket notation in directory names creates dynamic URL parameters. The value is available on `req.params`.

```
src/routes/api/users/[id]/get.ts  -->  GET /api/users/:id
```

```typescript
// src/routes/api/users/[id]/get.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  const userId = req.params.id;
  res.json({ userId });
}
```

### Catch-All with `[...slug]`

Use the spread notation to capture the rest of the URL path.

```
src/routes/docs/[...slug]/get.ts  -->  GET /docs/*
```

```typescript
// src/routes/docs/[...slug]/get.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  // For GET /docs/api/v2/users, slug = "api/v2/users"
  const slug = req.params.slug;
  res.json({ path: slug });
}
```

### Route Meta for Swagger

Export a `meta` object alongside the handler to provide Swagger documentation.

```typescript
// src/routes/api/products/get.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = {
  summary: "List all products",
  description: "Returns a paginated list of products with optional filtering.",
  tags: ["Products"],
  responses: {
    "200": { description: "A list of products" },
  },
};

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  res.json({ data: [] });
}
```

## Programmatic Routing

For routes that don't fit the file-based convention, use the top-level functions. These are merged into the router on server startup.

```typescript
import { get, post, put, del, patch, any } from "tina4-nodejs";

// Simple GET route
get("/hello", async (req, res) => {
  res.json({ message: "Hello" });
});

// POST with {id} dynamic parameter
post("/users/{id}", async (req, res) => {
  res.json({ id: req.params.id, body: req.body });
});

// DELETE route (use `del` since `delete` is a reserved word)
del("/users/{id}", async (req, res) => {
  res.json({ deleted: req.params.id });
});

// Route that matches ALL HTTP methods
any("/wildcard", async (req, res) => {
  res.json({ method: req.method });
});
```

### Parameter Syntax

Programmatic routes support three parameter styles (all equivalent internally):

```typescript
get("/users/{id}", handler);     // Curly braces (primary, matches Python Tina4)
get("/users/[id]", handler);     // Brackets (file-based convention)
get("/users/:id", handler);      // Express-style colon
```

## Route Groups

Group routes under a shared prefix with optional shared middleware.

```typescript
import { Router } from "tina4-nodejs";
import type { Middleware } from "tina4-nodejs";

const router = new Router();

const authCheck: Middleware = (req, res, next) => {
  if (!req.headers.authorization) {
    res({ error: "Unauthorized" }, 401);
    return;
  }
  next();
};

router.group("/api/v2", (group) => {
  group.get("/users", async (req, res) => {
    res.json({ users: [] });
  });

  group.post("/users", async (req, res) => {
    res.json({ created: true }, 201);
  });

  // Nested group
  group.group("/admin", (admin) => {
    admin.get("/stats", async (req, res) => {
      res.json({ stats: {} });
    });
  });
}, [authCheck]);
```

## Per-Route Middleware

Attach middleware to individual routes. They run before the handler and can short-circuit the chain.

```typescript
import { get } from "tina4-nodejs";
import type { Middleware } from "tina4-nodejs";

const requireAdmin: Middleware = (req, res, next) => {
  if ((req as any).auth?.role !== "admin") {
    res({ error: "Forbidden" }, 403);
    return;
  }
  next();
};

get("/admin/dashboard", async (req, res) => {
  res.json({ dashboard: "admin data" });
}, [requireAdmin]);
```

## Route Precedence

File-based routes take precedence over auto-CRUD routes. If both a file route and an auto-CRUD route match the same pattern, the file route wins.

## Notes

- All route files must use ESM (`export default`) -- no CommonJS.
- TypeScript files (`.ts`) and JavaScript files (`.js`) are both discovered.
- Routes are hot-reloaded during development when files change.

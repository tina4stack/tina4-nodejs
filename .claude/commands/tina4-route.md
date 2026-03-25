# Create a Tina4 Route

Create a new route file in `src/routes/`. Follow these rules exactly.

## Instructions

1. Create `src/routes/$ARGUMENTS.ts` (or ask the user for the resource name)
2. Import `Router` from `tina4-nodejs`
3. Follow auth defaults: GET=public, POST/PUT/PATCH/DELETE=secured
4. Use `noAuth: true` to make a write route public, `secured: true` to protect a GET
5. Path parameters: `:id`, `:slug`, `*` (wildcard)
6. Use async handlers with `(req, res)` signature
7. Add Swagger metadata if the route is an API endpoint

## Template

```typescript
import { Router } from "tina4-nodejs";

Router.get("/api/items", async (req, res) => {
    // Query params: req.params.page ?? "1"
    return res.json({ items: [] });
}, {
    description: "List all items",
    tags: ["items"],
});

Router.get("/api/items/:id", async (req, res) => {
    return res.json({ id: req.params.id });
}, {
    description: "Get a single item",
    tags: ["items"],
});

Router.post("/api/items", async (req, res) => {
    const data = req.body;
    return res.json({ created: true }, 201);
}, {
    description: "Create an item",
    tags: ["items"],
    example: { name: "Widget", price: 9.99 },
    exampleResponse: { id: 1, name: "Widget" },
});

Router.put("/api/items/:id", async (req, res) => {
    const data = req.body;
    return res.json({ updated: true });
}, {
    description: "Update an item",
    tags: ["items"],
});

Router.delete("/api/items/:id", async (req, res) => {
    return res.json({ deleted: true });
}, {
    description: "Delete an item",
    tags: ["items"],
});
```

## Route Options (third argument)

```typescript
Router.post("/path", handler, {
    noAuth: true,          // Make a write route public
    secured: true,         // Protect a GET route
    description: "...",    // Swagger docs
    tags: ["..."],         // Swagger tags
    example: {...},        // Request body example
    exampleResponse: {...},// Response body example
    cached: true,          // Enable response caching
    maxAge: 60,            // Cache TTL in seconds
});
```

## Key Rules

- One resource per file (e.g., `users.ts`, `products.ts`)
- Routes auto-discovered from `src/routes/` — no manual registration
- `req.body` is auto-parsed (object for JSON, object for form data)
- `req.params` for path and query string parameters
- `req.headers` for HTTP headers (lowercase keys)
- `req.files` for uploaded files
- Always return `res.json(data)` or `res.json(data, statusCode)`
- Use `res.render("template.twig", data)` for HTML pages

# Swagger / OpenAPI

Tina4 automatically generates OpenAPI 3.0 documentation from your routes and models. A Swagger UI is served at `/swagger` and the raw spec at `/swagger/openapi.json`.

## Automatic Setup

No configuration needed. When the server starts, Swagger routes are registered automatically.

- **Swagger UI:** `http://localhost:3000/swagger`
- **OpenAPI spec:** `http://localhost:3000/swagger/openapi.json`

## Route Documentation via Meta

Export a `meta` object from file-based route files to provide summary, description, and tags.

```typescript
// src/routes/api/users/get.ts
import type { Tina4Request, Tina4Response } from "@tina4/core";

export const meta = {
  summary: "List all users",
  description: "Returns a paginated list of users with optional filtering and sorting.",
  tags: ["Users"],
  responses: {
    "200": { description: "A paginated list of users" },
    "500": { description: "Internal server error" },
  },
};

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  res.json({ data: [], meta: { total: 0, page: 1 } });
}
```

### RouteMeta Interface

```typescript
interface RouteMeta {
  summary?: string;
  description?: string;
  tags?: string[];
  responses?: Record<string, { description: string }>;
}
```

## Model Schemas

Models are automatically converted to OpenAPI schemas under `#/components/schemas/`. Field types map to OpenAPI types:

| Tina4 Field Type | OpenAPI Type |
|-----------------|-------------|
| `"string"` | `{ type: "string" }` |
| `"text"` | `{ type: "string" }` |
| `"integer"` | `{ type: "integer" }` |
| `"number"` | `{ type: "number" }` |
| `"boolean"` | `{ type: "boolean" }` |
| `"datetime"` | `{ type: "string", format: "date-time" }` |

Field validation constraints (`minLength`, `maxLength`, `min`, `max`, `pattern`) are reflected in the schema. Primary keys with `autoIncrement` are marked `readOnly`.

## Auto-CRUD Documentation

Auto-CRUD endpoints get automatic Swagger documentation:

- **GET list** endpoints include `page`, `limit`, and `sort` query parameters.
- **POST/PUT** endpoints include a request body schema referencing the model.
- **Tags** are inferred from the URL path (e.g., `/api/users` is tagged "users").

## Tag Inference

When tags are not specified in `meta`, Tina4 infers them from the URL:

- `/api/users` -> tag: `users`
- `/api/orders/{id}` -> tag: `orders`
- `/health` -> tag: `health`

## Programmatic Meta

When registering programmatic routes, pass `meta` as the last argument:

```typescript
import { get } from "@tina4/core";

get("/api/status", async (req, res) => {
  res.json({ status: "ok" });
}, [], {
  summary: "System status",
  tags: ["System"],
});
```

## Notes

- Swagger UI is loaded from CDN (unpkg.com) to keep the package under 8MB.
- The spec is generated fresh on each request to `/swagger/openapi.json`, so changes are reflected immediately.
- The OpenAPI version used is 3.0.3.

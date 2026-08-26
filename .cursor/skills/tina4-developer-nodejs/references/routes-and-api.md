# Routes & API Development (Node.js)

## File-Based Routes

Routes in `tina4-nodejs` are **file-based** — there is no `get('/hello', handler)` registration in a
route file. A route file's **method is its filename** and its **URL path is its directory**:

```
src/routes/hello/get.ts            →  GET  /hello
src/routes/users/get.ts            →  GET  /users
src/routes/users/post.ts           →  POST /users
src/routes/users/[id]/get.ts       →  GET  /users/{id}
src/routes/users/[id]/put.ts       →  PUT  /users/{id}
src/routes/users/[id]/delete.ts    →  DELETE /users/{id}
```

- Valid method filenames: `get`, `post`, `put`, `delete`, `patch` (`.ts` or `.js`).
- A dynamic segment is a directory named `[id]` — it becomes the URL param `{id}`. A catch-all is
  `[...slug]` → `{...slug}`.
- Each file **`export default`s the handler**: `(request, response) => …`.

```typescript
// src/routes/hello/get.ts   →  GET /hello
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (request: Tina4Request, response: Tina4Response) {
  return response.text("Hello World");
}
```

```typescript
// src/routes/users/[id]/get.ts   →  GET /users/{id}
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { HTTP_OK, HTTP_NOT_FOUND } from "tina4-nodejs";
import { User } from "../../../models/User.js";

export default async function (request: Tina4Request, response: Tina4Response) {
  const user = await User.findById(request.params.id);
  if (!user) return response({ error: "Not found" }, HTTP_NOT_FOUND);
  return response(user, HTTP_OK);        // object → JSON automatically
}
```

```typescript
// src/routes/users/post.ts   →  POST /users  (secure by default — Bearer required)
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { HTTP_CREATED, HTTP_BAD_REQUEST } from "tina4-nodejs";
import { User } from "../../models/User.js";

export const meta = { summary: "Create a user", tags: ["Users"] };   // optional Swagger metadata

export default async function (request: Tina4Request, response: Tina4Response) {
  const { name, email } = request.body as { name?: string; email?: string };
  if (!name || !email) return response({ error: "name and email are required" }, HTTP_BAD_REQUEST);

  const user = await User.create({ name, email });      // false on validation/driver failure
  if (!user) return response({ error: "Could not create user" }, HTTP_BAD_REQUEST);
  return response(user, HTTP_CREATED);
}
```

### Imperative routes (for public writes, protected GETs, WebSockets)

File-based route files cannot toggle their own auth flag. When you need a **public write route**
(login/register/webhook) or a **protected GET**, register it imperatively in `app.ts` and chain a
modifier. `get`/`post`/`put`/`patch`/`del`/`websocket` are exported from `tina4-nodejs`:

```typescript
import { post, get, websocket } from "tina4-nodejs";

post("/api/login", loginHandler).noAuth();   // public write (opts out of the Bearer guard)
get("/api/me", meHandler).secure();          // protect an otherwise-public GET
websocket("/ws/chat", chatHandler).secure(); // require a JWT on the WS upgrade
```

`RouteRef` chainable modifiers: `.secure()`, `.noAuth()`, `.cache()`, `.middleware(...)`.

## Smart Response Types

The `response` object is **callable** and also has explicit methods:

- `response(data, status?)` — object → JSON, string → text, with an optional status code
- `response.json(data, status?)` — force JSON
- `response.text(str, status?)` / `response.html(str, status?)` / `response.xml(str, status?)`
- `await response.render("template.twig", data, status?)` — Frond template (**async — `await` it**)
- `response.redirect("/path", code?)`
- `response.file("path/to/file", { download?, contentType? })`
- `response.status(code)`, `response.header(name, value)`, `response.cookie(name, value, opts?)`,
  `response.clearCookie(name)`, `response.error(code, message, status?)`
- `await response.stream(asyncIterable, contentType?)`

Status-code constants are exported from `tina4-nodejs`: `HTTP_OK` (200), `HTTP_CREATED` (201),
`HTTP_NO_CONTENT` (204), `HTTP_BAD_REQUEST` (400), `HTTP_UNAUTHORIZED` (401), `HTTP_NOT_FOUND` (404),
`HTTP_UNPROCESSABLE` (422), `HTTP_SERVER_ERROR` (500), etc.

## Path & Query Parameters

`request.params` merges **route params and query-string params**. Route params may be coerced
numbers when typed (e.g. `{id:int}`); query params are always strings.

```typescript
// GET /search?q=hello&page=2   →  src/routes/search/get.ts
export default async function (request: Tina4Request, response: Tina4Response) {
  const query = (request.params.q as string) ?? "";
  const page = parseInt((request.params.page as string) ?? "1", 10);
  // …
}
```

`request.getParam(key)` fetches a single merged param. The parsed body is on `request.body`
(JSON is auto-parsed); headers are on `request.headers`.

## Middleware

A middleware is `(req, res, next) => void | Promise<void>`. Attach per-route via `.middleware(...)`
on an imperative route, or register built-ins by string spec (e.g. `"ResponseCache:300"`).

```typescript
import { get } from "tina4-nodejs";
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

async function requireAdmin(req: Tina4Request, res: Tina4Response, next: () => void) {
  if ((req.user as any)?.role !== "admin") return res.json({ error: "Forbidden" }, 403);
  next();
}

get("/api/admin/stats", statsHandler).secure().middleware(requireAdmin);
```

The framework already installs CORS, request logging, and rate limiting globally. Built-in
middleware classes exported from `tina4-nodejs` include `CorsMiddleware`, `RateLimiterMiddleware`,
`SecurityHeadersMiddleware`, `CsrfMiddleware`, `RequestLogger`.

## Swagger / OpenAPI

Auto-generated at `/swagger`. Add per-route metadata by exporting `meta` from the route file:

```typescript
export const meta = {
  summary: "List all active users",
  tags: ["Users"],
  responses: { "200": { description: "A list of users" } },
  security: "public",            // "public" | "bearerAuth" — documents the auth requirement in the spec
};
```

> Note: `meta.security` only affects the **Swagger document**. Actual auth enforcement is driven by
> the HTTP method (writes secure-by-default) and the imperative `.secure()` / `.noAuth()` modifiers —
> not by `meta.security`.

## CSRF / Form Token Protection

State-changing Frond forms include a CSRF token via `{{ formToken() }}`:

```twig
<form method="post" action="/contact">
    {{ formToken() }}
    <input type="text" name="name">
    <button type="submit">Send</button>
</form>
```

The framework validates a `formToken` in the body on write requests (it is one of the accepted
token sources, alongside the `Authorization: Bearer` header and a session token). Never skip CSRF
protection on server-rendered forms.

## CORS, Rate Limiting

Both are built in and installed globally with sensible defaults. Override via `.env` or by
configuring the middleware. No configuration is needed to get started.

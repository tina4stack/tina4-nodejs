# tina4-nodejs

> Simple. Fast. Human. This is not a framework.

Tina4 for Node.js/TypeScript. Convention over configuration, zero ceremony, batteries included.

## Quick Start

```bash
npx tina4 init my-api
cd my-api
npx tina4 serve
```

Your API is running at `http://localhost:3000`. Swagger docs at `http://localhost:3000/swagger`.

## Project Structure

```
my-api/
  src/
    routes/          # File-based routing
      api/
        hello/
          get.ts     # GET /api/hello
        users/
          get.ts     # GET /api/users (overrides auto-CRUD)
          [id]/
            get.ts   # GET /api/users/:id
    models/          # Auto-CRUD models
      User.ts
      Product.ts
    templates/       # Twig templates (optional)
      pages/
        home.html.twig
  public/            # Static files
    index.html
  data/              # SQLite database (auto-created)
    tina4.db
```

---

## Routing

Routes live in `src/routes/`. The directory path becomes the URL, and the filename determines the HTTP method.

### Basic Route

```
src/routes/api/hello/get.ts  →  GET /api/hello
```

```typescript
// src/routes/api/hello/get.ts
import type { Tina4Request, Tina4Response } from "@tina4/core";

export default async function (req: Tina4Request, res: Tina4Response) {
  res.json({ message: "Hello from Tina4!" });
}
```

### All HTTP Methods

```
src/routes/api/users/get.ts     →  GET    /api/users
src/routes/api/users/post.ts    →  POST   /api/users
src/routes/api/users/put.ts     →  PUT    /api/users
src/routes/api/users/delete.ts  →  DELETE /api/users
src/routes/api/users/patch.ts   →  PATCH  /api/users
```

### Dynamic Parameters

Use `[param]` in directory names for dynamic segments:

```
src/routes/api/users/[id]/get.ts        →  GET /api/users/:id
src/routes/api/posts/[postId]/comments/[commentId]/get.ts
                                        →  GET /api/posts/:postId/comments/:commentId
```

```typescript
// src/routes/api/users/[id]/get.ts
export default async function (req: Tina4Request, res: Tina4Response) {
  const userId = req.params.id;
  res.json({ userId });
}
```

### Catch-All Routes

Use `[...slug]` for wildcard matching:

```
src/routes/api/files/[...path]/get.ts   →  GET /api/files/*
```

```typescript
// src/routes/api/files/[...path]/get.ts
export default async function (req: Tina4Request, res: Tina4Response) {
  const filePath = req.params.path; // e.g. "docs/readme.md"
  res.json({ filePath });
}
```

### POST with JSON Body

```typescript
// src/routes/api/contact/post.ts
export default async function (req: Tina4Request, res: Tina4Response) {
  const { name, email, message } = req.body as {
    name: string;
    email: string;
    message: string;
  };

  // Process the contact form...
  res.status(201).json({ success: true, name, email });
}
```

```bash
curl -X POST http://localhost:3000/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name": "Andre", "email": "andre@tina4.com", "message": "Hello!"}'
```

### Query Parameters

```typescript
// src/routes/api/search/get.ts
export default async function (req: Tina4Request, res: Tina4Response) {
  const { q, page, limit } = req.query;
  res.json({ query: q, page: page ?? "1", limit: limit ?? "20" });
}
```

```bash
curl "http://localhost:3000/api/search?q=hello&page=2&limit=10"
```

### Response Helpers

```typescript
export default async function (req: Tina4Request, res: Tina4Response) {
  // JSON response
  res.json({ data: "hello" });

  // HTML response
  res.html("<h1>Hello</h1>");

  // Set status code (chainable)
  res.status(201).json({ created: true });

  // Plain text
  res.send("plain text");

  // Redirect
  res.redirect("/api/hello");
  res.redirect("/api/hello", 301); // permanent
}
```

### Route Metadata (for Swagger)

Export a `meta` object to add Swagger annotations:

```typescript
// src/routes/api/users/post.ts
export const meta = {
  summary: "Create a new user",
  description: "Creates a user account and returns the new user object",
  tags: ["Users"],
  responses: {
    201: { description: "User created successfully" },
    422: { description: "Validation failed" },
  },
};

export default async function (req: Tina4Request, res: Tina4Response) {
  // ...
}
```

---

## Models & Auto-CRUD

Define a model in `src/models/` and Tina4 auto-generates a full REST API.

### Defining a Model

```typescript
// src/models/User.ts
export default class User {
  static tableName = "users";

  static fields = {
    id:        { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:      { type: "string" as const,  required: true, maxLength: 255 },
    email:     { type: "string" as const,  required: true },
    age:       { type: "integer" as const, min: 0, max: 150 },
    bio:       { type: "text" as const },
    active:    { type: "boolean" as const, default: true },
    createdAt: { type: "datetime" as const, default: "now" },
  };
}
```

### Auto-Generated Endpoints

This model automatically creates:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/users` | List all users (with filtering, sorting, pagination) |
| `GET` | `/api/users/:id` | Get a single user by ID |
| `POST` | `/api/users` | Create a new user |
| `PUT` | `/api/users/:id` | Update a user |
| `DELETE` | `/api/users/:id` | Delete a user |

### Creating Records

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@example.com", "age": 30}'
```

Response:
```json
{
  "data": {
    "id": 1,
    "name": "Alice",
    "email": "alice@example.com",
    "age": 30,
    "active": 1,
    "createdAt": "2026-03-19 12:00:00"
  }
}
```

### Listing Records

```bash
curl http://localhost:3000/api/users
```

Response:
```json
{
  "data": [
    { "id": 1, "name": "Alice", "email": "alice@example.com", "age": 30 },
    { "id": 2, "name": "Bob", "email": "bob@example.com", "age": 25 }
  ],
  "meta": {
    "total": 2,
    "page": 1,
    "limit": 20,
    "totalPages": 1
  }
}
```

### Filtering

```bash
# Exact match
curl "http://localhost:3000/api/users?filter[name]=Alice"

# Greater than
curl "http://localhost:3000/api/users?filter[age][gt]=25"

# Less than or equal
curl "http://localhost:3000/api/users?filter[age][lte]=30"

# Not equal
curl "http://localhost:3000/api/users?filter[active][ne]=0"

# LIKE pattern
curl "http://localhost:3000/api/users?filter[name][like]=%25Ali%25"
```

Supported operators: `gt`, `gte`, `lt`, `lte`, `ne`, `like`

### Sorting

```bash
# Sort ascending by name
curl "http://localhost:3000/api/users?sort=name"

# Sort descending by age
curl "http://localhost:3000/api/users?sort=-age"

# Multiple sort fields
curl "http://localhost:3000/api/users?sort=name,-createdAt"
```

### Pagination

```bash
# Page 2, 10 items per page
curl "http://localhost:3000/api/users?page=2&limit=10"
```

### Updating Records

```bash
curl -X PUT http://localhost:3000/api/users/1 \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice Updated", "age": 31}'
```

### Deleting Records

```bash
curl -X DELETE http://localhost:3000/api/users/1
```

### Validation

Validation rules are inferred from field definitions:

```typescript
static fields = {
  name:  { type: "string",  required: true, minLength: 2, maxLength: 100 },
  email: { type: "string",  required: true, pattern: "^[^@]+@[^@]+$" },
  age:   { type: "integer", min: 0, max: 150 },
  price: { type: "number",  required: true, min: 0 },
};
```

Invalid requests return structured errors:

```json
{
  "error": "Validation failed",
  "statusCode": 422,
  "errors": [
    { "field": "name", "message": "is required" },
    { "field": "age", "message": "must be at least 0" }
  ]
}
```

### Field Types

| Type | SQLite Type | Description |
|------|-------------|-------------|
| `"string"` | `TEXT` | Short text, supports `minLength`, `maxLength`, `pattern` |
| `"text"` | `TEXT` | Long text, supports `minLength`, `maxLength` |
| `"integer"` | `INTEGER` | Whole numbers, supports `min`, `max` |
| `"number"` | `REAL` | Decimal numbers, supports `min`, `max` |
| `"boolean"` | `INTEGER` | True/false (stored as 1/0) |
| `"datetime"` | `TEXT` | ISO 8601 date/time string |

### Field Options

| Option | Description |
|--------|-------------|
| `primaryKey` | Mark as primary key |
| `autoIncrement` | Auto-increment (integer PKs) |
| `required` | Must be provided on create |
| `default` | Default value (`"now"` for current timestamp) |
| `minLength` / `maxLength` | String length constraints |
| `min` / `max` | Numeric range constraints |
| `pattern` | Regex validation pattern |

### Multiple Models

```typescript
// src/models/Product.ts
export default class Product {
  static tableName = "products";

  static fields = {
    id:          { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:        { type: "string" as const,  required: true },
    price:       { type: "number" as const,  required: true, min: 0 },
    description: { type: "text" as const },
    inStock:     { type: "boolean" as const, default: true },
    createdAt:   { type: "datetime" as const, default: "now" },
  };
}
```

```typescript
// src/models/Category.ts
export default class Category {
  static tableName = "categories";

  static fields = {
    id:   { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const,  required: true, maxLength: 100 },
    slug: { type: "string" as const,  required: true, pattern: "^[a-z0-9-]+$" },
  };
}
```

Each model gets its own set of CRUD endpoints automatically.

### Overriding Auto-CRUD

File-based routes take precedence. Create a route file to override any auto-generated endpoint:

```typescript
// src/routes/api/users/[id]/get.ts
// This overrides the auto-CRUD GET /api/users/:id
export default async function (req: Tina4Request, res: Tina4Response) {
  // Custom logic here — maybe join with another table,
  // add extra data, or apply access control
  res.json({ custom: true, id: req.params.id });
}
```

---

## Swagger / OpenAPI

Auto-generated API documentation is available at `/swagger` with zero configuration.

### Viewing Docs

Start your server and open:

- **Swagger UI**: `http://localhost:3000/swagger`
- **OpenAPI JSON**: `http://localhost:3000/swagger/openapi.json`

### What Gets Documented

- All file-based routes with path parameters
- All auto-CRUD endpoints with full request/response schemas
- Model schemas with field types, constraints, and required fields
- Route metadata from exported `meta` objects

### Adding Descriptions

```typescript
// src/routes/api/auth/login/post.ts
export const meta = {
  summary: "User login",
  description: "Authenticates a user and returns a session token",
  tags: ["Authentication"],
  responses: {
    200: { description: "Login successful" },
    401: { description: "Invalid credentials" },
  },
};

export default async function (req: Tina4Request, res: Tina4Response) {
  const { email, password } = req.body as { email: string; password: string };
  // Authentication logic...
  res.json({ token: "..." });
}
```

---

## Twig Templates

Optional server-side HTML rendering using the Twig template engine. Install `@tina4/twig` to enable.

### Basic Template

```twig
{# src/templates/pages/home.html.twig #}
<!DOCTYPE html>
<html>
<head><title>{{ title }}</title></head>
<body>
  <h1>Welcome, {{ name }}!</h1>
</body>
</html>
```

### Rendering from a Route

```typescript
// src/routes/api/page/get.ts
export default async function (req: Tina4Request, res: Tina4Response) {
  await res.render("pages/home.html.twig", {
    title: "My App",
    name: "World",
  });
}
```

### Template Inheritance

```twig
{# src/templates/layouts/base.html.twig #}
<!DOCTYPE html>
<html>
<head>
  <title>{% block title %}Tina4{% endblock %}</title>
  {% block head %}{% endblock %}
</head>
<body>
  <nav>{% block nav %}{% endblock %}</nav>
  <main>{% block content %}{% endblock %}</main>
  <footer>{% block footer %}&copy; 2026{% endblock %}</footer>
</body>
</html>
```

```twig
{# src/templates/pages/about.html.twig #}
{% extends "layouts/base.html.twig" %}

{% block title %}About Us{% endblock %}

{% block content %}
  <h1>About Us</h1>
  <p>We build with Tina4.</p>
{% endblock %}
```

### Loops and Conditionals

```twig
{# src/templates/pages/users.html.twig #}
{% extends "layouts/base.html.twig" %}

{% block content %}
  <h1>Users</h1>

  {% if users|length > 0 %}
    <ul>
      {% for user in users %}
        <li>
          <strong>{{ user.name }}</strong> — {{ user.email }}
          {% if user.active %}
            <span class="badge">Active</span>
          {% endif %}
        </li>
      {% endfor %}
    </ul>
  {% else %}
    <p>No users found.</p>
  {% endif %}
{% endblock %}
```

```typescript
// src/routes/page/users/get.ts
export default async function (req: Tina4Request, res: Tina4Response) {
  // Fetch users from the database
  const { getAdapter } = await import("@tina4/orm");
  const db = getAdapter();
  const users = db.query("SELECT * FROM users WHERE active = 1");

  await res.render("pages/users.html.twig", { users });
}
```

### Includes

```twig
{# src/templates/partials/card.html.twig #}
<div class="card">
  <h3>{{ card_title }}</h3>
  <p>{{ card_body }}</p>
</div>
```

```twig
{# Use it in another template #}
{% include "partials/card.html.twig" with { card_title: "Hello", card_body: "World" } %}
```

---

## Static Files

Files in the `public/` directory are served automatically at the root URL.

```
public/index.html    →  http://localhost:3000/
public/css/style.css →  http://localhost:3000/css/style.css
public/img/logo.png  →  http://localhost:3000/img/logo.png
```

Static files take precedence over routes for the root path.

---

## Database

SQLite is embedded by default via `better-sqlite3`. Zero configuration required.

### Default Location

The database file is created at `./data/tina4.db` on first run. The `data/` directory is auto-created.

### Auto-Migration

On server startup, Tina4 compares model definitions to the database schema:
- **New models**: Tables are created automatically
- **New fields**: Columns are added automatically
- **Removed fields**: Warned but not dropped (safety first)

### Direct Database Access

```typescript
// In any route handler
import { getAdapter } from "@tina4/orm";

export default async function (req: Tina4Request, res: Tina4Response) {
  const db = getAdapter();

  // Raw query
  const users = db.query("SELECT * FROM users WHERE age > ?", [25]);

  // Execute (INSERT, UPDATE, DELETE)
  db.execute("UPDATE users SET active = ? WHERE id = ?", [false, 1]);

  res.json({ users });
}
```

---

## CLI

### `tina4 init <name>`

Scaffolds a new project with:
- `package.json` with Tina4 dependencies
- `tsconfig.json` configured for TypeScript
- Sample route at `src/routes/api/hello/get.ts`
- Sample model at `src/models/Example.ts`
- Sample template at `src/templates/welcome.html.twig`
- Static landing page at `public/index.html`

### `tina4 serve`

Starts the development server with:
- Hot-reload on file changes
- Route auto-discovery
- Model sync and auto-CRUD registration
- Swagger doc generation
- Colorized request logging

Options:
```bash
tina4 serve              # Default port 3000
tina4 serve --port 8080  # Custom port
```

---

## Full Example: Blog API

Here's a complete blog API built with Tina4 in just a few files:

### Models

```typescript
// src/models/Post.ts
export default class Post {
  static tableName = "posts";

  static fields = {
    id:          { type: "integer" as const, primaryKey: true, autoIncrement: true },
    title:       { type: "string" as const,  required: true, maxLength: 200 },
    slug:        { type: "string" as const,  required: true, pattern: "^[a-z0-9-]+$" },
    body:        { type: "text" as const,    required: true },
    published:   { type: "boolean" as const, default: false },
    publishedAt: { type: "datetime" as const },
    createdAt:   { type: "datetime" as const, default: "now" },
  };
}
```

```typescript
// src/models/Comment.ts
export default class Comment {
  static tableName = "comments";

  static fields = {
    id:        { type: "integer" as const, primaryKey: true, autoIncrement: true },
    postId:    { type: "integer" as const, required: true },
    author:    { type: "string" as const,  required: true, maxLength: 100 },
    body:      { type: "text" as const,    required: true },
    createdAt: { type: "datetime" as const, default: "now" },
  };
}
```

### Custom Routes (overriding auto-CRUD where needed)

```typescript
// src/routes/api/posts/published/get.ts
// Custom endpoint: GET /api/posts/published — only published posts
import { getAdapter } from "@tina4/orm";

export const meta = {
  summary: "List published posts",
  tags: ["Posts"],
};

export default async function (req: Tina4Request, res: Tina4Response) {
  const db = getAdapter();
  const posts = db.query(
    "SELECT * FROM posts WHERE published = 1 ORDER BY publishedAt DESC"
  );
  res.json({ data: posts });
}
```

```typescript
// src/routes/api/posts/[id]/comments/get.ts
// Custom endpoint: GET /api/posts/:id/comments
import { getAdapter } from "@tina4/orm";

export const meta = {
  summary: "Get comments for a post",
  tags: ["Comments"],
};

export default async function (req: Tina4Request, res: Tina4Response) {
  const db = getAdapter();
  const comments = db.query(
    "SELECT * FROM comments WHERE postId = ? ORDER BY createdAt DESC",
    [req.params.id]
  );
  res.json({ data: comments });
}
```

### Using the API

```bash
# Create a post
curl -X POST http://localhost:3000/api/posts \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Hello World",
    "slug": "hello-world",
    "body": "This is my first post!",
    "published": true,
    "publishedAt": "2026-03-19T12:00:00Z"
  }'

# List all posts with pagination
curl "http://localhost:3000/api/posts?page=1&limit=10&sort=-createdAt"

# Get published posts only
curl http://localhost:3000/api/posts/published

# Filter posts
curl "http://localhost:3000/api/posts?filter[published]=1"

# Add a comment
curl -X POST http://localhost:3000/api/comments \
  -H "Content-Type: application/json" \
  -d '{"postId": 1, "author": "Reader", "body": "Great post!"}'

# Get comments for a post
curl http://localhost:3000/api/posts/1/comments

# Update a post
curl -X PUT http://localhost:3000/api/posts/1 \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello World (Updated)"}'

# Delete a post
curl -X DELETE http://localhost:3000/api/posts/1

# View Swagger docs
open http://localhost:3000/swagger
```

---

## Architecture

Tina4 is a monorepo with modular packages:

| Package | npm Name | Description |
|---------|----------|-------------|
| `packages/cli` | `tina4` | CLI for `init` and `serve` commands |
| `packages/core` | `@tina4/core` | HTTP server, router, route discovery, middleware |
| `packages/orm` | `@tina4/orm` | Database adapters, models, auto-CRUD, query builder |
| `packages/swagger` | `@tina4/swagger` | OpenAPI spec generation, Swagger UI |
| `packages/twig` | `@tina4/twig` | Twig template engine (optional) |

### Type Imports

```typescript
import type {
  Tina4Request,
  Tina4Response,
  RouteHandler,
  Tina4Config,
  Middleware,
} from "@tina4/core";

import type {
  FieldDefinition,
  ModelDefinition,
  DatabaseAdapter,
  QueryOptions,
} from "@tina4/orm";
```

---

## Philosophy

- **Language is the hero**: You write TypeScript. Tina4 is invisible infrastructure.
- **Zero ceremony**: Every feature works with zero configuration. Opt-in complexity, never opt-out.
- **Tina4 DNA**: If the PHP version does it, the Node version should too — but idiomatically.
- **Ship fast**: Developer speed and simplicity over architectural purity.

---

## Requirements

- Node.js 20+
- TypeScript 5+

## Links

- [tina4.com](https://tina4.com)
- [github.com/tina4stack](https://github.com/tina4stack)

## License

MIT

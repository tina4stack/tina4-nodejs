<p align="center">
  <img src="https://tina4.com/logo.svg" alt="Tina4" width="200">
</p>

<h1 align="center">Tina4 Node.js</h1>
<h3 align="center">This is not a framework</h3>

<p align="center">
  Laravel joy. TypeScript speed. 10x less code. Zero third-party dependencies.
</p>

<p align="center">
  <a href="https://tina4.com">Documentation</a> &bull;
  <a href="#getting-started">Getting Started</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#cli-reference">CLI Reference</a> &bull;
  <a href="https://tina4.com">tina4.com</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-1247%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/carbonah-A%2B%20rated-00cc44" alt="Carbonah A+">
  <img src="https://img.shields.io/badge/zero--dep-core-blue" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/node-20%2B-blue" alt="Node 20+">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT License">
</p>

---

## Quickstart

```bash
npm install tina4
npx tina4 init my-app
cd my-app
npx tina4 serve
# -> http://localhost:7145
```

That's it. Zero configuration, zero classes, zero boilerplate.

---

## What's Included

Every feature is built from scratch -- no npm install, no node_modules bloat, no third-party runtime dependencies in core.

| Category | Features |
|----------|----------|
| **HTTP** | Native `node:http` server, file-based + programmatic routing, path params (`{id}`, `[...slug]`), middleware pipeline, CORS, rate limiting, graceful shutdown |
| **Templates** | Frond engine (Twig-compatible), inheritance, partials, 53+ filters, macros, fragment caching, sandboxing |
| **ORM** | Active Record, typed fields with validation, soft delete, relationships (`hasOne`/`hasMany`/`belongsTo`), scopes, result caching, auto-CRUD |
| **Database** | SQLite, PostgreSQL, MySQL -- unified adapter interface |
| **Auth** | Zero-dep JWT (HS256 + RS256), sessions (file backend), PBKDF2 password hashing, form tokens |
| **API** | Swagger/OpenAPI auto-generation, GraphQL with schema builder and GraphiQL IDE |
| **Background** | File-backed queue with priority, delayed jobs, retry, batch processing |
| **Real-time** | Native WebSocket (RFC 6455), per-path routing, connection manager, broadcast |
| **Frontend** | tina4-css (~24 KB), frond.js helper, SCSS compiler, live reload, CSS hot-reload |
| **DX** | Dev admin dashboard, error overlay, request inspector, hot-reload, Carbonah green benchmarks |
| **Data** | Migrations with rollback, 26+ fake data generators, ORM and table seeders |
| **Other** | Service runner, localization (i18n), in-memory cache (TTL/tags/LRU), HTTP constants, health check, configurable error pages |

**580 tests across all modules. All Carbonah benchmarks rated A+.**

For full documentation visit **[tina4.com](https://tina4.com)**.

---

## Install

```bash
npm install tina4
```

Or scaffold a new project directly:

```bash
npx tina4 init my-app
```

---

## Getting Started

### 1. Create a project

```bash
npx tina4 init my-app
cd my-app
```

This creates:

```
my-app/
├── package.json        # Entry point
├── tsconfig.json       # TypeScript config
├── .env                # Configuration
├── src/
│   ├── routes/         # API + page routes (auto-discovered)
│   ├── models/         # Database models (auto-CRUD)
│   ├── templates/      # Frond/Twig templates
│   ├── seeds/          # Database seeders
│   ├── scss/           # SCSS (auto-compiled to public/css/)
│   └── public/         # Static assets served at /
├── migrations/         # SQL migration files
├── data/               # SQLite database (auto-created)
└── test/               # Tests
```

### 2. Create a route

**File-based routing** -- the directory path becomes the URL:

```
src/routes/api/hello/get.ts  ->  GET /api/hello
```

```typescript
// src/routes/api/hello/get.ts
import type { Tina4Request, Tina4Response } from "@tina4/core";

export default async function (request: Tina4Request, response: Tina4Response) {
    response({message: "Hello from Tina4!"}, HTTP_OK);
}
```

**Programmatic routing** -- decorator-style in a single file:

```typescript
// src/routes/hello.ts
import { get } from "@tina4/core";

get("/api/hello/{name}", async (request, response) => {
    response({message: `Hello, ${request.params.name}!`}, HTTP_OK);
});
```

Visit `http://localhost:7145/api/hello` -- routes are auto-discovered, no imports needed.

### 3. Add a database

Edit `.env`:

```bash
DATABASE_URL=sqlite:///data/app.db
```

Create and run a migration:

```bash
npx tina4 migrate:create "create users table"
```

Edit the generated SQL:

```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

```bash
npx tina4 migrate
```

### 4. Create an ORM model

Create `src/models/User.ts`:

```typescript
export default class User {
    static tableName = "users";

    static fields = {
        id:        { type: "integer" as const, primaryKey: true, autoIncrement: true },
        name:      { type: "string" as const,  required: true, maxLength: 100 },
        email:     { type: "string" as const,  required: true, pattern: "^[^@]+@[^@]+\\.[^@]+$" },
        createdAt: { type: "datetime" as const, default: "now" },
    };
}
```

### 5. Build a REST API

**File-based** -- create `src/routes/api/users/get.ts`:

```typescript
import type { Tina4Request, Tina4Response } from "@tina4/core";
import { getAdapter } from "@tina4/orm";

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getAdapter();
    const users = db.query("SELECT * FROM users LIMIT 100");
    response(users, HTTP_OK);
}
```

Create `src/routes/api/users/[id]/get.ts`:

```typescript
export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getAdapter();
    const user = db.query("SELECT * FROM users WHERE id = ?", [request.params.id]);
    if (user.length) {
        response(user[0], HTTP_OK);
    } else {
        response({error: "Not found"}, HTTP_NOT_FOUND);
    }
}
```

Create `src/routes/api/users/post.ts`:

```typescript
export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getAdapter();
    db.execute("INSERT INTO users (name, email) VALUES (?, ?)",
        [request.body.name, request.body.email]);
    response({success: true}, HTTP_CREATED);
}
```

> **Auto-CRUD alternative**: Simply define the model in `src/models/User.ts` and Tina4 auto-generates all CRUD endpoints. File routes override auto-CRUD when both exist.

### 6. Add a template

Create `src/templates/base.twig`:

```twig
<!DOCTYPE html>
<html>
<head>
    <title>{% block title %}My App{% endblock %}</title>
    <link rel="stylesheet" href="/css/tina4.min.css">
    {% block stylesheets %}{% endblock %}
</head>
<body>
    {% block content %}{% endblock %}
    <script src="/js/frond.js"></script>
    {% block javascripts %}{% endblock %}
</body>
</html>
```

Create `src/templates/pages/home.twig`:

```twig
{% extends "base.twig" %}
{% block content %}
<div class="container mt-4">
    <h1>{{ title }}</h1>
    <ul>
    {% for user in users %}
        <li>{{ user.name }} -- {{ user.email }}</li>
    {% endfor %}
    </ul>
</div>
{% endblock %}
```

Render it from a route:

```typescript
// src/routes/page/home/get.ts
export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getAdapter();
    const users = db.query("SELECT * FROM users LIMIT 20");
    await response.render("pages/home.twig", {title: "Users", users});
}
```

### 7. Seed, test, deploy

```bash
npx tina4 seed                          # Run seeders from src/seeds/
npx tina4 test                          # Run test suite
npx tina4 build                         # Build distributable
```

For the complete step-by-step guide, visit **[tina4.com](https://tina4.com)**.

---

## Features

### Routing

Tina4 supports both **file-based** and **programmatic** routing:

```typescript
// File-based: src/routes/api/items/get.ts
export default async function (request: Tina4Request, response: Tina4Response) {
    response({items: []}, HTTP_OK);
}

// Programmatic: src/routes/webhooks.ts
import { get, post, noauth, secured, middleware } from "@tina4/core";

get("/api/items", async (request, response) => {
    response({items: []}, HTTP_OK);
});

noauth(
    post("/api/webhook", async (request, response) => {
        response({ok: true}, HTTP_OK);
    })
);

secured(
    get("/api/admin/stats", async (request, response) => {
        response({secret: true}, HTTP_OK);
    })
);
```

Path parameter types: `{id}` (string), `[id]` (file-based), `[...slug]` (catch-all).

### ORM

Active Record with typed fields, validation, soft delete, relationships, and auto-CRUD:

```typescript
// src/models/User.ts
export default class User {
    static tableName = "users";

    static fields = {
        id:    { type: "integer" as const, primaryKey: true, autoIncrement: true },
        name:  { type: "string" as const,  required: true, maxLength: 100 },
        email: { type: "string" as const,  required: true, pattern: "^[^@]+@[^@]+$" },
        role:  { type: "string" as const,  default: "user" },
        age:   { type: "integer" as const, min: 0, max: 150 },
    };
}

// Auto-generates: GET/POST /api/users, GET/PUT/DELETE /api/users/:id
// With filtering, sorting, pagination, and validation built in
```

### Database

Unified interface across multiple engines:

```typescript
import { getAdapter, initDatabase } from "@tina4/orm";

const db = initDatabase("sqlite:///data/app.db");

const result = db.query("SELECT * FROM users WHERE age > ?", [18]);
const row = db.query("SELECT * FROM users WHERE id = ?", [1]);
db.execute("INSERT INTO users (name, email) VALUES (?, ?)", ["Alice", "alice@test.com"]);
```

### Middleware

```typescript
import { middleware } from "@tina4/core";

const authCheck = async (request: Tina4Request, response: Tina4Response, next: Function) => {
    if (!request.headers.authorization) {
        return response({error: "Unauthorized"}, HTTP_UNAUTHORIZED);
    }
    return next();
};

middleware(authCheck,
    get("/protected", async (request, response) => {
        response({secret: true}, HTTP_OK);
    })
);
```

### JWT Authentication

```typescript
import { Auth } from "@tina4/core";

const auth = new Auth({secret: "your-secret"});
const token = auth.createToken({userId: 42});
const payload = auth.validateToken(token);
```

POST/PUT/PATCH/DELETE routes require `Authorization: Bearer <token>` by default. Use `noauth()` to make public, `secured()` to protect GET routes.

### Sessions

```typescript
request.session.set("userId", 42);
const userId = request.session.get("userId");
```

Backend: file (default). Set via `TINA4_SESSION_HANDLER` in `.env`.

### Queues

```typescript
import { Queue, Producer, Consumer } from "@tina4/core";

new Producer(new Queue({topic: "emails"})).produce({to: "alice@example.com"});

new Consumer(new Queue({topic: "emails"})).onMessage((msg) => {
    sendEmail(msg.data);
});
```

### GraphQL

```typescript
import { GraphQL } from "@tina4/core";

const gql = new GraphQL();
gql.schema.fromModels();
gql.registerRoute("/graphql");   // GET = GraphiQL IDE, POST = queries
```

### WebSocket

```typescript
import { WebSocketManager } from "@tina4/core";

const ws = new WebSocketManager();

ws.route("/ws/chat", async (connection, message) => {
    await ws.broadcast("/ws/chat", `User said: ${message}`);
});
```

### Swagger / OpenAPI

Auto-generated at `/swagger`:

```typescript
// src/routes/api/users/get.ts
export const meta = {
    summary: "Get all users",
    tags: ["Users"],
};

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getAdapter();
    response(db.query("SELECT * FROM users"), HTTP_OK);
}
```

### Service Runner

```typescript
import { ServiceRunner } from "@tina4/core";

const runner = new ServiceRunner();

runner.register("cleanup", "0 */6 * * *", async () => {
    // Runs every 6 hours
    await cleanupExpiredSessions();
});
```

### Template Engine (Frond)

Twig-compatible, 53+ filters, macros, inheritance, fragment caching, sandboxing:

```twig
{% extends "base.twig" %}
{% block content %}
<h1>{{ title | upper }}</h1>
{% for item in items %}
    <p>{{ item.name }} -- {{ item.price | number_format(2) }}</p>
{% endfor %}

{% cache "sidebar" 300 %}
    {% include "partials/sidebar.twig" %}
{% endcache %}
{% endblock %}
```

### REST Client

```typescript
import { Api } from "@tina4/core";

const api = new Api("https://api.example.com", {authHeader: "Bearer xyz"});
const result = await api.sendRequest("/users/42");
```

### Data Seeder

```typescript
import { Fake, seedModel } from "@tina4/core";

const fake = new Fake();
fake.name();      // "Alice Johnson"
fake.email();     // "alice.johnson@example.com"

seedModel(User, {count: 50});
```

### Response Cache

```typescript
import { cached } from "@tina4/core";

cached(60,
    get("/api/stats", async (request, response) => {
        response(computeExpensiveStats(), HTTP_OK);
    })
);
```

### SCSS, Localization

- **SCSS**: Drop `.scss` in `src/scss/` -- auto-compiled to CSS. Variables, nesting, mixins, `@import`, `@extend`.
- **i18n**: JSON translation files, parameter substitution.

---

## Dev Mode

Set `TINA4_DEBUG_LEVEL=DEBUG` in `.env` to enable:

- **Live reload** -- browser auto-refreshes on code changes
- **CSS hot-reload** -- SCSS changes apply without page refresh
- **Error overlay** -- rich error display in the browser
- **Dev admin** with routes, queue, requests, errors, system tabs

---

## CLI Reference

```bash
npx tina4 init [dir]             # Scaffold a new project
npx tina4 serve [--port 7145]    # Start dev server (default: 7145)
npx tina4 migrate                # Run pending migrations
npx tina4 migrate:create <desc>  # Create a migration file
npx tina4 migrate:rollback       # Rollback last batch
npx tina4 seed                   # Run seeders from src/seeds/
npx tina4 routes                 # List all registered routes
npx tina4 test                   # Run test suite
npx tina4 build                  # Build distributable package
npx tina4 ai [--all]             # Detect AI tools and install context
```

## Environment

```bash
SECRET=your-jwt-secret
DATABASE_URL=sqlite:///data/app.db
TINA4_DEBUG_LEVEL=DEBUG              # DEBUG, INFO, WARNING, ERROR, ALL
TINA4_LANGUAGE=en                    # en, fr, af, zh, ja, es
TINA4_SESSION_HANDLER=SessionFileHandler
SWAGGER_TITLE=My API
```

## Carbonah Green Benchmarks

All benchmarks rated **A+** (South Africa grid, 1000 iterations each):

| Metric | Value |
|--------|-------|
| Startup time | 38ms |
| Memory usage | 104.2MB |
| SCI score | 0.00552 gCO2eq |
| Grade | A+ |

Run locally: `npx tina4 benchmark`

---

## Documentation

Full guides, API reference, and examples at **[tina4.com](https://tina4.com)**.

## License

MIT (c) 2007-2025 Tina4 Stack
https://opensource.org/licenses/MIT

---

<p align="center"><b>Tina4</b> -- The framework that keeps out of the way of your coding.</p>

---

## Our Sponsors

**Sponsored with 🩵 by Code Infinity**

[<img src="https://codeinfinity.co.za/wp-content/uploads/2025/09/c8e-logo-github.png" alt="Code Infinity" width="100">](https://codeinfinity.co.za/about-open-source-policy?utm_source=github&utm_medium=website&utm_campaign=opensource_campaign&utm_id=opensource)

*Supporting open source communities <span style="color: #1DC7DE;">•</span> Innovate <span style="color: #1DC7DE;">•</span> Code <span style="color: #1DC7DE;">•</span> Empower*

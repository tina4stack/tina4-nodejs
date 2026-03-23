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
  <img src="https://img.shields.io/badge/tests-1669%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/carbonah-A%2B%20rated-00cc44" alt="Carbonah A+">
  <img src="https://img.shields.io/badge/zero--dep-core-blue" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/node-20%2B-blue" alt="Node 20+">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT License">
</p>

---

## Quick Start

```bash
# Install the Tina4 CLI
cargo install tina4  # or download binary from https://github.com/tina4stack/tina4/releases

# Create a project
tina4 init nodejs ./my-app

# Run it
cd my-app && tina4 serve
```

Open http://localhost:7148 — your app is running.

<details>
<summary><strong>Without the Tina4 CLI</strong></summary>

```bash
# 1. Create project
mkdir my-app && cd my-app
npm init -y
npm install tina4-nodejs

# 2. Create entry point
cat > app.ts << 'EOF'
import { startServer } from "tina4-nodejs";
startServer({ port: 7148, host: "0.0.0.0" });
EOF

# 3. Create .env
echo 'TINA4_DEBUG=true' > .env
echo 'TINA4_LOG_LEVEL=ALL' >> .env

# 4. Create route directory
mkdir -p src/routes

# 5. Run
npx tsx app.ts
```

Open http://localhost:7148

</details>

---

## What's Included

Every feature is built from scratch -- no npm install, no node_modules bloat, no third-party runtime dependencies in core.

| Category | Features |
|----------|----------|
| **HTTP** | Native `node:http` server, file-based + programmatic routing, path params (`{id}`, `[...slug]`), middleware pipeline, CORS, rate limiting, graceful shutdown |
| **Templates** | Frond engine (Twig-compatible), inheritance, partials, 53+ filters, macros, fragment caching, sandboxing |
| **ORM** | Active Record, typed fields with validation, soft delete, relationships (`hasOne`/`hasMany`/`belongsTo`), scopes, result caching, auto-CRUD |
| **Database** | SQLite, PostgreSQL, MySQL, MSSQL/SQL Server, Firebird -- unified adapter interface, query caching (TINA4_DB_CACHE=true for 4x speedup) |
| **Auth** | Zero-dep JWT (HS256 + RS256), sessions (file backend), PBKDF2 password hashing, form tokens |
| **API** | Swagger/OpenAPI auto-generation, GraphQL with schema builder and GraphiQL IDE |
| **Background** | Queue (SQLite/RabbitMQ/Kafka/MongoDB) with priority, delayed jobs, retry, batch processing |
| **Real-time** | Native WebSocket (RFC 6455), per-path routing, connection manager, broadcast |
| **Frontend** | tina4-css (~24 KB), frond.js helper, SCSS compiler, live reload, CSS hot-reload |
| **DX** | Dev admin dashboard, error overlay, request inspector, hot-reload, Carbonah green benchmarks |
| **Data** | Migrations with rollback, 26+ fake data generators, ORM and table seeders |
| **Other** | Service runner, localization (i18n), cache (memory/Redis/file), messenger (.env driven), HTTP constants, health check, configurable error pages |

**1,669 tests across 38 built-in features. Zero dependencies. All Carbonah benchmarks rated A+.**

For full documentation visit **[tina4.com](https://tina4.com)**.

---

## Install

```bash
npm install tina4-nodejs
```

Or scaffold a new project directly:

```bash
npx tina4nodejs init my-app
```

---

## Getting Started

### 1. Create a project

```bash
npx tina4nodejs init my-app
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
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (request: Tina4Request, response: Tina4Response) {
    response({message: "Hello from Tina4!"}, HTTP_OK);
}
```

**Programmatic routing** -- decorator-style in a single file:

```typescript
// src/routes/hello.ts
import { get } from "tina4-nodejs";

get("/api/hello/{name}", async (request, response) => {
    response({message: `Hello, ${request.params.name}!`}, HTTP_OK);
});
```

Visit `http://localhost:7148/api/hello` -- routes are auto-discovered, no imports needed.

### 3. Add a database

Edit `.env`:

```bash
DATABASE_URL=sqlite:///data/app.db
```

Create and run a migration:

```bash
npx tina4nodejs migrate:create "create users table"
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
npx tina4nodejs migrate
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
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { getAdapter } from "tina4-nodejs";

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
npx tina4nodejs seed                          # Run seeders from src/seeds/
npx tina4nodejs test                          # Run test suite
npx tina4nodejs build                         # Build distributable
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
import { get, post } from "tina4-nodejs";

get("/api/items", async (request, response) => {
    response({items: []}, HTTP_OK);
});

// POST routes require auth by default; GET routes are public by default.
// Use JSDoc @noauth / @secured annotations to override:

/** @noauth */
post("/api/webhook", async (request, response) => {
    response({ok: true}, HTTP_OK);
});

/** @secured */
get("/api/admin/stats", async (request, response) => {
    response({secret: true}, HTTP_OK);
});
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
import { getAdapter, initDatabase } from "tina4-nodejs";

const db = initDatabase("sqlite:///data/app.db");

const result = db.query("SELECT * FROM users WHERE age > ?", [18]);
const row = db.query("SELECT * FROM users WHERE id = ?", [1]);
db.execute("INSERT INTO users (name, email) VALUES (?, ?)", ["Alice", "alice@test.com"]);
```

### Middleware

```typescript
import { get } from "tina4-nodejs";

const authCheck = async (request: Tina4Request, response: Tina4Response, next: Function) => {
    if (!request.headers.authorization) {
        return response({error: "Unauthorized"}, HTTP_UNAUTHORIZED);
    }
    return next();
};

get("/protected", async (request, response) => {
    response({secret: true}, HTTP_OK);
}, [authCheck]);
```

### JWT Authentication

```typescript
import { createToken, validateToken } from "tina4-nodejs";

const token = createToken({userId: 42}, "your-secret");
const payload = validateToken(token, "your-secret");
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
import { Queue } from "tina4-nodejs";

const queue = new Queue({ topic: "emails" });
queue.push({ to: "alice@example.com" });

const job = queue.pop();
if (job) {
    sendEmail(job.data);
    job.complete();
}
```

### GraphQL

```typescript
import { GraphQL } from "tina4-nodejs";

const gql = new GraphQL();
gql.schema.fromModels();
gql.registerRoute("/graphql");   // GET = GraphiQL IDE, POST = queries
```

### WebSocket

```typescript
import { WebSocketServer } from "tina4-nodejs";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (client) => {
    client.on("message", (msg) => {
        wss.broadcast(`User said: ${msg}`);
    });
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
import { ServiceRunner } from "tina4-nodejs";

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
import { Api } from "tina4-nodejs";

const api = new Api("https://api.example.com", {authHeader: "Bearer xyz"});
const result = await api.sendRequest("/users/42");
```

### Data Seeder

```typescript
import { FakeData } from "tina4-nodejs";

const fake = new FakeData();
fake.name();      // "Alice Johnson"
fake.email();     // "alice.johnson@example.com"

// Seed via ORM package:
// import { seedOrm } from "@tina4/orm";
// await seedOrm(User, 50);
```

### Response Cache

```typescript
import { get, responseCache } from "tina4-nodejs";

// Apply response cache as middleware with 60-second TTL
get("/api/stats", async (request, response) => {
    response(computeExpensiveStats(), HTTP_OK);
}, [responseCache({ ttl: 60 })]);
```

### SCSS, Localization

- **SCSS**: Drop `.scss` in `src/scss/` -- auto-compiled to CSS. Variables, nesting, mixins, `@import`, `@extend`.
- **i18n**: JSON translation files, parameter substitution.

---

## Dev Mode

Set `TINA4_DEBUG=true` in `.env` to enable:

- **Live reload** -- browser auto-refreshes on code changes
- **CSS hot-reload** -- SCSS changes apply without page refresh
- **Error overlay** -- rich error display in the browser
- **Dev admin** with routes, queue, requests, errors, system tabs

---

## CLI Reference

```bash
npx tina4nodejs init [dir]             # Scaffold a new project
npx tina4nodejs serve [--port 7148]    # Start dev server (default: 7148)
npx tina4nodejs serve --production     # Auto-use cluster mode (multi-core)
npx tina4nodejs migrate                # Run pending migrations
npx tina4nodejs migrate:create <desc>  # Create a migration file
npx tina4nodejs migrate:rollback       # Rollback last batch
npx tina4nodejs generate model <name>  # Generate model scaffold
npx tina4nodejs generate route <name>  # Generate route scaffold
npx tina4nodejs generate migration <d> # Generate migration file
npx tina4nodejs generate middleware <n># Generate middleware scaffold
npx tina4nodejs seed                   # Run seeders from src/seeds/
npx tina4nodejs routes                 # List all registered routes
npx tina4nodejs test                   # Run test suite
npx tina4nodejs build                  # Build distributable package
npx tina4nodejs ai [--all]             # Detect AI tools and install context
```

### Production Server Auto-Detection

`tina4 serve` automatically detects and uses the best available production server:

- **Node.js**: cluster mode with multiple workers, otherwise single http server
- Use `npx tina4nodejs serve --production` to auto-use cluster mode

### Scaffolding with `tina4 generate`

Quickly scaffold new components:

```bash
npx tina4nodejs generate model User          # Creates src/models/User.ts
npx tina4nodejs generate route users         # Creates src/routes/api/users/
npx tina4nodejs generate migration "add age" # Creates migration SQL file
npx tina4nodejs generate middleware AuthLog   # Creates middleware
```

### ORM Relationships & Eager Loading

```typescript
// Relationships defined in model
static relationships = {
  orders: { type: "hasMany", model: "Order", foreignKey: "userId" },
  profile: { type: "hasOne", model: "Profile", foreignKey: "userId" },
  customer: { type: "belongsTo", model: "Customer", foreignKey: "customerId" },
};

// Eager loading with include
const users = await db.query("SELECT * FROM users", [], { include: ["orders", "profile"] });
```

### DB Query Caching

Enable query caching for up to 4x speedup on read-heavy workloads:

```bash
# .env
TINA4_DB_CACHE=true
```

### Frond Pre-Compilation

Templates are pre-compiled for 2.8x faster rendering.

### Gallery

7 interactive examples with **Try It** deploy.

## Environment

```bash
SECRET=your-jwt-secret
DATABASE_URL=sqlite:///data/app.db
DATABASE_USERNAME=admin              # Separate credentials for networked databases
DATABASE_PASSWORD=secret
TINA4_DEBUG=true                     # Enable dev toolbar, error overlay
TINA4_LOG_LEVEL=ALL                  # ALL, DEBUG, INFO, WARNING, ERROR
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

Run locally: `npx tina4nodejs benchmark`

---

## Documentation

Full guides, API reference, and examples at **[tina4.com](https://tina4.com)**.

## License

MIT (c) 2007-2026 Tina4 Stack
https://opensource.org/licenses/MIT

---

<p align="center"><b>Tina4</b> -- The framework that keeps out of the way of your coding.</p>

---

## Our Sponsors

**Sponsored with 🩵 by Code Infinity**

[<img src="https://codeinfinity.co.za/wp-content/uploads/2025/09/c8e-logo-github.png" alt="Code Infinity" width="100">](https://codeinfinity.co.za/about-open-source-policy?utm_source=github&utm_medium=website&utm_campaign=opensource_campaign&utm_id=opensource)

*Supporting open source communities <span style="color: #1DC7DE;">•</span> Innovate <span style="color: #1DC7DE;">•</span> Code <span style="color: #1DC7DE;">•</span> Empower*

# tina4-nodejs Features

> Simple. Fast. Human. This is not a framework.

Tina4 for Node.js brings the full Tina4 developer experience to TypeScript. Convention over configuration, zero ceremony, batteries included.

---

## Core Capabilities

- **Zero-Config Scaffolding** — `npx tina4 init <name>` creates a working project with sample routes and models
- **Dev Server with Hot-Reload** — `npx tina4 serve` starts the server, watches for changes, auto-restarts
- **TypeScript-First** — Full type inference out of the box. JavaScript supported but TypeScript is primary
- **Node.js 20+** — Built for modern Node.js with native ESM support
- **Minimal Footprint** — Under 8MB installed. Fast cold-start. Minimal dependencies

---

## Routing

- **File-Based Route Discovery** — Routes auto-discovered from `src/routes/`. No registration needed
- **Convention Mapping** — Filename determines HTTP method: `get.ts`, `post.ts`, `put.ts`, `delete.ts`, `patch.ts`
- **Dynamic Parameters** — Directory name `[id]` maps to `:id` path parameter. `src/routes/api/users/[id]/get.ts` serves `GET /api/users/:id`
- **Catch-All Routes** — `[...slug]` for wildcard matching
- **Route Metadata** — Export a `meta` object for Swagger annotations (summary, tags, responses)
- **Static File Serving** — Files in `public/` served automatically
- **Simple Handler Signature** — Each route exports an async function `(req, res) => void`. No decorators, no base classes

---

## ORM & Database

- **Convention-Based Models** — Define models in `src/models/` with `static fields` — no decorators required
- **Auto-CRUD Generation** — Each model automatically gets GET (list), GET (by ID), POST, PUT, DELETE endpoints
- **SQLite by Default** — Embedded SQLite via `better-sqlite3`. Zero database setup required
- **Database Adapters** — Pluggable adapter pattern for PostgreSQL and MySQL
- **Auto-Migration** — Safe schema changes applied on startup (add columns, add tables). Warns on destructive changes
- **Query Filtering** — `?filter[name]=John`, `?filter[age][gt]=25`
- **Pagination** — `?page=2&limit=20` with metadata in response
- **Sorting** — `?sort=name,-createdAt` (prefix `-` for descending)
- **Input Validation** — Field-level validation from model definitions (required, type, min/max, pattern)
- **Parameterized Queries** — SQL injection prevention built-in

---

## Auto-Swagger / OpenAPI

- **Auto-Generated OpenAPI 3.0 Spec** — Available at `/swagger/openapi.json`
- **Swagger UI** — Interactive API docs at `/swagger` (CDN-based, zero install overhead)
- **Model Schemas** — Full request/response schemas inferred from model field definitions
- **Path Parameters** — Automatically documented from route structure
- **Route Annotations** — Optional metadata via exported `meta` object in route files
- **Live Updates** — Spec regenerated on each request in dev mode

---

## Templating (Optional)

- **Twig-Compatible Engine** — Server-rendered HTML via `@tina4/twig` package
- **Template Directory** — Templates live in `src/templates/`
- **Simple API** — `res.render("pages/home.html.twig", { title: "Hello" })`
- **Full Twig Support** — Template inheritance, includes, blocks, filters
- **Opt-In** — System works fully without `@tina4/twig` installed. Install only when you need it

---

## Developer Experience

- **Startup Banner** — Shows port, discovered routes, loaded models, swagger URL
- **Request Logging** — Method, path, status code, response time in colorized output
- **Structured Errors** — JSON error responses with status code and details
- **Helpful 404s** — Suggests similar routes when an endpoint is not found
- **Environment Aware** — `NODE_ENV=development` enables verbose logging and stack traces; production mode sanitizes errors

---

## Architecture

| Package | Purpose |
|---------|---------|
| `tina4` (CLI) | Project scaffolding and dev server |
| `@tina4/core` | HTTP server, router, route discovery |
| `@tina4/orm` | Database, models, auto-CRUD, query builder |
| `@tina4/swagger` | OpenAPI spec generation, Swagger UI |
| `@tina4/twig` | Twig template engine (optional) |

---

## Roadmap

- [ ] Bun runtime compatibility
- [ ] GraphQL engine
- [ ] WebSocket support
- [ ] Session management
- [ ] JWT authentication
- [ ] Queue system
- [ ] Localization (i18n)

---

*tina4.com | github.com/tina4stack | "This is not a framework"*

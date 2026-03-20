# Tina4 Node.js — Feature Demos

> This is not a framework. Tina4 is invisible infrastructure: convention-over-configuration, batteries included, file system as source of truth.

Each demo below covers a specific feature of Tina4 for Node.js/TypeScript with working code examples.

## Getting Started

```bash
npx tina4nodejs init my-project
cd my-project
tina4nodejs serve
```

Your API runs at `http://localhost:3000` with Swagger docs at `http://localhost:3000/swagger`.

---

## Core Features

| # | Feature | Description |
|---|---------|-------------|
| 01 | [Routing](01-routing.md) | File-based routing, dynamic params, catch-all, programmatic routes, route groups |
| 02 | [ORM & Models](02-orm.md) | Model definition, static fields, auto-CRUD, BaseModel instance methods |
| 03 | [Database](03-database.md) | SQLite adapter, initDatabase(), adapter interface, DATABASE_URL support |
| 04 | [Templates](04-templates.md) | Twig templates via `@tina4/twig`, `res.render()` |
| 05 | [Middleware](05-middleware.md) | Middleware chain, built-in CORS, request logger, per-route middleware |
| 06 | [Swagger](06-swagger.md) | Auto-generated OpenAPI 3.0 from routes and models, Swagger UI |
| 07 | [CLI](07-cli.md) | `tina4nodejs init` and `tina4nodejs serve` commands |
| 08 | [Static Files](08-static-files.md) | Static file serving from `public/`, MIME types, index.html fallback |
| 09 | [Hot Reload](09-hot-reload.md) | File watching and automatic route reload in dev mode |
| 10 | [Validation](10-validation.md) | Request body validation from model field definitions |
| 11 | [Query Params](11-query-params.md) | Filtering, sorting, pagination on auto-CRUD endpoints |
| 12 | [Migrations](12-migrations.md) | Auto-sync schema from models, migration tracking and rollback |
| 13 | [Cache](13-cache.md) | In-memory response cache middleware for GET requests |
| 14 | [Auth & JWT](14-auth.md) | JWT generation/verification, password hashing, auth middleware |
| 15 | [Sessions](15-sessions.md) | File-backed session management with flash data |
| 16 | [WebSockets](16-websockets.md) | Zero-dependency RFC 6455 WebSocket server |
| 17 | [GraphQL](17-graphql.md) | Zero-dependency GraphQL engine with recursive-descent parser |
| 18 | [Queue](18-queue.md) | File-backed job queue for background processing |
| 19 | [Internationalization](19-i18n.md) | JSON-based translations with locale fallback |
| 20 | [Seeder](20-seeder.md) | Fake data generation for testing and development |
| 21 | [Services](21-services.md) | Background service runner with cron scheduling |
| 22 | [Logging](22-logging.md) | Structured logging with file rotation and JSON output |
| 23 | [Rate Limiting](23-rate-limiting.md) | Sliding-window rate limiter per IP |
| 24 | [Environment Config](24-env-config.md) | `.env` file loading, `getEnv()`, `requireEnv()` |
| 25 | [Constants](25-constants.md) | HTTP status codes and content type constants |
| 26 | [SCSS Compiler](26-scss.md) | Zero-dependency SCSS-to-CSS compiler subset |
| 27 | [Response API](27-response-api.md) | Callable response object, cookies, redirects, content negotiation |
| 28 | [Request API](28-request-api.md) | Body parsing, file uploads, query strings, IP detection |
| 29 | [Health Check](29-health-check.md) | Built-in `/health` endpoint |
| 30 | [Deployment](30-deployment.md) | Production build with esbuild, environment configuration |

---

## Tech Stack

- **Language:** TypeScript (strict mode, ES2022, Node16 module resolution)
- **Runtime:** Node.js 20+ (ESM only)
- **HTTP:** Native `node:http` -- no Express, no Fastify
- **Database:** SQLite via `better-sqlite3` (default), adapter pattern for others
- **Templates:** Twig via the `twig` npm package (optional)
- **Dev tooling:** `tsx` for runtime TypeScript, `esbuild` for builds

## Project Structure

```
my-project/
  src/
    routes/          # File-based routing (get.ts, post.ts, etc.)
    models/          # Model definitions (static tableName, static fields)
    templates/       # Twig templates (.html.twig)
    locales/         # i18n JSON files (en.json, fr.json, etc.)
  public/            # Static files served as-is
  data/              # SQLite database, sessions, queue storage
  logs/              # Log files (auto-created)
  .env               # Environment configuration
  package.json
  tsconfig.json
```

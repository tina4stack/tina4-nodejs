# CLAUDE.md — AI Developer Guide for tina4-nodejs

> This file helps AI assistants (Claude, Copilot, Cursor, etc.) understand and work on this codebase effectively.

## What This Project Is

Tina4 for Node.js/TypeScript — a convention-over-configuration structural paradigm. **Not a framework.** The developer writes TypeScript; Tina4 is invisible infrastructure.

The philosophy: zero ceremony, batteries included, file system as source of truth.

## Repository Layout

```
tina4-nodejs/
  packages/
    cli/        # tina4 CLI (npx tina4 init, npx tina4 serve)
    core/       # HTTP server, router, route discovery, middleware
    orm/        # Database adapters, models, auto-CRUD, query builder
    swagger/    # OpenAPI spec generator, Swagger UI
    twig/       # Optional Twig template engine
  test/
    integration.ts   # Full integration test (32 assertions)
  plan/
    FEATURES.md      # Feature tracking and roadmap
```

This is an **npm workspaces monorepo**. All packages are in `packages/*`.

## Tech Stack

- **Language:** TypeScript (strict mode, ES2022 target, Node16 module resolution)
- **Runtime:** Node.js 20+ (ESM only, `"type": "module"` everywhere)
- **HTTP:** Native `node:http` — no Express, no Fastify
- **Database:** SQLite via `better-sqlite3` (default), adapter pattern for Postgres/MySQL
- **Templates:** Twig via `twig` npm package (optional)
- **Dev tooling:** `tsx` for runtime TS execution, `esbuild` for builds
- **Testing:** Custom integration test with `tsx test/integration.ts`

## Key Commands

```bash
npm install          # Install all workspace dependencies
npm test             # Run integration tests (32 assertions, expects all green)
npm run build        # Build all packages to dist/
npm run clean        # Remove all dist/ directories
```

## How to Run Locally

```bash
npx tsx packages/cli/src/bin.ts serve   # Start server from monorepo root
npx tsx packages/cli/src/bin.ts --help  # CLI help
```

Or create a test project:
```bash
npx tsx packages/cli/src/bin.ts init my-test
```

## Package Details

### @tina4/core (`packages/core/`)
The HTTP foundation. Handles request/response lifecycle, route matching, middleware.

**Key files:**
- `server.ts` — Server startup, integrates ORM + Swagger + Twig on boot
- `router.ts` — Pattern matching with `[id]` dynamic params and `[...slug]` catch-all
- `routeDiscovery.ts` — Scans `src/routes/` recursively, maps files to endpoints
- `request.ts` — Wraps `IncomingMessage`, adds `.params`, `.query`, `.body`
- `response.ts` — Wraps `ServerResponse`, adds `.json()`, `.html()`, `.status()`, `.send()`, `.redirect()`
- `middleware.ts` — Chain runner, built-in CORS and request logger
- `static.ts` — Serves files from `public/` with MIME type detection
- `watcher.ts` — `fs.watch` for hot-reload in dev mode
- `types.ts` — All shared type definitions (`Tina4Request`, `Tina4Response`, `RouteHandler`, etc.)

### @tina4/orm (`packages/orm/`)
Database layer with auto-CRUD generation.

**Key files:**
- `database.ts` — Adapter manager, `initDatabase()` factory
- `adapters/sqlite.ts` — `better-sqlite3` implementation of `DatabaseAdapter` interface
- `model.ts` — Discovers models from `src/models/`, reads `static tableName` and `static fields`
- `migration.ts` — Schema sync on startup (creates tables, adds columns, warns on destructive changes)
- `autoCrud.ts` — Generates GET/POST/PUT/DELETE route handlers for each model
- `query.ts` — Builds SQL from `?filter[field]=value`, `?sort=-name`, `?page=2&limit=10`
- `validation.ts` — Validates request bodies against model field definitions
- `types.ts` — `FieldDefinition`, `ModelDefinition`, `DatabaseAdapter`, `QueryOptions`

### @tina4/swagger (`packages/swagger/`)
Auto-generates OpenAPI 3.0 docs.

**Key files:**
- `generator.ts` — Produces OpenAPI spec from route table + model definitions
- `ui.ts` — Serves Swagger UI HTML (CDN-based) at `/swagger` and spec at `/swagger/openapi.json`

### @tina4/twig (`packages/twig/`)
Optional server-side template rendering.

**Key files:**
- `engine.ts` — Wraps the `twig` npm package, `renderTemplate(path, data)`
- `middleware.ts` — Adds `res.render(template, data)` to response objects

### tina4 CLI (`packages/cli/`)
Developer-facing CLI commands.

**Key files:**
- `bin.ts` — Entry point, command dispatch (`init`, `serve`, `--help`)
- `commands/init.ts` — Scaffolds a new project directory with sample files
- `commands/serve.ts` — Starts dev server with hot-reload via `@tina4/core`

## Conventions You Must Follow

### Route Files
- Located in `src/routes/`
- Filename = HTTP method: `get.ts`, `post.ts`, `put.ts`, `delete.ts`, `patch.ts`
- Directory path = URL path: `src/routes/api/users/[id]/get.ts` → `GET /api/users/:id`
- Dynamic params use bracket notation: `[id]`, `[...slug]`
- **Must export** a default async function:
  ```typescript
  export default async function (req: Tina4Request, res: Tina4Response) {}
  ```
- **Optionally export** a `meta` object for Swagger:
  ```typescript
  export const meta = { summary: "...", tags: ["..."] };
  ```

### Model Files
- Located in `src/models/`
- Export a default class with `static tableName` and `static fields`:
  ```typescript
  export default class User {
    static tableName = "users";
    static fields = {
      id:   { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const,  required: true },
    };
  }
  ```
- Field types: `"string"`, `"text"`, `"integer"`, `"number"`, `"boolean"`, `"datetime"`
- Field options: `primaryKey`, `autoIncrement`, `required`, `default`, `minLength`, `maxLength`, `min`, `max`, `pattern`
- Table name should be lowercase plural (e.g., `"users"`, `"products"`)

### File-based routes override auto-CRUD
If both a file route and an auto-CRUD route match, the file route wins.

### All packages use barrel exports
Every package has an `index.ts` that re-exports the public API. Import from the package, not from internal paths.

### ESM everywhere
All code is ESM. Use `.js` extensions in import paths (TypeScript convention for Node16 module resolution):
```typescript
import { Router } from "./router.js";  // .js even though the file is .ts
```

## Architecture Decisions

1. **Native `node:http`** — No framework dependency. Zero overhead.
2. **`tsx` for dev** — No build step needed during development. TypeScript runs directly.
3. **Convention-based models** — `static fields = {}` over decorators. No special TypeScript config needed.
4. **CDN for Swagger UI** — Keeps install under 8MB. Single HTML file loads from unpkg.com.
5. **Process restart for hot-reload** — Simpler and more reliable than HMR with ESM.
6. **SQLite default** — `better-sqlite3` is synchronous and fast. Adapter pattern for async databases.
7. **CLI named `tina4nodejs`** (primary) with `tina4` as alias — So `npx tina4nodejs init` or `npx tina4 init` both work.

## Testing

Run tests with:
```bash
npm test
```

This executes `test/integration.ts` which:
1. Creates a temporary project at `/tmp/tina4-integration-test`
2. Writes route files, model files, templates, and static files
3. Starts a real HTTP server on port 3399
4. Runs 32 assertions covering all features
5. Cleans up and exits with code 0 (pass) or 1 (fail)

**Always run tests after making changes.** All 32 must pass.

When adding new features, add assertions to `test/integration.ts`.

## Common Tasks

### Adding a new feature to @tina4/core
1. Create the file in `packages/core/src/`
2. Export it from `packages/core/src/index.ts`
3. If it needs integration with server startup, add it to `server.ts`
4. Add test assertions to `test/integration.ts`

### Adding a new database adapter
1. Create `packages/orm/src/adapters/<name>.ts` implementing `DatabaseAdapter`
2. Add the case to `initDatabase()` in `packages/orm/src/database.ts`
3. Add the dependency to `packages/orm/package.json`

### Adding a new CLI command
1. Create `packages/cli/src/commands/<name>.ts`
2. Add the case to the switch in `packages/cli/src/bin.ts`

### Adding a new model field type
1. Update `FieldType` in `packages/orm/src/types.ts`
2. Update `fieldTypeToSQLite()` in `packages/orm/src/adapters/sqlite.ts`
3. Update `fieldToSchemaProperty()` in `packages/swagger/src/generator.ts`
4. Update validation in `packages/orm/src/validation.ts`

## Roadmap (Not Yet Implemented)

- Bun runtime compatibility
- GraphQL engine
- WebSocket support
- Session management
- JWT authentication
- Queue system
- Localization (i18n)
- PostgreSQL and MySQL adapter implementations (stubs exist)

## Don'ts

- **Don't add Express, Fastify, or any HTTP framework** — we use native `node:http`
- **Don't use decorators** — convention-based models with static properties
- **Don't add CommonJS** — everything is ESM (`"type": "module"`)
- **Don't bundle `swagger-ui-dist`** — we load Swagger UI from CDN to stay under 8MB
- **Don't break the 32 integration tests** — run `npm test` before committing
- **Don't add unnecessary dependencies** — minimal footprint is a core principle
- **Don't use `url.parse()`** — use the WHATWG `URL` constructor instead (deprecated in Node 20+)

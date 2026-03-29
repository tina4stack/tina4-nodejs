# CLAUDE.md — AI Developer Guide for tina4-nodejs (v3.10.21)

> This file helps AI assistants (Claude, Copilot, Cursor, etc.) understand and work on this codebase effectively.

## What This Project Is

Tina4 for Node.js/TypeScript v3.10.21 — a convention-over-configuration structural paradigm. **Not a framework.** The developer writes TypeScript; Tina4 is invisible infrastructure.

The philosophy: zero ceremony, batteries included, file system as source of truth.

## Repository Layout

```
tina4-nodejs/
  packages/
    cli/        # tina4nodejs CLI (npx tina4nodejs init, npx tina4nodejs serve)
    core/       # HTTP server, router, route discovery, middleware, events, AI, testing
      src/
        ai.ts            # AI coding tool detection and context scaffolding
        auth.ts          # Authentication helpers
        cache.ts         # In-memory caching
        constants.ts     # HTTP status codes and content type constants
        devAdmin.ts      # Dev toolbar + admin dashboard (replaces floating button)
        devMailbox.ts    # Dev mailbox for local email testing
        dotenv.ts        # .env file loading
        errorOverlay.ts  # Rich debug error overlay (Catppuccin Mocha theme)
        events.ts        # Observer-pattern event system
        fakeData.ts      # Core fake data generator (PRNG-based, zero deps)
        graphql.ts       # GraphQL engine
        health.ts        # Health check endpoint
        htmlElement.ts   # Programmatic HTML element builder
        i18n.ts          # Internationalization / localization
        logger.ts        # Structured logging
        messenger.ts     # Messaging system
        queue.ts         # Queue system
        rateLimiter.ts   # Rate limiting middleware
        scss.ts          # SCSS compilation
        service.ts       # Service layer helpers
        session.ts       # Session management
        testing.ts       # Inline testing framework (attach tests to functions)
        websocket.ts     # WebSocket support (with backplane)
        wsdl.ts          # WSDL / SOAP support
    orm/        # Database adapters, models, auto-CRUD, query builder, seeding
      src/
        adapters/
          sqlite.ts        # SQLite via node:sqlite (default)
          postgres.ts      # PostgreSQL adapter
          mysql.ts         # MySQL adapter
          mssql.ts         # MSSQL / SQL Server adapter
          firebird.ts      # Firebird adapter
        baseModel.ts     # Base model class
        fakeData.ts      # ORM-aware fake data (extends core, field-type heuristics)
        seeder.ts        # Database seeding (seedTable, seedOrm)
        sqlTranslation.ts # Cross-engine SQL translator + query cache
    swagger/    # OpenAPI spec generator, Swagger UI
    twig/       # Optional Twig template engine
  test/
    run-all.ts       # Test runner — executes all 43 test files
    integration.ts   # Full integration test
    *.test.ts        # 42 individual test files covering all subsystems
  plan/
    FEATURES.md      # Feature tracking and roadmap
```

This is an **npm workspaces monorepo**. All packages are in `packages/*`.

## Tech Stack

- **Language:** TypeScript (strict mode, ES2022 target, Node16 module resolution)
- **Runtime:** Node.js 20+ (ESM only, `"type": "module"` everywhere)
- **HTTP:** Native `node:http` — no Express, no Fastify
- **Database:** SQLite via `node:sqlite` (default), with adapters for Postgres, MySQL, MSSQL/SQL Server, and Firebird
- **Templates:** Twig via `twig` npm package (optional)
- **Dev tooling:** `tsx` for runtime TS execution, `esbuild` for builds
- **Testing:** 43 test files via `tsx test/run-all.ts`

## Key Commands

```bash
npm install          # Install all workspace dependencies
npm test             # Run all 43 test files via test/run-all.ts
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
The HTTP foundation. Handles request/response lifecycle, route matching, middleware, events, AI context, error overlays, HTML building, and inline testing.

**Key files:**
- `server.ts` — Server startup, integrates ORM + Swagger + Twig on boot
- `router.ts` — Pattern matching with `{id}` dynamic params and `{...slug}` catch-all
- `routeDiscovery.ts` — Scans `src/routes/` recursively, maps files to endpoints (converts `[id]` dirs to `{id}` URL patterns)
- `request.ts` — Wraps `IncomingMessage`, adds `.params`, `.query`, `.body`
- `response.ts` — Wraps `ServerResponse`, adds `.json()`, `.html()`, `.status()`, `.send()`, `.redirect()`
- `middleware.ts` — Chain runner, built-in CORS and request logger
- `static.ts` — Serves files from `public/` with MIME type detection
- `watcher.ts` — `fs.watch` for hot-reload in dev mode
- `types.ts` — All shared type definitions (`Tina4Request`, `Tina4Response`, `RouteHandler`, etc.)
- `events.ts` — Observer-pattern event system (`Events.on`, `emit`, `once`, `off`, `clear`)
- `ai.ts` — AI coding tool detection and context scaffolding (`detectAi`, `installAiContext`, `aiStatusReport`)
- `errorOverlay.ts` — Rich debug error page for dev mode (`renderErrorOverlay`, `renderProductionError`, `isDebugMode`)
- `htmlElement.ts` — Programmatic HTML builder (`HtmlElement`, `htmlElement`, `addHtmlHelpers`)
- `testing.ts` — Inline testing framework (`tests`, `assertEqual`, `assertThrows`, `runAllTests`)
- `fakeData.ts` — Core fake data generator (names, emails, addresses, UUIDs, etc.)
- `constants.ts` — HTTP status codes (`HTTP_OK`, `HTTP_NOT_FOUND`, etc.) and content types (`APPLICATION_JSON`, `TEXT_HTML`, etc.)
- `devAdmin.ts` — Dev toolbar (fixed bottom bar injected into HTML pages) and admin dashboard at `/_dev/`
- `auth.ts` — Authentication helpers
- `cache.ts` — In-memory caching
- `session.ts` — Session management with pluggable handlers. `TINA4_SESSION_SAMESITE` env var (default: Lax)
- `websocket.ts` — WebSocket support with backplane for scaling via Redis pub/sub (`TINA4_WS_BACKPLANE`, `TINA4_WS_BACKPLANE_URL`)
- `queue.ts` — Queue system with pluggable backends
- `graphql.ts` — GraphQL engine
- `i18n.ts` — Internationalization / localization
- `logger.ts` — Structured logging
- `rateLimiter.ts` — Rate limiting middleware
- `dotenv.ts` — `.env` file loading
- `health.ts` — Health check endpoint
- `scss.ts` — SCSS compilation
- `messenger.ts` — Messaging system
- `service.ts` — Service layer helpers
- `wsdl.ts` — WSDL / SOAP support

### @tina4/orm (`packages/orm/`)
Database layer with auto-CRUD generation, seeding, fake data, and SQL translation.

**Key files:**
- `database.ts` — Adapter manager, `initDatabase()` factory
- `adapters/sqlite.ts` — `node:sqlite` implementation of `DatabaseAdapter` interface
- `adapters/postgres.ts` — PostgreSQL adapter
- `adapters/mysql.ts` — MySQL adapter
- `adapters/mssql.ts` — MSSQL / SQL Server adapter (`mssql` or `sqlserver` scheme)
- `adapters/firebird.ts` — Firebird adapter
- `model.ts` — Discovers models from `src/models/`, reads `static tableName` and `static fields`
- `migration.ts` — Schema sync on startup (creates tables, adds columns, warns on destructive changes)
- `autoCrud.ts` — Generates GET/POST/PUT/DELETE route handlers for each model
- `query.ts` — Builds SQL from `?filter[field]=value`, `?sort=-name`, `?page=2&limit=10`
- `validation.ts` — Validates request bodies against model field definitions
- `types.ts` — `FieldDefinition`, `ModelDefinition`, `DatabaseAdapter`, `QueryOptions`
- `fakeData.ts` — ORM-aware fake data extending core (adds `forField()` with column-name heuristics)
- `seeder.ts` — Database seeding (`seedTable` for raw SQL, `seedOrm` for model-based)
- `sqlTranslation.ts` — Cross-engine SQL translator (`SQLTranslator`) and TTL query cache (`QueryCache`)
- QueryBuilder supports `toMongo()` for generating MongoDB query documents from the same fluent API
- `getNextId(table: string, pkColumn?: string, generatorName?: string): Promise<number>` — Race-safe ID generation using atomic sequence table (`tina4_sequences`). SQLite/MySQL/MSSQL use `tina4_sequences` with atomic UPDATE+SELECT. PostgreSQL auto-creates sequences if missing. Firebird uses existing generators (unchanged).

**`tina4_sequences` table** — Auto-created by `getNextId()` on first use for SQLite, MySQL, and MSSQL. Stores the current sequence value per table. Do not modify this table manually.

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
- `commands/init.ts` — Scaffolds a new project directory with sample files, Dockerfile, and .dockerignore
- `commands/serve.ts` — Starts dev server with hot-reload via `@tina4/core`

## Module: Events (`packages/core/src/events.ts`)

Observer-pattern event system for decoupled communication. All methods are static on the `Events` class. Listeners run synchronously in priority order (higher priority first). One-time listeners auto-remove after firing.

```typescript
import { Events } from "@tina4/core";

// Register a listener (optional priority — higher runs first)
Events.on("user.created", (user) => {
  console.log(`Welcome ${(user as any).name}!`);
}, 10);

// One-time listener (auto-removes after first fire)
Events.once("app.ready", () => console.log("App started!"));

// Emit an event — returns array of listener results
const results = Events.emit("user.created", { name: "Alice" });

// Remove a specific listener or all listeners for an event
Events.off("user.created", specificHandler);
Events.off("user.created");  // removes all

// Introspection
Events.listeners("user.created");  // callback[]
Events.events();                   // all registered event names

// Clear everything
Events.clear();
```

## Module: AI (`packages/core/src/ai.ts`)

Detects AI coding tools (Claude Code, Cursor, Copilot, Windsurf, Aider, Cline, Codex) by checking for their config files/directories. Can scaffold a universal Tina4 context document into each tool's expected location.

```typescript
import { detectAi, installAiContext, aiStatusReport } from "@tina4/core";

// Detect which AI tools are present in a project directory
const tools = detectAi(".");
// → [{ name: "claude-code", description: "Claude Code (Anthropic CLI)",
//       configFile: "CLAUDE.md", status: "detected" }, ...]

// Install context files for all detected tools (creates CLAUDE.md, .cursorules, etc.)
const created = installAiContext(".", { force: false });
// → ["CLAUDE.md", ".cursorules"]

// Install for ALL known tools, not just detected ones
import { installAllAiContext } from "@tina4/core";
installAllAiContext(".", true);  // force overwrite

// Print a human-readable status report
console.log(aiStatusReport("."));
```

## Module: Error Overlay (`packages/core/src/errorOverlay.ts`)

Rich HTML error page for development mode. Uses Catppuccin Mocha colour palette, shows syntax-highlighted source context around the error line, stack trace with source preview, request details, and environment info. Controlled by `TINA4_DEBUG` env var.

```typescript
import { renderErrorOverlay, renderProductionError, isDebugMode } from "@tina4/core";

// In a route error handler:
try {
  await handler(req, res);
} catch (err) {
  const html = isDebugMode()
    ? renderErrorOverlay(err as Error, req)   // full debug overlay
    : renderProductionError(500, "Internal Server Error");  // safe production page
  res.html(html, 500);
}

// isDebugMode() returns true when TINA4_DEBUG is "true"
```

## Module: HtmlElement (`packages/core/src/htmlElement.ts`)

Programmatic HTML builder that avoids string concatenation. Three usage patterns: direct construction, builder-pattern functions, and helper injection.

```typescript
import { HtmlElement, htmlElement, addHtmlHelpers } from "@tina4/core";

// Direct construction
const el = new HtmlElement("div", { class: "card" }, ["Hello"]);
el.toString();  // '<div class="card">Hello</div>'

// Builder pattern — returns a callable that accepts attrs/children
const div = htmlElement("div");
const card = div({ class: "card" }, "Hello");
card.toString();  // '<div class="card">Hello</div>'

// Nesting
const page = htmlElement("div")(
  htmlElement("h1")("Title"),
  htmlElement("p")("Body text"),
);

// Helper injection — adds _div, _p, _a, _span, etc. to an object
const h: Record<string, any> = {};
addHtmlHelpers(h);
const html = h._div({ class: "card" },
  h._h1("Title"),
  h._p({ class: "body" }, "Content"),
  h._img({ src: "/logo.png", alt: "Logo" }),  // void tags self-close
);
html.toString();
```

Void tags (`br`, `hr`, `img`, `input`, `meta`, etc.) render without closing tags. Boolean attributes render as bare names (`disabled` not `disabled="true"`).

## Module: Inline Testing (`packages/core/src/testing.ts`)

Attach test assertions directly to functions. Tests are registered globally and run with `runAllTests()`. No external test runner needed.

```typescript
import { tests, assertEqual, assertThrows, assertTrue, assertFalse, runAllTests, resetTests } from "@tina4/core";

// Decorate a function with inline tests
const add = tests(
  assertEqual([5, 3], 8),        // add(5, 3) === 8
  assertEqual([0, 0], 0),        // add(0, 0) === 0
  assertThrows(Error, [null]),   // add(null) throws Error
)(function add(a: number, b: number | null = null): number {
  if (b === null) throw new Error("b required");
  return a + b;
});

// The original function works normally
add(2, 3);  // 5

// Run all registered tests
const results = runAllTests({ quiet: false, failfast: false });
// → { passed: 3, failed: 0, errors: 0, details: [...] }

// Additional assertion types
assertTrue([someArgs]);   // result is truthy
assertFalse([someArgs]);  // result is falsy

// Reset registry between test runs
resetTests();
```

## Module: Seeder / FakeData (`packages/orm/src/seeder.ts`, `packages/orm/src/fakeData.ts`)

Database seeding with fake data generation. The ORM `FakeData` extends core `FakeData` (which provides names, emails, addresses, etc.) and adds `forField()` for auto-generating values based on ORM field definitions with column-name heuristics.

```typescript
import { FakeData, seedTable, seedOrm } from "@tina4/orm";

// FakeData — deterministic with optional seed
const fake = new FakeData(42);
fake.name();        // fullName alias
fake.email();       // realistic email
fake.phone();       // phone number
fake.integer(1, 100);
fake.numeric(0, 1000, 2);  // float alias
fake.datetime(2020, 2025); // Date object
fake.boolean();
fake.uuid();
fake.address();
fake.company();
fake.sentence(5);
fake.paragraph(3);

// forField() — auto-generates based on FieldDefinition + column name heuristics
fake.forField({ type: "string", maxLength: 50 }, "email");   // generates email
fake.forField({ type: "integer", min: 0, max: 100 });        // random integer
fake.forField({ type: "boolean" });                           // true/false

// seedTable — raw SQL inserts with generator functions
await seedTable(db, "users", 50, {
  name: () => fake.name(),
  email: () => fake.email(),
  role: "user",  // static values also accepted
}, { active: true });  // overrides applied to every row

// seedOrm — auto-seed from model field definitions
import User from "./src/models/User.js";
await seedOrm(User, 100, { role: "user" }, 42);  // optional seed for determinism
```

Column-name heuristics in `forField()`: columns named `email`, `phone`, `name`, `address`, `city`, `country`, `company`, `url`, `uuid`, `ip`, `currency`, etc. get contextually appropriate fake data.

## Module: SQL Translation (`packages/orm/src/sqlTranslation.ts`)

Cross-engine SQL dialect translator and in-memory query cache. All translator methods are static on `SQLTranslator`. The `QueryCache` provides TTL-based caching with LRU eviction.

```typescript
import { SQLTranslator, QueryCache } from "@tina4/orm";

// Firebird: LIMIT/OFFSET → ROWS X TO Y
SQLTranslator.limitToRows("SELECT * FROM users LIMIT 10 OFFSET 5");
// → "SELECT * FROM users ROWS 6 TO 15"

// MSSQL: LIMIT → TOP N
SQLTranslator.limitToTop("SELECT * FROM users LIMIT 10");
// → "SELECT TOP 10 * FROM users"

// MySQL/MSSQL: || concatenation → CONCAT()
SQLTranslator.concatPipesToFunc("first_name || ' ' || last_name");
// → "CONCAT(first_name, ' ', last_name)"

// Boolean to integer (Firebird)
SQLTranslator.booleanToInt("WHERE active = TRUE");
// → "WHERE active = 1"

// ILIKE → LOWER() LIKE LOWER()
SQLTranslator.ilikeToLike("WHERE name ILIKE '%alice%'");
// → "WHERE LOWER(name) LIKE LOWER('%alice%')"

// Auto-increment DDL translation
SQLTranslator.autoIncrementSyntax(ddl, "postgresql");  // AUTOINCREMENT → SERIAL PRIMARY KEY
SQLTranslator.autoIncrementSyntax(ddl, "mysql");       // → AUTO_INCREMENT
SQLTranslator.autoIncrementSyntax(ddl, "mssql");       // → IDENTITY(1,1)

// Placeholder style conversion
SQLTranslator.placeholderStyle("SELECT * FROM t WHERE id = ?", ":"); // → :1
SQLTranslator.placeholderStyle("SELECT * FROM t WHERE id = ?", "%s"); // → %s

// RETURNING clause parsing
SQLTranslator.parseReturning("INSERT INTO t (x) VALUES (1) RETURNING id, name");
// → { sql: "INSERT INTO t (x) VALUES (1)", columns: ["id", "name"] }

// QueryCache — TTL-based in-memory cache
const cache = new QueryCache({ defaultTtl: 60, maxSize: 1000 });

const key = QueryCache.queryKey("SELECT * FROM users WHERE id = ?", [42]);
cache.set(key, [{ id: 42, name: "Alice" }], 30);  // TTL 30 seconds
cache.get(key);   // → [{ id: 42, name: "Alice" }] or undefined if expired
cache.has(key);   // true/false
cache.delete(key);
cache.sweep();    // remove all expired entries
cache.clear();    // remove everything

// Get-or-set pattern
const rows = cache.remember(key, 60, () => db.execute(sql, params));
```

## Conventions You Must Follow

### Route Files
- Located in `src/routes/`
- Filename = HTTP method: `get.ts`, `post.ts`, `put.ts`, `delete.ts`, `patch.ts`
- Directory path = URL path: `src/routes/api/users/[id]/get.ts` → `GET /api/users/{id}`
- Dynamic params use bracket notation in filenames: `[id]`, `[...slug]` (converted to `{id}`, `{...slug}` in URL patterns)
- **Must export** a default async function:
  ```typescript
  export default async function (req: Tina4Request, res: Tina4Response) {}
  ```
- **Optionally export** a `meta` object for Swagger:
  ```typescript
  export const meta = { summary: "...", tags: ["..."] };
  ```
- **Optionally export** a `template` string to render a Twig template:
  ```typescript
  export const template = "page.twig";  // renders src/templates/page.twig
  ```
  The route handler provides data; the template renders the HTML. Use `res.template("name.twig", data)` for programmatic template rendering.

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
6. **SQLite default** — `node:sqlite` is synchronous and fast. Full adapters for Postgres, MySQL, MSSQL/SQL Server, and Firebird.
7. **CLI named `tina4nodejs`** (primary) with `tina4` as alias — So `npx tina4nodejs init` or `npx tina4 init` both work.
8. **Event system** — Static `Events` class, synchronous dispatch, priority ordering, zero deps.
9. **Inline testing** — Tests as decorators on functions, no external test runner for unit-level checks.
10. **SQL translation** — Dialect differences handled at runtime via `SQLTranslator` static methods, not at query-build time.
11. **Error overlay** — Dev-only rich HTML error page, controlled by `TINA4_DEBUG` env var.
12. **AI context scaffolding** — Auto-detect and install context files for all major AI coding tools.
13. **Dev toolbar** — Fixed bottom bar injected into HTML pages in dev mode, showing route info, request ID, version. Admin dashboard at `/_dev/`.
14. **Default port 7148** — Config priority: explicit config > `PORT` env var > 7148. Default host: `0.0.0.0`.

## Database Configuration

### Connection string format
Set `DATABASE_URL` in your `.env` file using `driver://host:port/database` format:

```bash
# SQLite (default if nothing configured)
DATABASE_URL=sqlite:///path/to/db.sqlite
DATABASE_URL=sqlite://./data/tina4.db

# PostgreSQL
DATABASE_URL=postgres://localhost:5432/mydb
DATABASE_URL=postgresql://localhost:5432/mydb

# MySQL
DATABASE_URL=mysql://localhost:3306/mydb

# MSSQL / SQL Server (both schemes work)
DATABASE_URL=mssql://localhost:1433/mydb
DATABASE_URL=sqlserver://localhost:1433/mydb

# Firebird
DATABASE_URL=firebird://localhost:3050/mydb
```

### Credentials
Credentials can be embedded in the URL or provided separately:

```bash
# In the URL
DATABASE_URL=postgres://user:pass@localhost:5432/mydb

# Or as separate env vars (merged when URL has no credentials)
DATABASE_URL=postgres://localhost:5432/mydb
DATABASE_USERNAME=myuser
DATABASE_PASSWORD=mypass
```

Credential priority: `config.user` > `config.username` > `DATABASE_USERNAME` env var.

### Programmatic configuration
```typescript
import { initDatabase } from "@tina4/orm";

await initDatabase({ url: "postgres://localhost:5432/mydb" });
// or
await initDatabase({ type: "postgres", host: "localhost", port: 5432, database: "mydb", username: "user", password: "pass" });
```

### Available adapters
| Adapter | Scheme(s) | Package |
|---------|-----------|---------|
| SQLite | `sqlite://` | `node:sqlite` |
| PostgreSQL | `postgres://`, `postgresql://` | `pg` |
| MySQL | `mysql://` | `mysql2` |
| MSSQL | `mssql://`, `sqlserver://` | `tedious` |
| Firebird | `firebird://` | `node-firebird` |

## Testing

Run tests with:
```bash
npm test
```

This executes `test/run-all.ts` which runs all 43 test files:
- `test/integration.ts` — Full integration test (creates a temp project, starts a real server, runs assertions)
- `test/*.test.ts` — 42 individual test files covering all subsystems (ORM, routing, middleware, database drivers, sessions, queues, WebSocket, GraphQL, i18n, etc.)

**Always run tests after making changes.** All tests must pass.

When adding new features, add a corresponding `test/<feature>.test.ts` file.

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

## v3 Features Summary

- **38 built-in features**, zero third-party dependencies
- **1,812 tests** passing across all modules
- **Race-safe `getNextId()`** with atomic sequence table (`tina4_sequences`) for SQLite/MySQL/MSSQL; PostgreSQL auto-creates sequences
- **Frond template engine optimizations**: pre-compiled regexes, lazy loop context (copy-on-write), filter chain caching, path split caching, inline common filters (11-15% speedup)
- **Production server auto-detect**: `npx tina4nodejs serve --production` auto-uses cluster mode
- **`npx tina4nodejs generate`**: model, route, migration, middleware scaffolding
- **Database**: 5 engines (SQLite, PostgreSQL, MySQL, MSSQL, Firebird), query caching (`TINA4_DB_CACHE=true`)
- **Sessions**: file backend (default). `TINA4_SESSION_SAMESITE` env var (default: Lax)
- **Queue**: file/RabbitMQ/Kafka/MongoDB backends, configured via env vars
- **Cache**: memory/Redis/file backends
- **Messenger**: .env driven SMTP/IMAP
- **ORM relationships**: `hasMany`, `hasOne`, `belongsTo` with eager loading (`include`)
- **Frond pre-compilation**: 2.8x template render improvement
- **QueryBuilder** with NoSQL/MongoDB support (`toMongo()`)
- **WebSocket backplane** (Redis pub/sub) for horizontal scaling
- **SameSite=Lax** default on session cookies (`TINA4_SESSION_SAMESITE`)
- **`tina4 init`** generates Dockerfile and .dockerignore
- **Gallery**: 7 interactive examples with Try It deploy at `/_dev/`

## Don'ts

- **Don't add Express, Fastify, or any HTTP framework** — we use native `node:http`
- **Don't use decorators** — convention-based models with static properties
- **Don't add CommonJS** — everything is ESM (`"type": "module"`)
- **Don't bundle `swagger-ui-dist`** — we load Swagger UI from CDN to stay under 8MB
- **Don't break the test files** — run `npm test` before committing
- **Don't add unnecessary dependencies** — minimal footprint is a core principle
- **Parity across all frameworks** — Every new feature, fix, or optimization must be implemented with equivalent logic AND tests in all 4 Tina4 frameworks (Python, PHP, Ruby, Node.js). Never ship to one without shipping to all.
- **Don't use `url.parse()`** — use the WHATWG `URL` constructor instead (deprecated in Node 20+)

## Tina4 Maintainer Skill
Always read and follow the instructions in .claude/skills/tina4-maintainer/SKILL.md when working on this codebase. Read its referenced files in .claude/skills/tina4-maintainer/references/ as needed for specific subsystems.

## Tina4 Developer Skill
Always read and follow the instructions in .claude/skills/tina4-developer/SKILL.md when building applications with this framework. Read its referenced files in .claude/skills/tina4-developer/references/ as needed.

## Tina4-js Frontend Skill
Always read and follow the instructions in .claude/skills/tina4-js/SKILL.md when working with tina4-js frontend code. Read its referenced files in .claude/skills/tina4-js/references/ as needed.

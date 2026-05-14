# CLAUDE.md — AI Developer Guide for tina4-nodejs (v3.12.10)

> This file helps AI assistants (Claude, Copilot, Cursor, etc.) understand and work on this codebase effectively.

## What This Project Is

Tina4 for Node.js/TypeScript v3.12.10 — The Intelligent Native Application 4ramework. A convention-over-configuration structural paradigm. The developer writes TypeScript; Tina4 is invisible infrastructure.

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
- `websocket.ts` — WebSocket support with backplane for scaling via Redis pub/sub (`TINA4_WS_BACKPLANE`, `TINA4_WS_BACKPLANE_URL`). Rooms API: `wss.joinRoom(clientId, room)`, `wss.leaveRoom(clientId, room)`, `wss.broadcastToRoom(room, msg, excludeIds?)`, `wss.getRoomConnections(room)`, `wss.roomCount(room)`, `wss.getClientRooms(clientId)`
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
- **Instance methods:** `save(): this|null` (fluent, null on failure), `delete()`, `forceDelete()`, `restore()`, `load(sql, params?, include?): boolean`, `validate(): string[]`, `toDict(include?)`, `toAssoc(include?)`, `toObject()`, `toArray(): unknown[]`, `toList()`, `toJson(include?)`, `hasOne(class, fk)`, `hasMany(class, fk, limit?, offset?)`, `belongsTo(class, fk)`
- **Static methods:** `find(id, include?)`, `findById(id, include?)`, `findOrFail(id)`, `create(data)`, `all(where?, params?, include?)`, `select(sql, params?)`, `selectOne(sql, params?, include?)`, `where(conditions, params?, limit?, offset?, include?)`, `count(conditions?, params?)`, `withTrashed(conditions?, params?, limit?, offset?)`, `scope(name, filterSql, params?)` (registers reusable method), `createTable()`, `query()`, `_processForeignKeys()`, `_applyFkRegistry()`
- **Foreign key auto-wire:** Declare a field with `type: "foreignKey"` and `references: "ModelName"` to auto-wire both `belongsTo` on the declaring model and `hasMany` on the referenced model. Optional `relatedName` overrides the has-many key. Models must be registered via `BaseModel.registerModel(name, class)` for name-based resolution. Example: `user_id: { type: "foreignKey", references: "User" }` → `post.belongsTo(User, "user_id")` and `user.hasMany(Post, "user_id")` both resolve without extra wiring.
- QueryBuilder supports `toMongo()` for generating MongoDB query documents from the same fluent API
- `getNextId(table: string, pkColumn?: string, generatorName?: string): Promise<number>` — Race-safe ID generation using atomic sequence table (`tina4_sequences`). SQLite/MySQL/MSSQL use `tina4_sequences` with atomic UPDATE+SELECT. PostgreSQL auto-creates sequences if missing. Firebird uses existing generators (unchanged).

**`tina4_sequences` table** — Auto-created by `getNextId()` on first use for SQLite, MySQL, and MSSQL. Stores the current sequence value per table. Do not modify this table manually.

### File Uploads

Multipart file uploads via `req.files` (dict keyed by field name):

```typescript
// req.files["avatar"] =>
{
  fieldName: "avatar",
  filename: "photo.png",
  type: "image/png",
  content: Buffer,            // raw bytes — NOT base64
  size: 102400
}
```

```typescript
post("/api/upload", (req, res) => {
  const file = req.files["avatar"];
  if (!file) return res.json({ error: "No file" }, 400);
  fs.writeFileSync(`src/public/uploads/${(file as any).filename}`, (file as any).content);
  return res.json({ ok: true });
});
```

Max upload size: `TINA4_MAX_UPLOAD_SIZE` env var (default 10MB).

### Auth

```typescript
// expires_in is in MINUTES (default 60). Reads SECRET from env if not passed.
getToken(payload, secret?, expiresIn=60): string
validToken(token, secret?): Record | null
getPayload(token): Record | null
refreshToken(token, secret?, expiresIn=60): string | null
hashPassword(password, salt?, iterations=260000): string  // PBKDF2-SHA256, $ delimiter
checkPassword(password, hash): boolean  // timing-safe
validateApiKey(provided, expected?): boolean  // reads TINA4_API_KEY from env
authenticateRequest(headers, secret?): Record | null  // Bearer JWT, falls back to API key
// Also available as Auth.getToken(), Auth.validToken(), etc.
```

### Session

```typescript
session.start(sessionId?): string
session.get(key, defaultValue?): unknown
session.set(key, value): void
session.delete(key): void
session.has(key): boolean
session.all(): Record
session.clear(): void
session.destroy(): void
session.regenerate(): string
session.flash(key, value?): unknown     // Dual-mode: set with value, get+remove without
session.getFlash(key, defaultValue?): unknown
session.save(): void                    // Public — persist to backend
session.cookieHeader(name?): string     // Set-Cookie header value
session.getSessionId(): string | null
session.gc(): void
```

Backends: file, redis, redis-npm, valkey, mongodb, database.

### Database extras

```typescript
db.execute(sql, params?): boolean | unknown  // bool for writes, result for RETURNING/CALL/EXEC
db.getLastId(): string | number
db.getError(): string | null
db.cacheStats(): { enabled, size, ttl }
```

### Request extras

```typescript
req.files: Record<string, UploadedFile>  // dict keyed by field name (not array)
req.cookies: Record<string, string>       // parsed from Cookie header
req.contentType: string                   // from content-type header
req.query: Record<string, string>         // query string params
response.xml(content, status?): Tina4Response
response.stream(generator, contentType?: string, status?: number): void  // SSE/streaming
```

### Queue

```typescript
queue.consume(topic?, id?, pollInterval=1000): AsyncGenerator<QueueJob>
// Long-running async generator. Sleeps when empty. pollInterval=0 for single-pass.
// Usage: for await (const job of queue.consume("emails")) { ... }
```

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

## Module: Router (`packages/core/src/router.ts`)

Programmatic route registration. The convention is file-based discovery in `src/routes/`, but a `Router` class and module-level `get`/`post`/etc. helpers are also exported for libraries, plugins, and tests.

```typescript
import { Router, defaultRouter, get, post, put, patch, del, any } from "@tina4/core";
import type { Tina4Request, Tina4Response } from "@tina4/core";

// Module-level helpers register on the default global router
get("/api/users", async (req, res) => res.json([]));
post("/api/users", async (req, res) => res.json({ ok: true }));
put("/api/users/{id}", handler);
patch("/api/users/{id}", handler);
del("/api/users/{id}", handler);   // "del" — "delete" is a reserved word
any("/api/webhook", handler);      // matches all HTTP methods

// Wildcard routes: catch-all segment
get("/api/files/{...path}", async (req, res) => {
  const path = req.params["path"];   // "a/b/c.txt"
  return res.send(path);
});

// Fluent route refs — chain auth, cache, middleware
get("/api/data", handler).secure().cache(60);

// Dedicated Router instance (e.g. for sub-apps or testing)
const r = new Router();
r.get("/ping", async (_req, res) => res.json({ pong: true }));
r.group("/api/v1", (g) => {
  g.get("/users", listUsers);
  g.post("/users", createUser);
});
```

**Path patterns:** `{id}` for dynamic params, `{...slug}` for catch-all. Read params via `req.params["id"]`.

## Module: Database (`packages/orm/src/database.ts`)

Full Database API. The same instance covers all five drivers (sqlite, postgres, mysql, mssql, firebird) — pick the driver via `DATABASE_URL` or pass a `DatabaseConfig` to `initDatabase()`.

```typescript
import { initDatabase, Database, DatabaseResult } from "@tina4/orm";

const db = await initDatabase({ url: "sqlite:///app.db" });
// Connection pooling: pass `pool: 4` for round-robin connections.

// Reads — synchronous (node:sqlite is sync; other adapters are wrapped)
db.fetch(sql, params?, limit?, offset?): DatabaseResult           // .records, .count, .limit, .offset
db.fetchOne<T>(sql, params?): T | null

// Writes — return boolean for simple writes, result for RETURNING / CALL / EXEC / SELECT
db.execute(sql, params?): boolean | unknown
db.executeMany(sql, paramSets): unknown[]                         // wrapped in a transaction
db.insert(table, data): DatabaseWriteResult
db.update(table, data, filter?, params?): DatabaseWriteResult
db.delete(table, filter?, params?): DatabaseWriteResult

// Last-write metadata
db.getLastId(): string | number | null
db.getError(): string | null

// Transactions — autoCommit defaults to ON unless TINA4_DB_AUTOCOMMIT=false
db.startTransaction(): void
db.commit(): void
db.rollback(): void

// Schema introspection
db.tableExists(name): boolean
db.getTables(): string[]
db.getColumns(table): { name, type, nullable?, default?, primaryKey? }[]

// Race-safe sequence — uses tina4_sequences for SQLite/MySQL/MSSQL,
// auto-creates Postgres sequences, and uses native Firebird generators.
db.getNextId(table, pkColumn?, generatorName?): number

// Query cache (TINA4_DB_CACHE=true)
db.cacheStats(): { enabled, size, ttl }
db.cacheClear(): void

// Connection pool access (null when pooling disabled)
db.pool
```

**`tina4_sequences` table** — Auto-created by `getNextId()` on first use for SQLite, MySQL, and MSSQL. Stores the current sequence value per table. Do not modify this table manually.

## Module: ORM (`packages/orm/src/baseModel.ts`)

Active-Record base class. Models live in `src/models/` and are auto-discovered. Use `static fields` (not decorators) — same convention across all four frameworks.

```typescript
import { BaseModel, ormBind } from "@tina4/orm";

export default class User extends BaseModel {
  static tableName = "users";
  static fields = {
    id:        { type: "integer" as const, primaryKey: true, autoIncrement: true },
    email:     { type: "string"  as const, required: true, maxLength: 255 },
    author_id: { type: "foreignKey" as const, references: "Author" }, // auto-wires belongsTo + hasMany
  };
  static softDelete = true;   // optional — toggles is_deleted column
}

// Instance methods (chainable where it makes sense)
const user = new User({ email: "alice@example.com" });
user.save();              // returns this on success, null on failure
user.delete();            // soft-delete if enabled, otherwise hard
user.forceDelete();       // bypasses soft-delete
user.restore();           // clears soft-delete marker
user.load(sql, params?, include?): boolean
user.validate(): string[];                 // empty = valid
user.toDict(include?); user.toAssoc(include?); user.toObject();
user.toArray(): unknown[]; user.toList();
user.toJson(include?): string;
user.hasOne(RelatedClass, fk?);
user.hasMany(RelatedClass, fk?, limit?, offset?);
user.belongsTo(RelatedClass, fk?);

// Static methods — also callable as `new User().all()`
User.find(id, include?);
User.findById(id, include?);
User.findOrFail(id);                       // throws if missing
User.create(data);                         // construct + save
User.all(where?, params?, include?);
User.select(sql, params?);
User.selectOne(sql, params?, include?);
User.where(conditions, params?, limit?, offset?, include?);
User.count(conditions?, params?);
User.withTrashed(conditions?, params?, limit?, offset?);
User.scope(name, filterSql, params?);     // registers a reusable named method
User.createTable();
User.query(): QueryBuilder;
BaseModel.registerModel(name, class);     // for foreignKey name resolution

ormBind(db);   // bind a Database instance for all models in the registry
```

**Soft delete:** set `static softDelete = true`. Adds an `is_deleted` INTEGER column (0/1). `delete()` flips the flag, `forceDelete()` removes the row, `restore()` clears it.

## Module: QueryBuilder (`packages/orm/src/queryBuilder.ts`)

Fluent builder for JOINs, aggregates, and GROUP BY. Prefer over raw `db.fetch()` for any query more involved than a single table read.

```typescript
import { QueryBuilder } from "@tina4/orm";

// Standalone
const orders = QueryBuilder.fromTable("orders o")
  .select("o.*", "c.name as customer_name")
  .join("customers c", "o.customer_id = c.id")
  .where("o.status = ?", ["pending"])
  .orderBy("o.created_at DESC")
  .limit(20)
  .get();                       // → row[]

// LEFT JOIN
QueryBuilder.fromTable("products p")
  .leftJoin("categories c", "p.category_id = c.id")
  .get();

// Aggregates with HAVING
const top = QueryBuilder.fromTable("orders")
  .select("customer_id", "SUM(total) as total")
  .groupBy("customer_id")
  .having("SUM(total) > ?", [1000])
  .first();                     // → single row | null

// From an ORM model
const adults = User.query().where("age > ?", [18]).orderBy("name").get();

// Methods: fromTable, select, where, orWhere, join, leftJoin, groupBy, having,
// orderBy, limit, get, first, count, exists, toSql, toMongo
```

**NoSQL bridge:** `toMongo()` returns `{ filter, projection, sort, limit, skip }` — the same fluent state expressed as a MongoDB query document.

## Module: Migration (`packages/orm/src/migration.ts`)

SQL-file based migrations under `migrations/`. The framework runs pending migrations on startup; the helpers here are for programmatic control (CLI, scripts, tests).

```typescript
import {
  migrate, rollback, status, createMigration, syncModels,
  ensureMigrationTable, isMigrationApplied, recordMigration,
} from "@tina4/orm";

await migrate(db);                          // run all pending migrations
await rollback(db, 1);                      // roll back last N batches (default 1)
await status(db);                           // pending vs applied
await createMigration("add users table");   // scaffolds migrations/<ts>_add_users_table.sql
syncModels(discoveredModels);               // auto-create tables / add columns from `static fields`
```

Migration tracking lives in `tina4_migration` (id, name, batch, applied_at). Schema sync runs alongside SQL migrations on boot.

## Module: Frond (`packages/frond/src/engine.ts`)

Zero-dependency Twig-compatible template engine. Replaces the older `Template`. Supports variables, filters, `if`/`for`/`set`, `extends`/`block`, `include`, `macro`, comments, whitespace control, tests, fragment caching, and sandbox mode.

```typescript
import { Frond } from "@tina4/frond";

const frond = new Frond("src/templates");

frond.render("page.twig", { user, posts });           // file template
frond.renderString("Hello {{ name }}", { name: "Al" });

// Customise
frond.addFilter("upper", (v) => String(v).toUpperCase());
frond.addGlobal("siteName", "Tina4");
frond.addTest("even", (v) => Number(v) % 2 === 0);

// Sandbox — restrict capabilities for user-supplied templates
frond.sandbox(["upper"], ["if"], ["x"]);   // allowed: filters, tags, vars
frond.unsandbox();
```

- **SafeString** — filters can return `new SafeString(value)` to bypass auto-escaping.
- **Fragment caching** — `{% cache "key" 300 %}...{% endcache %}` caches block output for TTL seconds.
- **Raw blocks** — `{% raw %}...{% endraw %}` outputs literal template syntax.
- **Pre-compiled regexes** + token caching (cleared on file mtime change in dev mode) for ~2.8x render improvement over the naive path.

## Module: Api (`packages/core/src/api.ts`)

Zero-dep HTTP client over `node:http` / `node:https`. Used by integrations, queue producers, health checks, and tests.

```typescript
import { Api } from "@tina4/core";

const api = new Api("https://api.example.com", "" /* authHeader */, 30 /* timeoutSeconds */);

api.addHeaders({ "X-Trace-Id": "abc" });
api.setBearerToken(token);
api.setBasicAuth(user, pass);
api.setIgnoreSsl(true);                  // dev / self-signed certs only

const r = await api.get("/users", { active: "1" });
await api.post("/users",   { name: "Alice" });
await api.put("/users/1",  { name: "Alice" });
await api.patch("/users/1",{ active: false });
await api.delete("/users/1");
await api.sendRequest("OPTIONS", "/users");

// Result shape (all methods return the same):
//   { http_code: 200, body: <parsed JSON or string>, headers: {...}, error: null }
```

`error` is non-null on transport failure or timeout; `http_code` is `null` if the request never reached the server.

## Module: Queue (`packages/core/src/queue.ts`)

Pluggable job queue (file/RabbitMQ/Kafka/MongoDB backends). The same fluent API works against any backend — pick via env vars.

```typescript
import { Queue } from "@tina4/core";

const queue = new Queue("emails", 3 /* maxRetries */);

const id = queue.push({ to: "a@b.c", body: "hi" }, 0 /* delaySec */, 0 /* priority */);
const job = queue.pop();
queue.size("pending");
queue.purge("completed");
queue.retryFailed();
queue.deadLetters();
queue.produce("notifications", payload, 0, 0);

// Job methods
job?.complete();
job?.fail("smtp timeout");
job?.reject("permanent");
job?.retry(60);

// Long-running consumer — async generator
for await (const job of queue.consume("emails")) {
  try {
    await sendEmail(job.payload);
    job.complete();
  } catch (err) {
    job.fail(String(err));
  }
}
// pollInterval=0 for single-pass drain (tests).
```

## Module: Background Tasks (`packages/core/src/background.ts`)

Periodic callbacks that run alongside the HTTP server. Use this instead of bare `setInterval` so timers integrate with the server lifecycle and clear on graceful shutdown.

```typescript
import { background, stopAllBackgroundTasks, backgroundTaskCount } from "@tina4/core";

// Run every 2 seconds
const task = background(() => processQueue(), 2);

// Async callbacks are fine — rejections are caught and logged.
background(async () => {
  const r = await api.get("/health");
  if (r.error) Log.warn("health check failed");
}, 30);

task.stop();              // stop just this one
stopAllBackgroundTasks(); // stop everything (also runs on SIGTERM/SIGINT)
backgroundTaskCount();    // test helper
```

**Never use bare `setInterval` for periodic work in a Tina4 app.** `background()` catches errors, integrates with shutdown signals, calls `timer.unref()` so it doesn't block process exit, and matches Python's `background()` API exactly.

## Module: DI Container (`packages/core/src/container.ts`)

Lightweight dependency injection. Transient factories build a fresh instance every `get()`; singletons memoise the first build. Node.js is single-threaded, so no locking is needed.

```typescript
import { Container, container } from "@tina4/core";

// Use the default global container, or construct your own
container.register("mailer", () => new MailService());        // transient
container.singleton("db", () => initDatabase({ url }));        // singleton

const mailer = container.get<MailService>("mailer");           // new each call
const db     = container.get<Database>("db");                  // same each call

container.has("db");      // true
container.has("missing"); // false
container.reset();        // clear all registrations + cached instances
```

## Module: Response Cache (`packages/core/src/cache.ts`)

Multi-backend cache. Used as middleware to cache GET responses, or directly via `cacheGet`/`cacheSet` for arbitrary key/value caching. Backends: memory (default), redis/valkey, file.

```typescript
import {
  responseCache, cacheGet, cacheSet, cacheDelete, cacheClear, cacheStats,
} from "@tina4/core";

// Middleware on a route
get("/api/products", listProducts).middleware(responseCache({ ttl: 60 }));

// Direct key/value usage (same shape across all four frameworks)
cacheSet("user:1", { name: "Alice" }, 120);
const u = cacheGet("user:1");
cacheDelete("user:1");
cacheClear();

cacheStats();   // { hits, misses, size, backend }
```

Environment:
- `TINA4_CACHE_BACKEND` — `memory` | `redis` | `file` (default: `memory`)
- `TINA4_CACHE_URL` — `redis://localhost:6379` (redis backend only)
- `TINA4_CACHE_TTL` — default TTL seconds (default: `0` = disabled)
- `TINA4_CACHE_MAX_ENTRIES` — max entries (default: `1000`)

## Firebird-Specific Rules

When using Firebird as the database engine:

- **No `IF NOT EXISTS`** for `ALTER TABLE ADD` — the migration runner detects already-present columns via `RDB$RELATION_FIELDS` and skips silently.
- **No `AUTOINCREMENT`** — use generators. `db.getNextId(table, pkColumn?, generatorName?)` creates and uses generators (default name: `GEN_<TABLE>_ID`).
- **Pagination** — `SQLTranslator.limitToRows()` rewrites `LIMIT n OFFSET m` to Firebird's `ROWS m+1 TO m+n` syntax automatically.
- **No `TEXT` type** — use `VARCHAR(n)` or `BLOB SUB_TYPE TEXT`. The migration tracker schema (`tina4_migration`) uses `VARCHAR(500)` for the name column on Firebird.
- **No `REAL`/`FLOAT`** — use `DOUBLE PRECISION`.
- **BLOB handling** — `db.fetch()` and `db.fetchOne()` auto-convert memoryview/Buffer BLOB columns to `Buffer` (raw bytes, not base64).
- **No triggers, no foreign keys** in migrations on Firebird-targeted projects — relationships are wired in the ORM layer instead.

## How DevReload works

The `tina4` Rust CLI is the sole file watcher for the Tina4 stack — there is no framework-side watcher. The flow:

1. Rust CLI (`npx tina4nodejs serve`) watches `src/`, `migrations/`, `.env`. Noise is filtered (Access/Metadata events, `node_modules`, `.git`, `dist`, `logs`, `.log`/`.db*`/`.swp` files) and a real mtime check defeats overlayfs spurious events.
2. On a real change, the CLI POSTs `/__dev/api/reload` to the running server.
3. The framework bumps its in-memory reload counter and (a) broadcasts `{type: 'reload'}` over WebSocket at `/__dev_reload`, and (b) exposes the counter at `GET /__dev/api/mtime` for the polling fallback.
4. The browser's dev toolbar JS listens on the WS (primary) and polls `/__dev/api/mtime` every 3s (fallback). On a change it reloads the page, or swaps the stylesheet if the change was CSS.

No configuration needed — set `TINA4_DEBUG=true` to enable. If you're running without the Rust CLI (e.g. Docker), there is no automatic reload; the production path is unaffected.

**AI dual-port mode:** when `TINA4_DEBUG=true` and `TINA4_NO_AI_PORT` is unset, the main port suppresses reload/toolbar injection (so AI tools never trigger a refresh) and a second server on `port+1000` provides the normal hot-reload experience for browser testing.

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
  The route handler provides data; the template renders the HTML. Use `res.render("name.twig", data)` for programmatic template rendering. Matches Python `response.render()`, PHP `$response->render()`, Ruby `response.render` — same method name across all four frameworks.

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
5. **Browser reload, not process restart** — The `tina4` Rust CLI watches `src/`, `migrations/`, `.env` and POSTs `/__dev/api/reload` to the running server. The server stays up; only the browser reloads (via WS on `/__dev_reload`, polling fallback on `GET /__dev/api/mtime`). No ESM HMR gymnastics, no server restart, no framework-side watcher.
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

- **45 built-in features**, zero third-party dependencies
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
- **SSE/Streaming**: `response.stream()` for Server-Sent Events — pass an async generator, framework handles chunked transfer encoding and keep-alive

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

## First Principle: Documentation Matches Code Reality

**This rule overrides everything else in this file.**

Every command, env var, method, class, or feature mentioned in any
documentation file (`*.md` in this repo, or any tina4-book chapter,
or `tina4-documentation/docs/`) MUST exist in code. No exceptions.
No "we'll build it later" entries. No Laravel/Rails-style commands
that look right but don't exist. No env vars that the framework
doesn't actually read.

When you add a doc reference, add the implementation in the same PR.
When you remove a feature, remove every doc reference in the same PR.
When you find drift, fix it both ways: build the real thing OR delete
the doc.

The `tina4-documentation/scripts/audit-truth.py` script is the source
of truth. It runs as a CI gate (`audit-truth.yml`) on every PR — the
build fails on CLI drift. Run it locally before pushing if you've
touched docs:

```bash
cd /path/to/tina4-documentation
python3 scripts/audit-truth.py --strict
```

If you're unsure whether something exists, run `tina4 <command> --help`
or grep the framework source. Don't guess.

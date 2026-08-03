# CLAUDE.md - AI Developer Guide for tina4-nodejs (v3.13.94)

> This file helps AI assistants (Claude, Copilot, Cursor, etc.) understand and work on this codebase effectively.

## What This Project Is

Tina4 for Node.js/TypeScript v3.13.94 - The Intelligent Native Application 4ramework. A convention-over-configuration structural paradigm. The developer writes TypeScript; Tina4 is invisible infrastructure.

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
        seeder.ts        # Database seeding (seedTable, seedOrm, seedModels)
        sqlTranslator.ts # Cross-engine SQL translator + query cache
    swagger/    # OpenAPI spec generator, Swagger UI
    frond/      # Zero-dependency Twig-compatible template engine
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
- **Templates:** Frond — built-in zero-dependency Twig-compatible engine (`@tina4/frond`)
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
- `response.ts` — Wraps `ServerResponse`, adds `.json()`, `.html()`, `.status()`, `.send()`, `.redirect()`. `res.json(...)` / `response(...)` auto-serialize an ORM model (→ JSON object), an array of models, or a `DatabaseResult` (→ JSON array) — no manual `toDict()`/`toJson()`. Plain objects, arrays and strings behave exactly as before (purely additive).
- `middleware.ts` — Chain runner, built-in CORS and request logger
- `static.ts` — Serves files from `public/` with MIME type detection
- `types.ts` — All shared type definitions (`Tina4Request`, `Tina4Response`, `RouteHandler`, etc.)
- `events.ts` — Observer-pattern event system (`Events.on`, `emit`, `once`, `off`, `clear`)
- `ai.ts` — AI coding tool context installer (`AI_TOOLS`, `isInstalled`, `showMenu`, `installSelected`, `installAll`, `generateContext`)
- `errorOverlay.ts` — Rich debug error page for dev mode (`renderErrorOverlay`, `renderProductionError`, `isDebugMode`)
- `htmlElement.ts` — Programmatic HTML builder (`HtmlElement`, `htmlElement`, `addHtmlHelpers`)
- `testing.ts` — Inline testing framework (`tests`, `assertEqual`, `assertRaises`, `runAll`)
- `fakeData.ts` — Core fake data generator (names, emails, addresses, UUIDs, etc.)
- `constants.ts` — HTTP status codes (`HTTP_OK`, `HTTP_NOT_FOUND`, etc.) and content types (`APPLICATION_JSON`, `TEXT_HTML`, etc.)
- `devAdmin.ts` — Dev toolbar (fixed bottom bar injected into HTML pages) and admin dashboard at `/_dev/`
- `mcp.ts` - Model Context Protocol server (mounted by `devAdmin.ts` at `/__dev/mcp`) for live AI access to project tools. **MCP environment (read by `mcp.ts` / `devAdmin.ts`):**
  - `TINA4_MCP` / `TINA4_DEBUG` - capability gate (whether MCP is enabled at all). Explicit `TINA4_MCP` true/false wins on any host; else `TINA4_DEBUG=true` enables it.
  - `TINA4_MCP_TOKEN` - bearer token authorising a REMOTE MCP request (fallback `TINA4_API_KEY`). Accepted as `Authorization: Bearer`, `X-MCP-Token`, or `X-Api-Key`. With no token configured a remote caller is always denied. Loopback callers never need it.
  - `TINA4_MCP_REMOTE` - set `true` to allow non-loopback MCP callers at all (still requires a valid token).
- `auth.ts` — Authentication helpers
- `cache.ts` — In-memory caching
- `session.ts` — Session management with pluggable handlers. `TINA4_SESSION_SAMESITE` env var (default: Lax)
- `websocket.ts` — WebSocket support with backplane for scaling via Redis/NATS pub/sub (`TINA4_WS_BACKPLANE`, `TINA4_WS_BACKPLANE_URL`). The backplane is wired for real: `broadcast`/`broadcastToRoom`/`sendTo` deliver to LOCAL connections first (resiliently — a dead/slow client is pruned, never aborting the loop) then publish an envelope `{src,kind,exclude,room,path,text|b64}` to the shared channel `tina4:ws` (identical wire shape across all 4 frameworks). The subscribe callback relays directly on the event loop with an origin guard (drop our own `src` echo — no double-delivery) and never re-publishes (no cluster loop); binary messages ride as base64. Security/ops knobs (all opt-in, non-breaking): `TINA4_WS_ALLOWED_ORIGINS` (comma-separated origin allow-list enforced on upgrade — empty/unset = allow all), `TINA4_WS_IDLE_TIMEOUT` (seconds; 0/unset disables the idle-connection reaper), `TINA4_WS_MAX_BACKLOG` (bytes; a slow client whose socket write backlog exceeds this is dropped rather than buffered without bound). Rooms API: `wss.joinRoom(clientId, room)`, `wss.leaveRoom(clientId, room)`, `wss.broadcastToRoom(room, msg, excludeIds?)`, `wss.getRoomConnections(room)`, `wss.roomCount(room)`, `wss.getClientRooms(clientId)`. `originAllowed(headers)` is exported for upgrade-path checks. **Per-route auth (v3.13.39, Python master b5976d4):** a WS route is PUBLIC by default (mirrors GET). Mark it secured imperatively — `Router.websocket(path, fn, { secured: true })` / chain `.secure()` on the returned `WsRouteRef` / `WebSocketServer.route(path, fn, { secured: true })` — OR decorator-style via a `_secured` flag on the handler (works in either declaration order). A secured route enforces a valid JWT on the upgrade, AFTER the origin allow-list and BEFORE accept: missing/invalid → reject with HTTP 401 (never accept); public routes always pass (non-breaking). Three token transports (`wsToken(headers, query, subprotocol)`): (1) `Authorization: Bearer <jwt>` header (server/CLI/mobile); (2) the `Sec-WebSocket-Protocol` subprotocol `"bearer, <jwt>"` (browsers — `new WebSocket()` can't set headers; the server echoes `bearer` back as the accepted subprotocol); (3) `?token=<jwt>` query param. Validated via the same `validToken` (Auth) the HTTP routes use. The verified payload is exposed as `connection.auth` (`null` on public routes). `wsAuthorized(route, headers, query, subprotocol) -> [payload, ok]` is the gate. **The integrated server (`server.ts`) now dispatches user WS routes:** its `upgrade` handler routes a non-`/__dev_reload` upgrade through `serveWebSocketRoute(req, socket, head)`, which matches the WS route table, enforces per-route auth, then drives the real open/message/close lifecycle on the connection (`wsRouteManager`) — parity with Python/PHP/Ruby (previously only `/__dev_reload` was wired, so user WS routes never reached a live connection).
- `queue.ts` — Queue system with pluggable backends
- `graphql.ts` — GraphQL engine. **Hardening:** selection-set nesting is bounded by `TINA4_GRAPHQL_MAX_DEPTH` (default `50`; `<= 0` disables; exposed as the public `gql.maxDepth` field + `graphqlMaxDepth()` helper). Depth increments on every recursive entry — sub-selections, fragment spreads, AND inline fragments — so an over-deep query or a circular fragment fails with `Query exceeds maximum depth of N` instead of overflowing the stack (top-level starts at depth 1). A resolver exception is logged via `Log.error` and the detail is surfaced to the client **only** under `TINA4_DEBUG` (`isDebugMode()`); otherwise it returns a generic `Internal server error` (path preserved) so internal state never leaks.
- `i18n.ts` — Internationalization / localization
- `logger.ts` — Structured logging. Five first-class severity levels: `debug`(0) < `info`(1) < `warning`(2) < `error`(3) < `critical`(4). `critical` is the HIGHEST level, NOT a relabelled `error`, and renders magenta. `Log.critical()` ALWAYS emits like every other level — subject only to `TINA4_LOG_LEVEL` (which it always clears) and teed to the log file whenever a file is being written. There is NO enable toggle: the old `TINA4_LOG_CRITICAL` opt-in was retired in v3.13.39 (the env var is no longer read), so a critical log is never a silent no-op. `Log.isEnabled("critical")` is ordinary threshold logic (`4 >= configured min`). **Dev/prod-aware default file output (v3.13.39, Python master 4c6d881):** stdout is ALWAYS on. When `TINA4_LOG_OUTPUT` is unset (default), the log FILE (`logs/tina4.log`) is written ONLY in development (`TINA4_DEBUG` truthy); in production / containers (`TINA4_DEBUG` falsy) the logger is stdout-only — no file to bloat the writable layer / disk (12-factor: logs on stdout for the platform to capture). Explicit `TINA4_LOG_OUTPUT=file`/`both`, OR an explicit `TINA4_LOG_FILE` path, always forces a file (explicit wins). `readEnv()` resolves all of this into a single `fileEnabled` flag that gates the file writer. Full parity with Python master. **Format is TEXT by default (settled logger contract, 2026-08-01):** `TINA4_LOG_FORMAT=json` is the ONLY thing that selects JSON, and it applies to BOTH sinks (stdout and file). The implicit "production means JSON" switch (an unset `TINA4_DEBUG`) is DELETED — it made the same `.env` produce four different formats across the four frameworks. `TINA4_DEBUG` now decides COLOUR only: ANSI on a dev terminal, clean bytes on a production pipe. An object/array passed as the MESSAGE is still JSON-encoded INLINE inside the text line (never `[object Object]`). **`TINA4_LOG_STRICT`:** truthy makes a log-write failure THROW instead of being swallowed (default off — logging must never crash an app that did not ask for it). **Every `TINA4_LOG_*` var is read LAZILY on each call**, so a script, worker, CLI tool or test that logs without booting a server still gets the operator's configuration; `Log.configure()` remains an explicit override.
- `rateLimiter.ts` — Rate limiting middleware
- `dotenv.ts` — `.env` file loading
- `health.ts` — Health check endpoint
- `scss.ts` — SCSS compilation
- `messenger.ts` — Messaging system
- `service.ts` — Service layer helpers
- `wsdl.ts` — WSDL / SOAP support. **Hardening:** a SOAP message containing a `<!DOCTYPE>` is rejected with a `Client` fault ("DOCTYPE declarations are not allowed in SOAP messages") BEFORE the body is parsed and the operation never runs — SOAP 1.1 forbids DTDs and this closes the XML entity-expansion (billion-laughs) / external-entity (XXE) surface (defence in depth — the hand-rolled parser is already immune). `convertValue` for an `int`/`float`/`integer`/`double`/`number` param throws on a non-numeric value (matching Python's `int()`/`float()` raise) so it becomes a `Server` fault instead of a silent `NaN`. An operation that throws is logged via `Log.error`; the real cause reaches the client **only** under `TINA4_DEBUG` (`isDebugMode()`), else a generic `Internal server error`.

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
- `seeder.ts` — Database seeding (`seedTable` raw SQL, `seedOrm` model-based, `seedModels` FK-ordered batch). All return a `SeedSummary { seeded, failed, errors }`; per-row failures are logged + counted + skipped (`strict` re-raises). Options: `{ overrides, clear, seed, strict }`.
- `sqlTranslator.ts` — Cross-engine SQL translator (`SQLTranslator`) and TTL query cache (`QueryCache`)
- **Instance methods:** `save(): this|false` (fluent, false on failure), `delete()`, `forceDelete()`, `restore()`, `load(sql, params?, include?): boolean`, `validate(): string[]`, `toDict(include?)`, `toAssoc(include?)`, `toObject()`, `toArray(): unknown[]`, `toList()`, `toJson(include?)`, `hasOne(class, fk)`, `hasMany(class, fk, limit?, offset?)`, `belongsTo(class, fk)`
- **Static methods:** `find(id, include?)`, `findById(id, include?)`, `findOrFail(id)`, `create(data)`, `all(limit=100, offset=0, include?, orderBy?)`, `select(sql, params?, limit=100, offset=0)`, `selectOne(sql, params?, include?)`, `where(conditions, params?, limit=100, offset=0, include?, orderBy?)`, `count(conditions?, params?)`, `withTrashed(conditions?, params?, limit=100, offset=0)`, `scope(name, filterSql, params?)` (registers reusable method), `createTable()`, `query()`, `_processForeignKeys()`, `_applyFkRegistry()`
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
refreshToken(token, expiresIn=60): string | null  // reads SECRET from env
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

Backends: file, redis, valkey, mongodb, database, memcached.

**`redis-npm` was removed on 2026-07-31.** It was a Node-only backend name that drove
Redis through the optional `redis` npm package. Python and Ruby also prefer that
driver when installed, but they choose it inside their single `redis` handler; only
Node exposed it as a selectable backend, and only Node's copy still ran
`execFileSync` per command instead of the persistent worker connection every other
handler moved to. Use `redis` — same backend, same `TINA4_SESSION_REDIS_*`
settings, faster transport. Setting `TINA4_SESSION_BACKEND=redis-npm` now **throws**
rather than falling through to the `file` default, because a silent demotion to disk
would log every user out on deploy and look like an outage.

**Backend-failure policy (all 4 frameworks): log-loud + degrade.** A backend (Redis/Valkey/Mongo/DB) that becomes unreachable mid-request is logged via `Log.error` and degraded rather than crashing the app or losing data silently. The external handlers now **throw** a transport error on an unreachable server (previously they swallowed it to an empty string — silent data loss); the `Session` boundary catches it: a read failure yields an empty session (the request still serves), and `save()` returns `false` (best-effort, dirty flag retained for a later retry). A genuine key/doc miss still returns empty **without** logging — empty is not a failure. Set `TINA4_SESSION_STRICT=true` to re-throw instead. Call `regenerate()` right after a successful login or privilege change to defeat session fixation.

### Database extras

```typescript
await db.execute(sql, params?): Promise<boolean | unknown>  // ASYNC — await it. RAISES on SQL error (never returns false; cause on getError()); on success: bool for writes, result for RETURNING/CALL/EXEC. try/catch — don't test the return.
db.getLastId(): string | number   // synchronous
db.getError(): string | null       // synchronous
db.cacheStats(): { enabled, size, ttl }   // synchronous
```

### DocStore — pymongo-style document store (zero-config SQLite fallback)

`getCollection(name)` (from `@tina4/orm`) returns a Mongo-style collection. When a Mongo URI is configured it is a real Mongo collection; otherwise it is a `SqliteCollection` backed by a local SQLite file (`node:sqlite`, JSON1). The call sites are identical either way — only the backend differs — so you develop against a zero-dependency local store and switch to MongoDB in production by setting one env var.

**The API is ASYNC on both providers (ADR-0025).** `getCollection` and every collection method return a Promise; `find()` is sync and returns a cursor whose `toArray()` is async, exactly matching the MongoDB driver. `node:sqlite` is synchronous underneath, but the SHAPE never changes with the provider — before 3.13.95 the fallback was fully sync, so identical source changed TYPE when `TINA4_MONGO_URI` was set, and because a Promise is always truthy, `if (doc)` succeeded for a document that did not exist.

```typescript
import { getCollection, isServerless, ObjectId } from "@tina4/orm";

const orders = (await getCollection("orders")) as any;
const res = await orders.insertOne({ customer_id: 1, total: 9.99, status: "new" });
await orders.findOne({ _id: res.insertedId });
await orders.updateOne({ _id: res.insertedId }, { $set: { status: "shipped" } });
// for await — a real FindCursor has Symbol.asyncIterator only, never Symbol.iterator
for await (const doc of orders.find({ total: { $gt: 5 } }).sort("total", -1).limit(10)) {
  // ...
}
await orders.countDocuments({ status: "shipped" });
isServerless();   // true when running on the SQLite fallback (sync — reads config only)
```

Filter operators: equality, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$ne`, `$exists`, `$regex`, implicit AND, `$or`, `$and`, and dotted nested keys (`addr.city`). Updates: `$set`, `$unset`, `$inc`, replace, upsert. Cursors: `sort`, `limit`, `skip`, projection. Values round-trip (Date to/from ISO-8601, `ObjectId` to/from 24-hex) and stay queryable via `json_extract`. Non-goals: aggregation pipelines, `$elemMatch`, geo queries.

Selection and configuration:
- `TINA4_MONGO_URI` — app-wide Mongo URI. Falls back to `TINA4_SESSION_MONGO_URI`, then the legacy `TINA4_SESSION_MONGO_URL`. When one is set, `getCollection` returns a real Mongo collection.
- `TINA4_DOC_STORE_PATH` — SQLite file for the fallback store (default `data/tina4_docstore.db`).

**One client per (uri, database), and a way to close it.** `getCollection` caches the connected Mongo client rather than building a new one per call — before 3.13.95 it constructed a `new MongoClient` on EVERY call and never closed it, so 20 calls left 40 server connections open and the count grew without bound (invisible locally, because the SQLite fallback opens no connections at all). `await closeDocStore()` closes every Mongo client and the SQLite store; a pooled client keeps the event loop alive, so a script or test that touched the real provider needs it to exit.

### Request extras

```typescript
req.files: Record<string, UploadedFile>  // dict keyed by field name (not array)
req.cookies: Record<string, string>       // parsed from Cookie header
req.contentType: string                   // from content-type header
req.query: Record<string, string>         // query string params
response.xml(content, status?): Tina4Response
response.stream(source: AsyncIterable<string | Buffer>, contentType?: string): Promise<Tina4Response>  // SSE/streaming
```

`response.stream()` is hardened: it bails cleanly when the client disconnects mid-stream (`res.writableEnded`/`res.socket.destroyed`), catches a generator/source error (logs via `Log.error`, ends the stream cleanly — never crashes the handler), applies slow-client backpressure (awaits `drain` when `res.write()` returns false rather than buffering ahead of a stalled client), and writes a periodic `:` keep-alive comment every `TINA4_SSE_HEARTBEAT` seconds (default 15; set `0` to opt out). On disconnect/error it best-effort closes the source (`.return()`/`.close()`/`.aclose()`).

`res.json(model)`, `res.json(arrayOfModels)`, and `res.json(db.fetch(...))` auto-serialize to JSON — a single model becomes a JSON object, an array of models or a `DatabaseResult` becomes a JSON array. No manual `toDict()`/`toJson()` needed.

### Queue

```typescript
queue.consume(topic?, id?, pollInterval=1000): AsyncGenerator<QueueJob>
// Long-running async generator. Sleeps when empty. pollInterval=0 for single-pass.
// Usage: for await (const job of queue.consume("emails")) { ... }
```

### @tina4/swagger (`packages/swagger/`)
Auto-generates OpenAPI 3.0.3 docs.

**Key files:**
- `generator.ts` — Produces OpenAPI spec from route table + model definitions
- `ui.ts` — Serves Swagger UI HTML (CDN-based) at `/swagger` and spec at `/swagger/openapi.json`

**3.13.40 spec behaviour:** ORM models become reusable `components.schemas` entries referenced by `$ref` (no more inlined duplicate shapes); a secured route emits a `bearerAuth` security requirement; the spec is OpenAPI 3.0.3.

**Environment (read by `generator.ts` / `ui.ts`):**
- `TINA4_SWAGGER_ENABLED` - turns the `/swagger` UI + `/swagger/openapi.json` endpoints on/off (`ui.ts`). Explicit `true`/`false` wins; unset falls back to `TINA4_DEBUG`. Set `false` to DISABLE swagger in ANY environment (including dev); set `true` to expose it in production. This is the documented production on/off switch (wired for real in 3.13.40 - previously ignored). **This is how you disable swagger.**
- `TINA4_SWAGGER_SERVERS` - comma-separated list of server URLs for the OpenAPI `servers[]` block (multi-server / multi-environment). Falls back to `SWAGGER_DEV_URL`, else the framework default.
- `TINA4_SWAGGER_UI_CDN` - base URL for the Swagger UI assets (`swagger-ui.css` + `swagger-ui-bundle.js`). Defaults to the public CDN (`https://unpkg.com/swagger-ui-dist@5`); point it at a self-hosted mirror for air-gapped deployments.
- Info block: `TINA4_SWAGGER_TITLE`, `TINA4_SWAGGER_VERSION`, `TINA4_SWAGGER_DESCRIPTION`, `TINA4_SWAGGER_CONTACT_EMAIL`, `TINA4_SWAGGER_CONTACT_TEAM`, `TINA4_SWAGGER_CONTACT_URL`, `TINA4_SWAGGER_LICENSE`.

**Configurability (v3.13.42):**
- `TINA4_SWAGGER_OPENAPI` - OpenAPI version (default `3.0.3`); `3.1`/`3.1.0` emits `3.1.0`.
- `TINA4_SWAGGER_BEARER_FORMAT` - `bearerFormat` on the built-in `bearerAuth` scheme (default `JWT`; use `opaque` for `sk_live_` keys).
- `TINA4_SWAGGER_API_KEY_NAME` / `TINA4_SWAGGER_API_KEY_IN` - when the name is set, emit an `apiKeyAuth` scheme; `_IN` is `header` (default) / `query` / `cookie`.
- `TINA4_SWAGGER_DEFAULT_SCHEME` - scheme a secured route uses when its `meta` declares no `security` (default `bearerAuth`).
- `TINA4_SWAGGER_INCLUDE` / `TINA4_SWAGGER_EXCLUDE` - comma-separated path-prefix allow-list / deny-list (`/swagger` + `/__dev` always excluded).

**Per-route security + reusable schemas (v3.13.42).** A route's `meta` may carry `security` (a scheme name, a `{name: [scopes]}` map, a list of maps for OR, or the string `"public"` to force `security: []`), a sibling `scopes` array, and `requestSchema` / `responseSchemas` referencing schemas registered with `addSchema(name, schema)`. Register arbitrary schemes (including `oauth2` with scopes) via `addSecurityScheme(name, definition)`; `resetRegistry()` clears both. All three are exported from `@tina4/swagger`. Scopes are kept spec-valid: only `oauth2`/`openIdConnect` carry them, `http`/`apiKey` get `[]`.

### @tina4/frond (`packages/frond/`)
Built-in zero-dependency Twig-compatible template engine (the only template engine; there is no `twig` npm dependency).

**Key files:**
- `engine.ts` — The `Frond` class: `render(path, data)`, `renderString(template, data)`, filters/globals/tests, sandbox mode

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

Installs Tina4 context files for AI coding tools (Claude Code, Cursor, Copilot, Windsurf, Aider, Cline, Codex). `AI_TOOLS` is the ordered list of known tools; the installer writes a marker-bracketed Tina4 skill block into each tool's context file, preserving existing content.

```typescript
import { AI_TOOLS, isInstalled, showMenu, installSelected, installAll, generateContext } from "@tina4/core";

// The known tools (name, description, contextFile, configDir)
AI_TOOLS;  // → [{ name: "claude-code", description: "Claude Code", contextFile: "CLAUDE.md", configDir: ".claude" }, ...]

// Check whether a tool's context file already exists in a project directory
isInstalled(".", AI_TOOLS[0]);  // → boolean

// Show the interactive numbered menu and read the user's selection (returns a Promise)
const selection = await showMenu(".");

// Install context files for a selection ("1,2,3" or "all") — returns created/updated paths
const created = installSelected(".", selection);
// → ["CLAUDE.md", ".cursorules", ...]

// Install for ALL known tools, non-interactive
installAll(".");

// Generate the context document string for a specific tool (defaults to "claude-code")
const doc = generateContext("cursor");
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

Attach test assertions directly to functions. Tests are registered globally and run with `runAll()`. No external test runner needed.

```typescript
import { tests, assertEqual, assertRaises, assertTrue, assertFalse, runAll, reset } from "@tina4/core";

// Decorate a function with inline tests
const add = tests(
  assertEqual([5, 3], 8),        // add(5, 3) === 8
  assertEqual([0, 0], 0),        // add(0, 0) === 0
  assertRaises(Error, [null]),   // add(null) throws Error
)(function add(a: number, b: number | null = null): number {
  if (b === null) throw new Error("b required");
  return a + b;
});

// The original function works normally
add(2, 3);  // 5

// Run all registered tests
const results = runAll({ quiet: false, failfast: false });
// → { passed: 3, failed: 0, errors: 0, details: [...] }

// Additional assertion types
assertTrue([someArgs]);   // result is truthy
assertFalse([someArgs]);  // result is falsy

// Reset registry between test runs
reset();
```

## Module: Seeder / FakeData (`packages/orm/src/seeder.ts`, `packages/orm/src/fakeData.ts`)

Database seeding with fake data generation. The ORM `FakeData` extends core `FakeData` (which provides names, emails, addresses, etc.) and adds `forField()` for auto-generating values based on ORM field definitions with column-name heuristics.

```typescript
import { FakeData, seedTable, seedOrm, seedModels } from "@tina4/orm";

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

// seedTable — raw SQL inserts with generator functions.
// Returns a SeedSummary { seeded, failed, errors } (NOT a bare number).
const summary = await seedTable(db, "users", 50, {
  name: () => fake.name(),
  email: () => fake.email(),
  role: "user",  // static values also accepted
}, undefined, { clear: true, seed: 42, strict: false });
// summary.seeded / summary.failed / summary.errors[{ row, message }]
// (legacy positional 5th arg overrides also still works: seedTable(..., { active: true }))

// seedOrm — auto-seed from model field definitions
import User from "./src/models/User.js";
await seedOrm(User, 100, { role: "user" }, 42);                  // legacy positional
await seedOrm(User, 100, undefined, undefined, { clear: true, seed: 42, strict: true });

// seedModels — batch-seed FK-related models in dependency order (parents first,
// reverse-order clear, FK columns resolved to real parent PKs). Topo-sorts by the
// `references` graph so the declared order doesn't matter.
const results = await seedModels([Book, Author], 10, { clear: true, seed: 7 });
// → { Author: SeedSummary, Book: SeedSummary }
```

**Visible-but-resilient seeding (P1-P4).** Every row is wrapped: a failing row is
logged (with its index + cause) and skipped, incrementing `summary.failed` — never
silent, never a crash. `strict: true` re-raises on the first failure instead of
skipping. `clear: true` truncates the target first (idempotent re-runs). `seed`
makes a run reproducible. `seedModels()` orders by the foreignKey dependency graph.
The dev-admin seed endpoint (`POST /__dev/api/seed`) routes through `seedTable`,
accepts `seed`/`clear`/`strict`, and returns `{ seeded, failed, errors, table }`.

Column-name heuristics in `forField()`: columns named `email`, `phone`, `name`, `address`, `city`, `country`, `company`, `url`, `uuid`, `ip`, `currency`, etc. get contextually appropriate fake data.

## Module: SQL Translation (`packages/orm/src/sqlTranslator.ts`)

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

Full Database API. The same instance covers all five drivers (sqlite, postgres, mysql, mssql, firebird) — pick the driver via `TINA4_DATABASE_URL` or pass a `DatabaseConfig` to `initDatabase()`.

```typescript
import { initDatabase, bindDatabase, createAdapterFromUrl, Database, DatabaseResult } from "@tina4/orm";

const db = await initDatabase({ url: "sqlite:///app.db" });
// Connection pooling: pass `pool: 4` for round-robin connections.

// db.fetch() caps at 100 rows when no limit is passed (one number across all
// four frameworks). db.fetchAll() deliberately does NOT inherit the cap -- its
// name is the request for every row -- so it routes around fetch()'s default.
// EVERY db method that touches the database is ASYNC on the Database wrapper --
// it returns a Promise, so `await` it. (The node:sqlite ADAPTER underneath is
// synchronous, but the wrapper is async so the query cache and the pg/mysql/
// mssql/firebird adapters share one uniform API.) Only getLastId(), getError()
// and close() are synchronous.

// Reads — async, await them
await db.fetch(sql, params?, limit?, offset?): Promise<DatabaseResult>   // limit defaults to DEFAULT_ROW_CAP (100)   // .records, .count, .limit, .offset
await db.fetchOne<T>(sql, params?): Promise<T | null>

// Writes — execute() RAISES on a SQL error (bad SQL, constraint violation,
// dead connection, missing driver): it records the cause on getError() then
// re-throws — it never swallows and returns false (mirrors fetch()/fetchOne()).
// On SUCCESS it resolves to boolean for simple writes, the result set for
// RETURNING / CALL / EXEC / SELECT. Callers needing a bool (ORM save(),
// createTable(), migration runner, dev-admin/MCP DB tools) try/catch and
// convert — they must NOT test the return value for false.
await db.execute(sql, params?): Promise<boolean | unknown>
await db.executeMany(sql, paramSets): Promise<unknown[]>          // wrapped in a transaction
await db.insert(table, data): Promise<DatabaseWriteResult>
await db.update(table, data, filter?, params?): Promise<DatabaseWriteResult>
await db.delete(table, filter?, params?): Promise<DatabaseWriteResult>
await db.truncate(table): Promise<DatabaseWriteResult>   // remove every row, explicitly
await db.primaryKey(table): Promise<string[]>            // introspected PK columns (cached)

// A WRITE WITH NO FILTER IS AN ERROR, not a full-table operation (3.13.94).
// update(table, data) with no filter takes the primary key out of `data` and uses
// it as the WHERE clause; with neither a filter nor the COMPLETE primary key in
// `data` it THROWS instead of silently changing nothing. delete(table) with no
// filter throws too -- truncate(table) is the explicit whole-table spelling.
// A failed write now throws rather than resolving to { success: false,
// affectedRows: 0 }, which a caller who did not inspect the result never saw.
// primaryKey() returns an ARRAY: a primary key may span several columns, and
// EVERY key column goes into the WHERE. A composite key keyed on only its first
// column would match every row sharing that value.

// Last-write metadata — SYNCHRONOUS (no await)
db.getLastId(): string | number
db.getError(): string | null

// Transactions — async (await). autoCommit defaults to ON: a standalone write
// commits on its own connection (durable + visible across the pool); inside
// startTransaction() the per-statement commit is suppressed so the transaction
// stays atomic. Set TINA4_AUTOCOMMIT=false for strict manual-commit mode.
await db.startTransaction(): Promise<void>
await db.commit(): Promise<void>
await db.rollback(): Promise<void>

// Schema introspection — async (await)
await db.tableExists(name): Promise<boolean>
await db.getTables(): Promise<string[]>
await db.getColumns(table): Promise<{ name, type, nullable?, default?, primaryKey? }[]>

// Race-safe sequence — async (await). Uses tina4_sequences for SQLite/MySQL/MSSQL,
// auto-creates Postgres sequences, and uses native Firebird generators.
await db.getNextId(table, pkColumn?, generatorName?): Promise<number>

// DB query cache — request-scoped auto cache is OFF by default (opt-in via
// TINA4_AUTO_CACHING=true, TTL TINA4_AUTO_CACHING_TTL=5s): when enabled it dedupes
// identical db.fetch()/ORM reads within a request, flushed on any write (always
// in-process, fastest). Default OFF because a request-scoped cache defaulting ON is a
// footgun — a read-after-write in one request (e.g. SELECT MAX(id) then INSERT) returns a
// cached pre-write value (duplicate PKs / stale state); enable it for read-heavy endpoints.
// Persistent cross-request cache opt-in
// via TINA4_DB_CACHE=true (TTL TINA4_DB_CACHE_TTL=30s), configured via TINA4_DB_CACHE_BACKEND
// + TINA4_DB_CACHE_URL. The persistent layer routes through the SAME unified async backend
// set (memory default = in-process; redis/valkey/memcached/mongodb/database distribute), so
// multiple instances share one cache with global write-invalidation — full parity with
// Python/PHP/Ruby. (Node's read path — db.fetch → fetchAsync — is async, so the backend's
// async get/set work directly; the KV/middleware API is async, await it.) cacheStats() reports
// mode + backend; cacheClear() is real.
db.cacheStats(): { enabled, size, ttl, mode, backend }   // mode: "request" | "persistent" | "off"
db.cacheClear(): void

// Connection pool access (null when pooling disabled)
db.pool
```

### Binding adapters: `bindDatabase` / `createAdapterFromUrl`

There are three ways models get an adapter, in increasing order of explicitness:

```typescript
import { initDatabase, bindDatabase, createAdapterFromUrl } from "@tina4/orm";

// (a) .env auto-default (unchanged) — initDatabase() auto-binds the default at boot.
//     Most apps need nothing more than TINA4_DATABASE_URL in .env.
const db = await initDatabase({ url: "sqlite:///app.db" });

// (b) Set or override the default explicitly with bindDatabase(adapter).
bindDatabase(adapter);

// (c) Register a NAMED / secondary connection and point a model at it.
bindDatabase(await createAdapterFromUrl("postgres://localhost:5432/analytics"), "analytics");
// then a model selects it:
//   class Visit extends BaseModel { static _db = "analytics"; }
```

- `bindDatabase(adapter, name?)` — public binder. With no `name` it sets/overrides the **default** connection; with a `name` it registers a **named** connection. `initDatabase()` (auto-binds the `.env` default) and the internal `setAdapter()` are unchanged — `bindDatabase` is additive and non-breaking.
- `createAdapterFromUrl(url, user?, pass?)` — now exported. Builds a `DatabaseAdapter` from a connection URL (and optional credentials), ready to pass to `bindDatabase`.
- A model selects a named connection via `static _db = "analytics"`. A mistyped/missing named connection (e.g. `static _db = "typo"`) now **throws** a clear error instead of silently falling back to the default.

**`tina4_sequences` table** — Auto-created by `getNextId()` on first use for SQLite, MySQL, and MSSQL. Stores the current sequence value per table. Do not modify this table manually.

## Module: ORM (`packages/orm/src/baseModel.ts`)

Active-Record base class. Models live in `src/models/` and are auto-discovered. Use `static fields` (not decorators) — same convention across all four frameworks.

```typescript
import { BaseModel, initDatabase, bindDatabase, createAdapterFromUrl } from "@tina4/orm";

export default class User extends BaseModel {
  static tableName = "users";
  static fields = {
    id:        { type: "integer" as const, primaryKey: true, autoIncrement: true },
    email:     { type: "string"  as const, required: true, maxLength: 255 },
    author_id: { type: "foreignKey" as const, references: "Author" }, // auto-wires belongsTo + hasMany
  };
  static softDelete = true;   // optional — toggles is_deleted column
  // static _db = "analytics";  // optional — bind this model to a named connection
}

// Constructor accepts an object OR a JSON object string. Passing an array throws TypeError.
const user  = new User({ email: "alice@example.com" });
const user2 = new User('{"email":"bob@example.com"}');  // JSON object string -> one record
// new User([{ ... }]);  // throws TypeError — map over the list to build many records

// Instance methods (chainable where it makes sense)
user.save();              // returns this on success, false on failure
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
User.all(limit?, offset?, include?, orderBy?);   // limit defaults to 100; NO filter -- use where()
User.select(sql, params?, limit?, offset?);       // limit defaults to 100
User.selectOne(sql, params?, include?);
User.where(conditions, params?, limit?, offset?, include?, orderBy?);
User.count(conditions?, params?);
User.withTrashed(conditions?, params?, limit?, offset?);
User.scope(name, filterSql, params?);     // registers a reusable named method
User.createTable();
User.query(): QueryBuilder;
BaseModel.registerModel(name, class);     // for foreignKey name resolution

// Models bind to the active adapter, not a Database wrapper. There are three ways:
// (a) .env auto-default (unchanged) — initDatabase() auto-binds the default at boot:
await initDatabase({ url: "sqlite:///app.db" });   // sets the default adapter for all models
// (b) set/override the default explicitly:
bindDatabase(adapter);
// (c) register a NAMED/secondary connection, then point a model at it with `static _db`:
bindDatabase(await createAdapterFromUrl("postgres://localhost:5432/analytics"), "analytics");
//   class Visit extends BaseModel { static _db = "analytics"; }
// A mistyped/missing named connection (e.g. static _db = "typo") now throws instead of
// silently falling back to the default. (initDatabase / the internal setAdapter are unchanged.)
```

**Soft delete:** set `static softDelete = true`. Server boot (`syncModels()`) adds the `is_deleted` INTEGER column (0/1) — but **`Model.createTable()` does not**, so declare it there yourself. `delete()` flips the flag, `forceDelete()` removes the row, `restore()` clears it.

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
  .get();                       // → DatabaseResult (.records, .count, .limit, .offset)

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

**Auto-run on startup (`TINA4_AUTO_MIGRATE`, default on).** `startServer()` calls `autoMigrateOnStartup()` (in `server.ts`) AFTER `initDatabase()`/model sync and BEFORE the server listens. When a `migrations/` folder with at least one `.sql` file exists, `TINA4_AUTO_MIGRATE` is not falsy (default `"true"`; `false`/`0`/`no`/`off` disable), and a DB adapter is resolvable, it runs the existing `migrate()` runner so the schema is current with no manual `tina4 migrate` step. It is **non-breaking**: a failure is logged via `Log.error` and the service still starts (a bad migration must never take the backend down). The runner is wrapped in try/catch and `autoMigrateOnStartup()` never rejects/throws out of the boot path. Set `TINA4_AUTO_MIGRATE=false` to disable (e.g. multi-instance production that migrates as a separate deploy step — concurrent first-apply can race). The explicit `tina4 migrate` CLI (`packages/cli/src/commands/migrate.ts`) is unaffected and stays **fail-fast** (`process.exit(1)` on a statement error) so CI keeps the non-zero exit code.

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

### How migrations work internally

- SQL files live in `migrations/`, named `NNNNNN_description.sql` (sequential) or `YYYYMMDDHHMMSS_description.sql` (timestamp), and are split on the `;` delimiter.
- Files are applied in **numeric-prefix order** (`9_` before `10_` — a plain lexical sort misorders unpadded prefixes because `"10" < "9"`). A file with no numeric/timestamp prefix sorts **after** the numbered ones (lexically) and logs a `Log.warning` — its order is undefined.
- State is tracked in the `tina4_migration` table (auto-created per engine, canonical columns `id, migration_name VARCHAR(500) NOT NULL UNIQUE, description VARCHAR(500), batch INTEGER NOT NULL DEFAULT 1, executed_at VARCHAR(50) NOT NULL, passed INTEGER NOT NULL DEFAULT 1` - identical across all four frameworks). A migration is **applied** when a row exists for it with `passed = 1` (the applied-read is `WHERE passed = 1`). `migrate()` writes **only `passed = 1` rows**, and it does so **delete-before-insert**: on success it DELETEs any existing row for that `migration_name` and then INSERTs the fresh `passed = 1` row (the shared `recordApplied()` helper, mirroring the Python master's `_record_applied()`), so the table holds **at most one row per `migration_name`** - latest state wins. A FAILED migration file is rolled back and **no row is written** for it (it is NOT recorded as `passed = 0`; the record step is never reached), and the run STOPS (the `migrate()` summary's `failed[]` carries the failure). The public `recordMigration(name, batch, passed)` API can write a `passed = 0` row (and one may be carried over from an older table); any `passed = 0` row is treated as **not applied**. Because the success path deletes any existing row for the `migration_name` before the `passed = 1` INSERT, a leftover `passed = 0` row **re-applies cleanly** on the next `migrate()` - the stale row is superseded rather than colliding on the UNIQUE `migration_name` (that collision previously wedged a re-run). Fix the bad file and re-run.
- **Each migration FILE is wrapped in its own transaction.** On a failure the file rolls back and `migrate()` **STOPS** — later files are never applied on top of a missing earlier one (parity with Python/PHP/Ruby). Already-applied files stay applied. The explicit `tina4 migrate` CLI surfaces a non-empty `failed[]` as a non-zero exit; startup auto-migration logs it and the service still boots (see `TINA4_AUTO_MIGRATE` above).
- **Atomicity caveat:** per-file transactions are truly atomic only on engines with **transactional DDL (PostgreSQL)**. MySQL, Firebird, and SQLite auto-commit DDL, so a multi-statement migration that fails midway on those engines leaves earlier statements applied — keep one logical change per file. `CREATE TABLE` and `ALTER TABLE ... ADD` are made idempotent on Firebird/MSSQL (existence-checked via `RDB$RELATION_FIELDS` / `tableExists`) so a re-run with a raw `CREATE`/`ADD` does not error "object already exists"; SQLite/MySQL/PostgreSQL support `IF NOT EXISTS` and are left to the engine. Only a genuine already-exists is skipped — every other error still raises.
- The stored-proc block delimiters (`$$ … $$` / `// … //`) are extracted before splitting, but a `//` preceded by a colon is **not** treated as a delimiter, so a URL (`https://…`) or any `://` literal inside a migration is never swallowed as an opaque block.

Schema sync (`syncModels`) runs alongside SQL migrations on boot.

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

- **Safe output** — Frond's built-in `raw`/`safe`-style filters (and the `{% autoescape %}` controls) mark output as already-escaped so it bypasses auto-escaping. The internal `SafeString` wrapper backing this is not exported from `@tina4/frond` (only `Frond`, `FilterFn`, `TestFn` are public).
- **Fragment caching** — `{% cache "key" 300 %}...{% endcache %}` caches block output for TTL seconds.
- **Raw blocks** — `{% raw %}...{% endraw %}` outputs literal template syntax.
- **Pre-compiled regexes** + token caching (cleared on file mtime change in dev mode) for ~2.8x render improvement over the naive path.

## Module: Api (`packages/core/src/api.ts`)

Zero-dep HTTP client over `node:http` / `node:https`. Used by integrations, queue producers, health checks, and tests.

**Retry/backoff (opt-in, default off):** pass `maxRetries` (default `0`) and `retryBackoff` (default `0.5`s base, exponential) in the options bag — `new Api(url, { bearerToken, maxRetries: 3, retryBackoff: 0.5 })`. Retries a transport error (`http_code` null) or a retryable status (429/500/502/503/504); 4xx is never retried (a retried non-idempotent request may be re-sent, so retries are opt-in).

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

**Multipart upload, streaming download, transport seam, cookie jar, redirects (v3.13.69, Python master parity).** All zero-dep, all opt-in and non-breaking:

```typescript
// Multipart upload — from disk OR in-memory bytes (no temp file needed).
// Boundary is "----Tina4Boundary" + 32 hex; part Content-Type is guessed from
// the filename (fallback application/octet-stream). A missing file / no source
// returns a clean error result ({ http_code: null, error: ... }) — never throws.
await api.upload("/avatars", { filePath: "/tmp/me.png", extraFields: { user_id: "42" } });
await api.upload("/avatars", { fileBytes: buf, filename: "me.png", fieldName: "file" });

// Streaming download — writes the body to disk in 64KB chunks (never buffered
// whole). Returns { http_code, headers, error, path } (NO body field); path is
// null and no file is written on any error.
const dl = await api.download("/report.pdf", "/tmp/report.pdf", { q: "2026" });

// Transport seam — an injectable async/sync callable
// (method, url, headers, body, timeout) => { http_code, body, headers, error }
// that REPLACES the node:http/https call. For APPLICATION-developer unit tests
// only — Tina4's own suite never injects a fake (no-mock rule).
new Api(url, { transport: async (method, u, headers, body, timeout) => ({ http_code: 200, body: {}, headers: {}, error: null }) });

// Cookie jar — opt-in, in-memory, per-client. Parses Set-Cookie (leading
// name=value, last write wins) and replays the accumulated Cookie header.
new Api(url, { cookies: true });
```

**Redirect following (all verbs + download):** unlike bare `node:http`/`node:https`, the client now follows 3xx redirects (bounded to 10 hops). 301/302/303 on a body-bearing method become GET (body dropped, matching urllib); 307/308 preserve method + body. **Security:** the `Authorization` AND `Cookie` headers are STRIPPED when the redirect target is a different origin (scheme/host/port), so a bearer token or session cookie never leaks to a host you didn't authenticate to; same-origin redirects keep them. Full parity with Python master.

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

## Graceful shutdown (`packages/core/src/server.ts`)

`startServer()` owns signal handling. It is the ONLY place that registers
`process.on("SIGTERM"/"SIGINT")` — `background.ts` and the CLI's `serve.ts`
deliberately register none.

On SIGTERM or SIGINT it: stops background tasks, sends RFC 6455 close code
**1001 ("going away")** to every live WebSocket, closes the listeners so new
connections get a clean refusal, waits for in-flight requests to finish (up to
`TINA4_SHUTDOWN_TIMEOUT`), closes the database, and exits **0**.

| Env var | Default | Purpose |
| --- | --- | --- |
| `TINA4_SHUTDOWN_TIMEOUT` | `30` | Seconds to wait for in-flight requests before force-closing them. Matches Kubernetes' default `terminationGracePeriodSeconds` and Gunicorn's `graceful_timeout`, and is the same env var and default as tina4-python / tina4-php / tina4-ruby. A non-numeric or negative value warns and falls back to 30. |
| `TINA4_DEFAULT_WEBSERVER` | unset | **Accepted and ignored in Node.** `TRUE` pins the built-in server. Node has only one server (`node:http`), so there is nothing to switch and this is a genuine no-op. It exists here so the env surface is identical across all four frameworks: in tina4-python it forces the built-in asyncio server instead of uvicorn/hypercorn/granian, and in tina4-ruby it forces WEBrick instead of Puma. Setting it must never be an error. |

**SIGHUP is deliberately NOT trapped** — the default disposition terminates the
process. The Rust CLI owns file watching and production logs go to stdout, so
neither Puma's log-reopen nor gunicorn's config-reload use for SIGHUP applies.
`test/gracefulShutdown.test.ts` pins this so it is not restored by accident.

**Never register a signal handler that does not exit.** Adding any listener for
SIGTERM REPLACES Node's default disposition, so a handler that only cleans up
does not "add" to the default, it CANCELS it — the process then ignores SIGTERM
and runs until SIGKILL. `background.ts` shipped exactly that bug: a server with
one registered `background()` task hung forever on SIGTERM, burning the whole
Kubernetes grace period on every rolling deploy.

Set `terminationGracePeriodSeconds` ABOVE `TINA4_SHUTDOWN_TIMEOUT` in your pod
spec so the drain finishes before SIGKILL.

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
stopAllBackgroundTasks(); // stop everything (the server's shutdown calls this on SIGTERM/SIGINT)
backgroundTaskCount();    // test helper
```

**Never use bare `setInterval` for periodic work in a Tina4 app.** `background()` catches errors, is cleared by the server's graceful shutdown (which owns the signal handlers), calls `timer.unref()` so it doesn't block process exit, and matches Python's `background()` API exactly.

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

Unified multi-backend cache. Used as middleware to cache GET responses, or directly via the **async** KV API (`cacheGet`/`cacheSet`/…) for arbitrary key/value caching. Seven backends, selected by `TINA4_CACHE_BACKEND`: `memory` (default), `file`, `redis`, `valkey`, `memcached`, `mongodb`, `database`.

```typescript
import {
  responseCache, cacheGet, cacheSet, cacheDelete, cacheClear, cacheStats,
} from "@tina4/core";

// Middleware on a route
get("/api/products", listProducts).middleware(responseCache({ ttl: 60 }));

// Direct key/value usage — Node's KV API is ASYNC (await), matching Node's
// async-everywhere idiom. All 7 backends use native async clients (no child processes).
await cacheSet("user:1", { name: "Alice" }, 120);
const u = await cacheGet("user:1");
await cacheDelete("user:1");
await cacheClear();

await cacheStats();   // { hits, misses, size, backend } — reflects the real KV backend
```

**Async everywhere (full parity):** the KV API, the `responseCache` middleware, and the persistent DB query cache all route through the same unified async backend set with native async clients (no child processes). The `responseCache` middleware and persistent DB cache distribute cross-instance when a network backend (redis/valkey/memcached/mongodb/database) is selected — exactly like Python/PHP/Ruby. The default `memory` backend keeps both in-process (fastest), so default behaviour is unchanged. Because the KV/middleware API is async, **`await` it** (`await cacheGet`/`await cacheSet`/`await clearCache`; the middleware runner and `db.fetch` are async). Request-scoped DB caching (`TINA4_AUTO_CACHING`) always stays in-process.

**Graceful fallback**: if a configured backend's driver is missing or the service/credentials are unreachable or wrong, the cache logs a warning and falls back to the **file** backend — a real persistent cache, never a silent no-op.

Environment:
- `TINA4_CACHE_BACKEND` — `memory` (default) | `file` | `redis` | `valkey` | `memcached` | `mongodb` | `database`
- `TINA4_CACHE_URL` — connection for redis/valkey/memcached/mongodb (`redis://localhost:6379`, `mongodb://host`), OR a SQL URL for `database` (falls back to `TINA4_DATABASE_URL`)
- `TINA4_CACHE_USERNAME` / `TINA4_CACHE_PASSWORD` — credentials (mirror `TINA4_DATABASE_USERNAME`/`_PASSWORD`); may also be embedded in `TINA4_CACHE_URL` (`redis://user:pass@host`, `redis://:pass@host`, `mongodb://user:pass@host`). memcached is unauthenticated
- `TINA4_CACHE_TTL` — default TTL seconds (default: `60`)
- `TINA4_CACHE_MAX_ENTRIES` — max entries (default: `1000`)
- `TINA4_CACHE_DIR` — directory for the `file` backend (default: `data/cache`)

## Firebird-Specific Rules

When using Firebird as the database engine:

- **No `IF NOT EXISTS`** for `ALTER TABLE ADD` — the migration runner detects already-present columns via `RDB$RELATION_FIELDS` and skips silently.
- **No `AUTOINCREMENT`** — use generators. `db.getNextId(table, pkColumn?, generatorName?)` creates and uses generators (default name: `GEN_<TABLE>_ID`).
- **Pagination** — `SQLTranslator.limitToRows()` rewrites `LIMIT n OFFSET m` to Firebird's `ROWS m+1 TO m+n` syntax automatically.
- **No `TEXT` type** — use `VARCHAR(n)` or `BLOB SUB_TYPE TEXT`. The migration tracker schema (`tina4_migration`) uses `VARCHAR(500)` for the name column on Firebird.
- **No `REAL`/`FLOAT`** — use `DOUBLE PRECISION`.
- **BLOB handling** — `db.fetch()` and `db.fetchOne()` auto-convert memoryview/Buffer BLOB columns to `Buffer` (raw bytes, not base64).
- **No triggers, no foreign keys** in migrations on Firebird-targeted projects — relationships are wired in the ORM layer instead.

## How DevReload works (WebSocket-primary)

DevReload is **WebSocket-primary** — the reload is instant, not polled. The `tina4` Rust CLI is the sole file watcher for the Tina4 stack; there is no framework-side watcher. The flow:

1. Rust CLI (`npx tina4nodejs serve`) watches `src/`, `migrations/`, `.env`. Noise is filtered (Access/Metadata events, `node_modules`, `.git`, `dist`, `logs`, `.log`/`.db*`/`.swp` files) and a real mtime check defeats overlayfs spurious events. The CLI does **not** restart the worker process.
2. On a real change, the CLI POSTs `/__dev/api/reload` to the running server.
3. The server re-runs route discovery — re-importing changed `src/routes/` files **in-process** (mtime-tracked; `addRoute()` replaces the same-pattern route so the fresh handler wins) so the worker keeps the same PID — then bumps its reload counter.
4. The server **broadcasts** a JSON message `{type, file, mtime}` to every browser connected on the `/__dev_reload` WebSocket (`type` is `"css"` for `.css`/`.scss` changes, else `"reload"`). The `/__dev_reload` route is registered (debug-only) on the main server's HTTP `upgrade` event and held open by the dev-reload connection manager (`devReloadWs` in `websocket.ts`). The broadcast is wrapped so a failure (or zero clients) never breaks the endpoint. The counter is also exposed at `GET /__dev/api/mtime` for the polling fallback.
5. The injected dev-toolbar client is **WebSocket-primary**: it opens a WebSocket to `/__dev_reload` (`ws`/`wss` by page protocol); on a `{type: reload|change|css}` message it swaps `<link rel=stylesheet>` hrefs with a cache-bust query for CSS, else does a full `location.reload()`. It **stops** the fallback poll the moment the socket connects, and only **starts** the `/__dev/api/mtime` poll (every 3 s) when the socket drops — reconnecting after ~2 s. The poll initialises its last-seen mtime to a `null` sentinel (not `0`) and reloads when the polled mtime *differs* (`!==`, not `>`), so the first change after load isn't swallowed and a counter reset on restart still triggers. **In normal operation there is no polling.**

No configuration needed — set `TINA4_DEBUG=true` to enable. If you're running without the Rust CLI (e.g. Docker, `TINA4_OVERRIDE_CLIENT=true`), there is no automatic reload; the production path is unaffected.

> **Dev caveat (`.ts` routes under `tsx`):** the in-process re-import (step 3) cache-busts the dynamic `import()` by file mtime. This is reliable for `.js` routes under Node's native ESM loader (built/production path). Under `tsx` (the default dev runner), `tsx`'s ESM loader caches compiled `.ts` modules and ignores the cache-bust, so an edited **`.ts` route body** is re-broadcast (browser reloads) but the new handler is only picked up after a full restart. The WebSocket broadcast, CSS hot-reload, new-file registration, and no-respawn behaviour all work under `tsx`.

**AI dual-port mode:** when `TINA4_DEBUG=true` and `TINA4_NO_AI_PORT` is unset, the **main port** provides the normal hot-reload experience (dev toolbar + `/__dev_reload` injected) for the human dev, and a second server on `port+1000` is the **stable AI port** — it suppresses reload/toolbar injection (and returns 404 for `/__dev_reload`) so an AI tool can drive it without its own edits triggering a refresh. The `tina4` client posts `/__dev/api/reload` to the **main port**. Matches Python (master), PHP, and Ruby.

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
Set `TINA4_DATABASE_URL` in your `.env` file using `driver://host:port/database` format:

```bash
# SQLite (default if nothing configured)
# Slash count decides relative vs absolute (the SQLAlchemy convention,
# identical in all four frameworks). THREE slashes is RELATIVE to the working
# directory; an absolute path needs FOUR.
TINA4_DATABASE_URL=sqlite:///app.db                 # relative: ./app.db
TINA4_DATABASE_URL=sqlite:////var/data/app.db       # absolute: /var/data/app.db
TINA4_DATABASE_URL=sqlite:/var/data/app.db          # absolute (one slash) too
TINA4_DATABASE_URL=sqlite://./data/tina4.db
# FOOTGUN: "sqlite://" + an absolute path yields THREE slashes, so the file is
# created UNDER the working directory and a stray ./var/data/ tree appears.

# PostgreSQL
TINA4_DATABASE_URL=postgres://localhost:5432/mydb
TINA4_DATABASE_URL=postgresql://localhost:5432/mydb

# MySQL
TINA4_DATABASE_URL=mysql://localhost:3306/mydb

# MSSQL / SQL Server (both schemes work)
TINA4_DATABASE_URL=mssql://localhost:1433/mydb
TINA4_DATABASE_URL=sqlserver://localhost:1433/mydb

# Firebird
TINA4_DATABASE_URL=firebird://localhost:3050/mydb
```

### Credentials
Credentials can be embedded in the URL or provided separately:

```bash
# In the URL
TINA4_DATABASE_URL=postgres://user:pass@localhost:5432/mydb

# Or as separate env vars (merged when URL has no credentials)
TINA4_DATABASE_URL=postgres://localhost:5432/mydb
TINA4_DATABASE_USERNAME=myuser
TINA4_DATABASE_PASSWORD=mypass
```

Credential priority: `config.user` > `config.username` > `TINA4_DATABASE_USERNAME` env var.

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

- **98 built-in features**, zero third-party dependencies
- **6,230 tests** passing, 0 failed, across 198 files (build + typecheck green) - measured 2026-07-29 on Ubuntu 24.04.4 LTS x86_64, Node 24.18.0, live services, TINA4_REQUIRE_SERVICES=1; Firebird excluded by design
- **Race-safe `getNextId()`** with atomic sequence table (`tina4_sequences`) for SQLite/MySQL/MSSQL; PostgreSQL auto-creates sequences
- **Frond template engine optimizations**: pre-compiled regexes, lazy loop context (copy-on-write), filter chain caching, path split caching, inline common filters (11-15% speedup)
- **Production server auto-detect**: `npx tina4nodejs serve --production` auto-uses cluster mode
- **`npx tina4nodejs generate`**: model, route, migration, middleware scaffolding
- **Database**: 5 engines (SQLite, PostgreSQL, MySQL, MSSQL, Firebird), DB query caching — request-scoped auto cache **off by default — opt-in via `TINA4_AUTO_CACHING=true`** (TTL `TINA4_AUTO_CACHING_TTL=5`s) which dedupes identical `db.fetch()`/ORM reads within a request and flushes on writes (always in-process); default OFF because a request-scoped cache defaulting on is a read-after-write footgun (cached pre-write `SELECT MAX(id)` → duplicate PKs); persistent cross-request cache opt-in via `TINA4_DB_CACHE=true` (TTL `TINA4_DB_CACHE_TTL=30`s) routed through the unified async backend set via `TINA4_DB_CACHE_BACKEND` (memory/file/redis/valkey/memcached/mongodb/database) + `TINA4_DB_CACHE_URL`, so instances share one cache with global write-invalidation (full parity with Python/PHP/Ruby). `db.cacheStats()` reports `mode` (request/persistent/off) + `backend`
- **Cache**: unified backend set — `memory` (default), `file`, `redis`, `valkey`, `memcached`, `mongodb`, `database` — via `TINA4_CACHE_BACKEND` (+ `TINA4_CACHE_URL`/credentials); file-backend fallback if a backend is unreachable. The KV API, the `responseCache` middleware, and the persistent DB query cache all route through this async backend set (native async clients, no child processes) — a network backend distributes them cross-instance, full parity with Python/PHP/Ruby; `memory` (default) keeps them in-process. `await` the async API (`cacheGet`/`cacheSet`/`clearCache`)
- **Sessions**: file backend (default). `TINA4_SESSION_SAMESITE` env var (default: Lax)
- **Queue**: file/RabbitMQ/Kafka/MongoDB backends, configured via env vars. **Reservation/visibility timeout** (file + MongoDB): a popped job is reserved for `TINA4_QUEUE_VISIBILITY_TIMEOUT` seconds (default 300; `visibilityTimeout` Queue option; `<= 0` disables) — if the consumer dies before `complete()`/`fail()`, the next `pop()` reclaims it (incrementing `attempts`, dead-lettering past `maxRetries`), so a crashed/evicted consumer never strands a job. RabbitMQ/Kafka delegate redelivery to the broker.
- **Cache**: memory/Redis/file backends
- **Messenger**: .env driven SMTP/IMAP. **Cross-framework contract:** `inbox(folder = "INBOX", limit = 20, offset = 0)` takes the folder FIRST (same order in all four frameworks — Node was the outlier at `(limit, offset, folder)` before 3.13.95); `uid` is a **string** everywhere; `read(uid, folder?)` returns `ImapFullMessage | null` and a non-existent UID reads as **`null`** — falsy, so `if (!message)` is the portable missing-message check, matching Python's `{}`, PHP's `null` and Ruby's `nil`. A missing UID is NOT an error and never throws. IMAP reads DO fail loud on a connection/auth/protocol failure: `inbox`/`read`/`unread`/`search`/`folders` all raise `MessengerConnectionError` rather than swallowing it into an empty result. Real SMTP + IMAP round-trips are covered against a live GreenMail in `test/messengerGreenMail.test.ts` (ports 3025/3143; `TINA4_TEST_SMTP_*` / `TINA4_TEST_IMAP_*` to relocate)
- **ORM relationships**: `hasMany`, `hasOne`, `belongsTo` with eager loading (`include`)
- **Frond pre-compilation**: 2.8x template render improvement
- **QueryBuilder** with NoSQL/MongoDB support (`toMongo()`)
- **WebSocket backplane** (Redis/NATS pub/sub) for horizontal scaling — wired for real: local-first resilient delivery, then publish a `{src,kind,exclude,room,path,text|b64}` envelope to the `tina4:ws` channel (cross-framework wire shape); subscribe relays directly with an origin guard (no own-echo) and never re-publishes. Origin allow-list (`TINA4_WS_ALLOWED_ORIGINS`), idle reaper (`TINA4_WS_IDLE_TIMEOUT`), and slow-client drop (`TINA4_WS_MAX_BACKLOG`) — all opt-in/non-breaking
- **SameSite=Lax** default on session cookies (`TINA4_SESSION_SAMESITE`)
- **`tina4 deploy docker`** generates Dockerfile and .dockerignore
- **Gallery**: 7 interactive examples with Try It deploy at `/_dev/`
- **SSE/Streaming**: `response.stream()` for Server-Sent Events — pass an async generator; framework handles chunked transfer encoding plus a periodic keep-alive heartbeat (`TINA4_SSE_HEARTBEAT`, default 15s, `0` to disable). Hardened against client disconnect (bails when the socket is gone), a generator error mid-stream (logs + ends cleanly, never crashes the worker), and slow clients (awaits socket drain instead of unbounded buffering)

## Don'ts

- **Don't add Express, Fastify, or any HTTP framework** — we use native `node:http`
- **Don't use decorators** — convention-based models with static properties
- **Don't add CommonJS** — everything is ESM (`"type": "module"`)
- **Don't bundle `swagger-ui-dist`** — we load Swagger UI from CDN to stay under 8MB
- **Don't break the test files** — run `npm test` before committing
- **Don't add unnecessary dependencies** — minimal footprint is a core principle
- **Parity across all frameworks** — Every new feature, fix, or optimization must be implemented with equivalent logic AND tests in all 4 Tina4 frameworks (Python, PHP, Ruby, Node.js). Never ship to one without shipping to all.
- **NO mock testing. Mocks are not acceptable in any circumstances.** A test double (mock, stub, fake, spy, monkeypatch, script-introspection assertion, or any in-test object standing in for a real collaborator) may never substitute for a real dependency, under any justification. There is no "supplement" exception and no "hard to reproduce" exception. Any test that touches a dependency (a DB engine, MongoDB, Redis/Valkey/Memcached, RabbitMQ/Kafka, an HTTP/SMTP service, the filesystem, a socket) must exercise the REAL service; if a failure mode is hard to trigger, reproduce it for real, never simulate it. "Verified"/"green" requires a real run; a passing mock test is not verification. CI provisions the services; use them and add any that is missing. The only tests that need no live dependency are pure functions with no dependency and no double; that is not a mock test. (The MongoDB queue re-delivered every completed job for two releases because its queue tests were mock/script-introspection-based and never ran against a real Mongo.)
- **Don't use `url.parse()`** — use the WHATWG `URL` constructor instead (deprecated in Node 20+)

## Tina4 Maintainer Skill
Always read and follow the instructions in .claude/skills/tina4-maintainer/SKILL.md when working on this codebase. Read its referenced files in .claude/skills/tina4-maintainer/references/ as needed for specific subsystems.

## Tina4 Developer Skill
Always read and follow the instructions in .claude/skills/tina4-developer-nodejs/SKILL.md when building applications with this framework. Read its referenced files in .claude/skills/tina4-developer-nodejs/references/ as needed.

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

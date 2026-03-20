# tina4-nodejs v3.0 — Gameplan

## Current State (v2)
- **Strong:** File-based routing (pioneered), auto-CRUD from models, auto-migration, Swagger/OpenAPI, query filtering/sorting/pagination, TypeScript-first, minimal footprint (~2000 lines)
- **Weak:** Most features missing — only SQLite driver, no auth, no sessions, no queue, no GraphQL, no WebSocket, no WSDL, no localization, no seeder, no email, no SCSS, no migrations (only auto-sync)
- **Third-party to remove:** `twig` npm package, `better-sqlite3` (keep — no Node.js stdlib SQLite)

## v3 Branch Strategy
- Create `v3` branch from current `main`
- v2 continues independently
- v3 development in monorepo under `nodejs/`

## Implementation Phases

### Phase 1: Foundation (Zero-Dep Core)
1. [ ] **DotEnv parser** — parse `.env` files natively
2. [ ] **Structured logger** — JSON (prod) / text (dev), request ID tracking
3. [ ] **Database adapter interface** — standardize contract, keep existing pattern
4. [ ] **SQLite adapter** — keep `better-sqlite3` (no stdlib alternative)
5. [ ] **DATABASE_URL parser** — auto-detect driver from URL scheme
6. [ ] **Router refactor** — keep file-based, add route caching, middleware pipeline, route model binding
7. [ ] **Middleware pipeline** — NEW, hook system (onRequest, beforeResponse, onError)
8. [ ] **Health check endpoint** — auto-registered `/health`
9. [ ] **Graceful shutdown** — `process.on('SIGTERM')` handlers
10. [ ] **CORS middleware** — declarative config from env vars
11. [ ] **Rate limiter** — in-memory + database-backed
12. [ ] **Standardize response types** — keep existing, add xml/text/file

### Phase 2: ORM & Data Layer
13. [ ] **ORM refactor** — keep convention-based models, add SQL-first methods
14. [ ] **Soft delete** — `deletedAt` field, auto-filtering, `restore()`, `forceDelete()`, `withTrashed()`
15. [ ] **Relationships** — `hasOne()`, `hasMany()` with eager loading
16. [ ] **Scopes** — reusable query filters on models
17. [ ] **Field mapping** — map property names to column names
18. [ ] **Paginated results** — keep existing format, standardize
19. [ ] **Result caching** — configurable per-query cache
20. [ ] **Input validation** — keep existing, standardize error format
21. [ ] **PostgreSQL adapter** — NEW, using `pg` npm
22. [ ] **MySQL adapter** — NEW, using `mysql2` npm
23. [ ] **MSSQL adapter** — NEW, using `tedious` npm
24. [ ] **Firebird adapter** — NEW, using `node-firebird` npm
25. [ ] **ODBC adapter** — NEW, using `odbc` npm
26. [ ] **Migrations** — NEW, file-based with run/create/rollback (.down.sql)

### Phase 3: Frond Template Engine
27. [ ] **Lexer** — tokenize Frond syntax (replaces `twig` npm)
28. [ ] **Parser** — build AST
29. [ ] **Compiler** — compile to JS functions
30. [ ] **Runtime** — execute with context
31. [ ] **All filters** — implement full filter set (~55 filters)
32. [ ] **All tags** — full tag set
33. [ ] **Tests** — all type tests
34. [ ] **Functions** — all built-in functions
35. [ ] **Extensibility API** — `addFilter`/`addFunction`/`addGlobal`/`addTest`/`addTag`
36. [ ] **Auto-escaping** — html/js/css/url strategies
37. [ ] **Sandboxing** — restrict access
38. [ ] **Template caching** — in-memory with dev invalidation via `fs.watch`
39. [ ] **Fragment caching** — `{% cache %}` tag
40. [ ] **`res.render()` integration** — replace Twig middleware

### Phase 4: Auth & Sessions
41. [ ] **JWT implementation** — NEW, using `node:crypto`
42. [ ] **Session: file backend** — NEW
43. [ ] **Session: Redis backend** — NEW, using `ioredis` npm
44. [ ] **Session: Memcache backend** — NEW, using `memcached` npm
45. [ ] **Session: MongoDB backend** — NEW, using `mongodb` npm
46. [ ] **Session: database backend** — NEW, using connected DB adapter
47. [ ] **Swagger/OpenAPI** — keep existing, add auth scheme support

### Phase 5: Extended Features
48. [ ] **Queue (DB-backed)** — NEW, zero-dep, uses connected database
49. [ ] **SCSS compiler** — NEW, build native TypeScript SCSS parser
50. [ ] **API client** — NEW, using `node:http`/`node:https` (no `fetch` polyfill needed in Node 20+)
51. [ ] **GraphQL** — NEW, port from Python/Ruby zero-dep parser
52. [ ] **WebSocket** — NEW, using `node:http` upgrade + native WebSocket API
53. [ ] **WSDL/SOAP** — NEW, port from Python/Ruby
54. [ ] **Localization** — NEW, JSON translation files
55. [ ] **Email/Messenger** — NEW, using `node:net` for SMTP
56. [ ] **Seeder/FakeData** — NEW
57. [ ] **Auto-CRUD** — keep existing, standardize endpoints
58. [ ] **Event/listener system** — NEW (can leverage `EventEmitter`)

### Phase 6: CLI & DX
59. [ ] **CLI: init** — keep existing scaffold, update for v3 structure
60. [ ] **CLI: serve** — keep existing with hot reload
61. [ ] **CLI: migrate** — NEW, `tina4 migrate` / `tina4 migrate:create` / `tina4 migrate:rollback`
62. [ ] **CLI: seed** — NEW, `tina4 seed` / `tina4 seed:create`
63. [ ] **CLI: test** — NEW, `tina4 test`
64. [ ] **CLI: routes** — NEW, list all registered routes
65. [ ] **Debug overlay** — inject shared debug overlay in dev mode
66. [ ] **frond.js** — copy shared JS to `public/js/`

### Phase 7: Testing
67. [ ] **Implement all shared test specs**
68. [ ] **Frond tests** — 20 positive + 5 negative
69. [ ] **ORM tests** — full coverage
70. [ ] **Database tests** — per driver
71. [ ] **Router tests** — patterns, middleware, caching, model binding
72. [ ] **Auth tests** — JWT, session backends
73. [ ] **Queue tests** — enqueue/dequeue/retry/failure
74. [ ] **Integration tests** — end-to-end HTTP
75. [ ] **Performance benchmarks**

## Naming Conventions (TypeScript Best Practice + Tina4 Convention)
- Classes: `PascalCase` — `DatabaseAdapter`, `UserModel`, `FrondEngine`
- Methods: `camelCase` — `fetchOne()`, `softDelete()`, `hasMany()`
- Constants: `UPPER_SNAKE` — `DATABASE_URL`, `TINA4_DEBUG`
- Files: `camelCase.ts` — `databaseAdapter.ts`, `frondEngine.ts`
- Types/Interfaces: `PascalCase` — `DatabaseAdapter`, `FieldDefinition`, `PaginatedResult`
- Test files: `*.test.ts` — `frond.test.ts`, `orm.test.ts`

## Dependencies (v3)
### Zero (built from scratch)
- Frond, JWT, SCSS, DotEnv, Queue, API client, Logger, Rate limiter, GraphQL, WSDL, WebSocket, Email, Seeder, Localization, Event system, Cache, Migrations

### Node.js built-in modules only
- `node:http`, `node:https`, `node:crypto`, `node:fs`, `node:path`, `node:url`, `node:net`, `node:events`, `node:util`

### Database drivers (optional npm packages)
- `better-sqlite3` (SQLite — required, no stdlib alternative)
- `pg` (PostgreSQL)
- `mysql2` (MySQL)
- `tedious` (MSSQL)
- `node-firebird` (Firebird)
- `odbc` (ODBC)

### Session backends (optional npm packages)
- `ioredis` (Redis)
- `memcached` (Memcache)
- `mongodb` (MongoDB)

## Note: Node.js Has the Most Work
Node.js v2 is the most minimal framework (~2000 lines). v3 requires building 36+ features from scratch. However, the existing patterns (file-based routing, convention-based models, auto-CRUD) are excellent foundations that the other frameworks should learn from.

## TypeScript Configuration
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  }
}
```
ESM-only. No CommonJS. Node.js 20+ required.

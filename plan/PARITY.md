# Tina4 Node.js — Feature Parity Checklist

Version: 3.10.37 | Last updated: 2026-03-31 | Reference: tina4-python

This checklist tracks feature parity against the Python reference implementation.

## Core HTTP Engine

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| Router (GET/POST/PUT/PATCH/DELETE/ANY) | [x] | [x] | `router.ts` — 586 lines |
| Path params ({id:int}, {price:float}, {path:path}) | [x] | [x] | |
| Wildcard routes (*) | [x] | [x] | |
| Route grouping | [x] | [x] | |
| Route discovery | [x] | [x] | `routeDiscovery.ts` |
| Server | [x] | [x] | `server.ts` — 854 lines |
| Request object | [x] | [x] | `request.ts` |
| Response object | [x] | [x] | `response.ts` — with headersSent guards |
| Static file serving | [x] | [x] | `static.ts` |
| CORS middleware | [x] | [x] | In `middleware.ts` |
| Health endpoint | [x] | [x] | `health.ts` |
| Constants | [x] | [x] | `constants.ts` |

## Auth & Security

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| JWT auth (zero-dep) | [x] | [x] | `auth.ts` |
| Password hashing | [x] | [x] | |
| @secured / @noauth | [x] | [x] | Via route options |
| Form token (CSRF) | [x] | [x] | |
| CSRF middleware | [x] | [x] | In `middleware.ts` |
| Rate limiter | [x] | [x] | `rateLimiter.ts` |
| Validator | [x] | [x] | `validator.ts` |

## Database

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| URL-based multi-driver connection | [x] | [x] | `database.ts` (packages/orm) |
| Connection pooling | [x] | [ ] | Less sophisticated than Python |
| SQLite driver | [x] | [x] | `adapters/sqlite.ts` |
| PostgreSQL driver | [x] | [x] | `adapters/postgres.ts` |
| MySQL driver | [x] | [x] | `adapters/mysql.ts` |
| MSSQL driver | [x] | [x] | `adapters/mssql.ts` |
| Firebird driver | [x] | [x] | `adapters/firebird.ts` |
| ODBC driver | [ ] | [ ] | Not implemented |
| DatabaseResult | [x] | [x] | `databaseResult.ts` |
| SQL translation | [x] | [x] | `sqlTranslator.ts` |
| Query caching | [x] | [x] | `cachedDatabase.ts` |
| get_next_id | [x] | [x] | |
| Transactions | [x] | [x] | |

## ORM

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| Active Record (save/load/delete/select) | [x] | [x] | `baseModel.ts` — 949 lines |
| Field types | [x] | [x] | |
| Relationships | [x] | [x] | |
| Soft delete | [x] | [x] | |
| create_table() | [x] | [x] | |
| QueryBuilder | [x] | [x] | `queryBuilder.ts` |
| AutoCRUD | [x] | [x] | `autoCrud.ts` |
| Model validation | [x] | [x] | `validation.ts` — extra, not in Python |

## Template Engine (Frond)

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| Twig-compatible syntax | [x] | [x] | `engine.ts` — 2100 lines |
| Block inheritance | [x] | [x] | |
| parent()/super() in blocks | [x] | [x] | |
| Include/import/macro | [x] | [x] | |
| Filters | [x] | [x] | |
| Custom filters/globals/tests | [x] | [x] | |
| SafeString | [x] | [x] | |
| Fragment caching | [x] | [x] | |
| Raw blocks | [x] | [x] | |
| Sandbox mode | [x] | [x] | |
| form_token / formTokenValue | [x] | [x] | |
| Arithmetic in {% set %} | [x] | [x] | |
| Filter-aware conditions | [x] | [x] | |
| Dev mode cache bypass | [x] | [x] | |

## API & Protocols

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| API client (zero-dep) | [x] | [x] | `api.ts` |
| Swagger/OpenAPI generator | [x] | [x] | `packages/swagger/` |
| GraphQL engine | [x] | [x] | `graphql.ts` — 812 lines |
| WSDL/SOAP server | [x] | [x] | `wsdl.ts` — 568 lines |
| MCP server | [x] | [x] | `mcp.ts` — 992 lines |

## Real-time & Messaging

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| WebSocket server | [x] | [x] | `websocket.ts` |
| WebSocket backplane | [x] | [x] | `websocketBackplane.ts` |
| Messenger (SMTP/IMAP) | [x] | [x] | `messenger.ts` — 904 lines |

## Queue

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| Database-backed job queue | [x] | [x] | `queue.ts` — 711 lines |
| Kafka backend | [x] | [x] | |
| RabbitMQ backend | [x] | [x] | |
| MongoDB backend | [x] | [x] | |

## Sessions

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| File session handler | [x] | [x] | Default |
| Database session handler | [x] | [x] | |
| Redis session handler | [x] | [x] | |
| Valkey session handler | [x] | [x] | |
| MongoDB session handler | [x] | [x] | |

## Infrastructure

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| Migrations | [x] | [x] | `migration.ts` — 747 lines |
| Seeder / FakeData | [x] | [x] | `seeder.ts` + `fakeData.ts` |
| i18n / Localization | [x] | [x] | `i18n.ts` |
| SCSS compiler | [x] | [x] | `scss.ts` |
| Events | [x] | [x] | `events.ts` |
| DotEnv loader | [x] | [x] | `dotenv.ts` |
| Structured logging | [x] | [x] | `logger.ts` |
| Error overlay | [x] | [x] | `errorOverlay.ts` |
| DI Container | [x] | [x] | `container.ts` |
| Response cache | [x] | [x] | `cache.ts` |
| Service runner | [x] | [x] | `service.ts` |

## Dev Tools

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| DevAdmin dashboard | [x] | [x] | `devAdmin.ts` — 2103 lines |
| DevMailbox | [x] | [x] | `devMailbox.ts` |
| DevReload (live-reload) | [x] | [x] | `watcher.ts` + server.ts |
| Gallery (interactive examples) | [x] | [x] | |
| Metrics (code analysis) | [ ] | [ ] | Not yet ported from Python |
| Version check | [x] | [ ] | Needs proxy like Python |

## Testing & CLI

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| TestClient | [x] | [x] | `testing.ts` |
| Inline testing | [x] | [x] | |
| CLI (init, serve, migrate, generate) | [x] | [x] | `packages/cli/` |
| AI context detection | [x] | [x] | `ai.ts` |

## Static Assets

| Feature | Present | Up to scratch | Notes |
|---------|---------|---------------|-------|
| Minified CSS (tina4.min.css) | [x] | [x] | |
| Minified JS (tina4.min.js, frond.min.js) | [x] | [x] | |
| HtmlElement builder | [x] | [x] | `htmlElement.ts` |

## Gaps vs Python Reference

| Gap | Priority | Notes |
|-----|----------|-------|
| ODBC driver | Low | Python has it |
| Metrics (code analysis) | High | Not yet ported from Python |
| Test coverage depth | High | Most tests have only 1 it() — needs expansion |

## Summary

- **Total features**: 75
- **Present**: 74/75
- **Up to scratch**: 72/75
- **Gaps**: 1 missing feature (metrics), 2 not fully up to scratch

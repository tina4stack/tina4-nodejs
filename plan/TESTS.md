# Tina4 Node.js — Test Coverage Plan

Version: 3.10.37 | Last updated: 2026-03-31

## Summary

- **Test files**: 57
- **Test assertions (it() calls)**: ~152
- **Test runner**: Node.js built-in test runner (`node --test`)
- **Run all**: `npm test` (from packages/core or root)

## Test Inventory

| # | Test File | Tests | Feature | Status |
|---|-----------|-------|---------|--------|
| 1 | ai.test.ts | 1 | AI integration | Minimal |
| 2 | auth.test.ts | 3 | Auth/JWT | Minimal |
| 3 | autoCrud.test.ts | 1 | AutoCRUD endpoints | Minimal |
| 4 | basePath.test.ts | 1 | Base path routing | Minimal |
| 5 | cache.test.ts | 1 | Cache | Minimal |
| 6 | container.test.ts | 1 | DI Container | Minimal |
| 7 | cors.test.ts | 1 | CORS middleware | Minimal |
| 8 | csrfMiddleware.test.ts | 1 | CSRF protection | Minimal |
| 9 | database.test.ts | 1 | Database core | Minimal |
| 10 | databaseDrivers.test.ts | 2 | DB adapter loading | Minimal |
| 11 | databaseSession.test.ts | 2 | Database session handler | Minimal |
| 12 | devAdmin.test.ts | 1 | Dev admin dashboard | Minimal |
| 13 | devMailbox.test.ts | 18 | Dev mailbox | Good |
| 14 | dotenv.test.ts | 1 | DotEnv loading | Minimal |
| 15 | errorOverlay.test.ts | 1 | Error overlay | Minimal |
| 16 | events.test.ts | 24 | Events system | Good |
| 17 | explicitRouter.test.ts | 1 | Explicit route registration | Minimal |
| 18 | fakeData.test.ts | 4 | Fake data generation | Minimal |
| 19 | fetchResult.test.ts | 1 | API client fetch result | Minimal |
| 20 | formToken.test.ts | 3 | Form token security | Minimal |
| 21 | frond.test.ts | 3 | Frond template engine | **Critical gap** |
| 22 | graphql.test.ts | 1 | GraphQL | Minimal |
| 23 | health.test.ts | 1 | Health endpoint | Minimal |
| 24 | htmlElement.test.ts | 1 | HTML element builder | Minimal |
| 25 | i18n.test.ts | 1 | i18n/localization | Minimal |
| 26 | liveReload.test.ts | 11 | Live reload/watcher | Good |
| 27 | logger.test.ts | 5 | Logger | Adequate |
| 28 | mcp.test.ts | 1 | MCP server | Minimal |
| 29 | messenger.test.ts | 1 | Email/messenger | Minimal |
| 30 | middleware.test.ts | 1 | Middleware chain | Minimal |
| 31 | migration.test.ts | 1 | Migrations | Minimal |
| 32 | mongoQueue.test.ts | 1 | MongoDB queue backend | Minimal |
| 33 | orm.test.ts | 1 | ORM base model | Minimal |
| 34 | portConfig.test.ts | 1 | Port configuration | Minimal |
| 35 | postProtection.test.ts | 1 | POST protection middleware | Minimal |
| 36 | queryBuilder.test.ts | 7 | Query builder | Adequate |
| 37 | queue.test.ts | 1 | Queue system | Minimal |
| 38 | queueBackends.test.ts | 1 | Queue backends | Minimal |
| 39 | rateLimiter.test.ts | 1 | Rate limiting | Minimal |
| 40 | request.test.ts | 1 | Request parsing | Minimal |
| 41 | response.test.ts | 1 | Response object | Minimal |
| 42 | responseMethods.test.ts | 1 | Response helper methods | Minimal |
| 43 | router.test.ts | 1 | Router | Minimal |
| 44 | scss.test.ts | 1 | SCSS compilation | Minimal |
| 45 | secureByDefault.test.ts | 1 | Secure-by-default config | Minimal |
| 46 | seeder.test.ts | 2 | Database seeding | Minimal |
| 47 | service.test.ts | 1 | Background services | Minimal |
| 48 | session.test.ts | 1 | Sessions | Minimal |
| 49 | sessionHandlers.test.ts | 1 | Session handler backends | Minimal |
| 50 | smoke.test.ts | 4 | Smoke/integration | Minimal |
| 51 | sqlTranslation.test.ts | 1 | SQL dialect translation | Minimal |
| 52 | static.test.ts | 17 | Static file serving | Good |
| 53 | swagger.test.ts | 1 | Swagger generation | Minimal |
| 54 | templateRoute.test.ts | 1 | Template routes | Minimal |
| 55 | testing.test.ts | 1 | TestClient | Minimal |
| 56 | websocket.test.ts | 1 | WebSocket | Minimal |
| 57 | wsdl.test.ts | 1 | WSDL/SOAP | Minimal |

## Critical Gaps

Node.js has the **weakest test coverage** of all 4 frameworks. Most test files contain only 1 `it()` call — likely a smoke/existence check rather than thorough feature testing.

| Feature | Current | Python equiv | Gap |
|---------|---------|-------------|-----|
| Frond template engine | 3 tests | 229 tests | **226 tests behind** |
| Auth | 3 tests | 51 tests | 48 tests behind |
| ORM | 1 test | 67 tests | 66 tests behind |
| Database | 1 test | 28 tests | 27 tests behind |
| Router | 1 test | 35 tests | 34 tests behind |
| WebSocket | 1 test | 86 tests | 85 tests behind |
| WSDL | 1 test | 59 tests | 58 tests behind |
| Swagger | 1 test | 57 tests | 56 tests behind |
| Queue | 1 test | 31 tests | 30 tests behind |
| MCP | 1 test | 24 tests | 23 tests behind |
| Cache | 1 test | 58 tests | 57 tests behind |
| Sessions | 1 test | 50 tests | 49 tests behind |

## Features with Good Coverage (5+ tests)

| Feature | Tests |
|---------|-------|
| Events | 24 |
| DevMailbox | 18 |
| Static files | 17 |
| Live reload | 11 |
| QueryBuilder | 7 |
| Logger | 5 |

## Missing Test Files

| Feature | Notes |
|---------|-------|
| WebSocket backplane | No test file |
| Watcher | No test file |
| Validator | No test file |
| Individual DB adapters | No per-adapter tests |
| Cached database | No test file |
| Constants | No test file |
| Metrics (code analysis) | Not implemented |

## Recommended Priority

1. **Frond tests** — 3 tests vs 229 in Python. Template engine is core functionality
2. **Auth tests** — Security-critical, needs thorough coverage
3. **ORM tests** — Data layer must be bulletproof
4. **Router tests** — Core HTTP routing
5. **Database tests** — Multi-driver support needs per-driver testing
6. **WebSocket tests** — Real-time features need connection lifecycle tests
7. **Session tests** — Security-sensitive, needs backend-specific tests

## Summary

- **57 test files**, **~152 total it() calls**
- **Most files have only 1 test** — existence checks, not feature coverage
- **Node.js is significantly behind** Python (2,018), PHP (1,551), and Ruby (1,784) in test depth
- Priority: expand existing test files with thorough assertions before adding new ones

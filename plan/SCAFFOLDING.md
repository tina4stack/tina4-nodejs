# Rich Scaffolding Plan — Node.js

## Scaffolding-first + secure-by-default (feat/scaffolding-first)

Ported the Python `feat/scaffolding-first` design (tina4-python @ c0b2085) to Node,
idiomatically for the file-per-method routing convention.

### Status

| Item | Status |
|------|--------|
| Model import fixed (`tina4-nodejs/orm`, was broken `tina4-nodejs`) | ✅ |
| Model-route `toJSON()` → real `toObject()`; `[id]` model-import depth fixed | ✅ |
| Route/CRUD secure-by-default (no `secure:false` on writes) | ✅ |
| `--public` opt-out — `export const secure = false;` on write files ONLY | ✅ |
| Route discovery reads `secure`/`noAuth` module exports (makes `--public` live) | ✅ |
| AI-FILL convention (Intent/Given/Use/Return/Ground + throw) for LOGIC stubs | ✅ |
| EXTEND marker (no throw) for working CRUD | ✅ |
| Auth login/register stay PUBLIC (`secure:false`) + real password hashing | ✅ |
| `generate service` (ServiceRunner default-export {name,handler,interval/timing}) | ✅ |
| `generate queue` (Queue produce/consume + daemon consumer) | ✅ |
| `generate validator` (Validator) | ✅ |
| `generate seeder` (seedOrm + FakeData, main-guarded run()) | ✅ |
| `generate websocket` (websocket() imperative registration) | ✅ |
| `generate listener` (Events.on imperative registration) | ✅ |
| Dispatcher + `--help` updated | ✅ |
| Real boot-gate tests (401/201/200), typecheck gate, logic-stub throws | ✅ (99 assertions) |

### Grounded Node symbols (differ from Python — verified in source)

| Generator | Real tina4-nodejs wiring | Deviation from Python |
|-----------|--------------------------|-----------------------|
| service   | `ServiceRunner.discover()` reads `export default { name, handler, interval\|timing }` (service.ts) | static `ServiceRunner`, `interval`/`timing` (not `interval=`/`cron=`); `ServiceContext` has no `.log`/`.stop_event` |
| queue     | `new Queue({topic}).produce/consume`; job `.payload`/`.complete()`/`.fail()` (queue.ts, job.ts) | payload is `job.payload` (not `job.data`); consumer is a ServiceRunner daemon |
| validator | `new Validator(data)` chain `.required/.email/.minLength/.integer/.inList`, `.isValid()`/`.errors()` (validator.ts) | camelCase methods |
| seeder    | `seedOrm(model, count, overrides)` (overrides may be `(fake)=>v`); `FakeData` (seeder.ts) | seed CLI runs the file as a script → main-guarded `run()`, not imported `run(db)` |
| websocket | `websocket(path, handler)` + `(connection, event, data)` (router.ts, types.ts) | NO file-based WS auto-discovery — import the module to register |
| listener  | `Events.on(event, cb)` / `Events.emit` / `Events.listeners` (events.ts) | NO `src/listeners/` auto-discovery — import the module to register |

## Commands

| Command | Output |
|---------|--------|
| `generate model Product --fields "name:string,price:float"` | `src/models/Product.ts` + `migrations/TS_create_product.sql` |
| `generate route products --model Product` | File-based routes under `src/routes/api/products/` |
| `generate crud Product --fields "name:string,price:float"` | model + migration + routes + template + test |
| `generate migration add_category` | `migrations/TS_add_category.sql` + `.down.sql` |
| `generate middleware Auth` | `src/middleware/auth.ts` with before/after |
| `generate test Product` | `test/product.test.ts` |

## File-Based Route Structure
```
src/routes/api/products/get.ts       — list all
src/routes/api/products/post.ts      — create
src/routes/api/products/[id]/get.ts  — get one
src/routes/api/products/[id]/put.ts  — update
src/routes/api/products/[id]/delete.ts — delete
```

## Field Type Mapping

| CLI | ORM type | SQL | TypeScript |
|-----|----------|-----|------------|
| string | "string" | TEXT | string |
| int/integer | "integer" | INTEGER | number |
| float/numeric | "number" | REAL | number |
| bool/boolean | "boolean" | INTEGER | boolean |
| datetime | "datetime" | TEXT | string |

## Table Convention
- Singular: `Product` → `product`
- Override: `pluralTable: true` or `--plural` flag

## Architecture
- Split generators into `packages/cli/src/generators/` directory
- Shared utils in `generators/utils.ts`
- Thin dispatcher in `commands/generate.ts`

## DX Fixes
- `--no-browser` flag on serve
- Kill existing process on port

## Files to Modify
- `packages/cli/src/commands/generate.ts` — refactor to dispatcher
- `packages/cli/src/bin.ts` — arg parsing
- `packages/cli/src/commands/serve.ts` — --no-browser, port-kill

## Files to Create
- `packages/cli/src/generators/utils.ts`
- `packages/cli/src/generators/model.ts`
- `packages/cli/src/generators/route.ts`
- `packages/cli/src/generators/migration.ts`
- `packages/cli/src/generators/middleware.ts`
- `packages/cli/src/generators/crud.ts`
- `packages/cli/src/generators/test.ts`

## Tests
- `test/generate.test.ts` — 9 unit + 8 integration tests

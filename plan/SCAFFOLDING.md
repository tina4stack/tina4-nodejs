# Rich Scaffolding Plan — Node.js

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

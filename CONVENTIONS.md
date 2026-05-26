# Tina4 Node.js v3.10.70 — Conventions

This is a **Tina4 for Node.js/TypeScript** project (https://tina4.com).

## Project Structure

```
src/routes/    — File-based route handlers (auto-discovered)
src/models/    — ORM models
src/templates/ — Twig templates
src/app/       — Service classes
src/scss/      — SCSS (auto-compiled)
src/public/    — Static assets
src/seeds/     — Database seeders
migrations/    — SQL migration files
```

## Built-in Features (Do NOT Install Packages For These)

Router, ORM, Database (SQLite/PostgreSQL/MySQL/MSSQL/Firebird), Frond templates (Twig-compatible), JWT auth, Sessions (File/Redis/Valkey/MongoDB/DB), GraphQL + GraphiQL, WebSocket + Redis backplane, WSDL/SOAP, Queue (File/RabbitMQ/Kafka/MongoDB), HTTP client, Messenger (SMTP/IMAP), FakeData/Seeder, Migrations, SCSS compiler, Swagger/OpenAPI, i18n, Events, Container/DI, HtmlElement, Inline testing, Error overlay, Dev dashboard, Rate limiter, Response cache, Logging, MCP server

## Conventions

1. File-based routing — src/routes/api/users/get.ts handles GET /api/users
2. Export default async function for route handlers
3. GET routes are public, POST/PUT/PATCH/DELETE require auth by default
4. ESM only (import/export, no require)
5. Every template extends base.twig
6. All schema changes via migrations — never create tables in route code
7. Use built-in features — never install npm packages for things Tina4 already provides

## Route Example

```typescript
// src/routes/api/users/get.ts
export default async function(req: Tina4Request, res: Tina4Response) {
  res.json({ users: [] });
}

// src/routes/api/users/post.ts
export default async function(req: Tina4Request, res: Tina4Response) {
  res.json({ created: req.body.name }, 201);
}
```

## Model Example

```typescript
// src/models/User.ts
export default class User {
  static tableName = "users";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true },
    email: { type: "string" as const },
  };
}
```

## Quick Commands

```bash
npx tina4nodejs serve     # Dev server on port 7148
npx tina4nodejs migrate   # Run migrations
npx tina4nodejs test      # Run tests
npx tina4nodejs routes    # List routes
```

## Key Rules

- TypeScript strict mode, ESM only, Node.js 20+
- Native `node:http` — no Express/Fastify
- Convention-based models with `static fields` — no decorators
- Dynamic route params use brackets: `[id]`, `[...slug]`
- Use `.js` extensions in import paths
- All schema changes via migrations

## Database

Default: SQLite via `node:sqlite`. Adapters for PostgreSQL, MySQL, MSSQL, Firebird.
Set `TINA4_DATABASE_URL` in `.env`.

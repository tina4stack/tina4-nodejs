# tina4-nodejs

> Simple. Fast. Human. This is not a framework.

Tina4 for Node.js/TypeScript. Convention over configuration, zero ceremony, batteries included.

## Quick Start

```bash
npx tina4 init my-api
cd my-api
npx tina4 serve
```

## Features

- **File-Based Routing** — Drop a `get.ts` in `src/routes/api/users/` and you have a `GET /api/users` endpoint
- **Auto-CRUD** — Define a model, get instant REST API with filtering, pagination, and validation
- **Auto-Swagger** — OpenAPI docs generated automatically at `/swagger`
- **TypeScript-First** — Full type inference, zero decorators, zero base classes
- **SQLite by Default** — Embedded database, zero config. Pluggable to PostgreSQL/MySQL
- **Twig Templates** — Optional server-rendered HTML with Twig-compatible engine

## Philosophy

The language is the hero. You write TypeScript. Tina4 is invisible infrastructure.

## Links

- [tina4.com](https://tina4.com)
- [github.com/tina4stack](https://github.com/tina4stack)

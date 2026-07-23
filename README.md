<p align="center">
  <img src="https://tina4.com/logo.svg" alt="Tina4" width="200">
</p>
<h1 align="center">Tina4 Node.js</h1>
<h3 align="center">The Intelligent Native Application 4ramework</h3>
<p align="center">97 built-in features. Zero dependencies. One import, everything works.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@tina4/core"><img src="https://img.shields.io/npm/v/@tina4/core?color=7b1fa2&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/tests-2%2C897%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/features-97-blue" alt="Features">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Deps">
  <a href="https://tina4.com"><img src="https://img.shields.io/badge/docs-tina4.com-7b1fa2" alt="Docs"></a>
</p>

---

## Quick Start

```bash
# With the Tina4 CLI (recommended, enables SCSS + live reload)
cargo install tina4    # or grab a binary from https://github.com/tina4stack/tina4/releases
tina4 init nodejs ./my-app
cd my-app && tina4 serve

# Without the Tina4 CLI
npx tina4nodejs init my-app
cd my-app && npx tina4nodejs serve
```

Open http://localhost:7148

---

## Code Examples

```typescript
// src/routes/api/hello/get.ts
export default async function(req: Tina4Request, res: Tina4Response) {
  res.json({ message: "Hello from Tina4!" });
}

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

---

## What's Included

| Category | Features |
|----------|----------|
| **Core HTTP** (7) | Router with path params (`{id:int}`, `{p:path}`), Server, Request/Response, Middleware pipeline, Static file serving, CORS |
| **Database** (6) | SQLite, PostgreSQL, MySQL, MSSQL, Firebird: unified adapter, connection pooling, query cache, transactions, race-safe ID generation, SQL dialect translation |
| **ORM** (7) | Active Record with typed fields, relationships (`has_one`/`has_many`/`belongs_to`), soft delete, QueryBuilder + MongoDB support, Auto-CRUD generator, migrations with rollback |
| **Auth & Security** (5) | JWT (HS256/RS256), password hashing (PBKDF2-SHA256), API key validation, rate limiting, CSRF form tokens |
| **Templating** (3) | Frond engine (Twig/Jinja2-compatible, pre-compiled 2.8× faster), SCSS auto-compilation, built-in CSS (~24 KB) |
| **API & Integration** (5) | HTTP client (zero-dep), GraphQL with ORM auto-schema + GraphiQL IDE, WSDL/SOAP with auto WSDL, WebSocket (RFC 6455) + Redis backplane, MCP server (24 dev tools) |
| **Background** (3) | Job queue (File/RabbitMQ/Kafka/MongoDB) with priority, delay, retry, dead letters; service runner; event system (on/emit/once/off) |
| **Data & Storage** (4) | Session (File/Redis/Valkey/MongoDB/DB), response cache (LRU, TTL), seeder + 50+ fake data generators, messenger (SMTP/IMAP) |
| **Developer Tools** (7) | Dev dashboard (11 tabs), dev toolbar, error overlay (Catppuccin Mocha), dev mailbox, hot reload + CSS hot-reload, code metrics (complexity, coupling, maintainability), AI context installer (7 tools) |
| **Utilities** (7) | DI container (transient + singleton), HtmlElement builder, inline testing (`@tests` decorator), i18n (6 languages), Swagger/OpenAPI auto-generation, CLI scaffolding (`generate model/route/migration/middleware`), structured logging |

**2,897 tests. Zero dependencies. Full parity across Python, PHP, Ruby, and Node.js.**

---

## CLI Reference

```bash
npx tina4nodejs init [dir]
npx tina4nodejs serve [--port PORT]
npx tina4nodejs migrate
npx tina4nodejs seed
npx tina4nodejs ai [--all]
npx tina4nodejs generate model <name>
```

---

## Performance

Benchmarked with `wrk`: 5,000 requests, 50 concurrent, median of 3 runs:

| Framework | JSON req/s | Deps | Features |
|-----------|-----------|------|----------|
| Raw `node:http` | 91,110 | 0 | 1 |
| **Tina4 Node.js** | **84,771** | 0 | 55 |

Tina4 Node.js runs at **93% of raw Node.js speed** while providing 97 built-in features, a zero-overhead architecture.

**Across all 4 Tina4 implementations:**

| | Python | PHP | Ruby | Node.js |
|---|--------|-----|------|---------|
| **JSON req/s** | 6,508 | 29,293 | 10,243 | 84,771 |
| **Dependencies** | 0 | 0 | 0 | 0 |
| **Features** | 55 | 55 | 55 | 55 |

---

## Cross-Framework Parity

Tina4 ships identical features across four languages: same architecture, same conventions, same 97 features:

| | Python | PHP | Ruby | Node.js |
|---|--------|-----|------|---------|
| **Package** | `tina4-python` | `tina4stack/tina4php` | `tina4ruby` | `@tina4/core` |
| **Tests (v3.11.12)** | 2,281 | 2,073 | 2,508 | 2,897 |
| **Default port** | 7146 | 7145 | 7147 | 7148 |

**~9,700 tests** across all 4 frameworks. See [tina4.com](https://tina4.com).

---

## Documentation

Full guides, API reference, and examples at **[tina4.com](https://tina4.com)**.

## License

MIT (c) 2007-2026 Tina4 Stack
https://opensource.org/licenses/MIT

---

## Our Sponsors

**Sponsored with 🩵 by Code Infinity**

[<img src="https://codeinfinity.co.za/wp-content/uploads/2025/09/c8e-logo-github.png" alt="Code Infinity" width="100">](https://codeinfinity.co.za/about-open-source-policy?utm_source=github&utm_medium=website&utm_campaign=opensource_campaign&utm_id=opensource)

*Supporting open source communities • Innovate • Code • Empower*

# Database

Tina4 uses an adapter pattern for database access. SQLite via `better-sqlite3` is the default and only currently implemented adapter. PostgreSQL and MySQL adapters are planned.

## Automatic Initialization

When `src/models/` exists, the server initializes the database automatically on startup using the default configuration:

- **Type:** SQLite
- **Path:** `./data/tina4.db`

No manual setup is needed for most projects.

## Manual Initialization

```typescript
import { initDatabase } from "@tina4/orm";

// SQLite with custom path
await initDatabase({
  type: "sqlite",
  path: "./data/myapp.db",
});
```

## DATABASE_URL Support

You can configure the database via a connection URL, either in code or via the `DATABASE_URL` environment variable.

```bash
# .env
DATABASE_URL=sqlite:///data/myapp.db
```

```typescript
import { initDatabase } from "@tina4/orm";

// URL takes priority over type+path
await initDatabase({
  url: "sqlite://./data/myapp.db",
});
```

### URL Formats

| URL | Description |
|-----|-------------|
| `sqlite:///absolute/path.db` | SQLite with absolute path |
| `sqlite://./relative/path.db` | SQLite with relative path |
| `postgresql://user:pass@host:port/db` | PostgreSQL (planned) |
| `mysql://user:pass@host:port/db` | MySQL (planned) |

You can parse a URL without connecting:

```typescript
import { parseDatabaseUrl } from "@tina4/orm";

const config = parseDatabaseUrl("postgresql://admin:secret@db.host:5432/myapp");
// { type: "postgres", host: "db.host", port: 5432, user: "admin", password: "secret", database: "myapp" }
```

## Adapter Interface

All database adapters implement the `DatabaseAdapter` interface:

```typescript
interface DatabaseAdapter {
  execute(sql: string, params?: unknown[]): unknown;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
  tableExists(name: string): boolean;
  createTable(name: string, columns: Record<string, FieldDefinition>): void;
}
```

### Direct Queries

```typescript
import { getAdapter } from "@tina4/orm";

const db = getAdapter();

// Execute (INSERT, UPDATE, DELETE)
const result = db.execute(
  'INSERT INTO users (name, email) VALUES (?, ?)',
  ["Alice", "alice@example.com"]
) as { lastInsertRowid: number };

// Query (SELECT)
const users = db.query<{ id: number; name: string }>(
  'SELECT * FROM users WHERE active = ?',
  [1]
);

// Check if table exists
if (db.tableExists("users")) {
  console.log("Users table exists");
}
```

## Server Configuration

Pass database config through `startServer()`:

```typescript
import { startServer } from "@tina4/core";

await startServer({
  port: 3000,
  database: {
    type: "sqlite",
    path: "./data/production.db",
  },
});
```

## Connection Lifecycle

The database connection is opened on server start and closed on shutdown. The `closeDatabase()` function closes all adapters (default and named).

```typescript
import { closeDatabase } from "@tina4/orm";

// Close all database connections
closeDatabase();
```

## Notes

- SQLite via `better-sqlite3` is synchronous, which makes it very fast for most workloads.
- The database file and its parent directory are created automatically if they don't exist.
- The adapter pattern means you can swap databases without changing model or route code.

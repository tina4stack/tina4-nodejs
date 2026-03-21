# Migrations

Tina4 handles database schema changes in two ways: automatic model sync on startup and a tracked migration system for custom schema changes.

## Automatic Schema Sync

When the server starts and models are discovered, `syncModels()` runs automatically:

1. If a model's table does not exist, it is created with all defined columns.
2. If the table exists but is missing columns from the model, new columns are added.
3. Existing columns are never modified or removed (destructive changes are avoided).

Console output during sync:

```
  Models discovered:
    Created table: users
    Added column: users.bio
    products (4 fields)
```

## Migration Tracking

For schema changes beyond what auto-sync handles (data transforms, index creation, column renames), use the migration tracking system. Migrations are tracked in a `tina4_migration` table with batch numbers.

### Applying a Migration

```typescript
import {
  ensureMigrationTable,
  applyMigration,
  getNextBatch,
  isMigrationApplied,
} from "tina4-nodejs";
import { getAdapter } from "tina4-nodejs";

// Ensure the tracking table exists
ensureMigrationTable();

// Get the next batch number
const batch = getNextBatch();

// Apply a migration (skips if already applied)
applyMigration("001_create_index_users_email", () => {
  const db = getAdapter();
  db.execute('CREATE INDEX IF NOT EXISTS idx_users_email ON "users" ("email")');
}, batch);

applyMigration("002_add_users_phone", () => {
  const db = getAdapter();
  db.execute('ALTER TABLE "users" ADD COLUMN "phone" TEXT');
}, batch);
```

### Rolling Back

Rollback undoes the last batch of migrations. You provide a map of migration names to their "down" functions:

```typescript
import { rollback } from "tina4-nodejs";

const downFunctions = new Map<string, () => void>();

downFunctions.set("001_create_index_users_email", () => {
  const db = getAdapter();
  db.execute('DROP INDEX IF EXISTS idx_users_email');
});

downFunctions.set("002_add_users_phone", () => {
  // SQLite doesn't support DROP COLUMN in older versions
  // Handle accordingly
});

const rolledBack = rollback(downFunctions);
console.log("Rolled back:", rolledBack);
```

### Querying Migration Status

```typescript
import {
  getAppliedMigrations,
  getLastBatchMigrations,
  isMigrationApplied,
} from "tina4-nodejs";

// List all applied migrations
const all = getAppliedMigrations();
// [{ id: 1, name: "001_create_index", batch: 1, applied_at: "2024-..." }]

// Get migrations from the last batch
const lastBatch = getLastBatchMigrations();

// Check if a specific migration was applied
if (isMigrationApplied("001_create_index_users_email")) {
  console.log("Already applied");
}
```

## Migration Table Schema

The `tina4_migration` table is created automatically when `ensureMigrationTable()` is called:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK, auto) | Unique ID |
| `name` | TEXT | Migration name |
| `batch` | INTEGER | Batch number (for grouped rollback) |
| `applied_at` | TEXT | ISO timestamp of application |

## Soft Delete Migration

When a model sets `static softDelete = true`, an `is_deleted` INTEGER column (default `0`) is automatically added to the table during sync. No manual migration needed.

## Notes

- Auto-sync only adds -- it never drops columns or tables. This is by design to prevent accidental data loss.
- Migration names should be unique and descriptive. A common convention is `NNN_description`.
- Batch numbers group migrations so `rollback()` undoes an entire deployment's worth of changes at once.

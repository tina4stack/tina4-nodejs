# ORM & Models

Tina4 uses convention-based models with static properties. Define a class with `static tableName` and `static fields`, and the framework handles table creation, auto-CRUD endpoints, validation, and Swagger schema generation.

## Defining a Model

Models live in `src/models/` and export a default class.

```typescript
// src/models/User.ts
export default class User {
  static tableName = "users";

  static fields = {
    id:    { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:  { type: "string" as const,  required: true, maxLength: 255 },
    email: { type: "string" as const,  required: true, pattern: "^[^@]+@[^@]+$" },
    age:   { type: "integer" as const, min: 0, max: 150 },
    bio:   { type: "text" as const },
    active:    { type: "boolean" as const, default: true },
    createdAt: { type: "datetime" as const, default: "now" },
  };
}
```

## Field Types

| Type | SQLite Column | Description |
|------|--------------|-------------|
| `"string"` | `TEXT` | Short text, supports `minLength`, `maxLength`, `pattern` |
| `"text"` | `TEXT` | Long text, same validation as string |
| `"integer"` | `INTEGER` | Whole numbers, supports `min`, `max` |
| `"number"` | `REAL` | Floating-point numbers, supports `min`, `max` |
| `"boolean"` | `INTEGER` | Stored as 0/1, accepts `true`/`false`/`0`/`1` |
| `"datetime"` | `TEXT` | ISO 8601 date strings |

## Field Options

| Option | Type | Description |
|--------|------|-------------|
| `primaryKey` | `boolean` | Marks as primary key |
| `autoIncrement` | `boolean` | Auto-increment (SQLite `AUTOINCREMENT`) |
| `required` | `boolean` | Must be provided on create (not on update) |
| `default` | `unknown` | Default value when not provided |
| `minLength` | `number` | Minimum string length |
| `maxLength` | `number` | Maximum string length |
| `min` | `number` | Minimum numeric value |
| `max` | `number` | Maximum numeric value |
| `pattern` | `string` | Regex pattern for string validation |

## Auto-CRUD Endpoints

When a model is discovered, Tina4 automatically generates these REST endpoints:

| Method | URL | Description |
|--------|-----|-------------|
| `GET` | `/api/{tableName}` | List with filtering, sorting, pagination |
| `GET` | `/api/{tableName}/{id}` | Get single record by primary key |
| `POST` | `/api/{tableName}` | Create a new record (validates body) |
| `PUT` | `/api/{tableName}/{id}` | Update an existing record |
| `DELETE` | `/api/{tableName}/{id}` | Delete a record |

For the `User` model above, you get `GET /api/users`, `POST /api/users`, etc. with no additional code.

## Soft Delete

Enable soft deletion to mark records as deleted instead of removing them from the database.

```typescript
export default class Product {
  static tableName = "products";
  static softDelete = true;  // Adds is_deleted column automatically

  static fields = {
    id:    { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:  { type: "string" as const,  required: true },
    price: { type: "number" as const,  min: 0 },
  };
}
```

When `softDelete` is `true`:
- `DELETE /api/products/1` sets `is_deleted = 1` instead of removing the row.
- `GET /api/products` automatically filters out records where `is_deleted = 1`.

## Table Filter

Apply a global WHERE condition to all queries for a model.

```typescript
export default class ActiveUser {
  static tableName = "users";
  static tableFilter = "active = 1";  // Always applied to SELECT queries

  static fields = {
    id:     { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:   { type: "string" as const,  required: true },
    active: { type: "boolean" as const, default: true },
  };
}
```

## Relationships

Define `hasOne` and `hasMany` relationships between models.

```typescript
export default class Author {
  static tableName = "authors";

  static hasOne = [
    { model: "Profile", foreignKey: "author_id" },
  ];

  static hasMany = [
    { model: "Post", foreignKey: "author_id" },
  ];

  static fields = {
    id:   { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const,  required: true },
  };
}
```

## BaseModel (Instance Methods)

For programmatic use beyond auto-CRUD, extend `BaseModel` to get `findById`, `findAll`, `save`, `delete`, and serialization methods.

```typescript
import { BaseModel } from "@tina4/orm";

export default class Task extends BaseModel {
  static tableName = "tasks";

  static fields = {
    id:     { type: "integer" as const, primaryKey: true, autoIncrement: true },
    title:  { type: "string" as const,  required: true },
    done:   { type: "boolean" as const, default: false },
  };
}
```

### Using BaseModel in a Route Handler

```typescript
import type { Tina4Request, Tina4Response } from "@tina4/core";
import Task from "../models/Task.js";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  // Find by ID
  const task = Task.findById(1);

  // Find all with optional WHERE clause
  const pending = Task.findAll("done = ?", [0]);

  // Create and save
  const newTask = new Task({ title: "Write docs", done: false });
  newTask.save();  // INSERT, sets newTask.id

  // Update
  newTask.title = "Write better docs";
  newTask.save();  // UPDATE (id is set)

  // Delete
  newTask.delete();

  // Serialize
  const obj = newTask.toArray();   // Plain object
  const json = newTask.toJson();   // JSON string

  res.json({ task: obj });
}
```

## Multi-Database Support

Models can target a specific named database adapter using `static _db`.

```typescript
export default class AnalyticsEvent extends BaseModel {
  static tableName = "events";
  static _db = "analytics";  // Uses the "analytics" named adapter

  static fields = {
    id:    { type: "integer" as const, primaryKey: true, autoIncrement: true },
    event: { type: "string" as const, required: true },
  };
}
```

Register named adapters at startup:

```typescript
import { initDatabase, setNamedAdapter } from "@tina4/orm";

// Default adapter
await initDatabase({ type: "sqlite", path: "./data/main.db" });

// Named adapter for analytics
const { SQLiteAdapter } = await import("@tina4/orm/src/adapters/sqlite.js");
setNamedAdapter("analytics", new SQLiteAdapter("./data/analytics.db"));
```

## Convention Summary

- Model files go in `src/models/`.
- Table names should be lowercase plural: `"users"`, `"products"`, `"order_items"`.
- One model per file, default export.
- No decorators needed -- just static properties.

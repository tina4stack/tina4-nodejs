# Data, ORM & Database (Node.js)

## Defining Models

Drop a model file in `src/models/` and it's auto-registered (`src/orm/` is also scanned). A model
**extends `BaseModel`** (imported from the ORM subpackage) and **MUST declare `static tableName` AND
`static fields`.**

> **Node models are NOT like the Python "declare public properties directly" story.** In TypeScript,
> property type annotations are **erased at runtime**, so the framework cannot discover columns from
> them. Discovery needs the two static descriptors. There is **no `static primaryKey`** — the primary
> key is whichever field has `primaryKey: true`.

```typescript
// src/models/User.ts
import { BaseModel } from "tina4-nodejs/orm";

export class User extends BaseModel {
  static tableName = "users";
  static fields = {
    id:     { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:   { type: "string"  as const, required: true },
    email:  { type: "string"  as const, required: true },
    active: { type: "boolean" as const, default: true },
  };
}
```

- `BaseModel` is exported from **`tina4-nodejs/orm`**, NOT from `tina4-nodejs` (core). Importing it
  from core fails.
- Use `as const` on each `type` so TypeScript narrows it to the literal the ORM expects.
- Field types: `"integer"`, `"string"`, `"text"`, `"number"`/`"numeric"`, `"boolean"`, `"datetime"`,
  `"json"`, `"foreignKey"`.
- Field options: `primaryKey`, `autoIncrement`, `required`, `default` (value or `() => value` for a
  per-row default), `maxLength`, `references` + `relatedName` (for `foreignKey`).
- camelCase JS properties auto-map to snake_case columns (e.g. `createdAt` ↔ `created_at`) via
  `autoMap` (on by default). Override with `static fieldMapping = { firstName: "first_name" }`.

Optional statics: `static softDelete = true`, `static autoCrud = true`,
`static tableFilter = "active = 1"`, `static hasOne/hasMany/belongsTo = [...]`, `static _db = "secondary"`.

## CRUD Operations

Model query/mutation methods are **static and async** (except instance `save`/`delete`). `await`
everything.

### Create

```typescript
// Static factory — returns the saved instance, or false on validation/driver failure.
const user = await User.create({ name: "Alice", email: "alice@example.com" });
if (!user) { /* creation failed — inspect why */ }

// Or construct + save. save() returns `this` on success, false on failure.
const u = new User({ name: "Alice", email: "alice@example.com" });
if (!(await u.save())) console.error(u.getError());   // real cause on failure
```

### Read — by primary key

```typescript
const user = await User.findById(1);          // instance or null
const user2 = await User.findOrFail(1);       // throws if not found
const user3 = await User.find(1);             // scalar arg → same as findById → instance | null
```

### Read — a single row by column (NOT `selectOne` with a bare condition)

> **`selectOne(sql, params)` executes `sql` as the WHOLE query.** Passing a bare WHERE fragment like
> `User.selectOne("email = ?", [email])` runs `email = ?` as if it were the entire SQL statement and
> fails. To fetch one row by a column, use `where(...)` or `find({...})` and take `[0]`:

```typescript
const user = (await User.where("email = ?", [email]))[0];   // ← correct
// or
const user2 = (await User.find({ email }))[0];              // filter object, first match
```

Use `selectOne` only with a **complete** SQL string:
`await User.selectOne('SELECT * FROM "users" WHERE email = ?', [email])`.

### Read — filtered list

```typescript
// find(): a filter OBJECT → array (AND-ed conditions); optional limit / offset / orderBy.
const active = await User.find({ active: true });
const page   = await User.find({ active: true }, 20, 40);        // limit 20, offset 40
const sorted = await User.find({}, 100, 0, "name ASC");

// where(): a raw WHERE string + params → array (limit defaults to 20).
const recent = await User.where("created_at > ?", ["2026-01-01"], 50);

// all(): optional WHERE STRING (not an options object!). For a plain limit, use find({}, n).
const everyone   = await User.all();                 // all rows
const activeOnes = await User.all("active = 1");     // WHERE string
const firstFifty = await User.find({}, 50);          // ← use find for a limit, NOT User.all({ limit: 50 })
```

> **`all()` takes a WHERE clause string, not `{ limit }`.** `User.all({ limit: 50 })` would coerce the
> object into a bogus WHERE clause. Use `await User.find({}, 50)` to cap the result set.

### Update

```typescript
const user = await User.findById(1);
if (user) { user.name = "Alice Smith"; await user.save(); }
```

### Delete

```typescript
const user = await User.findById(1);
await user?.delete();            // soft delete if `static softDelete = true`, else hard delete
await user?.forceDelete();       // bypass soft delete
await user?.restore();           // un-delete a soft-deleted row
```

### Serialisation

```typescript
user.toDict();     // { id: 1, name: "Alice", ... }   (accepts include[] for relationships)
user.toJson();     // '{"id":1,"name":"Alice",...}'
user.toArray();    // [1, "Alice", ...]
user.toDict(undefined, "snake");   // keys as snake_case DB columns
```

## Relationships

Declare relationships with `static` arrays, or let a `foreignKey` field auto-wire them:

```typescript
// src/models/Post.ts
import { BaseModel } from "tina4-nodejs/orm";
export class Post extends BaseModel {
  static tableName = "posts";
  static fields = {
    id:      { type: "integer" as const, primaryKey: true, autoIncrement: true },
    title:   { type: "string"  as const, required: true },
    userId:  { type: "foreignKey" as const, references: "User" },   // auto-wires belongsTo + User.hasMany
  };
}

// src/models/User.ts (add explicit relationships if you prefer)
export class User extends BaseModel {
  static tableName = "users";
  static fields = { /* … */ };
  static hasMany = [{ model: "Post", foreignKey: "user_id" }];
}
```

Eager-load with the `include` argument to avoid N+1 queries:

```typescript
const user  = await User.findById(1, ["posts"]);     // user.toDict(["posts"]) includes them
const users = await User.find({}, 100, 0, undefined, ["posts"]);
await User.eagerLoad(users, ["posts"]);              // or load onto an existing array
```

## Pagination

`find()` (limit/offset args) and `where()` (limit/offset args) page results. For a page N at
`perPage`, pass `offset = (N - 1) * perPage`.

```typescript
const perPage = 20, pageNumber = 3;
const rows = await User.find({ active: true }, perPage, (pageNumber - 1) * perPage);
const total = await User.count("active = 1");
```

## QueryBuilder — Fluent Queries with JOINs

For JOINs, aggregates, and GROUP BY, use `QueryBuilder` instead of raw SQL. Start from a model with
`Model.query()`, or from `QueryBuilder.fromTable(table, db)`. **The method is `fromTable` in Node**
(not `from`).

```typescript
import { QueryBuilder } from "tina4-nodejs/orm";

// From a model (inherits the model's DB connection)
const users = await User.query()
  .where("active = ?", [1])
  .orderBy("name")
  .limit(10)
  .get();                        // → DatabaseResult

// Standalone with a JOIN
const orders = await QueryBuilder.fromTable("orders o", User.query().getDb?.())
  .select("o.*", "c.name as customer_name")
  .join("customers c", "o.customer_id = c.id")
  .where("o.status = ?", ["pending"])
  .orderBy("o.created_at DESC")
  .limit(20)
  .get();
```

Terminal methods: `.get()` (→ DatabaseResult), `.first()` (single row or null), `.count()` (→ number),
`.exists()` (→ boolean), `.toSql()` (build SQL without executing). Chainables: `.select()`,
`.where()`, `.orWhere()`, `.join()`, `.leftJoin()`, `.groupBy()`, `.having()`, `.orderBy()`,
`.limit(n, offset?)`.

## Raw SQL

For queries the ORM/QueryBuilder can't express, use `Database` with the active adapter:

```typescript
import { Database, getAdapter } from "tina4-nodejs/orm";

const db = new Database(getAdapter());
const rows = await db.fetch("SELECT * FROM users WHERE id = ?", [1]);   // array of rows
const one  = await db.fetchOne("SELECT * FROM users WHERE id = ?", [1]); // single row or null
await db.execute("UPDATE users SET active = 0 WHERE id = ?", [1]);
```

Always use `?` placeholders with a params array — never string-concatenate values into SQL.

## Database Connection & Startup

Set `TINA4_DATABASE_URL` in `.env`. **SQLite** initialises automatically the first time a model runs.
For **any non-SQLite engine, call `await initDatabase(url)` at startup** (in `app.ts`) — the adapter
is created asynchronously:

```typescript
// app.ts
import { startServer } from "tina4-nodejs";
import { initDatabase } from "tina4-nodejs/orm";

await initDatabase(process.env.TINA4_DATABASE_URL!);   // required for postgres/mysql/mssql/firebird/mongodb
startServer();
```

Non-SQLite drivers are optional peer dependencies — install the one you use: `pg`, `mysql2`,
`tedious` (MSSQL), `mongodb`.

## Migrations

```bash
tina4nodejs migrate:create "create users table"   # writes a .sql + .down.sql pair in src/migrations/
tina4nodejs migrate                                # run pending migrations
tina4nodejs migrate:status                         # show applied + pending
tina4nodejs migrate:rollback                       # roll back the last batch
```

Migration files are versioned SQL in `src/migrations/`. Write standard SQL:

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Seeding

```bash
tina4nodejs seed          # run seed files from src/seeds/
```

Quick fake data:

```typescript
import { FakeData, seedOrm } from "tina4-nodejs/orm";

const fake = new FakeData();
fake.name();     // "Alice Johnson"
fake.email();    // "alice.johnson@example.com"

await seedOrm(User, 50);   // bulk-seed 50 rows from the field definitions
```

## Auto-CRUD

Set `static autoCrud = true` on a model — the server registers a full list/create/read/update/delete
route set for it on startup (only for models that explicitly opt in). File-based routes for the same
path always win over the generated ones.

```typescript
import { BaseModel } from "tina4-nodejs/orm";

export class Product extends BaseModel {
  static autoCrud = true;                 // registers CRUD routes on startup
  static tableName = "products";
  static fields = {
    id:    { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name:  { type: "string"  as const, required: true },
    price: { type: "number"  as const, default: 0 },
  };
}
```

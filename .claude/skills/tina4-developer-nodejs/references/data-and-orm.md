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
const result = await db.fetch("SELECT * FROM users WHERE id = ?", [1]);  // DatabaseResult, NOT a plain array
const rows = result.records;                                            // the row objects live on .records
const one  = await db.fetchOne("SELECT * FROM users WHERE id = ?", [1]); // single row object or null
await db.execute("UPDATE users SET active = 0 WHERE id = ?", [1]);       // throws on error (see footguns)
```

`db.fetch()` returns a **`DatabaseResult`**, not a list — rows are on **`.records`**, accessed by key
(`result.records[0].name`). It is iterable / indexable / `.length`-able and has `.toJson()` / `.toCsv()`
/ `.toArray()` / `.toPaginate()` for convenience, but ORM list methods (`all()`/`where()`/`find({})`)
return a **plain array** with none of those methods. Always use `?` placeholders with a params array —
never string-concatenate values into SQL.

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
tina4nodejs migrate:create "create users table"   # writes a .sql + .down.sql pair in migrations/
tina4nodejs migrate                                # run pending migrations
tina4nodejs migrate:status                         # show applied + pending
tina4nodejs migrate:rollback                       # roll back the last batch
```

Migration files are versioned SQL in **`migrations/`** at the project root — not `src/migrations/`.
The runner defaults to `resolve("migrations")` (`packages/orm/src/migration.ts`), the CLI scaffolds
into `migrations/` (`packages/cli/src/commands/migrateCreate.ts`), and `startServer()` auto-applies
`migrations/` at boot (see the auto-migrate footgun below). Write standard SQL:

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

## ORM Lifecycle & Footguns

The write path has a deliberate but **asymmetric** failure contract: `save()`/`create()` fail
*soft* (return `false`), while `delete()`/`restore()` and `db.execute()` fail *loud* (throw).
Getting this wrong is the single biggest source of wasted debugging. Each item below is **what
bites → the safe idiom → what breaks**, verified against tina4-nodejs's OWN source
(`packages/orm/src/baseModel.ts`, `database.ts`, `migration.ts`, `validation.ts`). Where Node
diverges from the Python story it is called out — port the behaviour, not the transliteration.

### The write path fails *soft* — `save()` / `create()` return `false`, never reject

`await save()` resolves to `this` on success and **`false`** on *any* failure (a validation error
OR a driver error). It **never rejects/throws** and never resolves to `null`/`undefined`. The real
cause is recorded on `model.lastError` / `model.getError()` (mirroring the adapter's `getError()`),
so a swallowed failure is always recoverable. `create(data)` = construct + `save()`; when the save
fails it resolves to `false` (not a half-saved instance).

```typescript
// SAFE — check the return, surface the cause
const user = new User({ name: "Alice", email: "a@x.com" });
if (!(await user.save())) {                       // false on failure — NOT a rejection
  return response({ error: user.getError() }, 422);   // e.g. "name is required"
}
```

* **Breaks:** `try { await user.save() } catch { … }` — the `catch` never fires, so a failed write
  looks like success. Testing `if ((await user.save()) == null)` is also wrong (it's `false`).
  `baseModel.ts:640` (`save`), `:389` (`create`), `:777` (`getError`).

### No auto table-create *at save() time* — a write into a missing table returns `false`

`save()` never creates a table (`baseModel.ts:640` runs INSERT/UPDATE only). A save into a table
that doesn't exist hits the driver's `no such table`, which `save()` catches → `false` with the
cause on `getError()` (now augmented with an actionable hint — `baseModel.ts` catch block).

> **Node divergence:** on a **running server**, `startServer()` calls `syncModels()`
> (`server.ts:959` → `migration.ts:187`) at boot, which **auto-creates tables from discovered
> models** (and adds columns). So inside a booted app the table usually exists. The footgun bites
> **outside the server** — scripts, workers, tests, or a write before boot — where nothing has
> synced the schema.

```typescript
// SAFE (script/worker/test) — create the table or run a migration before the first write
await User.createTable();                 // idempotent: CREATE TABLE IF NOT EXISTS from the fields
await new User({ name: "Alice" }).save();
```

* **Breaks:** relying on `save()` to bootstrap the schema in a non-server context — it returns
  `false` and no row lands. `createTable()` builds DDL from **declared fields only** — see the
  soft-delete footgun below. `baseModel.ts:948` (`createTable`).

### `softDelete` needs an `is_deleted` column — and `createTable()` does NOT add it

Set `static softDelete = true` and `delete()` flips an `is_deleted` flag while every read filters
`is_deleted = 0` (`baseModel.ts:362,468,558,602,797`). The column must exist:

* **The server boot path provisions it.** `syncModels()` injects `is_deleted INTEGER DEFAULT 0`
  when `softDelete` is on (`migration.ts:199-204`) — creating it on a new table and `ALTER TABLE
  ADD`-ing it onto an existing one. So a normal `startServer()` app is fine.
* **`Model.createTable()` does NOT inject it** (`baseModel.ts:948` builds from `this.fields` only).
  In a script/test that provisions with `createTable()` and skips the server, the first `delete()`
  throws `no such column: is_deleted` and soft-delete reads fail.

```typescript
// SAFE in a createTable()-only context — declare the column yourself…
static fields = {
  id:         { type: "integer" as const, primaryKey: true, autoIncrement: true },
  is_deleted: { type: "integer" as const, default: 0 },   // required when you skip syncModels()
};
// …or provision via the server / a migration so syncModels() adds it.
```

* **Breaks:** `static softDelete = true` + `await Model.createTable()` + `await row.delete()` in a
  non-server context → throws on the missing column. (Python's `create_table()` behaves the same;
  the divergence is that Node's *server boot* `syncModels()` does add it.)

### Constructing a model does NOT validate values — but an array / bad JSON string throws

**This is the opposite of Python.** Node's constructor (`baseModel.ts:143`) sets defaults and
populates data; it does **not** run field validation. Validation lives **only** in `save()`
(`baseModel.ts:645` → `validation.ts`, which **returns a `string[]`** and never throws). So:

* `new User(request.body)` with a missing/invalid field **does not throw** — build straight from
  untrusted input safely; the error surfaces as `save()` → `false`, not a 500.
* The constructor **does throw `TypeError`** for a shape it can't treat as one record: an **array**
  (`baseModel.ts:151`) or a **non-JSON string** (`JSON.parse`, `:147`).

```typescript
// SAFE — construct from a single object; map over lists; then rely on save()'s soft failure
const u = new User(request.body as Record<string, unknown>);   // no throw on bad values
if (!(await u.save())) return response({ error: u.getError() }, 422);

const many = rows.map((r) => new User(r));    // one object per record — never `new User(rows)`
```

* **Breaks:** `new User(arrayOfRows)` → `TypeError` ("expects an object … got an array"). Passing a
  string that isn't valid JSON → `SyntaxError` from `JSON.parse`.

### Read-path validation does NOT apply in Node — hydration never validates

In Python, tightening a constraint can break *reads* of existing rows (the constructor validates on
hydration and raises). **In Node it does not:** `find`/`all`/`where` build instances via
`new Model(row)` (`baseModel.ts:393,483,573,613`) and the constructor doesn't validate. Adding a
stricter `maxLength`/`pattern`/`min` only affects the **next write**, never a read. (Dropped from
the Python footgun list — noted here so nobody ports a phantom bug.)

### `delete()` / `restore()` / `forceDelete()` DO throw — the asymmetry

Unlike `save()`, the delete family fails **loud**. `delete()` and `forceDelete()` throw when
there's no primary-key value; `restore()` throws on a model without `softDelete`. Same ORM,
opposite contract.

```typescript
// SAFE — guard the preconditions; wrap in try/catch if the row may be unsaved
const user = await User.findById(uid);
if (user) await user.delete();            // throws if user.id is null or the DB write fails
```

* **Breaks:** `await new User({...}).delete()` on an unsaved instance (no PK) → throws
  ("Cannot delete a model without a primary key value"). `baseModel.ts:792` (`delete`), `:1127`
  (`forceDelete`), `:1150`/`:1159` (`restore`).

### `db.execute()` throws — it does not return `false`

Raw writes via `db.execute()` fail **loud**: on a driver error they **throw** (and populate
`db.getError()`); they do **not** return `false`. (The ORM's `save()` wraps this and converts it to
`false` — but a *direct* `db.execute()` propagates.) A standalone write auto-commits by default.

```typescript
// SAFE — wrap writes you expect might fail; don't test the return value for falsiness
try {
  await db.execute("INSERT INTO audit (msg) VALUES (?)", ["ok"]);
} catch {
  return response({ error: db.getError() }, 500);
}
```

* **Breaks:** `if (!(await db.execute(sql))) …` — a successful write resolves truthy, and a *failed*
  one throws rather than resolving falsy, so the branch never runs. `database.ts:758`.

### Bind a database before any ORM call

Every ORM query needs a resolvable adapter (`baseModel.ts:309`): `static _db` (named connection) →
the default set by `initDatabase()`/`bindDatabase()` → auto-discovery from `TINA4_DATABASE_URL`.
**SQLite auto-initialises synchronously** on first use; **any other engine throws** until you
`await initDatabase(url)` at startup.

```typescript
// SAFE — SQLite is zero-setup; for postgres/mysql/mssql/mongodb, init at boot:
await initDatabase(process.env.TINA4_DATABASE_URL!);   // required for non-SQLite engines
```

* **Breaks:** running an ORM query in a script/worker with a non-SQLite `TINA4_DATABASE_URL` but no
  `initDatabase()` → throws "Call await initDatabase() at startup…". With nothing configured at all
  → "No database adapter configured." `baseModel.ts:327,332`.

### No default ordering — paginate with a unique tiebreaker

`find()` and `all()` apply **no `ORDER BY` unless you pass an `orderBy` string** (`baseModel.ts:476`
for `find`, `:569` for `all`). Without one, row order is engine-defined and `limit`/`offset` pages
can repeat or skip rows; ordering by a non-unique column (e.g. `created_at`) has the same problem on
ties.

> **Node divergence:** `where()` has **no `orderBy` parameter** and defaults to `LIMIT 20 OFFSET 0`
> (`baseModel.ts:590`). To order + page, use `find({}, limit, offset, "created_at DESC, id DESC")`
> or `Model.query().orderBy(...)` (QueryBuilder). Don't reach for `where()` when you need ordering.

```typescript
// SAFE — order by a UNIQUE tiebreaker for stable pagination
const page = await User.find({ active: true }, 20, 40, "created_at DESC, id DESC");
```

* **Breaks:** `User.find({}, 20, 20)` with no `orderBy`, or `"created_at DESC"` alone — two rows
  with the same timestamp can land on two different pages (or neither). And `User.where("active = 1")`
  silently returns at most 20 rows because of the default `LIMIT`.

### Auto-migrate is fail-soft and server-only

`startServer()` applies pending SQL migrations from `migrations/` at boot
(`server.ts` → `autoMigrateOnStartup`). It is **fail-soft**: a bad migration is logged loud and
**the service still starts** (a broken migration must not take the backend down). The explicit
**`tina4nodejs migrate` CLI stays fail-fast** (`process.exit(1)` for CI). Disable boot migration
with `TINA4_AUTO_MIGRATE=false` (recommended for multi-instance prod, where concurrent first-apply
can race).

* **Breaks:** assuming a green server boot means migrations applied — check the logs, or gate
  deploys on `tina4nodejs migrate` (which exits non-zero).

### Framework gotchas (auth, routing, templates, background work)

These bite outside the ORM but hit the same agent-build loop. Verified against source.

* **N1 — Auth / unexpected 401 (security).** An unexpected 401 means **the caller needs a token**,
  not that the route should be opened. `.noAuth()` is a **last resort** for genuinely public
  endpoints only. See **`auth-and-services.md` → "Auth footguns"** for the full treatment (why a
  file-based write can't opt out, and the docs-only `meta.security` trap).

* **N2 — No decorators (the "decorator order" footgun does not apply).** tina4-nodejs uses **no TS
  decorators** — routing is file-based (`get.ts`/`post.ts`) plus imperative chained builders
  (`post("/x", h).noAuth()`, `get("/y", h).secure()`, `router.ts:97-121`). There is no
  `@get`/`@noauth` ordering to get wrong.

* **N3 — Postgres writes need a commit only inside an explicit transaction.** `autoCommit` is on by
  default (`TINA4_AUTOCOMMIT`, default `"true"` — `database.ts:495`), so a **standalone**
  `db.execute()` write is durable immediately. A write made **inside `db.startTransaction()`** (or
  with `TINA4_AUTOCOMMIT=false`) needs an explicit `await db.commit()` or it rolls back. (The ORM's
  `save()` already wraps start-transaction + commit.)

* **N4 — Frond templates (`src/templates/`, engine is Frond — verified against
  `packages/frond/src/engine.ts`).** Concatenate with `~`, **not `+`**: `{{ "hi " ~ name }}`. On
  strings `+` runs arithmetic and **both operands coerce to `0`** (`engine.ts:597-624`) — so
  `{{ "foo" + "bar" }}` silently renders `0`, no error. Unescape with `{{ x|raw }}` **or**
  `{{ x|safe }}` (both mark output safe; autoescape is on by default — `engine.ts:2052,2148`). Frond
  accepts **both** `{% elif %}` and `{% elseif %}` (`engine.ts:2190`). A malformed `{% live %}`
  region **throws at render** (poll needs seconds, `ws` needs a path, `src` must be same-origin —
  `engine.ts:2573-2612`).

* **N5 — `DatabaseResult` is not a list.** `db.fetch()` returns a `DatabaseResult`; rows live on
  **`.records`** (`databaseResult.ts:20`), accessed by key: `result.records[0].name`. The object is
  iterable/indexable/`.length`-able for convenience, but an ORM **list** (`all()`/`where()`/
  `find({})`) is a plain array with **no** `.toJson()`/`.toArray()`/`.toCsv()` — those are
  `DatabaseResult` methods.

* **N6 — Periodic work uses `background`, not raw timers.** Register recurring work with
  `background(fn, intervalSeconds)` from `tina4-nodejs` (`background.ts:51`) — it runs in the server
  lifecycle with clean SIGTERM/SIGINT shutdown and catches/logs callback errors — never a bare
  `setInterval` you can't stop.

  ```typescript
  import { background } from "tina4-nodejs";
  background(syncInbox, 60);   // every 60s
  ```

* **N7 — Route param types are a fixed set.** A typed path param (`/users/{id:int}`) must use a
  known type name, or route registration **throws** (`router.ts:650`). Valid types: **`string`,
  `int`, `integer`, `float`, `number`, `alpha`, `alnum`, `slug`, `uuid`, `path`** (`router.ts:605`);
  `int`/`integer`/`float`/`number` coerce to a JS `number`, the rest stay `string`. `{id:integer}`
  (typo) crashes at boot.

## When to reach for `tina4_context`

`tina4_context(instruction, language="nodejs")` (server `tina4-coder`) retrieves the authoritative,
version-current Tina4 API + real examples from the live corpus. It is a **grounding** tool, not a
code generator — write the code yourself from what it returns. Use it as a ladder, not a reflex:

1. **Skill covers it → write from the skill.** These reference files are the source of truth for the
   common surface (models, routes, CRUD, templates, auth, queues). Don't call `tina4_context` for
   something documented here — you'll just spend tokens.
2. **Uncovered / current-tree API / a surprise → then call `tina4_context`.** Reach for it when the
   skill doesn't cover the case, you need an API the installed version added recently, or the
   framework did something the doc didn't predict (a footgun you hit). Pass `language="nodejs"`
   explicitly — auto-detection mis-fires on ambiguous text.
3. **Write it yourself, then verify against the live API.** Confirm any method/field/route shape
   against the running project's MCP index (`api_class("BaseModel")`, `api_search("…")` at
   `/__dev/mcp`, needs `tina4 serve` + `TINA4_DEBUG=true`) or the package source under `packages/`.
   **The framework code is the final authority.** Do **not** use `tina4_code` (the self-hosted
   generator) — the value is the retrieval, not a small model. It failed a boot-and-verify gate that Claude grounded with `tina4_context` passed.

## Batteries included — one runtime dep at most

tina4-nodejs is **batteries-included** and, unlike most Node frameworks, effectively
**zero runtime dependencies**: the root and every workspace `package.json` declare **no
`dependencies`** (the CLI depends only on sibling `@tina4/*` packages). SQLite runs on Node's
**built-in `node:sqlite`** (`DatabaseSync`, `adapters/sqlite.ts:1`) — which is why `engines.node`
is **`>=22.0.0`** and there is no `better-sqlite3`. The only things you ever `npm install` are the
**optional DB drivers** for a non-SQLite engine — `pg`, `mysql2`, `tedious` (MSSQL), `mongodb` —
declared as `optionalDependencies` on `@tina4/orm`. Before you add a package, check whether it's
already in the box. **Need → Tina4 built-in (verified export) — don't add the dep:**

| Need | Tina4 built-in — don't `npm install …` |
|------|----------------------------------------|
| Auth / JWT / password hashing | `import { Auth, getToken, validToken, hashPassword, checkPassword } from "tina4-nodejs"` *(don't add `jsonwebtoken`, `bcrypt`)* |
| ORM / models | `import { BaseModel, initDatabase, bindDatabase } from "tina4-nodejs/orm"` *(don't add `sequelize`, `typeorm`, `prisma`)* |
| Fluent queries / JOINs | `import { QueryBuilder } from "tina4-nodejs/orm"` — `QueryBuilder.fromTable(...)` *(don't add `knex`)* |
| DB drivers | SQLite built in via `node:sqlite`; postgres/mysql/mssql/mongodb via the `optionalDependencies` above |
| Migrations | `tina4nodejs migrate:create` / `migrate` CLI (or `migrate`/`createMigration` from `tina4-nodejs/orm`) *(don't add `knex`/`node-pg-migrate`)* |
| Templating | Frond — `response.render("page.twig", {...})`; templates in `src/templates/` *(don't add `ejs`, `handlebars`, `nunjucks`)* |
| SCSS → CSS | drop `.scss` in `src/scss/` (`ScssCompiler`) — auto-compiled on serve *(don't add `sass`)* |
| Input validation | `import { validate } from "tina4-nodejs/orm"` (field-definition validation) *(don't add `zod`, `joi`)* |
| Response / JSON serialization | `response(data)` — objects/arrays → JSON; a model serialises via `toDict()`; also `response(data, status)` |
| Background queue | `import { Queue } from "tina4-nodejs"` — `new Queue({ topic }).produce(...)` / `.consume()` *(don't add `bullmq`, `bee-queue`)* |
| Email | `import { Messenger } from "tina4-nodejs"` — `new Messenger().send(to, subject, body, html)` *(don't add `nodemailer`)* |
| Sessions | `request.session.set/get/delete/clear` (backends: file/redis/valkey/mongodb/database via `TINA4_SESSION_BACKEND`) |
| Caching | `import { cacheGet, cacheSet, responseCache } from "tina4-nodejs"` + `{% cache %}` template blocks *(don't add `node-cache`)* |
| OpenAPI / Swagger docs | `import { addSecurityScheme } from "tina4-nodejs/swagger"` — docs metadata only (see N1 / Auth footguns) |
| WebSockets | `import { websocket } from "tina4-nodejs"` — `websocket("/ws/…", handler)` *(don't add `ws`, `socket.io`)* |
| GraphQL API from models | `import { GraphQL } from "tina4-nodejs"` *(don't add `apollo-server`, `graphql-yoga`)* |
| SOAP / WSDL | `import { WSDLService, WSDLOperation } from "tina4-nodejs"` |
| i18n / localization | `import { I18n } from "tina4-nodejs"`; JSON in `src/locales/` |
| .env loading + typed env | `import { loadEnv, Env, getEnv, requireEnv } from "tina4-nodejs"` *(don't add `dotenv`)* |
| Fake data / seeding | `import { FakeData, seedOrm } from "tina4-nodejs/orm"` — `seedOrm(User, 50)` *(don't add `@faker-js/faker`)* |
| Events | `import { Events } from "tina4-nodejs"` — `Events.on/emit/once/off` |
| Background/periodic tasks | `import { background } from "tina4-nodejs"` — `background(fn, seconds)` (see N6) |
| Outbound HTTP calls | `import { Api } from "tina4-nodejs"` *(don't add `axios`, `node-fetch`)* |
| Dependency injection | `import { Container } from "tina4-nodejs"` (see the DI Container module) |

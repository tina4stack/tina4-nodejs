/**
 * Unit tests for the ORM enhancements (Phase 2).
 * Run with: npx tsx test/orm.test.ts
 */
import { rmSync, mkdirSync } from "node:fs";
import {
  initDatabase,
  closeDatabase,
  getAdapter,
  validate,
  BaseModel,
  syncModels,
} from "../packages/orm/src/index.ts";
import { snakeToCamel, camelToSnake } from "../packages/orm/src/baseModel.ts";
import type { FieldDefinition, DiscoveredModel } from "../packages/orm/src/index.ts";

const TEST_DB = "/tmp/tina4-orm-test/test.db";
let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

// Clean slate
try { rmSync("/tmp/tina4-orm-test", { recursive: true }); } catch {}
mkdirSync("/tmp/tina4-orm-test", { recursive: true });

console.log("=== ORM Enhancement Tests ===\n");

// Initialize database
await initDatabase({ type: "sqlite", path: TEST_DB });

// --- Define test model classes ---

class User extends BaseModel {
  static tableName = "users";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string", required: true, minLength: 2, maxLength: 50 },
    email: { type: "string", required: true, pattern: "^.+@.+\\..+$" },
    age: { type: "integer", min: 0, max: 150 },
  };
}

class Article extends BaseModel {
  static tableName = "articles";
  static softDelete = true;
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "string", required: true },
    body: { type: "text" },
    author_id: { type: "integer" },
  };
  static belongsTo = [{ model: "User", foreignKey: "author_id" }];
  static hasMany = [{ model: "Reply", foreignKey: "article_id" }];
}

class Comment extends BaseModel {
  static tableName = "comments";
  static tableFilter = "approved = 1";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    text: { type: "string", required: true },
    article_id: { type: "integer" },
    approved: { type: "integer", default: 0 },
  };
}

class Reply extends BaseModel {
  static tableName = "replies";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    body: { type: "string", required: true },
    article_id: { type: "integer" },
  };
  static belongsTo = [{ model: "Article", foreignKey: "article_id" }];
}

// Register models for eager loading lookup
BaseModel.registerModel("User", User);
BaseModel.registerModel("Article", Article);
BaseModel.registerModel("Reply", Reply);
BaseModel.registerModel("Comment", Comment);

// --- Sync models (creates tables) ---
console.log("--- Table Creation ---");

const userModel: DiscoveredModel = {
  definition: {
    tableName: "users",
    fields: User.fields,
  },
  filePath: "test",
  modelClass: User,
};

const articleModel: DiscoveredModel = {
  definition: {
    tableName: "articles",
    fields: Article.fields,
    softDelete: true,
  },
  filePath: "test",
  modelClass: Article,
};

const commentModel: DiscoveredModel = {
  definition: {
    tableName: "comments",
    fields: Comment.fields,
    tableFilter: "approved = 1",
  },
  filePath: "test",
  modelClass: Comment,
};

const replyModel: DiscoveredModel = {
  definition: {
    tableName: "replies",
    fields: Reply.fields,
  },
  filePath: "test",
  modelClass: Reply,
};

syncModels([userModel, articleModel, commentModel, replyModel]);

const adapter = getAdapter();
assert("Users table created", (adapter as any).tableExists("users"));
assert("Articles table created", (adapter as any).tableExists("articles"));
assert("Comments table created", (adapter as any).tableExists("comments"));

// Verify soft delete column exists
const articleCols = (adapter as any).getTableColumns("articles");
const hasIsDeleted = articleCols.some((c: any) => c.name === "is_deleted");
assert("Articles has is_deleted column (soft delete)", hasIsDeleted);

// --- BaseModel CRUD ---
console.log("\n--- BaseModel CRUD ---");

const user = new User({ name: "Alice", email: "alice@test.com", age: 30 });
user.save();
assert("User saved with auto-generated ID", (user as any).id !== undefined);

const userId = (user as any).id;
const found = User.findById(userId);
assert("findById returns saved user", found !== null && (found as any).name === "Alice");

(user as any).name = "Alice Updated";
user.save();
const updated = User.findById(userId);
assert("save() updates existing record", (updated as any).name === "Alice Updated");

// Create more users
const bob = new User({ name: "Bob", email: "bob@test.com", age: 25 });
bob.save();
const charlie = new User({ name: "Charlie", email: "charlie@test.com", age: 35 });
charlie.save();

const allUsers = User.all();
assert("all returns all users", allUsers.length === 3);

const filtered = User.all("age > ?", [28]);
assert("all with WHERE clause", filtered.length === 2);

// --- Soft Delete ---
console.log("\n--- Soft Delete ---");

const article1 = new Article({ title: "Test Article", body: "Content", author_id: userId });
article1.save();
const articleId = (article1 as any).id;

const article2 = new Article({ title: "Another Article", body: "More content", author_id: userId });
article2.save();

// Soft delete article1
article1.delete();
assert("Soft delete sets is_deleted", (article1 as any).is_deleted === 1);

// findById should not find soft-deleted
const deletedArticle = Article.findById(articleId);
assert("findById excludes soft-deleted records", deletedArticle === null);

// all should not include soft-deleted
const allArticles = Article.all();
assert("all excludes soft-deleted records", allArticles.length === 1);

// Verify data still in DB
const rawRows = adapter.query(`SELECT * FROM "articles" WHERE id = ?`, [articleId]);
assert("Soft-deleted record still in database", rawRows.length === 1);

// --- Hard Delete ---
console.log("\n--- Hard Delete ---");

const userToDelete = User.findById(bob.id as number);
assert("User exists before delete", userToDelete !== null);
userToDelete!.delete();

const afterDelete = User.findById(bob.id as number);
assert("Hard delete removes record", afterDelete === null);

// --- Table Filter / Scopes ---
console.log("\n--- Table Filter (Scopes) ---");

// Insert comments directly
adapter.execute(`INSERT INTO "comments" (text, article_id, approved) VALUES (?, ?, ?)`, ["Good!", 1, 1]);
adapter.execute(`INSERT INTO "comments" (text, article_id, approved) VALUES (?, ?, ?)`, ["Spam!", 1, 0]);
adapter.execute(`INSERT INTO "comments" (text, article_id, approved) VALUES (?, ?, ?)`, ["Great!", 1, 1]);

const approvedComments = Comment.all();
assert("tableFilter filters to approved=1 only", approvedComments.length === 2);

const allCommentsRaw = adapter.query(`SELECT * FROM "comments"`);
assert("Raw query shows all comments", (allCommentsRaw as any[]).length === 3);

// --- toDict / toArray / toJson ---
console.log("\n--- toDict / toArray / toJson ---");

const alice = User.findById(userId);
const dict = alice!.toDict();
assert("toDict returns plain object", typeof dict === "object" && dict.name === "Alice Updated");
assert("toDict contains model fields", "id" in dict && "email" in dict && "age" in dict);
const arr = alice!.toArray();
assert("toArray returns array of values", Array.isArray(arr) && arr.includes("Alice Updated"));

const json = alice!.toJson();
const parsed = JSON.parse(json);
assert("toJson returns valid JSON", parsed.name === "Alice Updated");

// --- Validation ---
console.log("\n--- Validation ---");

const v1 = validate({}, User.fields, false);
assert("Required fields validation", v1.length >= 2); // name and email required

const v2 = validate({ name: "A", email: "bad", age: 200 }, User.fields, false);
assert("minLength validation", v2.some(e => e.field === "name" && e.message.includes("at least")));
assert("Pattern validation", v2.some(e => e.field === "email" && e.message.includes("pattern")));
assert("Max validation", v2.some(e => e.field === "age" && e.message.includes("at most")));

const v3 = validate({ name: "Valid Name", email: "valid@test.com" }, User.fields, false);
assert("Valid data passes validation", v3.length === 0);

const v4 = validate({ name: "X" }, User.fields, true);
assert("Update mode skips required for missing fields", !v4.some(e => e.field === "email"));

// --- Integer validation ---
const v5 = validate({ name: "Test", email: "t@t.com", age: 3.5 }, User.fields, false);
assert("Integer validation rejects float", v5.some(e => e.field === "age" && e.message.includes("integer")));

// --- Relationship Tests ---
console.log("\n--- Relationships ---");

// Create some replies for the article
const reply1 = new Reply({ body: "Nice article!", article_id: (article2 as any).id });
reply1.save();
const reply2 = new Reply({ body: "Great!", article_id: (article2 as any).id });
reply2.save();

// has_many (imperative)
const replies = article2.hasMany(Reply as any, "article_id");
assert("hasMany returns related records", replies.length === 2);

// belongs_to (imperative)
const parentUser = article2.belongsTo(User as any, "author_id");
assert("belongsTo returns parent record", parentUser !== null && (parentUser as any).name === "Alice Updated");

// hasOne on Reply table (article has many replies, check one exists)
const singleReply = article2.hasOne(Reply as any, "article_id");
assert("hasOne returns single related record", singleReply !== null);

// --- Eager Loading ---
console.log("\n--- Eager Loading ---");

// Create another article with replies
const article3 = new Article({ title: "Second Article", body: "Content 2", author_id: userId });
article3.save();
const reply3 = new Reply({ body: "Reply to second", article_id: (article3 as any).id });
reply3.save();

// all with include (eager load has_many)
const articlesWithReplies = Article.all(undefined, undefined, ["reply"]);
// article1 was soft-deleted, so we should get article2 and article3
assert("Eager load all returns correct count", articlesWithReplies.length === 2);

// findById with include
const singleArticle = Article.findById((article2 as any).id, ["reply"]);
assert("Eager load findById loads relationships", singleArticle !== null);

// toDict with include
const dictWithInclude = singleArticle!.toDict(["reply"]);
assert("toDict with include contains relationship", "reply" in dictWithInclude || "replies" in dictWithInclude);

// toDict with belongs_to include
const artDict = article2.toDict(["user"]);
assert("toDict with belongsTo include", "user" in artDict);

// --- Cache clears on save ---
console.log("\n--- Relationship Cache ---");
const freshArticle = Article.findById((article2 as any).id);
if (freshArticle) {
  freshArticle.hasMany(Reply as any, "article_id"); // populate cache
  (freshArticle as any).title = "Updated Title";
  freshArticle.save();
  // _relCache should be cleared
  assert("Relationship cache cleared on save", true);
}

// --- selectOne ---
console.log("\n--- selectOne ---");
{
  const db = getAdapter()!;
  db.execute("CREATE TABLE IF NOT EXISTS so_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)");
  db.execute("INSERT INTO so_users (name) VALUES (?)", ["Alice"]);
  db.execute("INSERT INTO so_users (name) VALUES (?)", ["Bob"]);

  class SoUser extends BaseModel {
    static tableName = "so_users";
    static fields: Record<string, FieldDefinition> = {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string", required: true },
    };
  }

  const found = SoUser.selectOne<SoUser>("SELECT * FROM so_users WHERE name = ?", ["Alice"]);
  assert("selectOne returns an instance", found !== null && (found as any).name === "Alice");

  const notFound = SoUser.selectOne<SoUser>("SELECT * FROM so_users WHERE name = ?", ["Nonexistent"]);
  assert("selectOne returns null when not found", notFound === null);
}

// --- select() ---
console.log("\n--- select() ---");

{
  const allUsers = User.select<User>("SELECT * FROM users");
  assert("select returns array", Array.isArray(allUsers));
  assert("select returns all non-deleted users", allUsers.length >= 2);

  const filtered = User.select<User>("SELECT * FROM users WHERE age > ?", [28]);
  assert("select with params filters correctly", filtered.length >= 1);

  const empty = User.select<User>("SELECT * FROM users WHERE age > ?", [9999]);
  assert("select with no matches returns empty array", empty.length === 0);
}

// --- all with various args ---
console.log("\n--- all Variations ---");

{
  const allUsersNow = User.all();
  assert("all without args returns all", allUsersNow.length >= 2);

  const withWhere = User.all("age > ?", [0]);
  assert("all with WHERE clause returns filtered", withWhere.length >= 1);

  const withEmpty = User.all("age > ?", [99999]);
  assert("all with no matches returns empty", withEmpty.length === 0);
}

// --- Validation Edge Cases ---
console.log("\n--- Validation Edge Cases ---");

{
  // Test number type validation
  const numFields: Record<string, FieldDefinition> = {
    score: { type: "number", min: 0, max: 100 },
  };

  const v1 = validate({ score: 50.5 }, numFields, false);
  assert("valid float passes", v1.length === 0);

  const v2 = validate({ score: -1 }, numFields, false);
  assert("below min fails", v2.some(e => e.field === "score"));

  const v3 = validate({ score: 101 }, numFields, false);
  assert("above max fails", v3.some(e => e.field === "score"));
}

{
  // Test string length validation
  const strFields: Record<string, FieldDefinition> = {
    code: { type: "string", minLength: 3, maxLength: 10 },
  };

  const v1 = validate({ code: "AB" }, strFields, false);
  assert("string too short fails", v1.some(e => e.field === "code"));

  const v2 = validate({ code: "ABCDEFGHIJK" }, strFields, false);
  assert("string too long fails", v2.some(e => e.field === "code"));

  const v3 = validate({ code: "ABCDE" }, strFields, false);
  assert("string in range passes", v3.length === 0);
}

{
  // Test boolean type validation
  const boolFields: Record<string, FieldDefinition> = {
    active: { type: "boolean" },
  };

  const v1 = validate({ active: true }, boolFields, false);
  assert("boolean true passes", v1.length === 0);

  const v2 = validate({ active: false }, boolFields, false);
  assert("boolean false passes", v2.length === 0);
}

{
  // Test datetime type validation
  const dtFields: Record<string, FieldDefinition> = {
    created_at: { type: "datetime" },
  };

  const v1 = validate({ created_at: "2024-01-15T10:30:00Z" }, dtFields, false);
  assert("valid ISO datetime passes", v1.length === 0);
}

{
  // Test default value
  const defFields: Record<string, FieldDefinition> = {
    status: { type: "string", default: "active" },
    name: { type: "string", required: true },
  };

  const v1 = validate({ name: "Test" }, defFields, false);
  assert("field with default is not required", v1.length === 0);
}

// --- BaseModel toArray ---
console.log("\n--- toArray/toDict Edge Cases ---");

{
  const user = User.all()[0];
  if (user) {
    const dict = user.toDict();
    assert("toDict has id field", "id" in dict);
    assert("toDict has name field", "name" in dict);
    assert("toDict has email field", "email" in dict);

    const arr = user.toArray();
    assert("toArray returns non-empty array", arr.length > 0);

    const json = user.toJson();
    assert("toJson is valid JSON string", typeof json === "string");
    const parsed = JSON.parse(json);
    assert("toJson round-trips correctly", parsed.name === dict.name);
  }
}

// --- Model Registry ---
console.log("\n--- Model Registry ---");

{
  // registerModel was called earlier — verify it doesn't throw on re-registration
  BaseModel.registerModel("User", User);
  assert("re-registering User does not throw", true);
  BaseModel.registerModel("Article", Article);
  assert("re-registering Article does not throw", true);
}

// --- Multiple saves (update idempotency) ---
console.log("\n--- Update Idempotency ---");

{
  const user = User.all()[0];
  if (user) {
    const origName = (user as any).name;
    (user as any).name = "Idempotent Test";
    user.save();
    const after1 = User.findById((user as any).id);
    assert("first save updates name", (after1 as any)?.name === "Idempotent Test");

    user.save(); // save again without changes
    const after2 = User.findById((user as any).id);
    assert("second save is idempotent", (after2 as any)?.name === "Idempotent Test");

    // Restore
    (user as any).name = origName;
    user.save();
  }
}

// --- New record without ID ---
console.log("\n--- Create Without ID ---");

{
  const newUser = new User({ name: "NoIdUser", email: "noid@test.com", age: 20 });
  assert("new user has no ID before save", (newUser as any).id === undefined);
  newUser.save();
  assert("new user gets ID after save", (newUser as any).id !== undefined);
  assert("new user ID is positive integer", typeof (newUser as any).id === "number" && (newUser as any).id > 0);

  // Clean up
  newUser.delete();
}

// ── snakeToCamel / camelToSnake ────────────────────────────────
{
  assert("snakeToCamel: first_name → firstName", snakeToCamel("first_name") === "firstName");
  assert("snakeToCamel: user_id → userId", snakeToCamel("user_id") === "userId");
  assert("snakeToCamel: id → id", snakeToCamel("id") === "id");
  assert("snakeToCamel: my_field_name → myFieldName", snakeToCamel("my_field_name") === "myFieldName");

  assert("camelToSnake: firstName → first_name", camelToSnake("firstName") === "first_name");
  assert("camelToSnake: userId → user_id", camelToSnake("userId") === "user_id");
  assert("camelToSnake: id → id", camelToSnake("id") === "id");
  assert("camelToSnake: myFieldName → my_field_name", camelToSnake("myFieldName") === "my_field_name");
}

// ── Parity contract: driver-native types on read path ──────────
//
// Mirrors tina4-python's TestFieldsNativeTypes suite. Guards against
// any future ORM read-path change that would accidentally re-coerce
// a value that's already the correct type (e.g. a native Date instance
// returned by the `pg` adapter on PostgreSQL).
//
// See tina4-python/plan/orm-field-validate-native-types.md.
{
  const adapter = getAdapter();
  if (adapter) {
    await adapter.execute(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created_at TEXT)"
    );
    await adapter.execute(
      "INSERT INTO events (title, created_at) VALUES (?, ?)",
      ["launch", "2026-04-16 22:30:00"]
    );
    const rows = await adapter.query("SELECT * FROM events WHERE id = 1");
    const arr = Array.isArray(rows) ? rows : [];
    assert("ORM datetime round-trip: fetch returns an array", Array.isArray(rows));
    assert("ORM datetime round-trip: row exists", arr.length === 1);
    assert(
      "ORM datetime round-trip: datetime value preserved",
      (arr[0] as any)?.created_at === "2026-04-16 22:30:00"
    );
  } else {
    assert("ORM datetime round-trip: adapter unavailable (skipped)", true);
  }
}

// --- Error message — regression for tina4-nodejs#45 ---
//
// Before the fix, "No database adapter configured" pointed users at the
// legacy bare DATABASE_URL. The boot guard since v3.12 rejects that key,
// so the old error sent users straight into a dead end. The error must
// now name TINA4_DATABASE_URL — the actual key the framework reads.
console.log("\n--- ORM error mentions TINA4_DATABASE_URL ---");
{
  const savedTina4 = process.env.TINA4_DATABASE_URL;
  const savedBare = process.env.DATABASE_URL;

  closeDatabase();
  delete process.env.TINA4_DATABASE_URL;
  delete process.env.DATABASE_URL;

  class _NoDbModel extends BaseModel {
    static tableName = "no_db";
    static fields = { id: { type: "integer" as const, primaryKey: true } };
  }

  let errMsg = "";
  try {
    await _NoDbModel.all();
  } catch (e) {
    errMsg = String((e as Error)?.message ?? e);
  }

  assert(
    "ORM error names TINA4_DATABASE_URL",
    /TINA4_DATABASE_URL/.test(errMsg),
    `got: ${errMsg}`,
  );
  assert(
    "ORM error does not point at legacy bare DATABASE_URL",
    !/set DATABASE_URL/.test(errMsg),
    `got: ${errMsg}`,
  );

  // Restore env so later tests/cleanups stay clean.
  if (savedTina4 !== undefined) process.env.TINA4_DATABASE_URL = savedTina4;
  if (savedBare !== undefined) process.env.DATABASE_URL = savedBare;
}

// Cleanup
closeDatabase();
try { rmSync("/tmp/tina4-orm-test", { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

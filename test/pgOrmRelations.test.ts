/**
 * Acceptance test for the v3.13.16 ORM/QueryBuilder fixes found by live
 * PostgreSQL validation. Three bugs, fixed to match the Python reference:
 *
 *   Bug 1 (HIGH) — eager-load `include` silently returned no relations when
 *     used standalone (no server-boot auto-discovery). Root cause: the parent
 *     model's hasMany is registered by the CHILD model's _processForeignKeys(),
 *     which never ran outside boot. Fixed by proactively processing the FK
 *     fields of ALL registered models in registerModel() and _eagerLoad().
 *
 *   Bug 2 (low) — `include` matching was effectively case-sensitive; only the
 *     exact model name worked. Now resolved case-insensitively against the
 *     model name, its singular/plural key, and the related table name, and a
 *     Log.warning is emitted when an include name matches nothing (no silent skip).
 *
 *   Bug 3 (low/parity) — aggregate columns (SUM, AVG, …) came back as strings
 *     because node-postgres returns int8/numeric as strings. The Postgres
 *     adapter now registers pg type parsers so int8 (OID 20) and numeric
 *     (OID 1700) decode to JS numbers — parity with Python/Ruby/PHP.
 *
 * Verifies STANDALONE — no server boot, just registerModel + findById/query.
 *
 * Skipped automatically when no PostgreSQL is reachable (socket probe) so CI
 * without a container just no-ops. Auto-discovered by test/run-all.ts.
 *
 * Run with: npx tsx test/pgOrmRelations.test.ts
 */
import net from "node:net";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "5432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function summaryAndExit(code = 0): never {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(code);
}

function pgReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.connect(PG_PORT, PG_HOST, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

console.log("=== ORM relations + aggregates on PostgreSQL ===\n");

const reachable = await pgReachable();
if (!reachable) {
  console.log(`  \x1b[33mSKIP\x1b[0m PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} — skipping`);
  summaryAndExit(0);
}

try {
  await import("pg");
} catch {
  console.log(`  \x1b[33mSKIP\x1b[0m 'pg' package not installed — npm install pg`);
  summaryAndExit(0);
}

const { initDatabase, closeDatabase, BaseModel, QueryBuilder } = await import(
  "../packages/orm/src/index.ts"
);
const { Log } = await import("../packages/core/src/index.ts");

const URL = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;

class Author extends BaseModel {
  static tableName = "t4_rel_authors";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 100 },
  };
  declare id?: number;
  declare name?: string;
}

class Post extends BaseModel {
  static tableName = "t4_rel_posts";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    title: { type: "string" as const, required: true, maxLength: 100 },
    qty: { type: "integer" as const },
    // Auto-wires Post.belongsTo(Author) AND Author.hasMany(Post).
    author_id: { type: "foreignKey" as const, references: "Author" },
  };
  declare id?: number;
  declare title?: string;
  declare qty?: number;
  declare author_id?: number;
}

// Standalone registration — NO server boot / auto-discovery.
BaseModel.registerModel("Author", Author);
BaseModel.registerModel("Post", Post);

const db = await initDatabase({ url: URL });

try {
  await db.execute("DROP TABLE IF EXISTS t4_rel_posts");
  await db.execute("DROP TABLE IF EXISTS t4_rel_authors");
  await Author.createTable();
  await Post.createTable();

  const author = new Author({ name: "Ada" });
  await author.save();
  await new Post({ title: "P1", qty: 5, author_id: author.id }).save();
  await new Post({ title: "P2", qty: 12, author_id: author.id }).save();

  // ── Bug 1: eager-load include populates posts STANDALONE ─────────
  const a1 = await Author.findById(author.id, ["Post"]);
  assert("findById() returns the author", a1 !== null && a1!.name === "Ada");
  const d1 = a1!.toDict(["Post"]);
  const posts1 = d1.Post as unknown[] | undefined;
  assert(
    "include[\"Post\"] eager-loads posts standalone (Bug 1)",
    Array.isArray(posts1) && posts1.length === 2,
    `(got ${JSON.stringify(posts1)})`,
  );

  // ── Bug 2: include name is resolved case-insensitively ───────────
  const a2 = await Author.findById(author.id, ["post"]);
  const posts2 = a2!.toDict(["post"]).post as unknown[] | undefined;
  assert(
    "include[\"post\"] (lowercase singular) resolves (Bug 2)",
    Array.isArray(posts2) && posts2.length === 2,
  );

  const a3 = await Author.findById(author.id, ["posts"]);
  const posts3 = a3!.toDict(["posts"]).posts as unknown[] | undefined;
  assert(
    "include[\"posts\"] (plural / table name) resolves (Bug 2)",
    Array.isArray(posts3) && posts3.length === 2,
  );

  // ── Bug 2: a bad include name warns instead of silently skipping ─
  // Log.warn was the prohibited alias (LOG-A02) and is gone -- warning() is
  // the one spelling now, and the real code path calls it internally.
  const origWarning = Log.warning;
  let warned = "";
  (Log as unknown as { warning: (m: string) => void }).warning = (m: string) => { warned += m; };
  try {
    await Author.findById(author.id, ["totally_bogus"]);
  } finally {
    (Log as unknown as { warning: (m: string) => void }).warning = origWarning;
  }
  assert(
    "unknown include name emits a Log.warning (Bug 2)",
    /totally_bogus/.test(warned) && /did not match/.test(warned),
    `(warned: ${JSON.stringify(warned)})`,
  );

  // ── Bug 3: aggregate columns come back as numbers (parity) ───────
  const sumRow = await QueryBuilder.fromTable("t4_rel_posts")
    .select("SUM(qty) as total")
    .first<{ total: unknown }>();
  assert(
    "SUM(qty) returns a number, not a string (Bug 3)",
    typeof sumRow?.total === "number" && sumRow!.total === 17,
    `(got ${JSON.stringify(sumRow?.total)} typeof ${typeof sumRow?.total})`,
  );

  const avgRow = await QueryBuilder.fromTable("t4_rel_posts")
    .select("AVG(qty) as average")
    .first<{ average: unknown }>();
  assert(
    "AVG(qty) (numeric) returns a number (Bug 3)",
    typeof avgRow?.average === "number",
    `(got ${JSON.stringify(avgRow?.average)} typeof ${typeof avgRow?.average})`,
  );

  // ── Regression: count() still returns a real number ──────────────
  const cnt = await Post.count();
  assert("count() still returns a number after type-parser change", cnt === 2);

  // ── Regression: getNextId() still works after type-parser change ─
  const nextId = await db.getNextId("t4_rel_posts");
  assert("getNextId() still returns a number", typeof nextId === "number" && nextId > 0);
} finally {
  try { await db.execute("DROP TABLE IF EXISTS t4_rel_posts"); } catch {}
  try { await db.execute("DROP TABLE IF EXISTS t4_rel_authors"); } catch {}
  try { await closeDatabase(); } catch {}
}

summaryAndExit(fail > 0 ? 1 : 0);

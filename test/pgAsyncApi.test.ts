/**
 * Acceptance test for the v3.14.0 "Option A" async ORM API on PostgreSQL.
 *
 * Before this change the public Database / BaseModel / QueryBuilder methods
 * called only the synchronous adapter methods, which the async adapters
 * (PostgreSQL/MySQL/MSSQL/Firebird/Mongo) make THROW
 * ("Use fetchAsync() for PostgreSQL."). Every DB-backed call therefore
 * exploded on PG — only db.getAdapter().fetchAsync(...) worked.
 *
 * The fix makes the wrapper methods async and await the adapter's *Async
 * method when present (falling back to the sync method for SQLite). This
 * test exercises the public API end-to-end against a live PostgreSQL:
 *   - db.fetch / db.fetchOne / db.execute
 *   - BaseModel.createTable + save (auto-inc id + string + boolean + datetime)
 *   - BaseModel.findById / all / count
 *   - QueryBuilder.fromTable(...).get() / .count() / .exists()
 * plus the Bug-1 engine-aware DDL check (datetime → TIMESTAMP, boolean →
 * native BOOLEAN on PG).
 *
 * Skipped automatically when no PostgreSQL is reachable so CI without a
 * container just no-ops (socket reachability probe + count line).
 *
 * Run with: npx tsx test/pgAsyncApi.test.ts
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

console.log("=== Async ORM API on PostgreSQL (Option A) ===\n");

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

const URL = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;

class PgWidget extends BaseModel {
  static tableName = "t4_async_widgets";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 100 },
    active: { type: "boolean" as const, default: true },
    created_at: { type: "datetime" as const },
  };
  declare id?: number;
  declare name?: string;
  declare active?: boolean;
  declare created_at?: string;
}

const db = await initDatabase({ url: URL });

try {
  // Clean slate
  await db.execute('DROP TABLE IF EXISTS t4_async_widgets');

  // ── 1. db.fetch on the public (async) API ──────────────────────
  const f = await db.fetch("SELECT 1 AS one");
  assert("db.fetch() works on PG", f.records.length === 1 && (f.records[0] as any).one === 1);

  // ── 2. BaseModel.createTable — engine-aware DDL (Bug 1) ─────────
  await PgWidget.createTable();
  assert("createTable() succeeded on PG", await db.tableExists("t4_async_widgets"));

  const cols = await db.getColumns("t4_async_widgets");
  const colType = (name: string) => cols.find((c) => c.name === name)?.type ?? "";
  assert(
    "datetime column → TIMESTAMP (not DATETIME) on PG",
    /timestamp/i.test(colType("created_at")),
    `(got ${colType("created_at")})`,
  );
  assert(
    "boolean column → native BOOLEAN on PG",
    /bool/i.test(colType("active")),
    `(got ${colType("active")})`,
  );

  // ── 3. save() round-trip: auto-inc id + string + boolean + datetime ─
  const w1 = new PgWidget({ name: "Alpha", active: true, created_at: "2026-06-15 09:00:00" });
  const saved1 = await w1.save();
  assert("save() returns instance (not false) on PG", saved1 !== false);
  assert("save() assigns auto-increment id from RETURNING", typeof w1.id === "number" && w1.id! > 0);

  const w2 = new PgWidget({ name: "Beta", active: false, created_at: "2026-06-15 10:00:00" });
  await w2.save();
  assert("second save() gets a distinct id", w2.id !== w1.id);

  // ── 4. findById / all / count ───────────────────────────────────
  const found = await PgWidget.findById(w1.id);
  assert("findById() returns the row", found !== null && found!.name === "Alpha");
  assert("boolean round-trips as a real boolean", found!.active === true);

  const all = await PgWidget.all();
  assert("all() returns both rows", all.length === 2);

  const cnt = await PgWidget.count();
  assert("count() returns 2", cnt === 2);

  // ── 5. QueryBuilder ─────────────────────────────────────────────
  const activeRows = await QueryBuilder.fromTable("t4_async_widgets")
    .select("id", "name")
    .where("active = ?", [true])
    .orderBy("id")
    .get();
  assert("QueryBuilder.get() returns active rows", activeRows.records.length === 1);

  const qbCount = await QueryBuilder.fromTable("t4_async_widgets").count();
  assert("QueryBuilder.count() returns 2", qbCount === 2);

  const exists = await QueryBuilder.fromTable("t4_async_widgets")
    .where("name = ?", ["Beta"])
    .exists();
  assert("QueryBuilder.exists() finds Beta", exists === true);

  // ── 6. db.execute (write) + db.fetchOne ─────────────────────────
  const ok = await db.execute("UPDATE t4_async_widgets SET name = ? WHERE id = ?", ["Alpha2", w1.id]);
  assert("db.execute() write returns true on PG", ok === true);

  const one = await db.fetchOne<{ name: string }>(
    "SELECT name FROM t4_async_widgets WHERE id = ?",
    [w1.id],
  );
  assert("db.fetchOne() reflects the update", one?.name === "Alpha2");
} finally {
  try { await db.execute('DROP TABLE IF EXISTS t4_async_widgets'); } catch {}
  try { await closeDatabase(); } catch {}
}

summaryAndExit(fail > 0 ? 1 : 0);

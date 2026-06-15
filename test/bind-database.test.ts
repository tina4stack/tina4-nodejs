/**
 * bindDatabase(adapter, name?) — public, user-facing connection binding.
 *
 * Mirrors the Python master `bind_database(db, name=None)`:
 *   - no name  → registers the global DEFAULT connection (getAdapter()).
 *   - name     → registers a NAMED connection; a model with `static _db = name`
 *                resolves to it via getNamedAdapter(name).
 *
 * getNamedAdapter() throws a clear error when the name was never bound (so a
 * mis-typed `_db` writes to nothing rather than silently hitting the default).
 *
 * createAdapterFromUrl() lets users build a named secondary adapter from a URL
 * without making it the default — the documented usage is
 *   bindDatabase(await createAdapterFromUrl(url, user, pass), "analytics").
 *
 * Includes ONE live two-database check (skipped if PostgreSQL is unreachable):
 * default connection from tina4_node, named "analytics" from tina4_py; a
 * default model and a `static _db = "analytics"` model each create a table and
 * insert in their own DB, and SELECT current_database() proves they resolved to
 * different databases.
 *
 * Run with: npx tsx test/bind-database.test.ts
 */
import net from "node:net";
import {
  bindDatabase,
  createAdapterFromUrl,
  getAdapter,
  getNamedAdapter,
  closeDatabase,
  BaseModel,
} from "../packages/orm/src/index.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";

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

// ── 1. bindDatabase(adapter) → default connection ────────────────────
{
  const adapter = new SQLiteAdapter(":memory:");
  bindDatabase(adapter);
  assert("bindDatabase(adapter) makes getAdapter() return it", getAdapter() === adapter);
}

// ── 2. bindDatabase(adapter2, "analytics") → named connection ────────
{
  const adapter2 = new SQLiteAdapter(":memory:");
  bindDatabase(adapter2, "analytics");
  assert(
    'bindDatabase(adapter2, "analytics") registers a named adapter',
    getNamedAdapter("analytics") === adapter2,
  );
  // The default must be untouched by a named bind.
  assert(
    "named bind does not clobber the default connection",
    getAdapter() !== adapter2,
  );

  // ── 3. a model with static _db = "analytics" resolves to adapter2 ──
  class AnalyticsModel extends BaseModel {
    static tableName = "events";
    static _db = "analytics";
    // expose protected getDb() for the test
    static resolveDb() { return (this as any).getDb(); }
  }
  assert(
    'model with static _db = "analytics" resolves to adapter2 via getDb()',
    (AnalyticsModel as any).resolveDb() === adapter2,
  );
}

// ── 4. getNamedAdapter("missing") throws ─────────────────────────────
{
  let threw = false;
  let message = "";
  try {
    getNamedAdapter("missing");
  } catch (e: any) {
    threw = true;
    message = e?.message ?? "";
  }
  assert("getNamedAdapter('missing') throws", threw);
  assert(
    "error message tells the dev to call bindDatabase(adapter, name)",
    /bindDatabase\(adapter, "missing"\)/.test(message),
    `(got: ${message})`,
  );
}

// ── 5. LIVE two-database check (skipped if PG unreachable) ───────────
const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "5432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USER ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASS ?? "tina4";
const PG_DEFAULT_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";
const PG_NAMED_DB = process.env.TINA4_TEST_PG_DB_2 ?? "tina4_py";

function pgReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
    socket.connect(PG_PORT, PG_HOST, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

console.log("\n--- Live two-database check ---");

const reachable = await pgReachable();
let pgAvailable = reachable;
if (reachable) {
  try {
    await import("pg");
  } catch {
    pgAvailable = false;
    console.log(`  \x1b[33mSKIP\x1b[0m 'pg' package not installed — npm install pg`);
  }
}

if (!pgAvailable) {
  if (reachable) {
    // already logged the pg-package skip above
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} — skipping live two-DB check`);
  }
  summaryAndExit(fail > 0 ? 1 : 0);
}

// Reset any adapter state left over from the unit assertions above.
try { closeDatabase(); } catch {}

const defaultUrl = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DEFAULT_DB}`;
const namedUrl = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_NAMED_DB}`;

// Default connection (tina4_node) — no name.
bindDatabase(await createAdapterFromUrl(defaultUrl, PG_USER, PG_PASS));
// Named secondary connection (tina4_py) — built from a URL without becoming default.
bindDatabase(await createAdapterFromUrl(namedUrl, PG_USER, PG_PASS), "analytics");

// A default model (resolves to getAdapter() → tina4_node).
class DefaultWidget extends BaseModel {
  static tableName = "t4_bind_default";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 100 },
  };
  declare id?: number;
  declare name?: string;
}

// An analytics model (static _db = "analytics" → tina4_py).
class AnalyticsWidget extends BaseModel {
  static tableName = "t4_bind_analytics";
  static _db = "analytics";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 100 },
  };
  declare id?: number;
  declare name?: string;
}

const defaultAdapter = getAdapter();
const namedAdapter = getNamedAdapter("analytics");

async function pgExec(adapter: any, sql: string, params?: unknown[]) {
  return adapter.executeAsync ? adapter.executeAsync(sql, params) : adapter.execute(sql, params);
}
async function pgFetchOne(adapter: any, sql: string, params?: unknown[]) {
  return adapter.fetchOneAsync ? adapter.fetchOneAsync(sql, params) : adapter.fetchOne(sql, params);
}

try {
  // Confirm the two adapters point at different databases at the connection level.
  const defDbRow: any = await pgFetchOne(defaultAdapter, "SELECT current_database() AS db");
  const namedDbRow: any = await pgFetchOne(namedAdapter, "SELECT current_database() AS db");
  assert(
    "default and named adapters resolve to DIFFERENT databases",
    defDbRow?.db && namedDbRow?.db && defDbRow.db !== namedDbRow.db,
    `(default=${defDbRow?.db}, named=${namedDbRow?.db})`,
  );
  assert(`default connection is ${PG_DEFAULT_DB}`, defDbRow?.db === PG_DEFAULT_DB, `(got ${defDbRow?.db})`);
  assert(`named "analytics" connection is ${PG_NAMED_DB}`, namedDbRow?.db === PG_NAMED_DB, `(got ${namedDbRow?.db})`);

  // Clean slate for the temp tables in each DB.
  await pgExec(defaultAdapter, "DROP TABLE IF EXISTS t4_bind_default");
  await pgExec(namedAdapter, "DROP TABLE IF EXISTS t4_bind_analytics");

  // Each model creates its table + inserts a row in ITS OWN database.
  await DefaultWidget.createTable();
  await AnalyticsWidget.createTable();

  await new DefaultWidget({ name: "from-default" }).save();
  await new AnalyticsWidget({ name: "from-analytics" }).save();

  // The default model's table exists in the DEFAULT db, not the named one.
  const defTableInDefaultDb: any = await pgFetchOne(defaultAdapter,
    "SELECT to_regclass('public.t4_bind_default') AS t");
  const defTableInNamedDb: any = await pgFetchOne(namedAdapter,
    "SELECT to_regclass('public.t4_bind_default') AS t");
  assert(
    "default model's table created in the DEFAULT database",
    defTableInDefaultDb?.t !== null && defTableInDefaultDb?.t !== undefined,
    `(got ${defTableInDefaultDb?.t})`,
  );
  assert(
    "default model's table is NOT in the named database",
    defTableInNamedDb?.t === null || defTableInNamedDb?.t === undefined,
    `(got ${defTableInNamedDb?.t})`,
  );

  // The analytics model's table exists in the NAMED db, not the default one.
  const anaTableInNamedDb: any = await pgFetchOne(namedAdapter,
    "SELECT to_regclass('public.t4_bind_analytics') AS t");
  const anaTableInDefaultDb: any = await pgFetchOne(defaultAdapter,
    "SELECT to_regclass('public.t4_bind_analytics') AS t");
  assert(
    "analytics model's table created in the NAMED database",
    anaTableInNamedDb?.t !== null && anaTableInNamedDb?.t !== undefined,
    `(got ${anaTableInNamedDb?.t})`,
  );
  assert(
    "analytics model's table is NOT in the default database",
    anaTableInDefaultDb?.t === null || anaTableInDefaultDb?.t === undefined,
    `(got ${anaTableInDefaultDb?.t})`,
  );

  // Each row landed in its own DB.
  const defRow: any = await pgFetchOne(defaultAdapter, "SELECT name FROM t4_bind_default LIMIT 1");
  const anaRow: any = await pgFetchOne(namedAdapter, "SELECT name FROM t4_bind_analytics LIMIT 1");
  assert("default model row landed in tina4_node", defRow?.name === "from-default", `(got ${defRow?.name})`);
  assert("analytics model row landed in tina4_py", anaRow?.name === "from-analytics", `(got ${anaRow?.name})`);
} finally {
  try { await pgExec(defaultAdapter, "DROP TABLE IF EXISTS t4_bind_default"); } catch {}
  try { await pgExec(namedAdapter, "DROP TABLE IF EXISTS t4_bind_analytics"); } catch {}
  try { closeDatabase(); } catch {}
}

summaryAndExit(fail > 0 ? 1 : 0);

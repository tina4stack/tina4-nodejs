/**
 * Feature 23 - ORM scopes: the shared conformance contract, parity with
 * tina4-python/tests/test_scopes_contract.py.
 *
 * SCOPE-DEC-01 (OWNER-DECISIONS.md Batch 4): fix PHP's scope global-registry
 * collision. Node's `static scope(name, ...)` reads `this` as the CALLING
 * class and assigns the generated method directly onto it
 * (`(ModelClass as any)[name] = fn`), so Node was ALREADY per-class. This
 * suite proves it; Node's framework code is UNCHANGED for this feature.
 *
 * SCOPE-DEC-02: scopes stay TERMINAL LISTS (no compose/rebind/global-scope --
 * the ledger did not separately ratify it).
 *
 * NO MOCKS: real SQLite AND real PostgreSQL (:55432, tina4/tina4). Positive AND
 * negative throughout. Under TINA4_REQUIRE_SERVICES a postgres skip is a hard
 * failure.
 *
 * Imports the ORM from src so tsx runs the checked-out source directly.
 */
import process from "node:process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { rmSync, mkdirSync } from "node:fs";
import {
  BaseModel,
  Database,
  bindDatabase,
  createAdapterFromUrl,
  closeDatabase,
} from "../packages/orm/src/index.js";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");
function skip(msg: string): void {
  if (requireServices) {
    console.error(`  \x1b[31mSKIP-AS-FAIL\x1b[0m ${msg}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const PG = {
  host: process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1",
  port: parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10),
  user: process.env.TINA4_TEST_PG_USERNAME ?? "tina4",
  pass: process.env.TINA4_TEST_PG_PASSWORD ?? "tina4",
  db: process.env.TINA4_TEST_PG_DB ?? "tina4_node",
};

const tmpDir = path.join(os.tmpdir(), `scopes_contract_${process.pid}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function engineDb(engine: string): Promise<any | null> {
  if (engine === "postgres") {
    if (!(await tcpReachable(PG.host, PG.port))) {
      skip(`postgres unreachable at ${PG.host}:${PG.port} (set TINA4_TEST_PG_*)`);
      return null;
    }
    const a: any = await createAdapterFromUrl(`postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${PG.db}`);
    const db = new Database(a); db.setDbType("postgres"); bindDatabase(a); return db;
  }
  const a: any = await createAdapterFromUrl(
    `sqlite:///${path.join(tmpDir, `scopes_${Math.random().toString(36).slice(2)}.db`)}`,
  );
  const db = new Database(a); db.setDbType("sqlite"); bindDatabase(a); return db;
}

async function dropTable(db: Database, table: string): Promise<void> {
  try { await db.execute(`DROP TABLE IF EXISTS ${table}`); } catch { /* best effort */ }
}

// ── models: two models share the SAME scope name with DIFFERENT filters --
//    the collision case ─────────────────────────────────────────────────────
class ScopeUserNode extends BaseModel {
  static tableName = "scope_users";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    active: { type: "integer", default: 0 },
  } as const;
}

class ScopeProductNode extends BaseModel {
  static tableName = "scope_products";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    discontinued: { type: "integer", default: 0 },
  } as const;
}

// Soft-delete model: proves a scope respects the soft-delete filter.
// NO is_deleted declared -- createTable() injects it (SOFTDEL-DEC-02).
class ScopeArticleNode extends BaseModel {
  static tableName = "scope_articles";
  static softDelete = true;
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    category: { type: "string" },
  } as const;
}

// Plain model with more rows than any single page -- proves limit/offset pushdown.
class ScopeWidgetNode extends BaseModel {
  static tableName = "scope_widgets";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}

// ── SCOPE-DEC-01: two models, SAME scope name, DIFFERENT filters -- no collision ─
async function twoModelsSameScopeName(engine: string): Promise<void> {
  const db = await engineDb(engine);
  if (!db) return;
  try {
    await dropTable(db, "scope_users");
    await dropTable(db, "scope_products");
    if (!(await ScopeUserNode.createTable())) throw new Error(`createTable scope_users: ${db.getError()}`);
    if (!(await ScopeProductNode.createTable())) throw new Error(`createTable scope_products: ${db.getError()}`);

    await ScopeUserNode.create({ name: "Alice", active: 1 });
    await ScopeUserNode.create({ name: "Bob", active: 0 });
    await ScopeUserNode.create({ name: "Carol", active: 1 });

    await ScopeProductNode.create({ name: "Widget", discontinued: 0 });
    await ScopeProductNode.create({ name: "Gadget", discontinued: 1 });
    await ScopeProductNode.create({ name: "Gizmo", discontinued: 0 });

    // SAME scope name ("active") registered on TWO different models with
    // DIFFERENT filters -- the exact SCOPE-PHP-COLLISION scenario from the
    // feature doc. The second registration must never overwrite or leak into
    // the first model's filter.
    ScopeUserNode.scope("active", "active = ?", [1]);
    ScopeProductNode.scope("active", "discontinued = ?", [0]);

    const users = await (ScopeUserNode as any).active();
    const products = await (ScopeProductNode as any).active();

    const userNames = users.map((u: any) => u.name).sort().join(",");
    const productNames = products.map((p: any) => p.name).sort().join(",");

    check("two_models_same_scope_name_return_different_rows",
      userNames === "Alice,Carol" && productNames === "Gizmo,Widget",
      `${engine} users=${userNames} products=${productNames}`);
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ── SCOPE-DEC-02: a scope respects the soft-delete filter (via where()) ───
async function scopeExcludesSoftDeleted(engine: string): Promise<void> {
  const db = await engineDb(engine);
  if (!db) return;
  try {
    await dropTable(db, "scope_articles");
    if (!(await ScopeArticleNode.createTable())) throw new Error(`createTable scope_articles: ${db.getError()}`);

    const one = await ScopeArticleNode.create({ name: "One", category: "news" }) as ScopeArticleNode;
    await ScopeArticleNode.create({ name: "Two", category: "news" });
    await ScopeArticleNode.create({ name: "Three", category: "news" });

    ScopeArticleNode.scope("news", "category = ?", ["news"]);
    const before = await (ScopeArticleNode as any).news();

    await one.delete();

    const visible = await (ScopeArticleNode as any).news();
    const names = visible.map((a: any) => a.name);

    // Negative: the row is still PHYSICALLY present (raw, unfiltered).
    const raw = await db.fetch("SELECT COUNT(*) AS c FROM scope_articles");
    const rawRow = raw.records[0] as Record<string, unknown>;
    const rawTotal = Number(rawRow.c ?? rawRow.C ?? 0);

    check("scope_excludes_a_soft_deleted_row",
      before.length === 3 && visible.length === 2 && !names.includes("One") && rawTotal === 3,
      `${engine} before=${before.length} visible=${visible.length} raw=${rawTotal}`);
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ── SCOPE-DEC-02: a scope pushes limit/offset to the database ─────────────
async function scopeHonoursLimitOffset(engine: string): Promise<void> {
  const db = await engineDb(engine);
  if (!db) return;
  try {
    await dropTable(db, "scope_widgets");
    if (!(await ScopeWidgetNode.createTable())) throw new Error(`createTable scope_widgets: ${db.getError()}`);

    for (let i = 0; i < 15; i++) {
      await ScopeWidgetNode.create({ name: `w${i}` });
    }

    ScopeWidgetNode.scope("everything", "1=1");

    // Negative: an explicit smaller limit is honoured exactly (proves the
    // argument reaches the DB rather than being silently discarded).
    const small = await (ScopeWidgetNode as any).everything(3);

    // Two pages of the SAME scope, from the SAME 15-row set, are DISJOINT --
    // proves offset reaches the database, not a client-side no-op.
    const page1 = await (ScopeWidgetNode as any).everything(5, 0);
    const page2 = await (ScopeWidgetNode as any).everything(5, 5);
    const ids1 = new Set(page1.map((w: any) => w.id));
    const ids2 = new Set(page2.map((w: any) => w.id));
    const overlap = [...ids1].filter((id) => ids2.has(id));

    check("scope_honours_limit_and_offset",
      small.length === 3 && page1.length === 5 && page2.length === 5 && overlap.length === 0,
      `${engine} small=${small.length} page1=${page1.length} page2=${page2.length} overlap=${overlap.length}`);
  } finally { try { db.close(); } catch { /* ignore */ } }
}

async function run(): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });
  for (const engine of ["sqlite", "postgres"]) {
    console.log(`\n--- ${engine} ---`);
    await twoModelsSameScopeName(engine);
    await scopeExcludesSoftDeleted(engine);
    await scopeHonoursLimitOffset(engine);
  }
  try { await closeDatabase(); } catch { /* ignore */ }
}

run()
  .catch((e) => { console.error("UNEXPECTED ERROR:", e); fail++; })
  .finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(fail > 0 ? 1 : 0);
  });

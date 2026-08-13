/**
 * Feature 21 - Declarative ORM relationships: the shared conformance contract,
 * parity with tina4-python/tests/test_relationships_contract.py.
 *
 * REL-DEC-01 (read-side-only cascade) + REL-DEC-02 (Node declarative auto-wire +
 * lazy load, soft-delete filter on traversal, bounded eager IN). NO MOCKS: real
 * SQLite AND real PostgreSQL (:55432, tina4/tina4). Row presence/absence is
 * asserted by querying the real table; "one query per relation" is proven with a
 * REAL executed-statement counter that instruments the real adapter (observation,
 * not a mock). Under TINA4_REQUIRE_SERVICES a postgres skip is a hard failure.
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

const tmpDir = path.join(os.tmpdir(), `rel_contract_${process.pid}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeAdapter(engine: string): Promise<any | null> {
  if (engine === "postgres") {
    if (!(await tcpReachable(PG.host, PG.port))) {
      skip(`postgres unreachable at ${PG.host}:${PG.port} (set TINA4_TEST_PG_*)`);
      return null;
    }
    return createAdapterFromUrl(`postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${PG.db}`);
  }
  return createAdapterFromUrl(`sqlite:///${path.join(tmpDir, `rel_${Math.random().toString(36).slice(2)}.db`)}`);
}

// ── models: parent + child with the DOCUMENTED declarative FK auto-wire ──────
class RelAuthorNode extends BaseModel {
  static tableName = "rel_author";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}

class RelPostNode extends BaseModel {
  static tableName = "rel_post";
  static softDelete = true;
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "string" },
    is_deleted: { type: "integer", default: 0 },
    // Read-side-only FK auto-wire: RelPost.author (belongsTo) + RelAuthor.posts (hasMany)
    author_id: { type: "foreignKey", references: "RelAuthorNode", relatedName: "posts" },
  } as const;
}
BaseModel.registerModel("RelAuthorNode", RelAuthorNode);
BaseModel.registerModel("RelPostNode", RelPostNode);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function freshDb(engine: string): Promise<any | null> {
  const a = await makeAdapter(engine);
  if (!a) return null;
  const db = new Database(a);
  db.setDbType(engine === "postgres" ? "postgres" : "sqlite");
  bindDatabase(a);
  for (const t of ["rel_post", "rel_author"]) {
    try { await db.execute(`DROP TABLE IF EXISTS ${t}`); } catch { /* best effort */ }
  }
  if (!(await RelAuthorNode.createTable())) throw new Error(`createTable rel_author: ${db.getError()}`);
  if (!(await RelPostNode.createTable())) throw new Error(`createTable rel_post: ${db.getError()}`);
  return { a, db };
}

async function rawCount(db: Database, table: string, where: string, params: unknown[]): Promise<number> {
  const r = await db.fetch(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, params);
  const row = r.records[0] as Record<string, unknown>;
  return Number(row.c ?? row.C ?? 0);
}

// ── REL-EAGER: exactly ONE query per relation (no N+1) ───────────────────────
async function eagerOneQuery(): Promise<void> {
  const ctx = await freshDb("sqlite");
  if (!ctx) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { a, db } = ctx as any;
  try {
    for (let x = 0; x < 3; x++) {
      const author = await RelAuthorNode.create({ name: `a${x}` }) as RelAuthorNode;
      for (let p = 0; p < 2; p++) {
        await RelPostNode.create({ title: `a${x}-p${p}`, author_id: (author as any).id });
      }
    }

    // Instrument the REAL adapter: count queries that touch the child table.
    let childFetches = 0;
    for (const m of ["queryAsync", "query"]) {
      if (typeof a[m] === "function") {
        const orig = a[m].bind(a);
        a[m] = (sql: string, params?: unknown[]) => {
          if (typeof sql === "string" && sql.includes("rel_post")) childFetches++;
          return orig(sql, params);
        };
      }
    }

    const authors = await RelAuthorNode.all(100, 0, ["posts"]);
    let total = 0;
    for (const author of authors) total += (await (author as any).posts).length;

    check("eager_include_runs_one_query_per_relation", total === 6 && childFetches === 1,
      `total=${total} childFetches=${childFetches} (want 6 / 1)`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

async function runEngine(engine: string): Promise<void> {
  // ── REL-SOFTDELETE: excluded from lazy traversal ──────────────────────────
  {
    const ctx = await freshDb(engine);
    if (!ctx) return;
    const { db } = ctx as { db: Database };
    try {
      const author = await RelAuthorNode.create({ name: "a" }) as RelAuthorNode;
      await RelPostNode.create({ title: "keep", author_id: (author as any).id });
      const gone = await RelPostNode.create({ title: "gone", author_id: (author as any).id }) as RelPostNode;
      await gone.delete(); // soft delete -> is_deleted = 1

      const raw = await rawCount(db, "rel_post", "1=1", []);
      const fresh = await RelAuthorNode.findById((author as any).id) as RelAuthorNode;
      const titles = (await (fresh as any).posts).map((p: RelPostNode) => (p as any).title);
      check("soft_deleted_child_excluded_from_lazy_traversal",
        raw === 2 && titles.length === 1 && titles[0] === "keep", `${engine} titles=${titles}`);
    } finally { try { db.close(); } catch { /* ignore */ } }
  }

  // ── REL-SOFTDELETE: excluded from eager traversal ─────────────────────────
  {
    const ctx = await freshDb(engine);
    if (!ctx) return;
    const { db } = ctx as { db: Database };
    try {
      const author = await RelAuthorNode.create({ name: "a" }) as RelAuthorNode;
      await RelPostNode.create({ title: "keep", author_id: (author as any).id });
      const gone = await RelPostNode.create({ title: "gone", author_id: (author as any).id }) as RelPostNode;
      await gone.delete();

      const loaded = await RelAuthorNode.all(100, 0, ["posts"]);
      const titles = (await (loaded[0] as any).posts).map((p: RelPostNode) => (p as any).title);
      check("soft_deleted_child_excluded_from_eager_traversal",
        loaded.length === 1 && titles.length === 1 && titles[0] === "keep", `${engine} titles=${titles}`);
    } finally { try { db.close(); } catch { /* ignore */ } }
  }

  // ── REL-DEC-02: lazy attribute access returns related rows (Node now works) ─
  {
    const ctx = await freshDb(engine);
    if (!ctx) return;
    const { db } = ctx as { db: Database };
    try {
      const author = await RelAuthorNode.create({ name: "a" }) as RelAuthorNode;
      await RelPostNode.create({ title: "p0", author_id: (author as any).id });
      await RelPostNode.create({ title: "p1", author_id: (author as any).id });

      const fresh = await RelAuthorNode.findById((author as any).id) as RelAuthorNode;
      const titles = (await (fresh as any).posts).map((p: RelPostNode) => (p as any).title).sort();

      const post = (await RelPostNode.where("title = ?", ["p0"]))[0] as RelPostNode;
      const parent = await (post as any).author as RelAuthorNode | null;

      check("lazy_attribute_access_returns_related_rows",
        titles.length === 2 && titles[0] === "p0" && titles[1] === "p1"
          && parent !== null && (parent as any).name === "a", `${engine} titles=${titles}`);
    } finally { try { db.close(); } catch { /* ignore */ } }
  }

  // ── REL-DEC-01: read-side-only -- deleting a parent leaves children ────────
  {
    const ctx = await freshDb(engine);
    if (!ctx) return;
    const { db } = ctx as { db: Database };
    try {
      const author = await RelAuthorNode.create({ name: "a" }) as RelAuthorNode;
      await RelPostNode.create({ title: "p0", author_id: (author as any).id });
      await RelPostNode.create({ title: "p1", author_id: (author as any).id });

      await author.forceDelete(); // hard delete the parent

      const parents = await rawCount(db, "rel_author", "id = ?", [(author as any).id]);
      const children = await rawCount(db, "rel_post", "author_id = ?", [(author as any).id]);
      check("deleting_a_parent_leaves_children_in_the_db",
        parents === 0 && children === 2, `${engine} parents=${parents} children=${children}`);
    } finally { try { db.close(); } catch { /* ignore */ } }
  }
}

// ── REL-EAGER-UNBOUNDED: > default-cap children fully reachable (SQLite) ──────
async function largeChildSet(): Promise<void> {
  const ctx = await freshDb("sqlite");
  if (!ctx) return;
  const { db } = ctx as { db: Database };
  try {
    const author = await RelAuthorNode.create({ name: "a" }) as RelAuthorNode;
    const rows = Array.from({ length: 1001 }, (_, i) => ({ title: `p${i}`, author_id: (author as any).id, is_deleted: 0 }));
    await db.insert("rel_post", rows);

    const fresh = await RelAuthorNode.findById((author as any).id) as RelAuthorNode;
    const posts = await (fresh as any).posts;
    check("large_child_set_is_fully_reachable_not_truncated", posts.length === 1001, `got ${posts.length}`);
  } finally { try { db.close(); } catch { /* ignore */ } }
}

async function run(): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });
  console.log("\n--- eager one-query ---");
  await eagerOneQuery();
  for (const engine of ["sqlite", "postgres"]) {
    console.log(`\n--- ${engine} ---`);
    await runEngine(engine);
  }
  console.log("\n--- large child set (sqlite) ---");
  await largeChildSet();
  try { await closeDatabase(); } catch { /* ignore */ }
}

run()
  .catch((e) => { console.error("UNEXPECTED ERROR:", e); fail++; })
  .finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(fail > 0 ? 1 : 0);
  });

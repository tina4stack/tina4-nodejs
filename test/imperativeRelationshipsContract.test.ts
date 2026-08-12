/**
 * Feature 22 - Imperative ORM relationships: the shared conformance contract,
 * parity with tina4-python/tests/test_imperative_relationships_contract.py.
 *
 * IMPREL-DEC-01: imperative relationships are a PER-LANGUAGE IDIOM (Node keeps
 * its distinct instance-method API hasOne/hasMany/belongsTo). IMPREL-DEC-02:
 * fix Node's serialize-orphan -- the imperative methods wrote the loaded relation
 * onto this[tableName] but NEVER populated _relCache, which toDict reads, so an
 * imperatively-loaded relation was orphaned from serialization; they now populate
 * _relCache too. Also unify the imperative has_many cap with the lazy path
 * (uncapped by default). NO MOCKS: real SQLite AND real PostgreSQL (:55432,
 * tina4/tina4). Positive AND negative throughout. Under TINA4_REQUIRE_SERVICES a
 * postgres skip is a hard failure.
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

const tmpDir = path.join(os.tmpdir(), `imprel_contract_${process.pid}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeAdapter(engine: string): Promise<any | null> {
  if (engine === "postgres") {
    if (!(await tcpReachable(PG.host, PG.port))) {
      skip(`postgres unreachable at ${PG.host}:${PG.port} (set TINA4_TEST_PG_*)`);
      return null;
    }
    return createAdapterFromUrl(`postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${PG.db}`);
  }
  return createAdapterFromUrl(`sqlite:///${path.join(tmpDir, `imprel_${Math.random().toString(36).slice(2)}.db`)}`);
}

// ── models: table name != lowercased class name so the serialize-orphan bug
//    (keyed on the TABLE name) would bite ──────────────────────────────────────
class ImpRelAuthorNode extends BaseModel {
  static tableName = "imp_rel_author";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}

class ImpRelPostNode extends BaseModel {
  static tableName = "imp_rel_post";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "string" },
    // FK auto-wire: ImpRelPost.author (belongsTo) + ImpRelAuthor.posts (hasMany)
    author_id: { type: "foreignKey", references: "ImpRelAuthorNode", relatedName: "posts" },
  } as const;
}
BaseModel.registerModel("ImpRelAuthorNode", ImpRelAuthorNode);
BaseModel.registerModel("ImpRelPostNode", ImpRelPostNode);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function freshDb(engine: string): Promise<any | null> {
  const a = await makeAdapter(engine);
  if (!a) return null;
  const db = new Database(a);
  db.setDbType(engine === "postgres" ? "postgres" : "sqlite");
  bindDatabase(a);
  for (const t of ["imp_rel_post", "imp_rel_author"]) {
    try { await db.execute(`DROP TABLE IF EXISTS ${t}`); } catch { /* best effort */ }
  }
  if (!(await ImpRelAuthorNode.createTable())) throw new Error(`createTable imp_rel_author: ${db.getError()}`);
  if (!(await ImpRelPostNode.createTable())) throw new Error(`createTable imp_rel_post: ${db.getError()}`);
  return { a, db };
}

async function runEngine(engine: string): Promise<void> {
  // ── IMPREL-DEC-02: an imperatively-loaded relation SERIALIZES ──────────────
  {
    const ctx = await freshDb(engine);
    if (!ctx) return;
    const { db } = ctx as { db: Database };
    try {
      const author = await ImpRelAuthorNode.create({ name: "a" }) as ImpRelAuthorNode;
      for (let i = 0; i < 3; i++) {
        await ImpRelPostNode.create({ title: `p${i}`, author_id: (author as any).id });
      }

      // Imperative load: stores under the serializer's key (imp_rel_post = the
      // child's TABLE name) in _relCache, so toDict(["imp_rel_post"]) includes it.
      const rel = await author.hasMany(ImpRelPostNode as any, "author_id");
      const d = author.toDict(["imp_rel_post"]);
      const serialized = (d["imp_rel_post"] as unknown[]) ?? [];
      // Negative: WITHOUT include the relation is not serialized (fields only).
      const noInclude = author.toDict();

      check("imperative_relation_serializes",
        rel.length === 3
          && Array.isArray(d["imp_rel_post"]) && serialized.length === 3
          && !("imp_rel_post" in noInclude),
        `${engine} rel=${rel.length} serialized=${serialized.length} noIncludeHasKey=${"imp_rel_post" in noInclude}`);
    } finally { try { db.close(); } catch { /* ignore */ } }
  }

  // ── IMPREL-DEC-01: the imperative surface behaves the same (per-language) ───
  {
    const ctx = await freshDb(engine);
    if (!ctx) return;
    const { db } = ctx as { db: Database };
    try {
      const author = await ImpRelAuthorNode.create({ name: "a" }) as ImpRelAuthorNode;
      await ImpRelPostNode.create({ title: "p0", author_id: (author as any).id });
      await ImpRelPostNode.create({ title: "p1", author_id: (author as any).id });
      const child = (await ImpRelPostNode.where("title = ?", ["p0"]))[0] as ImpRelPostNode;

      const one = await author.hasOne(ImpRelPostNode as any, "author_id") as ImpRelPostNode | null;
      const many = await author.hasMany(ImpRelPostNode as any, "author_id");
      const parent = await child.belongsTo(ImpRelAuthorNode as any, "author_id") as ImpRelAuthorNode | null;

      // Negative: belongsTo whose FK resolves to no parent returns null
      // (read-side-only: no DB FK constraint, so a dangling FK inserts fine).
      const orphan = await ImpRelPostNode.create({ title: "orphan", author_id: 999999 }) as ImpRelPostNode;
      const noParent = await orphan.belongsTo(ImpRelAuthorNode as any, "author_id");

      const manyTitles = many.map((p) => (p as any).title).sort().join(",");
      check("imperative_surface_behaves_same_all_four",
        one !== null && ["p0", "p1"].includes((one as any).title)
          && manyTitles === "p0,p1"
          && parent !== null && (parent as any).name === "a"
          && noParent === null,
        `${engine} one=${one && (one as any).title} many=${manyTitles} parent=${parent && (parent as any).name} noParent=${noParent}`);
    } finally { try { db.close(); } catch { /* ignore */ } }
  }
}

// ── IMPREL-PY-CAP parity: imperative and lazy return the SAME row count ───────
async function capParity(): Promise<void> {
  const ctx = await freshDb("sqlite");
  if (!ctx) return;
  const { db } = ctx as { db: Database };
  try {
    const author = await ImpRelAuthorNode.create({ name: "a" }) as ImpRelAuthorNode;
    const rows = Array.from({ length: 150 }, (_, i) => ({ title: `p${i}`, author_id: (author as any).id }));
    await db.insert("imp_rel_post", rows);

    const imperative = await author.hasMany(ImpRelPostNode as any, "author_id");
    const fresh = await ImpRelAuthorNode.findById((author as any).id) as ImpRelAuthorNode;
    const lazy = await (fresh as any).posts as ImpRelPostNode[];
    // Negative: an EXPLICIT limit still pages (default is genuinely uncapped).
    const capped = await author.hasMany(ImpRelPostNode as any, "author_id", 100);

    check("imperative_and_lazy_same_row_count",
      imperative.length === 150 && lazy.length === 150
        && imperative.length === lazy.length && capped.length === 100,
      `imperative=${imperative.length} lazy=${lazy.length} capped=${capped.length}`);
  } finally { try { db.close(); } catch { /* ignore */ } }
}

async function run(): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });
  for (const engine of ["sqlite", "postgres"]) {
    console.log(`\n--- ${engine} ---`);
    await runEngine(engine);
  }
  console.log("\n--- cap parity (sqlite) ---");
  await capParity();
  try { await closeDatabase(); } catch { /* ignore */ }
}

run()
  .catch((e) => { console.error("UNEXPECTED ERROR:", e); fail++; })
  .finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(fail > 0 ? 1 : 0);
  });

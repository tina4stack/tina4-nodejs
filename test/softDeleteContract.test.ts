/**
 * Feature 20 - Soft delete: the shared conformance contract, parity with
 * tina4-python/tests/test_softdelete_contract.py.
 *
 * Proves the soft-delete BEHAVIOUR against a REAL database, NO MOCKS. Every case
 * runs on real SQLite AND the lab's real PostgreSQL (:55432, tina4/tina4 by
 * default) so row presence/absence is asserted by querying the real table, not a
 * double: a soft-deleted row is COUNT=1 in the raw table but ABSENT from the
 * finders; a force-deleted row is COUNT=0.
 *
 * Case names are shared verbatim across the four frameworks and gated by
 * scripts/audit-contract-fixtures.py. Under TINA4_REQUIRE_SERVICES a postgres
 * skip is a hard failure (a run with skips is NOT verification).
 *
 * SOFTDEL-DEC-01 / SOFTDEL-DEC-02: delete() FLAGS not removes; finders exclude
 * it; withTrashed() includes it; restore() un-deletes; forceDelete() ALWAYS
 * hard-removes (the regression that catches the PHP-class throw-instead-of-delete
 * bug); createTable() INJECTS the is_deleted column for a softDelete model that
 * never declared it.
 *
 * Imports the ORM from src so tsx runs the checked-out source directly.
 */
import process from "node:process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
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

/** A provisioned service (PostgreSQL) that is missing is a hard FAILURE. */
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

const tmpDir = path.join(os.tmpdir(), `sd_contract_${process.pid}`);

async function engineDb(engine: string): Promise<Database | null> {
  if (engine === "postgres") {
    if (!(await tcpReachable(PG.host, PG.port))) {
      skip(`postgres unreachable at ${PG.host}:${PG.port} (set TINA4_TEST_PG_*)`);
      return null;
    }
    const a: any = await createAdapterFromUrl(`postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${PG.db}`);
    const db = new Database(a); db.setDbType("postgres"); bindDatabase(a); return db;
  }
  // sqlite — always available, a fresh temp file per engine pass
  const a: any = await createAdapterFromUrl(`sqlite:///${path.join(tmpDir, "sd.db")}`);
  const db = new Database(a); db.setDbType("sqlite"); bindDatabase(a); return db;
}

async function dropTable(db: Database, table: string): Promise<void> {
  try { await db.execute(`DROP TABLE IF EXISTS ${table}`); } catch { /* best effort */ }
}

async function rawCount(db: Database, table: string): Promise<number> {
  const r = await db.fetch(`SELECT COUNT(*) AS c FROM ${table}`);
  const row = r.records[0] as Record<string, unknown>;
  return Number(row.c ?? row.C ?? 0);
}

async function flagValue(db: Database, table: string, id: unknown): Promise<number> {
  const r = await db.fetch(`SELECT is_deleted FROM ${table} WHERE id = ?`, [id]);
  const row = r.records[0] as Record<string, unknown>;
  return Number(row.is_deleted ?? row.IS_DELETED ?? -1);
}

// ── models ──────────────────────────────────────────────────────────────────

class SdItem extends BaseModel {
  static tableName = "sd_item";
  static softDelete = true;
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "string" },
    is_deleted: { type: "integer", default: 0 }, // DECLARED (behaviour independent of injection)
  } as const;
}

class SdAuto extends BaseModel {
  static tableName = "sd_auto";
  static softDelete = true;
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "string" },
    // NO is_deleted declared -- createTable must INJECT it (SOFTDEL-CREATETABLE-COLUMN)
  } as const;
}

async function freshItem(db: Database): Promise<void> {
  await dropTable(db, SdItem.tableName);
  if (!(await SdItem.createTable())) throw new Error(`createTable failed: ${db.getError()}`);
}

async function runEngine(engine: string, db: Database): Promise<void> {
  // ── delete() FLAGS, does not remove ───────────────────────────────────────
  await freshItem(db);
  {
    const it = await SdItem.create({ title: "keep-me" }) as SdItem;
    await it.delete();
    check("delete flags the row instead of removing it",
      (await rawCount(db, "sd_item")) === 1 && (await flagValue(db, "sd_item", (it as any).id)) === 1, engine);
  }

  // ── excluded from the default finder ──────────────────────────────────────
  await freshItem(db);
  {
    const it = await SdItem.create({ title: "hide-me" }) as SdItem;
    const before = (await SdItem.all()).length === 1 && (await SdItem.count()) === 1;
    await it.delete();
    const present = (await rawCount(db, "sd_item")) === 1;           // negative control
    const excluded =
      (await SdItem.all()).length === 0 &&
      (await SdItem.count()) === 0 &&
      (await SdItem.findById((it as any).id)) === null &&
      (await SdItem.where("id = ?", [(it as any).id])).length === 0;
    check("a soft deleted row is excluded from the default finder", before && present && excluded, engine);
  }

  // ── withTrashed() includes ────────────────────────────────────────────────
  await freshItem(db);
  {
    const it = await SdItem.create({ title: "trashed" }) as SdItem;
    await it.delete();
    const trashed = await SdItem.withTrashed();
    check("with trashed returns the soft deleted row",
      (await SdItem.all()).length === 0 && trashed.length === 1 && (trashed[0] as any).id === (it as any).id, engine);
  }

  // ── restore() un-deletes ──────────────────────────────────────────────────
  await freshItem(db);
  {
    const it = await SdItem.create({ title: "comeback" }) as SdItem;
    await it.delete();
    const gone = (await SdItem.count()) === 0;
    await it.restore();
    check("restore undeletes the row so it reappears in the finder",
      gone && (await SdItem.count()) === 1 &&
      (await SdItem.findById((it as any).id)) !== null &&
      (await flagValue(db, "sd_item", (it as any).id)) === 0, engine);
  }

  // ── forceDelete() ALWAYS hard-removes (the PHP-class regression) ───────────
  await freshItem(db);
  {
    const it = await SdItem.create({ title: "gone" }) as SdItem;
    const before = (await rawCount(db, "sd_item")) === 1;
    await it.forceDelete();
    check("force delete hard removes the row even from with trashed",
      before && (await rawCount(db, "sd_item")) === 0 && (await SdItem.withTrashed()).length === 0, engine);
  }

  // ── createTable() INJECTS the column (SOFTDEL-CREATETABLE-COLUMN) ──────────
  await dropTable(db, SdAuto.tableName);
  if (!(await SdAuto.createTable())) throw new Error(`SdAuto.createTable failed: ${db.getError()}`);
  {
    // The model declares NO is_deleted; createTable() injected it above. A full
    // round-trip must work on the generated schema with no manual column.
    const cols = (await db.getColumns("sd_auto")).map((c: any) => String(c.name).toLowerCase());
    const it = await SdAuto.create({ title: "auto" }) as SdAuto;
    await it.delete();
    const flagged = (await rawCount(db, "sd_auto")) === 1 && (await SdAuto.all()).length === 0 &&
      (await SdAuto.withTrashed()).length === 1;
    await it.restore();
    const restored = (await SdAuto.all()).length === 1;
    await it.forceDelete();
    const hard = (await rawCount(db, "sd_auto")) === 0;
    check("create table injects a usable is deleted column for a soft delete model",
      cols.includes("is_deleted") && flagged && restored && hard, `${engine} cols=${cols.join(",")}`);
  }

  await dropTable(db, "sd_item");
  await dropTable(db, "sd_auto");
}

async function run(): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(tmpDir, { recursive: true });
  for (const engine of ["sqlite", "postgres"]) {
    console.log(`\n--- ${engine} ---`);
    const db = await engineDb(engine);
    if (!db) continue; // skipped (or skip-as-fail already exited)
    try {
      await runEngine(engine, db);
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
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

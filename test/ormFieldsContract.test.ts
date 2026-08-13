/**
 * Feature 18 - ORM fields and column mapping: the shared conformance contract,
 * parity with tina4-python/tests/test_ormfields_contract.py.
 *
 * Proves the reconciled field-model BEHAVIOUR (FIELD-DEC-01 gap + FIELD-DEC-02),
 * NO MOCKS. The cross-engine DDL cases actually CREATE the table on the lab's
 * REAL PostgreSQL / MySQL / MSSQL / Firebird and read the column type back from
 * each engine's OWN catalog. Case names are shared verbatim across the four
 * frameworks and gated by scripts/audit-contract-fixtures.py.
 *
 * Under TINA4_REQUIRE_SERVICES a PG/MySQL/MSSQL skip is a hard failure (a run
 * with skips is NOT verification); Firebird is gated (runs when
 * TINA4_TEST_FIREBIRD_URL is set, which the lab sets, else stays green).
 *
 * Imports the ORM from src so tsx runs the checked-out source directly.
 */
import process from "node:process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BaseModel, Database, bindDatabase, createAdapterFromUrl } from "../packages/orm/src/index.js";

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

/** A provisioned service (PG/MySQL/MSSQL) that is missing is a hard FAILURE. */
function skip(msg: string): void {
  if (requireServices) {
    console.error(`  \x1b[31mSKIP-AS-FAIL\x1b[0m ${msg}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
}

/** Firebird is NOT in the require-services gate: an unset URL stays a green skip. */
function skipGated(msg: string): void {
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

// ── models ────────────────────────────────────────────────────────────────

class OrmfWidget extends BaseModel {
  static tableName = "ormf_widget";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" }, note: { type: "text" }, qty: { type: "integer" },
    active: { type: "boolean" }, ratio: { type: "decimal", precision: 8, scale: 3 },
    made_at: { type: "datetime" }, payload: { type: "json" },
  } as const;
}
class OrmfDoc extends BaseModel {
  static tableName = "ormf_doc";
  static fields = { id: { type: "integer", primaryKey: true, autoIncrement: true }, body: { type: "json" } } as const;
}
let ticketCounter = 0;
class OrmfTicket extends BaseModel {
  static tableName = "ormf_ticket";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    seq: { type: "integer", default: () => ++ticketCounter },
  } as const;
}
class OrmfSession extends BaseModel {
  static tableName = "ormf_session";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    token: { type: "string", default: () => "tok-" + Math.random().toString(16).slice(2) },
  } as const;
}
class OrmfBlob extends BaseModel {
  static tableName = "ormf_blob";
  static fields = { id: { type: "integer", primaryKey: true, autoIncrement: true }, data: { type: "json" } } as const;
}
class OrmfMoney extends BaseModel {
  static tableName = "ormf_money";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    amount: { type: "decimal", precision: 12, scale: 4 },
  } as const;
}
// A natural string PK (the round-trip supplies it) so the row insert exercises
// the field COLUMNS on the real engine without depending on per-engine
// auto-increment -- uniform with the Python/PHP/Ruby engine models.
class OrmfEngine extends BaseModel {
  static tableName = "ormf_engine";
  static fields = {
    id: { type: "string", primaryKey: true },
    flag: { type: "boolean" }, payload: { type: "json" },
    amount: { type: "decimal", precision: 12, scale: 4 }, made_at: { type: "datetime" },
  } as const;
}

// ── engine coordinates ──────────────────────────────────────────────────────

const PG = {
  host: process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1",
  port: parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10),
  user: process.env.TINA4_TEST_PG_USERNAME ?? "tina4",
  pass: process.env.TINA4_TEST_PG_PASSWORD ?? "tina4",
  db: process.env.TINA4_TEST_PG_DB ?? "tina4_node",
};
const MY = {
  host: process.env.TINA4_TEST_MYSQL_HOST ?? "127.0.0.1",
  port: parseInt(process.env.TINA4_TEST_MYSQL_PORT ?? "3306", 10),
  user: process.env.TINA4_TEST_MYSQL_USERNAME ?? "tina4",
  pass: process.env.TINA4_TEST_MYSQL_PASSWORD ?? "tina4",
  db: process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test",
};
const MS = {
  host: process.env.TINA4_TEST_MSSQL_HOST ?? "127.0.0.1",
  port: parseInt(process.env.TINA4_TEST_MSSQL_PORT ?? "1433", 10),
  user: process.env.TINA4_TEST_MSSQL_USERNAME ?? "sa",
  pass: process.env.TINA4_TEST_MSSQL_PASSWORD ?? "TinaSQL123!Secure",
  db: process.env.TINA4_TEST_MSSQL_DB ?? "tina4_test",
};
const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL ?? "";

async function engineDb(engine: string): Promise<Database | null> {
  if (engine === "postgres") {
    if (!(await tcpReachable(PG.host, PG.port))) { skip(`postgres unreachable at ${PG.host}:${PG.port} (set TINA4_TEST_PG_*)`); return null; }
    const a: any = await createAdapterFromUrl(`postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${PG.db}`);
    const db = new Database(a); db.setDbType("postgres"); bindDatabase(a); return db;
  }
  if (engine === "mysql") {
    if (!(await tcpReachable(MY.host, MY.port))) { skip(`mysql unreachable at ${MY.host}:${MY.port} (set TINA4_TEST_MYSQL_*)`); return null; }
    const a: any = await createAdapterFromUrl(`mysql://${MY.user}:${MY.pass}@${MY.host}:${MY.port}/${MY.db}`);
    const db = new Database(a); db.setDbType("mysql"); bindDatabase(a); return db;
  }
  if (engine === "mssql") {
    if (!(await tcpReachable(MS.host, MS.port))) { skip(`mssql unreachable at ${MS.host}:${MS.port} (set TINA4_TEST_MSSQL_*)`); return null; }
    const a: any = await createAdapterFromUrl(`mssql://${MS.user}:${MS.pass}@${MS.host}:${MS.port}/${MS.db}`);
    const db = new Database(a); db.setDbType("mssql"); bindDatabase(a); return db;
  }
  // firebird — gated
  if (!FIREBIRD_URL) { skipGated("TINA4_TEST_FIREBIRD_URL not set (needs a live Firebird)"); return null; }
  const a: any = await createAdapterFromUrl(FIREBIRD_URL);
  const db = new Database(a); db.setDbType("firebird"); bindDatabase(a); return db;
}

async function dropEngineTable(db: Database, engine: string, table: string): Promise<void> {
  try {
    if (engine === "mssql") await db.execute(`IF OBJECT_ID('${table}', 'U') IS NOT NULL DROP TABLE ${table}`);
    else if (engine === "firebird") { if (await db.tableExists(table)) await db.execute(`DROP TABLE ${table}`); }
    else await db.execute(`DROP TABLE IF EXISTS ${table}`);
  } catch { /* best effort */ }
}

function lower(row: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(row)) o[k.toLowerCase()] = row[k];
  return o;
}

async function describe(db: Database, engine: string, table: string): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  let rows: Record<string, unknown>[] = [];
  if (engine === "postgres") {
    rows = (await db.fetch(
      "SELECT column_name, data_type, udt_name, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = ?",
      [table.toLowerCase()], 1000)).records as Record<string, unknown>[];
    for (const raw of rows) {
      const r = lower(raw);
      out[String(r.column_name).toLowerCase()] = {
        type: String(r.udt_name ?? r.data_type).toLowerCase(),
        precision: r.numeric_precision == null ? null : Number(r.numeric_precision),
        scale: r.numeric_scale == null ? null : Number(r.numeric_scale),
      };
    }
  } else if (engine === "mysql") {
    rows = (await db.fetch(
      "SELECT column_name, data_type, column_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE()",
      [table], 1000)).records as Record<string, unknown>[];
    for (const raw of rows) {
      const r = lower(raw);
      out[String(r.column_name).toLowerCase()] = {
        type: String(r.column_type).toLowerCase(),
        precision: r.numeric_precision == null ? null : Number(r.numeric_precision),
        scale: r.numeric_scale == null ? null : Number(r.numeric_scale),
      };
    }
  } else if (engine === "mssql") {
    rows = (await db.fetch(
      "SELECT column_name, data_type, numeric_precision, numeric_scale, character_maximum_length FROM information_schema.columns WHERE table_name = ?",
      [table], 1000)).records as Record<string, unknown>[];
    for (const raw of rows) {
      const r = lower(raw);
      out[String(r.column_name).toLowerCase()] = {
        type: String(r.data_type).toLowerCase(),
        precision: r.numeric_precision == null ? null : Number(r.numeric_precision),
        scale: r.numeric_scale == null ? null : Number(r.numeric_scale),
        maxlen: r.character_maximum_length == null ? null : Number(r.character_maximum_length),
      };
    }
  } else {
    rows = (await db.fetch(
      "SELECT TRIM(rf.rdb$field_name) AS fname, f.rdb$field_type AS ftype, f.rdb$field_sub_type AS fsub, " +
      "f.rdb$field_precision AS fprec, f.rdb$field_scale AS fscale FROM rdb$relation_fields rf " +
      "JOIN rdb$fields f ON rf.rdb$field_source = f.rdb$field_name WHERE rf.rdb$relation_name = ?",
      [table.toUpperCase()], 1000)).records as Record<string, unknown>[];
    for (const raw of rows) {
      const r = lower(raw);
      out[String(r.fname).trim().toLowerCase()] = {
        ftype: Number(r.ftype), fsub: r.fsub == null ? null : Number(r.fsub),
        precision: r.fprec == null ? null : Number(r.fprec),
        scale: r.fscale == null ? null : Number(r.fscale),
      };
    }
  }
  return out;
}

async function makeEngineTable(db: Database, engine: string): Promise<Record<string, any>> {
  await dropEngineTable(db, engine, "ormf_engine");
  const ok = await OrmfEngine.createTable();
  check(`create_table succeeds on ${engine}`, ok === true, `getError=${db.getError()}`);
  return describe(db, engine, "ormf_engine");
}

async function main(): Promise<void> {
  // ── SQLite (real, no service): field types / json / defaults / decimal DDL ──
  const tmp = path.join(os.tmpdir(), `ormf_node_${Date.now()}.db`);
  const sqliteAdapter: any = await createAdapterFromUrl(`sqlite:///${tmp}`);
  const sdb = new Database(sqliteAdapter); sdb.setDbType("sqlite");
  bindDatabase(sqliteAdapter);

  // each declared field type round trips through a real database
  {
    await OrmfWidget.createTable();
    const w = new OrmfWidget({ name: "gizmo", note: "a longer note", qty: 7, active: true,
      ratio: 12.345, made_at: "2026-01-02 03:04:05", payload: { k: "v", n: [1, 2, 3] } });
    await w.save();
    const got: any = await OrmfWidget.findById((w as any).id);
    check("each declared field type round trips through a real database",
      got && got.name === "gizmo" && got.note === "a longer note" && got.qty === 7 &&
      Boolean(got.active) === true && Math.abs(Number(got.ratio) - 12.345) < 1e-6 &&
      String(got.made_at).includes("2026-01-02") &&
      JSON.stringify(got.payload) === JSON.stringify({ k: "v", n: [1, 2, 3] }),
      JSON.stringify(got));
  }

  // a json field round trips to a native object
  {
    await OrmfDoc.createTable();
    const d = new OrmfDoc({ body: { tags: ["a", "b"], meta: { n: 1 } } });
    await d.save();
    const got: any = await OrmfDoc.findById((d as any).id);
    check("a json field round trips to a native object",
      got && typeof got.body === "object" && Array.isArray(got.body.tags) &&
      got.body.tags[0] === "a" && got.body.meta.n === 1, JSON.stringify(got?.body));
  }

  // a callable default is resolved per instance
  {
    ticketCounter = 0;
    const a: any = new OrmfTicket();
    const b: any = new OrmfTicket();
    const c: any = new OrmfTicket();
    check("a callable default is resolved per instance", a.seq === 1 && b.seq === 2 && c.seq === 3,
      `${a.seq}/${b.seq}/${c.seq}`);
  }

  // a callable default is not present in the create table ddl
  {
    await OrmfSession.createTable();
    const row: any = await sdb.fetchOne("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", ["ormf_session"]);
    check("a callable default is not present in the create table ddl",
      !!row && !String(row.sql).toUpperCase().includes("DEFAULT"), String(row?.sql));
  }

  // a non serializable json value makes save return false and is logged
  {
    await OrmfBlob.createTable();
    const bad = new OrmfBlob({ data: { x: 10n } });   // a BigInt is not JSON-serializable
    const res = await bad.save();
    const cnt = await OrmfBlob.count();
    check("a non serializable json value makes save return false and is logged",
      res === false && cnt === 0, `res=${res} count=${cnt}`);
  }

  // a decimal field produces a decimal precision scale column
  {
    await OrmfMoney.createTable();
    const row: any = await sdb.fetchOne("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", ["ormf_money"]);
    check("a decimal field produces a decimal precision scale column",
      !!row && String(row.sql).replace(/\s/g, "").toUpperCase().includes("DECIMAL(12,4)"), String(row?.sql));
  }

  sdb.close();

  // ── real-engine DDL (replaces the deleted Python mock) ────────────────────
  for (const engine of ["postgres", "mysql", "mssql", "firebird"]) {
    const db = await engineDb(engine);
    if (!db) continue;   // skipped (hard fail already triggered for PG/MySQL/MSSQL)
    try {
      // a boolean column is created with the engine native boolean type
      {
        const cols = await makeEngineTable(db, engine);
        const flag = cols.flag;
        let ok = false;
        if (engine === "postgres") ok = String(flag.type).includes("bool");
        else if (engine === "mysql") ok = flag.type === "tinyint(1)";
        else if (engine === "mssql") ok = flag.type === "bit";
        else ok = flag.ftype === 8;   // Firebird LONG / INTEGER
        check("a boolean column is created with the engine native boolean type", ok, `${engine}: ${JSON.stringify(flag)}`);
      }
      // a json column is created with the engine native json type
      {
        const cols = await describe(db, engine, "ormf_engine");
        const payload = cols.payload;
        let ok = false;
        if (engine === "postgres") ok = payload.type === "jsonb";
        else if (engine === "mysql") ok = payload.type === "json";
        else if (engine === "mssql") ok = payload.type === "nvarchar" && payload.maxlen === -1;
        else ok = payload.ftype === 261 && payload.fsub === 1;   // BLOB SUB_TYPE TEXT
        check("a json column is created with the engine native json type", ok, `${engine}: ${JSON.stringify(payload)}`);
      }
      // a decimal column is created with decimal precision and scale on the engine
      {
        const cols = await describe(db, engine, "ormf_engine");
        const amount = cols.amount;
        let ok = false;
        if (engine === "firebird") ok = amount.precision === 12 && amount.scale === -4;
        else ok = amount.precision === 12 && amount.scale === 4;
        check("a decimal column is created with decimal precision and scale on the engine", ok, `${engine}: ${JSON.stringify(amount)}`);
      }
      // the engine ddl types round trip a real row. Drive write/read through the
      // DB facade with an explicit key: proves the ENGINE COLUMNS accept + return
      // a real row of each type, independent of ORM auto-increment and the
      // natural-key save path (separate feature 16/17 concerns). The ORM's JSON
      // serialize/hydrate is proven by the SQLite cases above.
      {
        await db.insert("ormf_engine", {
          id: "row-1", flag: true, payload: JSON.stringify({ k: "v", n: [1, 2] }),
          amount: 1234.5678, made_at: "2026-03-04 05:06:07",
        });
        const rows = (await db.fetch("SELECT * FROM ormf_engine WHERE id = ?", ["row-1"], 1)).records as Record<string, unknown>[];
        const raw = rows[0];
        const r = raw ? lower(raw) : {};
        let payload: any = (r as any).payload;
        if (Buffer.isBuffer(payload)) payload = payload.toString("utf-8");
        else if (payload && typeof payload === "object" && (payload as any).type === "Buffer") payload = Buffer.from((payload as any).data).toString("utf-8");
        if (typeof payload === "string") payload = JSON.parse(payload);
        // Every driver returns the TIMESTAMP as a Date object; String(Date) is a
        // locale string, so normalise to ISO (YYYY-MM-DD...) before the date check.
        const madeAt = (r as any).made_at instanceof Date
          ? ((r as any).made_at as Date).toISOString()
          : String((r as any).made_at);
        check("the engine ddl types round trip a real row",
          !!raw && ["1", "t", "true"].includes(String((r as any).flag).toLowerCase()) &&
          JSON.stringify(payload) === JSON.stringify({ k: "v", n: [1, 2] }) &&
          Math.abs(Number((r as any).amount) - 1234.5678) < 1e-3 &&
          madeAt.includes("2026-03-04"),
          `${engine}: flag=${(r as any).flag} amount=${(r as any).amount} madeAt=${madeAt} payload=${JSON.stringify(payload)}`);
      }
      await dropEngineTable(db, engine, "ormf_engine");
    } finally {
      db.close();
    }
  }

  console.log(`\normfields contract: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

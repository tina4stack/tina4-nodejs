// Identifier allow-list contract (ADR-0069): identifiers that reach SQL come
// from the model, never from the request.
//
//   A. AutoCrud list route - filter[KEY] / filter[KEY][OP] keys and sort parts
//      resolve against the model's DECLARED fields (property name or its mapped
//      column); an unknown key is a 400 UNKNOWN_FIELD before any SQL runs.
//   B. BaseModel.find(object) - same resolver, unknown key throws an Error.
//      Runs on SQLite, PostgreSQL, MySQL, MSSQL and Firebird.
//   C. DocStore SQLite fallback - every dot segment of a field path must match
//      [A-Za-z0-9_-]+; the accepted shapes return the same documents as a REAL
//      MongoDB for the same data and queries.
//
// NO MOCKS: a real startServer() over node:http with a real model file and a
// real SQLite database, real database engines, a real MongoDB.
//
// Run with: npx tsx test/identifierAllowListContract.test.ts

import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../packages/core/src/index.ts";
import { BaseModel, Database, bindDatabase, createAdapterFromUrl } from "../packages/orm/src/index.ts";
import { SqliteDatabase } from "../packages/orm/src/docstore.ts";

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");

/** A provisioned service that is missing: a hard FAILURE under TINA4_REQUIRE_SERVICES. */
function serviceMissing(msg: string): void {
  if (requireServices) {
    failed++;
    console.log(`  \x1b[31mSKIP-AS-FAIL\x1b[0m ${msg}`);
  } else {
    skipped++;
    console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
  }
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

/** Resolve to the thrown/rejected message, or null when the call succeeded. */
async function errorOf(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A. AutoCrud over a real server
// ═══════════════════════════════════════════════════════════════════════════

interface Result {
  status: number;
  json: any;
  text: string;
}

function request(port: number, path: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* leave null */ }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const ORM_SRC = join(import.meta.dirname, "..", "packages", "orm", "src");
const PORT = 3947;

function unknownFieldBody(kind: "filter" | "sort", key: string): string {
  return JSON.stringify({ error: true, code: "UNKNOWN_FIELD", message: `Unknown ${kind} field '${key}'`, status: 400 });
}

async function autoCrudCases(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tina4-ident-allow-"));
  mkdirSync(join(root, "src/models"), { recursive: true });
  mkdirSync(join(root, "src/routes"), { recursive: true });

  writeFileSync(
    join(root, "src/models/IdentItem.ts"),
    `import { BaseModel } from "file://${ORM_SRC}/baseModel.js";

export default class IdentItem extends BaseModel {
  static tableName = "ident_item";
  static autoCrud = true;
  static fieldMapping = { firstName: "first_name" };
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
    firstName: { type: "string" as const },
    age: { type: "integer" as const },
  };
}
`,
  );

  // The table exists BEFORE the server boots and carries one column the model
  // does NOT declare (internal_code) - an undeclared-but-real column.
  const dbPath = join(root, "ident.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec(`CREATE TABLE ident_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, first_name TEXT, age INTEGER, internal_code TEXT)`);
  seed.exec(`INSERT INTO ident_item (id, name, first_name, age, internal_code) VALUES
    (1, 'alpha', 'Zed', 30, 'c1'), (2, 'beta', 'Amy', 20, 'c2'), (3, 'gamma', 'Amy', 40, 'c3')`);
  seed.close();

  const server = await startServer({
    port: PORT,
    routesDir: join(root, "src/routes"),
    modelsDir: join(root, "src/models"),
    staticDir: join(root, "public"),
    database: { type: "sqlite", path: dbPath },
  });

  const get = (path: string) => request(PORT, path);
  const ids = (r: Result): number[] => (r.json?.records ?? []).map((row: any) => Number(row.id));

  try {
    // ── unknown_filter_field_returns_400 ─────────────────────────────────
    console.log("\n--- unknown_filter_field_returns_400 ---");
    const badFilters: [string, string][] = [
      ["/api/ident_item?filter[internal_code]=c1", "internal_code"],
      ["/api/ident_item?filter[internal_code][gt]=c0", "internal_code"],
      ["/api/ident_item?filter[first%20name]=Amy", "first name"],
      ["/api/ident_item?filter[na%22me]=alpha", 'na"me'],
      ["/api/ident_item?filter[age)]=1", "age)"],
    ];
    for (const [path, key] of badFilters) {
      const r = await get(path);
      assert(`unknown_filter_field_returns_400: ${JSON.stringify(key)} -> 400`, r.status === 400, `status=${r.status} body=${r.text.slice(0, 200)}`);
      assert(
        `unknown_filter_field_returns_400: ${JSON.stringify(key)} -> exact UNKNOWN_FIELD body`,
        JSON.stringify(r.json) === unknownFieldBody("filter", key),
        r.text.slice(0, 200),
      );
    }

    // ── unknown_sort_field_returns_400 ───────────────────────────────────
    console.log("\n--- unknown_sort_field_returns_400 ---");
    const badSorts: [string, string][] = [
      ["/api/ident_item?sort=internal_code", "internal_code"],
      ["/api/ident_item?sort=-internal_code", "internal_code"],
      ["/api/ident_item?sort=name,internal_code", "internal_code"],
      ["/api/ident_item?sort=first%20name", "first name"],
      ["/api/ident_item?sort=na%22me", 'na"me'],
      ["/api/ident_item?filter[name]=alpha&sort=-age)", "age)"],
    ];
    for (const [path, key] of badSorts) {
      const r = await get(path);
      assert(`unknown_sort_field_returns_400: ${JSON.stringify(key)} (${path.split("?")[1]}) -> 400`, r.status === 400, `status=${r.status} body=${r.text.slice(0, 200)}`);
      assert(
        `unknown_sort_field_returns_400: ${JSON.stringify(key)} (${path.split("?")[1]}) -> exact UNKNOWN_FIELD body`,
        JSON.stringify(r.json) === unknownFieldBody("sort", key),
        r.text.slice(0, 200),
      );
    }

    // ── declared_filter_and_sort_still_work ──────────────────────────────
    console.log("\n--- declared_filter_and_sort_still_work ---");
    const goods: [string, string, number[]][] = [
      ["declared field filter", "/api/ident_item?filter[name]=alpha", [1]],
      ["mapped field filter by property", "/api/ident_item?filter[firstName]=Amy&sort=id", [2, 3]],
      ["mapped field filter by column", "/api/ident_item?filter[first_name]=Amy&sort=id", [2, 3]],
      ["operator filter on a declared field", "/api/ident_item?filter[age][gt]=25&sort=id", [1, 3]],
      ["sort without filter, -field DESC", "/api/ident_item?sort=-age", [3, 1, 2]],
      ["multi-field sort by property", "/api/ident_item?sort=firstName,-age", [3, 2, 1]],
      ["multi-field sort by column", "/api/ident_item?sort=first_name,name", [2, 3, 1]],
      ["filter + sort together", "/api/ident_item?filter[firstName]=Amy&sort=-age", [3, 2]],
      ["filter and sort on a mapped field by property", "/api/ident_item?filter[firstName]=Amy&sort=-firstName,-id", [3, 2]],
      ["filter and sort on a mapped field by column", "/api/ident_item?filter[first_name]=Amy&sort=first_name,id", [2, 3]],
      ["empty sort parts are skipped", "/api/ident_item?sort=name,,", [1, 2, 3]],
    ];
    for (const [label, path, expected] of goods) {
      const r = await get(path);
      assert(
        `declared_filter_and_sort_still_work: ${label}`,
        r.status === 200 && JSON.stringify(ids(r)) === JSON.stringify(expected),
        `status=${r.status} ids=${JSON.stringify(ids(r))} expected=${JSON.stringify(expected)} body=${r.text.slice(0, 300)}`,
      );
    }
    const total = await get("/api/ident_item?filter[firstName]=Amy");
    assert("declared_filter_and_sort_still_work: total counts the resolved filter", total.json?.total === 2, total.text.slice(0, 300));
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// B. BaseModel.find(object) on every engine
// ═══════════════════════════════════════════════════════════════════════════

class IdentWidget extends BaseModel {
  static tableName = "ident_widget";
  static autoMap = false;
  static fieldMapping = { firstName: "first_name" };
  static fields = {
    id: { type: "integer" as const, primaryKey: true },
    name: { type: "string" as const, maxLength: 40 },
    firstName: { type: "string" as const, maxLength: 40 },
  };
}

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

async function engineDb(engine: string, sqlitePath: string): Promise<Database | null> {
  let url: string;
  if (engine === "sqlite") {
    url = `sqlite:///${sqlitePath}`;
  } else if (engine === "postgres") {
    if (!(await tcpReachable(PG.host, PG.port))) { serviceMissing(`orm_find_rejects_undeclared_filter_key: postgres not reachable at ${PG.host}:${PG.port} (set TINA4_TEST_PG_*)`); return null; }
    url = `postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${PG.db}`;
  } else if (engine === "mysql") {
    if (!(await tcpReachable(MY.host, MY.port))) { serviceMissing(`orm_find_rejects_undeclared_filter_key: mysql not reachable at ${MY.host}:${MY.port} (set TINA4_TEST_MYSQL_*)`); return null; }
    url = `mysql://${MY.user}:${MY.pass}@${MY.host}:${MY.port}/${MY.db}`;
  } else if (engine === "mssql") {
    if (!(await tcpReachable(MS.host, MS.port))) { serviceMissing(`orm_find_rejects_undeclared_filter_key: mssql not reachable at ${MS.host}:${MS.port} (set TINA4_TEST_MSSQL_*)`); return null; }
    url = `mssql://${MS.user}:${MS.pass}@${MS.host}:${MS.port}/${MS.db}`;
  } else {
    // Firebird is not in CI's provisioned set (the repo's gate excludes it);
    // the lab sets TINA4_TEST_FIREBIRD_URL and then it must connect.
    if (!FIREBIRD_URL) {
      skipped++;
      console.log(`  \x1b[33mSKIP\x1b[0m orm_find_rejects_undeclared_filter_key on firebird [needs:firebird] TINA4_TEST_FIREBIRD_URL not set`);
      return null;
    }
    url = FIREBIRD_URL;
  }
  const adapter: any = await createAdapterFromUrl(url);
  const db = new Database(adapter);
  db.setDbType(engine);
  bindDatabase(adapter);
  return db;
}

async function dropTable(db: Database, engine: string): Promise<void> {
  try {
    if (engine === "mssql") await db.execute(`IF OBJECT_ID('ident_widget', 'U') IS NOT NULL DROP TABLE ident_widget`);
    else if (engine === "firebird") { if (await db.tableExists("ident_widget")) await db.execute(`DROP TABLE ident_widget`); }
    else await db.execute(`DROP TABLE IF EXISTS ident_widget`);
  } catch { /* best effort */ }
}

async function ormFindCases(): Promise<void> {
  console.log("\n--- orm_find_rejects_undeclared_filter_key ---");
  const sqliteDir = mkdtempSync(join(tmpdir(), "tina4-ident-orm-"));
  try {
    for (const engine of ["sqlite", "postgres", "mysql", "mssql", "firebird"]) {
      const db = await engineDb(engine, join(sqliteDir, "orm.db"));
      if (!db) continue;
      try {
        await dropTable(db, engine);
        const created = await IdentWidget.createTable();
        assert(`orm_find_rejects_undeclared_filter_key: table created on ${engine}`, created === true, `getError=${db.getError()}`);
        // An undeclared-but-real column next to the declared ones.
        await db.execute(
          engine === "mssql" || engine === "firebird"
            ? `ALTER TABLE ident_widget ADD internal_code VARCHAR(20)`
            : `ALTER TABLE ident_widget ADD COLUMN internal_code VARCHAR(20)`,
        );
        for (const [id, name, first, code] of [[1, "alpha", "Zed", "c1"], [2, "beta", "Amy", "c2"], [3, "gamma", "Amy", "c3"]] as const) {
          await db.insert("ident_widget", { id, name, first_name: first, internal_code: code });
        }

        // negative: an undeclared-but-real column is rejected before any SQL
        const undeclared = await errorOf(() => IdentWidget.find({ internal_code: "c1" }));
        assert(
          `orm_find_rejects_undeclared_filter_key: undeclared real column rejected on ${engine}`,
          undeclared === "Unknown filter field 'internal_code' for model IdentWidget",
          `got ${JSON.stringify(undeclared)}`,
        );
        // negative: a non-identifier key is rejected with the same message shape
        const spaced = await errorOf(() => IdentWidget.find({ "first name": "Amy" }));
        assert(
          `orm_find_rejects_undeclared_filter_key: non-identifier key rejected on ${engine}`,
          spaced === "Unknown filter field 'first name' for model IdentWidget",
          `got ${JSON.stringify(spaced)}`,
        );

        // positive: declared field, mapped field by property and by column
        const byName = await IdentWidget.find({ name: "alpha" });
        assert(
          `orm_find_rejects_undeclared_filter_key: declared field still filters on ${engine}`,
          byName.length === 1 && Number((byName[0] as any).id) === 1,
          `rows=${JSON.stringify(byName)}`,
        );
        const byProp = await IdentWidget.find({ firstName: "Amy" });
        assert(
          `orm_find_rejects_undeclared_filter_key: mapped field by property filters on ${engine}`,
          JSON.stringify(byProp.map((m: any) => Number(m.id)).sort()) === "[2,3]",
          `rows=${JSON.stringify(byProp)}`,
        );
        const byCol = await IdentWidget.find({ first_name: "Amy" });
        assert(
          `orm_find_rejects_undeclared_filter_key: mapped field by column filters on ${engine}`,
          JSON.stringify(byCol.map((m: any) => Number(m.id)).sort()) === "[2,3]",
          `rows=${JSON.stringify(byCol)}`,
        );
      } catch (err) {
        assert(`orm_find_rejects_undeclared_filter_key: ${engine} run completed`, false, String((err as Error)?.stack ?? err));
      } finally {
        await dropTable(db, engine);
        try { db.close(); } catch { /* already closed */ }
      }
    }
  } finally {
    rmSync(sqliteDir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// C. DocStore field paths
// ═══════════════════════════════════════════════════════════════════════════

const MONGO_URI = process.env.TINA4_TEST_MONGO_URI ?? "mongodb://127.0.0.1:27017";

const DOCS = [
  { _id: "d1", a_b: 1, "a-b": "x", A1: true, nested: { key: "n1" } },
  { _id: "d2", a_b: 2, "a-b": "y", A1: false, nested: { key: "n2" } },
  { _id: "d3", a_b: 3, "a-b": "x", A1: true, nested: { key: "n1" } },
];

// Every accepted key shape, as filter, operator field, $or member and sort key.
const SAFE_QUERIES: [string, Record<string, unknown>, Record<string, number>][] = [
  ["a_b equality", { a_b: 2 }, { a_b: 1 }],
  ["a-b equality", { "a-b": "x" }, { a_b: 1 }],
  ["A1 equality", { A1: true }, { a_b: 1 }],
  ["nested.key equality", { "nested.key": "n1" }, { a_b: 1 }],
  ["_id equality", { _id: "d2" }, { a_b: 1 }],
  ["a_b operator", { a_b: { $gte: 2 } }, { a_b: 1 }],
  ["nested.key operator", { "nested.key": { $in: ["n2"] } }, { a_b: 1 }],
  ["$or over a-b and nested.key", { $or: [{ "a-b": "y" }, { "nested.key": "n1" }] }, { a_b: 1 }],
  ["sort by a-b then -a_b", {}, { "a-b": 1, a_b: -1 }],
  ["sort by nested.key desc then a_b", { A1: { $exists: true } }, { "nested.key": -1, a_b: 1 }],
];

async function runQuery(collection: any, filter: Record<string, unknown>, sort: Record<string, number>): Promise<string[]> {
  const docs = await collection.find(filter).sort(sort).toArray();
  return docs.map((d: any) => String(d._id));
}

const INVALID_PATH = (key: string) =>
  `DocStore: invalid field path '${key}' - each dot-separated segment must match [A-Za-z0-9_-]+`;

async function docStoreCases(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tina4-ident-ds-"));
  const store = new SqliteDatabase(join(dir, "ds.db"));
  const collection: any = store.getCollection("ident_docs");
  await collection.insertMany(DOCS.map((d) => structuredClone(d)));

  try {
    // ── docstore_rejects_unsafe_field_path ───────────────────────────────
    console.log("\n--- docstore_rejects_unsafe_field_path ---");
    const unsafe: [string, string, () => unknown][] = [
      ["filter key with a space", "a b", () => collection.find({ "a b": 1 }).toArray()],
      ["filter key with a quote", 'a"b', () => collection.find({ 'a"b': 1 }).toArray()],
      ["filter key with an empty segment", "nested..key", () => collection.find({ "nested..key": "n1" }).toArray()],
      ["nested $or key", "a'b", () => collection.find({ $or: [{ a_b: 1 }, { "a'b": 1 }] }).toArray()],
      ["nested $and key", "a b", () => collection.find({ $and: [{ a_b: 1 }, { "a b": 1 }] }).toArray()],
      ["operator field with a bracket", "a[0]", () => collection.find({ "a[0]": { $gt: 1 } }).toArray()],
      ["sort key with a space", "a b", () => collection.find({}).sort({ "a b": 1 }).toArray()],
      ["sort key with a bracket", "nested.key)", () => collection.find({}).sort("nested.key)", -1).toArray()],
      ["countDocuments key", "a)", () => collection.countDocuments({ "a)": 1 })],
      ["updateMany key", "a b", () => collection.updateMany({ "a b": 1 }, { $set: { a_b: 9 } })],
      ["deleteMany key", "a;b", () => collection.deleteMany({ "a;b": 1 })],
    ];
    for (const [label, key, call] of unsafe) {
      const message = await errorOf(call);
      assert(
        `docstore_rejects_unsafe_field_path: ${label} raises`,
        message === INVALID_PATH(key),
        `got ${JSON.stringify(message)}`,
      );
    }
    // No SQL ran for the rejected writes: every document is still there, unchanged.
    const after = await collection.find({}).sort({ a_b: 1 }).toArray();
    assert(
      "docstore_rejects_unsafe_field_path: rejected writes changed nothing",
      JSON.stringify(after.map((d: any) => [d._id, d.a_b])) === JSON.stringify([["d1", 1], ["d2", 2], ["d3", 3]]),
      JSON.stringify(after),
    );

    // ── docstore_accepts_safe_field_paths ────────────────────────────────
    console.log("\n--- docstore_accepts_safe_field_paths ---");
    const expectedFallback: Record<string, string[]> = {
      "a_b equality": ["d2"],
      "a-b equality": ["d1", "d3"],
      "A1 equality": ["d1", "d3"],
      "nested.key equality": ["d1", "d3"],
      "_id equality": ["d2"],
      "a_b operator": ["d2", "d3"],
      "nested.key operator": ["d2"],
      "$or over a-b and nested.key": ["d1", "d2", "d3"],
      "sort by a-b then -a_b": ["d3", "d1", "d2"],
      "sort by nested.key desc then a_b": ["d2", "d1", "d3"],
    };
    const fallbackResults: Record<string, string[]> = {};
    for (const [label, filter, sort] of SAFE_QUERIES) {
      let got: string[] | string;
      try {
        got = await runQuery(collection, filter, sort);
      } catch (err) {
        got = String((err as Error).message);
      }
      fallbackResults[label] = Array.isArray(got) ? got : [];
      assert(
        `docstore_accepts_safe_field_paths: ${label}`,
        JSON.stringify(got) === JSON.stringify(expectedFallback[label]),
        `got ${JSON.stringify(got)} expected ${JSON.stringify(expectedFallback[label])}`,
      );
    }

    // ── docstore_safe_paths_match_on_real_mongo ──────────────────────────
    console.log("\n--- docstore_safe_paths_match_on_real_mongo ---");
    await realMongoParity(fallbackResults);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function realMongoParity(fallbackResults: Record<string, string[]>): Promise<void> {
  let MongoClient: any;
  try {
    ({ MongoClient } = await import("mongodb"));
  } catch {
    serviceMissing("docstore_safe_paths_match_on_real_mongo: mongodb driver not installed");
    return;
  }
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
  } catch {
    serviceMissing(`docstore_safe_paths_match_on_real_mongo: mongo not reachable at ${MONGO_URI} (set TINA4_TEST_MONGO_URI)`);
    try { await client.close(); } catch { /* not connected */ }
    return;
  }

  // The DocStore's own provider path: getCollection() with a configured URI
  // returns the real driver collection (ADR-0025). A unique database, dropped after.
  const dbName = `tina4_sqli_node_${process.pid}_${Date.now()}`;
  const saved = { uri: process.env.TINA4_MONGO_URI, db: process.env.TINA4_MONGO_DB };
  process.env.TINA4_MONGO_URI = MONGO_URI;
  process.env.TINA4_MONGO_DB = dbName;
  const docstore = await import("../packages/orm/src/docstore.ts");
  try {
    const collection: any = await docstore.getCollection("ident_docs");
    assert(
      "docstore_safe_paths_match_on_real_mongo: the provider is the real driver, not the fallback",
      collection?.constructor?.name !== "SqliteCollection",
      String(collection?.constructor?.name),
    );
    await collection.insertMany(DOCS.map((d) => structuredClone(d)));
    for (const [label, filter, sort] of SAFE_QUERIES) {
      const got = await runQuery(collection, filter, sort);
      assert(
        `docstore_safe_paths_match_on_real_mongo: ${label}`,
        JSON.stringify(got) === JSON.stringify(fallbackResults[label]),
        `mongo=${JSON.stringify(got)} fallback=${JSON.stringify(fallbackResults[label])}`,
      );
    }
  } finally {
    try { await client.db(dbName).dropDatabase(); } catch { /* best effort */ }
    await docstore.closeDocStore();
    await client.close();
    if (saved.uri === undefined) delete process.env.TINA4_MONGO_URI; else process.env.TINA4_MONGO_URI = saved.uri;
    if (saved.db === undefined) delete process.env.TINA4_MONGO_DB; else process.env.TINA4_MONGO_DB = saved.db;
  }
}

async function main(): Promise<void> {
  await autoCrudCases();
  await ormFindCases();
  await docStoreCases();

  console.log(`\n==================================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`==================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

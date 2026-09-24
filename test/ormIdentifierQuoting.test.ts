/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

// The ORM emits table/column names through the bound adapter's dialect quoting.
//
// Port of the Python master's design: the adapter owns identifier quoting
// (Python `quote_identifier`: MySQL backticks, Firebird upper-cased, `"name"`
// elsewhere). BaseModel and AutoCrud used to hard-code `"name"`, which on MySQL
// is a STRING literal (every BaseModel query was a syntax error) and on
// Firebird names a case-sensitive lower-case table that the ORM's own DDL never
// creates (every BaseModel query was "Table unknown").
//
// NO MOCKS: pure-logic cases for the quoting function, then BaseModel CRUD and
// the AutoCrud list/get routes over a real startServer() against real SQLite,
// PostgreSQL, MySQL, MSSQL and Firebird.
//
// Run with: npx tsx test/ormIdentifierQuoting.test.ts

import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/src/index.ts";
import {
  BaseModel, Database, bindDatabase, createAdapterFromUrl, getAdapter,
} from "../packages/orm/src/index.ts";
import { quoteIdentifier } from "../packages/orm/src/database.ts";
import { quoteIdentifierWith, quoteIdentifierAnsi } from "../packages/orm/src/adapters/sqlDialect.ts";
import { safeErrorText } from "./_safeError.ts";
import { labEngineUrl, hostAndPort } from "./_engineUrls.ts";

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

// ── pure logic ─────────────────────────────────────────────────────────────

function pureCases(): void {
  console.log("\n--- identifier quoting is idempotent, dot-aware and leaves expressions alone ---");
  const cases: [string, string, string][] = [
    ["ansi plain", quoteIdentifierAnsi("users"), '"users"'],
    ["ansi already quoted", quoteIdentifierAnsi('"users"'), '"users"'],
    ["ansi dotted", quoteIdentifierAnsi("app.users"), '"app"."users"'],
    ["ansi wildcard untouched", quoteIdentifierAnsi("*"), "*"],
    ["ansi expression untouched", quoteIdentifierAnsi("COUNT(*)"), "COUNT(*)"],
    ["mysql plain", quoteIdentifierWith("order", "`", "`"), "`order`"],
    ["mysql already quoted", quoteIdentifierWith("`order`", "`", "`"), "`order`"],
    ["mysql dotted", quoteIdentifierWith("shop.order", "`", "`"), "`shop`.`order`"],
    ["firebird upper-cases", quoteIdentifierWith("quote_widget", '"', '"', true), '"QUOTE_WIDGET"'],
    ["firebird keeps an already-quoted case-sensitive name", quoteIdentifierWith('"orders"', '"', '"', true), '"orders"'],
    ["no adapter falls back to ansi", quoteIdentifier(null, "users"), '"users"'],
  ];
  for (const [label, got, expected] of cases) {
    assert(`identifier quoting: ${label}`, got === expected, `got ${got} expected ${expected}`);
  }
}

// ── engines ────────────────────────────────────────────────────────────────

const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL ?? "";

/** The engine URL, or null when the engine is unavailable (reported). */
async function engineUrl(engine: string, sqlitePath: string): Promise<string | null> {
  if (engine === "sqlite") return `sqlite:///${sqlitePath}`;
  if (engine === "postgres") {
    const pgUrl = labEngineUrl("postgres");
    const pgTarget = hostAndPort(pgUrl, 55432);
    if (!(await tcpReachable(pgTarget.host, pgTarget.port))) { serviceMissing(`postgres not reachable at ${pgTarget.host}:${pgTarget.port} (set TINA4_TEST_PG_URL)`); return null; }
    return pgUrl;
  }
  if (engine === "mysql") {
    const myUrl = labEngineUrl("mysql");
    const myTarget = hostAndPort(myUrl, 3306);
    if (!(await tcpReachable(myTarget.host, myTarget.port))) { serviceMissing(`mysql not reachable at ${myTarget.host}:${myTarget.port} (set TINA4_TEST_MYSQL_URL)`); return null; }
    return myUrl;
  }
  if (engine === "mssql") {
    const msUrl = labEngineUrl("mssql");
    const msTarget = hostAndPort(msUrl, 1433);
    if (!(await tcpReachable(msTarget.host, msTarget.port))) { serviceMissing(`mssql not reachable at ${msTarget.host}:${msTarget.port} (set TINA4_TEST_MSSQL_URL)`); return null; }
    return msUrl;
  }
  // Firebird is not in CI's provisioned set (the repo's gate excludes it); the
  // lab sets TINA4_TEST_FIREBIRD_URL and then it must connect.
  if (!FIREBIRD_URL) {
    skipped++;
    console.log(`  \x1b[33mSKIP\x1b[0m firebird [needs:firebird] TINA4_TEST_FIREBIRD_URL not set`);
    return null;
  }
  return FIREBIRD_URL;
}

async function dropTable(db: Database, engine: string, table: string): Promise<void> {
  try {
    if (engine === "mssql") await db.execute(`IF OBJECT_ID('${table}', 'U') IS NOT NULL DROP TABLE ${table}`);
    else if (engine === "firebird") { if (await db.tableExists(table)) await db.execute(`DROP TABLE ${table}`); }
    else await db.execute(`DROP TABLE IF EXISTS ${table}`);
  } catch { /* best effort */ }
}

class QuoteWidget extends BaseModel {
  static tableName = "quote_widget";
  static autoMap = false;
  static fields = {
    id: { type: "integer" as const, primaryKey: true },
    name: { type: "string" as const, maxLength: 40 },
    qty: { type: "integer" as const },
  };
}

const EXPECTED_QUOTE: Record<string, string> = {
  sqlite: '"quote_widget"',
  postgres: '"quote_widget"',
  mysql: "`quote_widget`",
  mssql: '"quote_widget"',
  firebird: '"QUOTE_WIDGET"',
};

async function modelCases(engine: string, url: string): Promise<void> {
  const adapter: any = await createAdapterFromUrl(url);
  const db = new Database(adapter);
  db.setDbType(engine);
  bindDatabase(adapter);
  try {
    await dropTable(db, engine, "quote_widget");
    assert(`${engine}: createTable`, (await QuoteWidget.createTable()) === true, `getError=${db.getError()}`);
    assert(`${engine}: the bound adapter quotes in its own dialect`,
      quoteIdentifier(getAdapter(), "quote_widget") === EXPECTED_QUOTE[engine],
      quoteIdentifier(getAdapter(), "quote_widget"));

    for (const [id, name, qty] of [[1, "alpha", 5], [2, "beta", 7], [3, "gamma", 1]] as const) {
      const saved = await new QuoteWidget({ id, name, qty }).save();
      assert(`${engine}: BaseModel save() inserts row ${id}`, saved !== false);
    }
    const two = await QuoteWidget.findById(2);
    assert(`${engine}: BaseModel findById()`, (two as any)?.name === "beta", JSON.stringify(two));
    const alpha = await QuoteWidget.find({ name: "alpha" });
    assert(`${engine}: BaseModel find(filter)`, alpha.length === 1 && Number((alpha[0] as any).id) === 1, JSON.stringify(alpha));
    const all = await QuoteWidget.all();
    assert(`${engine}: BaseModel all()`, all.length === 3, `length=${all.length}`);
    assert(`${engine}: BaseModel count()`, (await QuoteWidget.count()) === 3);
    const many = await QuoteWidget.where("qty > ?", [4]);
    assert(`${engine}: BaseModel where()`, many.length === 2, `length=${many.length}`);

    const one: any = await QuoteWidget.findById(1);
    one.name = "alpha2";
    assert(`${engine}: BaseModel save() updates`, (await one.save()) !== false, String(one.lastError));
    assert(`${engine}: the update persisted`, ((await QuoteWidget.findById(1)) as any)?.name === "alpha2");
    await one.delete();
    assert(`${engine}: BaseModel delete()`, (await QuoteWidget.count()) === 2);
  } catch (err) {
    assert(`${engine}: BaseModel CRUD completed`, false, safeErrorText(err).slice(0, 300));
  } finally {
    await dropTable(db, engine, "quote_widget");
    try { db.close(); } catch { /* already closed */ }
  }
}

// ── AutoCrud over a real server, per engine ───────────────────────────────

const ORM_SRC = join(import.meta.dirname, "..", "packages", "orm", "src");

function get(port: number, path: string): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function autoCrudCases(engine: string, url: string, port: number): Promise<void> {
  const table = `quote_crud_${engine}`;
  const root = mkdtempSync(join(tmpdir(), "tina4-quote-crud-"));
  mkdirSync(join(root, "src/models"), { recursive: true });
  mkdirSync(join(root, "src/routes"), { recursive: true });
  writeFileSync(join(root, "src/models/QuoteCrud.ts"), `import { BaseModel } from "file://${ORM_SRC}/baseModel.js";

export default class QuoteCrud extends BaseModel {
  static tableName = "${table}";
  static autoCrud = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true },
    name: { type: "string" as const, maxLength: 40 },
  };
}
`);

  // Start clean on the engine, then let the server's own syncModels create it.
  {
    const adapter: any = await createAdapterFromUrl(url);
    const db = new Database(adapter);
    await dropTable(db, engine, table);
    db.close();
  }

  const savedUrl = process.env.TINA4_DATABASE_URL;
  process.env.TINA4_DATABASE_URL = url;
  let server: { close: () => void } | null = null;
  try {
    server = await startServer({
      port,
      routesDir: join(root, "src/routes"),
      modelsDir: join(root, "src/models"),
      staticDir: join(root, "public"),
    });
    const db = new Database(getAdapter());
    for (const [id, name] of [[1, "alpha"], [2, "beta"], [3, "beta"]] as const) {
      await db.insert(table, { id, name });
    }
    const list = await get(port, `/api/${table}?filter[name]=beta&sort=-id`);
    const ids = (list.json?.records ?? []).map((r: any) => Number(r.id ?? r.ID));
    assert(`${engine}: AutoCrud list with filter + sort`,
      list.status === 200 && JSON.stringify(ids) === "[3,2]",
      `status=${list.status} ids=${JSON.stringify(ids)} body=${list.text.slice(0, 200)}`);
    const one = await get(port, `/api/${table}/1`);
    assert(`${engine}: AutoCrud get by id`,
      one.status === 200 && (one.json?.data?.name ?? one.json?.data?.NAME) === "alpha",
      `status=${one.status} body=${one.text.slice(0, 200)}`);
    await dropTable(db, engine, table);
  } catch (err) {
    assert(`${engine}: AutoCrud run completed`, false, safeErrorText(err).slice(0, 300));
  } finally {
    server?.close();
    if (savedUrl === undefined) delete process.env.TINA4_DATABASE_URL; else process.env.TINA4_DATABASE_URL = savedUrl;
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  pureCases();
  const sqliteDir = mkdtempSync(join(tmpdir(), "tina4-quote-"));
  try {
    let port = 3961;
    for (const engine of ["sqlite", "postgres", "mysql", "mssql", "firebird"]) {
      console.log(`\n--- ${engine}: BaseModel and AutoCrud emit identifiers in the engine's dialect ---`);
      const url = await engineUrl(engine, join(sqliteDir, `${engine}.db`));
      if (!url) continue;
      await modelCases(engine, url);
      await autoCrudCases(engine, url, port++);
    }
  } finally {
    rmSync(sqliteDir, { recursive: true, force: true });
  }

  console.log(`\n==================================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`==================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(safeErrorText(err));
  process.exit(1);
});

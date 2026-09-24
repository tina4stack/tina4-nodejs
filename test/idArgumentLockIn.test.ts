/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

// Lock-in (ADR-0069 neighbourhood): a row id from the request is a BOUND value,
// never SQL text, so it addresses exactly one row.
//
//   autocrud_id_route_addresses_only_that_row - AutoCrud GET/PUT/DELETE
//     /api/{table}/{id} over a real startServer() and real SQLite: a non-first
//     id touches only that row, and a non-numeric id is a 404 that changes
//     nothing.
//   graphql_id_argument_addresses_only_that_row - the GraphQL schema that
//     GraphQL.fromOrm() generates, executed in-process against a real SQLite
//     adapter: the single-row query and the update/delete mutations touch only
//     the addressed row, and a non-matching id changes nothing.
//   graphql_orm_mutations_write_only_declared_fields - the generated create /
//     update mutations write declared fields only.
//
// NO MOCKS. Run with: npx tsx test/idArgumentLockIn.test.ts

import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../packages/core/src/index.ts";
import { getToken } from "../packages/core/src/auth.ts";
import { GraphQL } from "../packages/core/src/graphql.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";
import { safeErrorText } from "./_safeError.ts";

process.env.TINA4_SECRET = "id-argument-lock-in-secret";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const SEED = [[1, "alpha"], [2, "beta"], [3, "gamma"]] as const;

function seedTable(path: string, table: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT)`);
  for (const [id, name] of SEED) db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`).run(id, name);
  db.close();
}

function tableState(path: string, table: string): string {
  const db = new DatabaseSync(path);
  const rows = db.prepare(`SELECT id, name FROM ${table} ORDER BY id`).all() as { id: number; name: string }[];
  db.close();
  return JSON.stringify(rows.map((r) => [Number(r.id), r.name]));
}

// ── AutoCrud ────────────────────────────────────────────────────────────────

function request(port: number, path: string, method: string, headers: Record<string, string> = {}, body?: unknown):
  Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1", port, path, method,
      headers: payload === undefined ? headers : { "content-type": "application/json", ...headers },
    }, (res) => {
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function autoCrudCases(): Promise<void> {
  console.log("\n--- autocrud_id_route_addresses_only_that_row ---");
  const root = mkdtempSync(join(tmpdir(), "tina4-id-route-"));
  mkdirSync(join(root, "src/models"), { recursive: true });
  mkdirSync(join(root, "src/routes"), { recursive: true });
  const ormSrc = join(import.meta.dirname, "..", "packages", "orm", "src");
  writeFileSync(join(root, "src/models/IdRow.ts"), `import { BaseModel } from "file://${ormSrc}/baseModel.js";

export default class IdRow extends BaseModel {
  static tableName = "id_row";
  static autoCrud = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true },
    name: { type: "string" as const },
  };
}
`);
  const dbPath = join(root, "id.db");
  seedTable(dbPath, "id_row");

  const port = 3949;
  const server = await startServer({
    port,
    routesDir: join(root, "src/routes"),
    modelsDir: join(root, "src/models"),
    staticDir: join(root, "public"),
    database: { type: "sqlite", path: dbPath },
  });
  const authed = { Authorization: `Bearer ${getToken({ sub: "id-argument-lock-in" }, 3600)}` };
  const label = "autocrud_id_route_addresses_only_that_row";
  try {
    const one = await request(port, "/api/id_row/2", "GET");
    assert(`${label}: GET a non-first id returns that row`, one.status === 200 && one.json?.data?.id === 2 && one.json?.data?.name === "beta", one.text);

    const put = await request(port, "/api/id_row/2", "PUT", authed, { name: "beta-2" });
    assert(`${label}: PUT a non-first id changes only that row`,
      put.status === 200 && tableState(dbPath, "id_row") === JSON.stringify([[1, "alpha"], [2, "beta-2"], [3, "gamma"]]),
      `status=${put.status} state=${tableState(dbPath, "id_row")}`);

    const del = await request(port, "/api/id_row/2", "DELETE", authed);
    assert(`${label}: DELETE a non-first id removes only that row`,
      del.status === 200 && tableState(dbPath, "id_row") === JSON.stringify([[1, "alpha"], [3, "gamma"]]),
      `status=${del.status} state=${tableState(dbPath, "id_row")}`);

    const before = tableState(dbPath, "id_row");
    for (const odd of ["abc", "2x", "%20"]) {
      const get = await request(port, `/api/id_row/${odd}`, "GET");
      const putOdd = await request(port, `/api/id_row/${odd}`, "PUT", authed, { name: "changed" });
      const delOdd = await request(port, `/api/id_row/${odd}`, "DELETE", authed);
      assert(`${label}: a non-numeric id (${JSON.stringify(decodeURIComponent(odd))}) is a 404 for GET/PUT/DELETE`,
        get.status === 404 && putOdd.status === 404 && delOdd.status === 404,
        `GET=${get.status} PUT=${putOdd.status} DELETE=${delOdd.status}`);
    }
    assert(`${label}: the non-numeric ids changed no rows`, tableState(dbPath, "id_row") === before, `${before} -> ${tableState(dbPath, "id_row")}`);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ── GraphQL.fromOrm ─────────────────────────────────────────────────────────

class GqlWidget {
  static tableName = "gql_widget";
  static fields = {
    id: { type: "integer", primaryKey: true },
    name: { type: "string" },
  };
}

async function graphqlCases(): Promise<void> {
  console.log("\n--- graphql_id_argument_addresses_only_that_row ---");
  const dir = mkdtempSync(join(tmpdir(), "tina4-id-gql-"));
  const dbPath = join(dir, "gql.db");
  seedTable(dbPath, "gql_widget");
  const adapter = new SQLiteAdapter(dbPath);
  const label = "graphql_id_argument_addresses_only_that_row";
  try {
    const gql = new GraphQL().fromOrm(GqlWidget, adapter as any);

    const one = await gql.execute(`{ gqlWidget(id: "2") { id name } }`);
    assert(`${label}: the single-row query returns only the addressed row`,
      (one.data as any)?.gqlWidget?.name === "beta" && String((one.data as any)?.gqlWidget?.id) === "2", JSON.stringify(one));

    const upd = await gql.execute(`mutation { updateGqlWidget(id: "2", name: "beta-2") { id name } }`);
    assert(`${label}: update changes only the addressed row`,
      (upd.data as any)?.updateGqlWidget?.name === "beta-2" &&
        tableState(dbPath, "gql_widget") === JSON.stringify([[1, "alpha"], [2, "beta-2"], [3, "gamma"]]),
      `${JSON.stringify(upd)} state=${tableState(dbPath, "gql_widget")}`);

    const del = await gql.execute(`mutation { deleteGqlWidget(id: "2") }`);
    assert(`${label}: delete removes only the addressed row`,
      (del.data as any)?.deleteGqlWidget === true &&
        tableState(dbPath, "gql_widget") === JSON.stringify([[1, "alpha"], [3, "gamma"]]),
      `${JSON.stringify(del)} state=${tableState(dbPath, "gql_widget")}`);

    const before = tableState(dbPath, "gql_widget");
    const missUpdate = await gql.execute(`mutation { updateGqlWidget(id: "99", name: "changed") { id } }`);
    const missDelete = await gql.execute(`mutation { deleteGqlWidget(id: "abc") }`);
    const missQuery = await gql.execute(`{ gqlWidget(id: "2x") { id } }`);
    assert(`${label}: a non-matching id changes nothing and finds nothing`,
      (missUpdate.data as any)?.updateGqlWidget === null &&
        (missDelete.data as any)?.deleteGqlWidget === false &&
        (missQuery.data as any)?.gqlWidget === null &&
        tableState(dbPath, "gql_widget") === before,
      `update=${JSON.stringify(missUpdate)} delete=${JSON.stringify(missDelete)} query=${JSON.stringify(missQuery)} state=${tableState(dbPath, "gql_widget")}`);
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// graphql_orm_mutations_write_only_declared_fields: the create/update
// mutations fromOrm() generates write the model's declared fields only. The
// executor hands a resolver every argument the query names, so an argument the
// schema never declared used to reach the INSERT/UPDATE column list.
async function graphqlDeclaredFieldCases(): Promise<void> {
  console.log("\n--- graphql_orm_mutations_write_only_declared_fields ---");
  const dir = mkdtempSync(join(tmpdir(), "tina4-gql-declared-"));
  const dbPath = join(dir, "gql.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("CREATE TABLE gql_widget (id INTEGER PRIMARY KEY, name TEXT, internal_code TEXT)");
  seed.exec("INSERT INTO gql_widget (id, name, internal_code) VALUES (1, 'alpha', 'c1')");
  seed.close();
  const read = (): string => {
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT id, name, internal_code FROM gql_widget ORDER BY id").all() as any[];
    db.close();
    return JSON.stringify(rows.map((r) => [Number(r.id), r.name, r.internal_code]));
  };
  const adapter = new SQLiteAdapter(dbPath);
  const label = "graphql_orm_mutations_write_only_declared_fields";
  try {
    const gql = new GraphQL().fromOrm(GqlWidget, adapter as any);
    const upd = await gql.execute(`mutation { updateGqlWidget(id: "1", name: "alpha-2", internal_code: "zz") { id name } }`);
    assert(`${label}: update writes the declared field and not the undeclared one`,
      read() === JSON.stringify([[1, "alpha-2", "c1"]]), `${JSON.stringify(upd)} state=${read()}`);
    const only = await gql.execute(`mutation { updateGqlWidget(id: "1", internal_code: "zz") { id } }`);
    assert(`${label}: an update naming only undeclared arguments changes nothing`,
      read() === JSON.stringify([[1, "alpha-2", "c1"]]), `${JSON.stringify(only)} state=${read()}`);
    const created = await gql.execute(`mutation { createGqlWidget(name: "beta", internal_code: "zz") { id name } }`);
    assert(`${label}: create writes the declared field and not the undeclared one`,
      read() === JSON.stringify([[1, "alpha-2", "c1"], [2, "beta", null]]), `${JSON.stringify(created)} state=${read()}`);
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await autoCrudCases();
  await graphqlCases();
  await graphqlDeclaredFieldCases();
  console.log(`\n==================================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`==================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(safeErrorText(err));
  process.exit(1);
});

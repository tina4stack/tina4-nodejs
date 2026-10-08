/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/*
 * ADR-0094: the AutoCrud list endpoint gains ?search (LIKE %term% OR'd across
 * the model's string/text columns, with a filtered total) and ?sort/?sort_dir
 * (ADR-0069 safe-sort with an asc|desc direction) — the surface the CRUD admin
 * grid drives over AJAX.
 *
 * NO MOCKS: a real on-disk SQLite DB with real rows, the real generated list
 * handler, invoked inside a REAL node:http server so we read the JSON the client
 * actually received. Same harness shape as test/autoCrud.test.ts.
 */

import { generateCrudRoutes, initDatabase, getAdapter, adapterExecute, closeDatabase } from "../packages/orm/src/index.ts";
import type { DiscoveredModel } from "../packages/orm/src/index.ts";
import { createResponse } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const peopleModel: DiscoveredModel = {
  filePath: "src/models/Person.ts",
  modelClass: undefined,
  definition: {
    tableName: "people",
    fields: {
      id:    { type: "integer", primaryKey: true, autoIncrement: true },
      name:  { type: "string", required: true },
      email: { type: "string" },
      age:   { type: "integer" },
    },
  },
};

const routes = generateCrudRoutes([peopleModel]);
const listRoute = routes.find((r) => r.method === "GET" && r.pattern === "/api/people")!;

const tmpDir = mkdtempSync(join(tmpdir(), "tina4-crud-search-"));

/** Run the list handler inside a one-shot real HTTP server, read the JSON back. */
async function listWith(query: Record<string, string>): Promise<{ statusCode: number; body: any }> {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const treq = req as unknown as Tina4Request;
    treq.params = {};
    (treq as any).query = query;
    const response = createResponse(res) as Tina4Response;
    try {
      await (listRoute.handler as any)(treq, response);
    } catch {
      if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ error: "test server error" })); }
    }
    if (!res.writableEnded) res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: addr.port, path: "/api/people" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      }).on("error", reject);
    });
  } finally {
    server.close();
  }
}

async function main() {
  console.log("=== AutoCrud ?search + ?sort_dir (real SQLite + real socket) ===\n");

  await initDatabase({ url: `sqlite:///${join(tmpDir, "people.db")}` });
  const adapter = getAdapter();
  await adapterExecute(adapter, "CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, age INTEGER)", []);
  for (const [name, email, age] of [
    ["Alice", "alice@example.com", 30],
    ["Bob", "bob@acme.com", 25],
    ["Charlie", "charlie@example.com", 35],
    ["Alicia", "alicia@example.com", 28],
  ] as Array<[string, string, number]>) {
    await adapterExecute(adapter, "INSERT INTO people (name, email, age) VALUES (?, ?, ?)", [name, email, age]);
  }

  console.log("--- ?search ---");
  let r = await listWith({ search: "Ali" });
  assert("search=Ali matches Alice + Alicia across string columns", r.body.records.length === 2,
    `got ${r.body.records.map((x: any) => x.name).join(",")}`);
  assert("search total is the FILTERED count, not the whole table", r.body.total === 2, `got ${r.body.total}`);

  r = await listWith({ search: "acme" });
  assert("search matches the email column too (Bob via bob@acme.com)",
    r.body.records.length === 1 && r.body.records[0].name === "Bob");

  r = await listWith({ search: "zzz-nothing" });
  assert("a no-match search returns zero records and total 0", r.body.records.length === 0 && r.body.total === 0);

  r = await listWith({});
  assert("no search returns the whole table (4 rows)", r.body.total === 4);

  console.log("\n--- ?sort + ?sort_dir ---");
  r = await listWith({ sort: "name", sort_dir: "asc" });
  assert("sort=name&sort_dir=asc orders ascending",
    r.body.records.map((x: any) => x.name).join(",") === "Alice,Alicia,Bob,Charlie",
    r.body.records.map((x: any) => x.name).join(","));

  r = await listWith({ sort: "name", sort_dir: "desc" });
  assert("sort=name&sort_dir=desc orders descending",
    r.body.records.map((x: any) => x.name).join(",") === "Charlie,Bob,Alicia,Alice",
    r.body.records.map((x: any) => x.name).join(","));

  r = await listWith({ sort: "age", sort_dir: "desc" });
  assert("sort=age&sort_dir=desc orders by the numeric column",
    r.body.records.map((x: any) => x.age).join(",") === "35,30,28,25",
    r.body.records.map((x: any) => x.age).join(","));

  console.log("\n--- search + sort together ---");
  r = await listWith({ search: "Ali", sort: "age", sort_dir: "asc" });
  assert("search + sort compose (Alicia 28 before Alice 30)",
    r.body.records.map((x: any) => x.name).join(",") === "Alicia,Alice",
    r.body.records.map((x: any) => x.name).join(","));

  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });

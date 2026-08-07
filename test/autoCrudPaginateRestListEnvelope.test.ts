/**
 * ADR-0043: the AutoCrud REST list endpoint IS the canonical paginate envelope.
 *
 * The GET /api/{table} list handler must return EXACTLY the seven snake_case keys
 * `records, total, page, per_page, total_pages, limit, offset` — the same envelope
 * DatabaseResult.toPaginate() builds — with `total` the TRUE COUNT over the filter
 * (never the number of rows this page returned) and `page` derived from the offset.
 *
 * Before 3.13.96 the handler built its OWN envelope (`{ data, meta: { total, page,
 * limit, totalPages } }`), bypassing to_paginate() — the `data` alias, the camelCase
 * `totalPages`, and the nested `meta` all violated ADR-0043's key-set invariant.
 *
 * Real node:sqlite on disk, a real 250-row table, the generated handler driven
 * inside a real node:http server so we read the JSON the client got off the wire.
 * No mocks, stubs, or fakes.
 *
 * Run with: npx tsx test/autoCrudPaginateRestListEnvelope.test.ts
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
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== AutoCrud REST list envelope (ADR-0043) ===\n");

/**
 * Drive a generated CRUD handler inside a one-shot real HTTP server: augment the
 * real IncomingMessage with the `params`/`query` the framework adds, invoke the
 * handler with the real createResponse() wrapper, fire a single real GET request,
 * and resolve with the status + parsed JSON the client received off the socket.
 */
async function invokeHandler(
  handler: (req: Tina4Request, res: Tina4Response) => unknown,
  opts: { params?: Record<string, string | number>; query?: Record<string, string> } = {},
): Promise<{ statusCode: number; body: any }> {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const treq = req as unknown as Tina4Request;
    treq.params = opts.params ?? {};
    treq.query = opts.query ?? {};
    const response = createResponse(res);
    try {
      await handler(treq, response);
    } catch (err) {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
    if (!res.writableEnded) res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const r = http.request(
        { host: "127.0.0.1", port: addr.port, path: "/", method: "GET" },
        (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: any = text;
            try { parsed = JSON.parse(text); } catch { /* leave raw */ }
            resolve({ statusCode: resp.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const model: DiscoveredModel = {
  filePath: "src/models/Widget.ts",
  definition: {
    tableName: "widgets",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string", required: true },
    },
  },
};

const tmpDir = mkdtempSync(join(tmpdir(), "tina4-autocrud-paginate-"));

await (async () => {
  await initDatabase({ url: `sqlite:///${join(tmpDir, "paginate.db")}` });
  const adapter = getAdapter();
  await adapterExecute(adapter,
    `CREATE TABLE "widgets" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);

  // 250 real rows — a true COUNT over the filter must read 250, never the 20 a
  // single page returns (the exact laundering ADR-0043 abolished).
  await adapterExecute(adapter, "BEGIN");
  for (let i = 1; i <= 250; i++) {
    await adapterExecute(adapter, `INSERT INTO "widgets" (name) VALUES (?)`, [`Widget ${i}`]);
  }
  await adapterExecute(adapter, "COMMIT");

  const listHandler = generateCrudRoutes([model])
    .find((r) => r.method === "GET" && r.pattern === "/api/widgets")!.handler;

  // Page 2 at 20 per page: offset 20, rows id 21..40, total 250, 13 pages.
  // sort=id makes the page deterministic (no default ORDER BY).
  const { statusCode, body } = await invokeHandler(listHandler, {
    query: { page: "2", limit: "20", sort: "id" },
  });

  assert("GET-list responds 200 off the wire", statusCode === 200, String(statusCode));

  // The key-set gate. EXACTLY the seven snake_case keys, no more, no fewer — no
  // `data`, no `meta`, no camelCase `totalPages`/`perPage`, no `count`.
  const expectedKeys = ["limit", "offset", "page", "per_page", "records", "total", "total_pages"];
  const actualKeys = body && typeof body === "object" ? Object.keys(body).sort() : [];
  assert(
    "paginate-rest-list-envelope-is-the-seven-keys",
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `got ${JSON.stringify(actualKeys)}`,
  );

  // total is the TRUE COUNT over the whole table (250), NOT the 20 rows returned.
  assert("total is the true COUNT (250), not rows returned", body?.total === 250, JSON.stringify(body?.total));
  assert("page is derived from the offset (page 2)", body?.page === 2, JSON.stringify(body?.page));
  assert("per_page is the query limit (20)", body?.per_page === 20, JSON.stringify(body?.per_page));
  assert("total_pages is ceil(250/20) = 13", body?.total_pages === 13, JSON.stringify(body?.total_pages));
  assert("limit is the SQL limit applied (20)", body?.limit === 20, JSON.stringify(body?.limit));
  assert("offset is the SQL offset applied (20)", body?.offset === 20, JSON.stringify(body?.offset));

  // records are the rows the query returned, verbatim — all 20 of page 2.
  assert("records carries all 20 rows of the page", Array.isArray(body?.records) && body.records.length === 20, JSON.stringify(body?.records?.length));
  assert("records are the page-2 rows (id 21..40)",
    body?.records?.[0]?.id === 21 && body?.records?.[19]?.id === 40,
    JSON.stringify([body?.records?.[0]?.id, body?.records?.[19]?.id]));

  // The dropped legacy spellings must be gone (ADR-0043 removes them).
  assert("no legacy `data` / `meta` / `totalPages` / `perPage` / `count` keys",
    !("data" in body) && !("meta" in body) && !("totalPages" in body) &&
    !("perPage" in body) && !("count" in body),
    JSON.stringify(Object.keys(body)));

  closeDatabase();
})();

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

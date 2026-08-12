/**
 * PAGE-DEC-01 pagination clamp + cap — feature 24 (pagination_contract.json).
 *
 * The audit's PAGE-NEGATIVE-OFFSET finding: `page < 1` was NOT clamped in
 * Python/Ruby/Node's AutoCrud list handler, so `offset = (page - 1) * limit`
 * handed the driver a NEGATIVE offset — a hard ERROR on PostgreSQL ("OFFSET
 * must not be negative") and a silent 0-offset on SQLite (still wrong: the
 * envelope reported page:0). PAGE-NO-MAX-LIMIT: Node's own AutoCrud list
 * honoured an oversized ?limit=/?per_page= verbatim — a client could request
 * the whole table in one query.
 *
 * PAGE-DEC-01 (OWNER-DECISIONS.md Batch 4): clamp page >= 1 (so offset is
 * never negative) and cap the per-page size at DEFAULT_ROW_CAP (100 — the
 * same row cap Database.fetch()/BaseModel.all() already default to).
 *
 * Real SQLite (always) + real PostgreSQL :55432 tina4/tina4 (when reachable,
 * TINA4_TEST_PG_* to relocate; a skip is a hard failure under
 * TINA4_REQUIRE_SERVICES) through the REAL AutoCrud list handler driven
 * inside a real node:http server. No mocks. The page=0 case is the one that
 * matters on PostgreSQL: before the fix it is a genuine driver ERROR, not
 * just a wrong number.
 *
 * Mutation-proof (manual): revert `Math.max(options.page ?? 1, 1)` back to
 * `options.page ?? 1` in packages/orm/src/query.ts and
 * "page_zero_clamps_to_page_one" goes RED on postgres with "OFFSET must not
 * be negative" surfaced through the response; restore it and it is GREEN.
 *
 * Run with: npx tsx test/paginationClampContract.test.ts
 */
import {
  generateCrudRoutes,
  initDatabase,
  getAdapter,
  adapterExecute,
  bindDatabase,
  createAdapterFromUrl,
  closeDatabase,
} from "../packages/orm/src/index.ts";
import type { DiscoveredModel } from "../packages/orm/src/index.ts";
import { createResponse } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import net from "node:net";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== Pagination clamp + cap (feature 24, PAGE-DEC-01) ===\n");

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";
const pgUrl = (): string => `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;

const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");

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

/**
 * Drive a generated CRUD handler inside a one-shot real HTTP server — same
 * harness as test/autoCrudPaginateRestListEnvelope.test.ts.
 */
async function invokeHandler(
  handler: (req: Tina4Request, res: Tina4Response) => unknown,
  opts: { query?: Record<string, string> } = {},
): Promise<{ statusCode: number; body: any }> {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const treq = req as unknown as Tina4Request;
    treq.params = {};
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
  filePath: "src/models/PageClampWidget.ts",
  definition: {
    tableName: "page_clamp_widget",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string", required: true },
    },
  },
};

async function seed(engine: "sqlite" | "postgres"): Promise<void> {
  const adapter = getAdapter();
  await adapterExecute(adapter, `DROP TABLE IF EXISTS "page_clamp_widget"`);
  const ddl =
    engine === "postgres"
      ? `CREATE TABLE "page_clamp_widget" (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      : `CREATE TABLE "page_clamp_widget" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`;
  await adapterExecute(adapter, ddl);
  for (let i = 0; i < 5; i++) {
    await adapterExecute(adapter, `INSERT INTO "page_clamp_widget" (name) VALUES (?)`, [`w${i}`]);
  }
}

async function runCases(engine: "sqlite" | "postgres"): Promise<void> {
  await seed(engine);
  const listHandler = generateCrudRoutes([model])
    .find((r) => r.method === "GET" && r.pattern === "/api/page_clamp_widget")!.handler;

  // page_zero_clamps_to_page_one (limit=, not per_page= - see the NOTE below;
  // Node's AutoCrud list only reads ?limit= for the per-page size)
  for (const badPage of ["0", "-3"]) {
    const { statusCode, body } = await invokeHandler(listHandler, {
      query: { page: badPage, limit: "10" },
    });
    assert(
      `[${engine}] page_zero_clamps_to_page_one: page=${badPage} must not error`,
      statusCode === 200,
      `got ${statusCode}: ${JSON.stringify(body)}`,
    );
    assert(
      `[${engine}] page_zero_clamps_to_page_one: page=${badPage} -> envelope page 1`,
      body?.page === 1,
      `got page=${JSON.stringify(body?.page)}`,
    );
    assert(
      `[${engine}] page_zero_clamps_to_page_one: page=${badPage} -> envelope offset 0`,
      body?.offset === 0,
      `got offset=${JSON.stringify(body?.offset)}`,
    );
    assert(
      `[${engine}] page_zero_clamps_to_page_one: page=${badPage} -> all 5 rows`,
      Array.isArray(body?.records) && body.records.length === 5,
      `got ${JSON.stringify(body?.records?.length)}`,
    );
  }

  // oversized_per_page_is_capped
  //
  // NOTE (out-of-scope drift, reported not fixed): Node's parseQueryString()
  // reads ?page=/?limit=/?offset= but never ?per_page= as an input alias
  // (unlike Python/PHP/Ruby, which all accept per_page as a limit fallback) -
  // measured while writing this suite. That is a distinct, pre-existing parity
  // gap outside PAGE-DEC-01's scope (clamp + cap only), so this case drives
  // the one query param Node's AutoCrud list actually reads for the per-page
  // size - ?limit= - matching the audit's exact measurement ("Node's AutoCrud
  // list honours ?limit=1000000 verbatim"). A ?per_page= assertion here would
  // be a false positive: the param is silently dropped and the handler falls
  // through to the same default (100) with or without the cap fix.
  {
    const { statusCode, body } = await invokeHandler(listHandler, {
      query: { limit: "1000000" },
    });
    assert(`[${engine}] oversized_per_page_is_capped: responds 200`, statusCode === 200, String(statusCode));
    assert(
      `[${engine}] oversized_per_page_is_capped: limit capped at 100`,
      body?.limit === 100,
      `got limit=${JSON.stringify(body?.limit)}`,
    );
    assert(
      `[${engine}] oversized_per_page_is_capped: per_page capped at 100`,
      body?.per_page === 100,
      `got per_page=${JSON.stringify(body?.per_page)}`,
    );
  }
}

async function main(): Promise<void> {
  // --- sqlite (always) ---
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-pageclamp-"));
  await initDatabase({ url: `sqlite:///${join(tmpDir, "pageclamp.db")}` });
  try {
    await runCases("sqlite");
  } finally {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // --- postgres (when reachable; a hard failure under TINA4_REQUIRE_SERVICES) ---
  const reachable = await tcpReachable(PG_HOST, PG_PORT);
  if (!reachable) {
    if (requireServices) {
      console.error(`\n  \x1b[31mSKIP-AS-FAIL\x1b[0m no reachable postgres at ${PG_HOST}:${PG_PORT} (set TINA4_TEST_PG_*)`);
      process.exit(1);
    }
    console.log(`\n  \x1b[33mSKIP\x1b[0m no reachable postgres at ${PG_HOST}:${PG_PORT} (set TINA4_TEST_PG_*)`);
  } else {
    const adapter = await createAdapterFromUrl(pgUrl());
    bindDatabase(adapter);
    try {
      await runCases("postgres");
    } finally {
      try {
        await adapterExecute(getAdapter(), `DROP TABLE IF EXISTS "page_clamp_widget"`);
      } catch {
        // best effort
      }
      closeDatabase();
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();

/**
 * Unit tests for auto-CRUD route generation (autoCrud.ts).
 * Run with: npx tsx test/autoCrud.test.ts
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

console.log("=== Auto-CRUD Route Generation Tests ===\n");

// --- Basic CRUD route generation ---
console.log("--- Basic CRUD Routes ---");

const userModel: DiscoveredModel = {
  filePath: "src/models/User.ts",
  definition: {
    tableName: "users",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string", required: true },
      email: { type: "string", required: true },
      active: { type: "boolean" },
    },
  },
};

const routes = generateCrudRoutes([userModel]);

assert("Generates 5 CRUD routes per model", routes.length === 5);
assert("GET /api/users (list)", routes.some(r => r.method === "GET" && r.pattern === "/api/users"));
assert("GET /api/users/{id}", routes.some(r => r.method === "GET" && r.pattern === "/api/users/{id}"));
assert("POST /api/users", routes.some(r => r.method === "POST" && r.pattern === "/api/users"));
assert("PUT /api/users/{id}", routes.some(r => r.method === "PUT" && r.pattern === "/api/users/{id}"));
assert("DELETE /api/users/{id}", routes.some(r => r.method === "DELETE" && r.pattern === "/api/users/{id}"));

// --- Meta / Swagger ---
console.log("\n--- Route Metadata ---");

const listRoute = routes.find(r => r.method === "GET" && r.pattern === "/api/users");
assert("List route has meta.summary", listRoute?.meta?.summary === "List users");
assert("List route has meta.tags", Array.isArray(listRoute?.meta?.tags) && listRoute!.meta!.tags![0] === "users");

const getByIdRoute = routes.find(r => r.method === "GET" && r.pattern === "/api/users/{id}");
assert("Get-by-ID route has summary", getByIdRoute?.meta?.summary === "Get users by ID");

const postRoute = routes.find(r => r.method === "POST" && r.pattern === "/api/users");
assert("POST route has summary", postRoute?.meta?.summary === "Create users");

const putRoute = routes.find(r => r.method === "PUT" && r.pattern === "/api/users/{id}");
assert("PUT route has summary", putRoute?.meta?.summary === "Update users");

const deleteRoute = routes.find(r => r.method === "DELETE" && r.pattern === "/api/users/{id}");
assert("DELETE route has summary", deleteRoute?.meta?.summary === "Delete users");

// --- Multiple models ---
console.log("\n--- Multiple Models ---");

const productModel: DiscoveredModel = {
  filePath: "src/models/Product.ts",
  definition: {
    tableName: "products",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "string", required: true },
      price: { type: "number" },
    },
  },
};

const multiRoutes = generateCrudRoutes([userModel, productModel]);
assert("Two models generate 10 routes", multiRoutes.length === 10);
assert("Has /api/products routes", multiRoutes.some(r => r.pattern === "/api/products"));
assert("Has /api/users routes", multiRoutes.some(r => r.pattern === "/api/users"));

// --- Empty models ---
console.log("\n--- Edge Cases ---");

const emptyRoutes = generateCrudRoutes([]);
assert("No models produces no routes", emptyRoutes.length === 0);

// --- Generated handlers run REAL queries against a REAL SQLite DB ---
//
// Previously this block only checked `typeof route.handler === "function"`
// (a smoke test — a handler that throws on the first DB call, or returns the
// wrong shape, would still pass). It now exercises the generated handlers end
// to end: a real on-disk SQLite DB (bound globally via initDatabase, exactly
// what getAdapter() returns inside the handlers), a real `users` table with
// real rows, and the handler invoked inside a REAL node:http server so we read
// the JSON the HTTP client actually received off the wire. No mocks, stubs, or
// fakes — only the framework's own createResponse() over a real socket.
console.log("\n--- Generated Handlers (real SQLite + real socket) ---");

const tmpDir = mkdtempSync(join(tmpdir(), "tina4-autocrud-"));

/**
 * Drive a generated CRUD handler inside a one-shot real HTTP server. We build
 * the Tina4Request the framework normally hands the handler by augmenting the
 * real IncomingMessage with the `params`/`query` it reads (these are real
 * request properties the framework adds, not a stand-in collaborator), invoke
 * the handler with the real createResponse() wrapper, then fire a single real
 * GET request and resolve with the status + parsed JSON the client received.
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

await (async () => {
  // Bind a real SQLite database globally — this IS what getAdapter() returns
  // inside every generated handler.
  await initDatabase({ url: `sqlite:///${join(tmpDir, "autocrud.db")}` });
  const adapter = getAdapter();
  await adapterExecute(adapter,
    `CREATE TABLE "users" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, active INTEGER)`);
  await adapterExecute(adapter,
    `INSERT INTO "users" (name, email, active) VALUES ('Alice', 'alice@example.com', 1)`);
  await adapterExecute(adapter,
    `INSERT INTO "users" (name, email, active) VALUES ('Bob', 'bob@example.com', 0)`);
  await adapterExecute(adapter,
    `INSERT INTO "users" (name, email, active) VALUES ('Carol', 'carol@example.com', 1)`);

  const liveRoutes = generateCrudRoutes([userModel]);
  const listHandler = liveRoutes.find(r => r.method === "GET" && r.pattern === "/api/users")!.handler;
  const getByIdHandler = liveRoutes.find(r => r.method === "GET" && r.pattern === "/api/users/{id}")!.handler;

  // GET /api/users — the list handler must run a real SELECT and return the
  // canonical seven-key paginate envelope (ADR-0043): records + a true COUNT(*),
  // NOT a `data`/`meta` shape.
  {
    const { statusCode, body } = await invokeHandler(listHandler);
    assert("GET-list handler responds 200 off the wire", statusCode === 200, String(statusCode));
    assert("GET-list returns records array of the 3 real rows",
      Array.isArray(body?.records) && body.records.length === 3,
      JSON.stringify(body));
    assert("GET-list rows carry the real column values",
      body?.records?.[0]?.name === "Alice" && body?.records?.[0]?.email === "alice@example.com",
      JSON.stringify(body?.records?.[0]));
    assert("GET-list total reflects real COUNT(*)", body?.total === 3, JSON.stringify(body));
    assert("GET-list page defaults to 1", body?.page === 1, JSON.stringify(body));
    assert("GET-list per_page defaults to 100", body?.per_page === 100, JSON.stringify(body));
    assert("GET-list limit defaults to 100", body?.limit === 100, JSON.stringify(body));
    assert("GET-list total_pages computed from total/per_page", body?.total_pages === 1, JSON.stringify(body));
    assert("GET-list envelope is exactly the seven snake_case keys",
      JSON.stringify(Object.keys(body ?? {}).sort()) ===
        JSON.stringify(["limit", "offset", "page", "per_page", "records", "total", "total_pages"]),
      JSON.stringify(Object.keys(body ?? {})));
  }

  // GET /api/users?filter[active]=1 — the real WHERE filter narrows the rows.
  {
    const { statusCode, body } = await invokeHandler(listHandler, { query: { "filter[active]": "1" } });
    assert("GET-list honours a real ?filter[] (active=1 → 2 rows)",
      statusCode === 200 && Array.isArray(body?.records) && body.records.length === 2,
      JSON.stringify(body));
    assert("GET-list filtered total reflects filtered COUNT(*)", body?.total === 2, JSON.stringify(body));
  }

  // GET /api/users/{id} — the by-id handler returns the single real row.
  {
    const { statusCode, body } = await invokeHandler(getByIdHandler, { params: { id: "2" } });
    assert("GET-by-id handler responds 200 for an existing row", statusCode === 200, String(statusCode));
    assert("GET-by-id returns the real row for id=2",
      body?.data?.id === 2 && body?.data?.name === "Bob",
      JSON.stringify(body?.data));
  }

  // GET /api/users/{id} for a missing row — the handler runs a real SELECT,
  // finds nothing, and takes the 404 error path (not just a 200 stub).
  {
    const { statusCode, body } = await invokeHandler(getByIdHandler, { params: { id: "9999" } });
    assert("GET-by-id 404s for a missing row off the wire", statusCode === 404, String(statusCode));
    assert("GET-by-id 404 body carries error + statusCode",
      body?.error === "Not Found" && body?.statusCode === 404,
      JSON.stringify(body));
  }

  closeDatabase();
})();

// --- Soft delete model ---
console.log("\n--- Soft Delete Model ---");

const softDeleteModel: DiscoveredModel = {
  filePath: "src/models/Post.ts",
  definition: {
    tableName: "posts",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "string", required: true },
    },
    softDelete: true,
  },
};

const softRoutes = generateCrudRoutes([softDeleteModel]);
assert("Soft delete model generates 5 routes", softRoutes.length === 5);

// --- Table filter model ---
console.log("\n--- Table Filter Model ---");

const filteredModel: DiscoveredModel = {
  filePath: "src/models/Active.ts",
  definition: {
    tableName: "items",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      status: { type: "string" },
    },
    tableFilter: "status = 'active'",
  },
};

const filteredRoutes = generateCrudRoutes([filteredModel]);
assert("Table filter model generates 5 routes", filteredRoutes.length === 5);

// --- Custom primary key ---
console.log("\n--- Custom Primary Key ---");

const customPkModel: DiscoveredModel = {
  filePath: "src/models/Custom.ts",
  definition: {
    tableName: "custom_items",
    fields: {
      item_id: { type: "integer", primaryKey: true, autoIncrement: true },
      label: { type: "string" },
    },
  },
};

const customPkRoutes = generateCrudRoutes([customPkModel]);
assert("Custom PK model generates correct routes", customPkRoutes.length === 5);
assert("Base path uses table name", customPkRoutes.some(r => r.pattern === "/api/custom_items"));

// Clean up the temp SQLite directory created for the real-DB handler tests.
rmSync(tmpDir, { recursive: true, force: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

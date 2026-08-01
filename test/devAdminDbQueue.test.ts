/**
 * Real end-to-end test for the dev-admin DB + Queue parity fixes.
 * Run with: npx tsx test/devAdminDbQueue.test.ts
 *
 * NO MOCKS. This boots the ACTUAL Tina4 dev server (TINA4_DEBUG=true) on a
 * unique high port, against a scaffolded project directory that holds:
 *   - a REAL sqlite database with a real `widget` table + rows, and
 *   - a REAL persisted queue job on disk (data/queue/emails/*.queue-data),
 *     enqueued through the real file-backed Queue.
 *
 * It then hits the live HTTP endpoints and asserts:
 *   GET /__dev/api/table?name=widget         → real columns + real sample rows
 *   GET /__dev/api/queue?topic=emails        → the on-disk persisted job shows
 *   GET /__dev/api/queue/dead-letters        → real (empty) dead-letter store
 *   GET/POST /__dev/api/grounding/*          → self-contained .env token round-trip
 *   plus the negative paths (missing name, unknown table).
 *
 * Regression target: before the fix, /table always returned
 * {columns:[],rows:[],message:"Database not connected or table not found"}
 * and /queue read only the empty in-memory DevQueue.
 */
import { rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { freePort } from "./freePort.ts";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
    failed++;
  }
}

// An OS-assigned ephemeral port so parallel/re-runs never collide. A random
// pick is not a reservation — it can collide with anything, including itself.
const PORT = await freePort();
const scaffold = join(tmpdir(), `tina4-devadmin-parity-${Date.now()}-${process.pid}`);
const originalCwd = process.cwd();

function httpGetJson(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: PORT, path, timeout: 5000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(body); } catch { /* leave null */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("request timeout")); });
  });
}

function httpPostJson(path: string, payload: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path, method: "POST", timeout: 5000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(body); } catch { /* leave null */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("request timeout")); });
    req.write(data);
    req.end();
  });
}

async function main(): Promise<void> {
  mkdirSync(join(scaffold, "data"), { recursive: true });
  process.chdir(scaffold);

  // Real environment for a dev-mode boot. Set BEFORE importing the framework
  // so DevAdmin.isEnabled() reads TINA4_DEBUG at register time.
  process.env.TINA4_DEBUG = "true";
  process.env.TINA4_LOG_LEVEL = "ERROR";
  process.env.TINA4_SUPPRESS = "true"; // quiet the ASCII banner
  process.env.TINA4_DATABASE_URL = `sqlite:///${join(scaffold, "data", "app.db")}`;
  process.env.TINA4_HOST_NAME = `localhost:${PORT}`;
  // Clean grounding baseline — ignore any ambient token from the real shell so
  // the self-contained .env round-trip below starts unconfigured.
  delete process.env.TINA4_MCP_TOKEN;
  delete process.env.TINA4_MCP_URL;

  const { startServer, Queue } = await import("../packages/core/src/index.ts");
  const { initDatabase, getAdapter, closeDatabase } = await import("../packages/orm/src/index.ts");

  // ── Real database: create a table + rows through the real adapter ──
  await initDatabase({ url: process.env.TINA4_DATABASE_URL });
  const db = getAdapter();
  db.execute(
    "CREATE TABLE widget (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL)",
  );
  db.execute("INSERT INTO widget (name, price) VALUES ('Sprocket', 9.99)");
  db.execute("INSERT INTO widget (name, price) VALUES ('Cog', 4.50)");

  // ── Real persisted queue job on disk (file-backed LiteBackend) ──
  const queue = new Queue({ topic: "emails" });
  const jobId = queue.push({ to: "user@example.com", subject: "Welcome" });

  // ── Boot the real server ──
  const server = await startServer({ port: PORT, host: "127.0.0.1" });

  try {
    // 1. GET /table — real columns + real sample rows (positive).
    {
      const { status, json } = await httpGetJson("/__dev/api/table?name=widget");
      assert("GET /table 200", status === 200, `status=${status}`);
      const colNames = Array.isArray(json?.columns) ? json.columns.map((c: any) => c.name) : [];
      assert("GET /table returns real columns", colNames.includes("id") && colNames.includes("name") && colNames.includes("price"),
        JSON.stringify(colNames));
      assert("GET /table columns carry types", (json?.columns?.[0]?.type ?? "") !== "", JSON.stringify(json?.columns?.[0]));
      assert("GET /table returns real rows", Array.isArray(json?.rows) && json.rows.length === 2, `rows=${JSON.stringify(json?.rows)}`);
      assert("GET /table row content is real", json?.rows?.some((r: any) => r.name === "Sprocket" && Number(r.price) === 9.99),
        JSON.stringify(json?.rows));
      assert("GET /table count matches", json?.count === 2, `count=${json?.count}`);
      assert("GET /table is no longer the inert stub", (json?.message ?? "") !== "Database not connected or table not found");
    }

    // 2. GET /table with no name (negative).
    {
      const { json } = await httpGetJson("/__dev/api/table");
      assert("GET /table missing name → error", typeof json?.error === "string" && json.error.length > 0, JSON.stringify(json));
    }

    // 3. GET /table for a nonexistent table (negative).
    {
      const { json } = await httpGetJson("/__dev/api/table?name=does_not_exist");
      assert("GET /table unknown table → empty + message",
        Array.isArray(json?.columns) && json.columns.length === 0 && Array.isArray(json?.rows) && json.rows.length === 0 && !!json?.message,
        JSON.stringify(json));
    }

    // 4. GET /queue — the on-disk persisted job shows (positive; core fix).
    {
      const { status, json } = await httpGetJson("/__dev/api/queue?topic=emails");
      assert("GET /queue 200", status === 200, `status=${status}`);
      const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
      const mine = jobs.find((j: any) => j.id === jobId);
      assert("GET /queue shows the on-disk persisted job", !!mine, `jobId=${jobId} jobs=${JSON.stringify(jobs)}`);
      assert("GET /queue job carries real payload", mine?.data?.to === "user@example.com" && mine?.data?.subject === "Welcome",
        JSON.stringify(mine));
      assert("GET /queue job status is pending", mine?.status === "pending", JSON.stringify(mine));
      assert("GET /queue stats reflect the persisted pending job", Number(json?.stats?.pending) >= 1, JSON.stringify(json?.stats));
    }

    // 5. GET /queue for an empty topic → real store, no ghost jobs (negative).
    {
      const { json } = await httpGetJson("/__dev/api/queue?topic=nonexistent");
      assert("GET /queue empty topic → no jobs", Array.isArray(json?.jobs) && json.jobs.length === 0, JSON.stringify(json?.jobs));
      assert("GET /queue empty topic → zero pending", Number(json?.stats?.pending) === 0, JSON.stringify(json?.stats));
    }

    // 6. GET /queue/dead-letters — real (empty) file-backed dead-letter store.
    {
      const { status, json } = await httpGetJson("/__dev/api/queue/dead-letters?topic=emails");
      assert("GET /queue/dead-letters 200", status === 200, `status=${status}`);
      assert("GET /queue/dead-letters returns a real array", Array.isArray(json?.jobs) && json.count === json.jobs.length,
        JSON.stringify(json));
    }

    // 7. Grounding — self-contained .env round-trip (no Rust agent). Baseline
    //    unconfigured, save flips it and writes .env, clear removes it.
    const envPath = join(scaffold, ".env");
    {
      const { status, json } = await httpGetJson("/__dev/api/grounding/status");
      assert("GET /grounding/status 200", status === 200, `status=${status}`);
      assert("grounding baseline unconfigured", json?.configured === false, JSON.stringify(json));
      assert("grounding baseline last4 empty", json?.last4 === "", JSON.stringify(json));
      assert("grounding default url", json?.url === "https://mcp.tina4.com", JSON.stringify(json));
    }
    {
      const { status, json } = await httpPostJson("/__dev/api/grounding/token", { token: "wxyz1234" });
      assert("POST /grounding/token 200", status === 200, `status=${status}`);
      assert("token save reports configured", json?.ok === true && json?.configured === true, JSON.stringify(json));
      assert("token save reports last4", json?.last4 === "1234", JSON.stringify(json));
      assert("token persisted to .env", existsSync(envPath) && readFileSync(envPath, "utf-8").includes("TINA4_MCP_TOKEN=wxyz1234"),
        existsSync(envPath) ? readFileSync(envPath, "utf-8") : "(no .env)");
    }
    {
      const { json } = await httpGetJson("/__dev/api/grounding/status");
      assert("grounding status flips to configured", json?.configured === true && json?.last4 === "1234", JSON.stringify(json));
    }
    {
      const { json } = await httpPostJson("/__dev/api/grounding/token", { token: "" });
      assert("empty token clears configured", json?.configured === false && json?.last4 === "", JSON.stringify(json));
      const envBody = readFileSync(envPath, "utf-8");
      assert("cleared .env keeps empty key", /^TINA4_MCP_TOKEN=\s*$/m.test(envBody), envBody);
    }
  } finally {
    server.close();
    try { closeDatabase(); } catch { /* ignore */ }
    process.chdir(originalCwd);
    try { rmSync(scaffold, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  // Best-effort cleanup on hard failure.
  try { process.chdir(originalCwd); } catch { /* ignore */ }
  try { rmSync(scaffold, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\nResults: ${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});

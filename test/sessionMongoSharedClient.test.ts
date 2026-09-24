/**
 * The MongoDB session backend reuses ONE client per process
 * (tina4-python#136 parity lock-in).
 *
 * THE PYTHON DEFECT: with TINA4_SESSION_BACKEND=mongodb every request builds a
 * Session, every Session resolves a NEW handler, and each handler created a NEW
 * pymongo MongoClient (its own monitor threads and pool) that was never closed.
 * Threads and server connections grew with every request.
 *
 * NODE IS NOT AFFECTED. A new MongoSessionHandler per Session holds only
 * configuration; every command goes through mongoCommandSync(), which asks
 * syncBridge.getBridge() for the worker keyed by host:port:database:collection.
 * That worker is created once per process and builds its MongoClient once, on
 * the first command, then reuses it (it is dropped and rebuilt only after a
 * transport error).
 *
 * WHAT IS MEASURED: this process's own ESTABLISHED TCP connections to the Mongo
 * port, read from the kernel (/proc/self/net/tcp{,6} joined to the socket inodes
 * in /proc/self/fd). The worker thread shares the process's descriptor table, so
 * every connection the session backend opens is counted, and nothing another
 * process does to the shared lab Mongo can move the number.
 *
 * NO MOCKS: a REAL startServer() with the mongodb session backend against a REAL
 * MongoDB, real HTTP requests, and a real MongoClient for the control case.
 *
 * Same case names in all four frameworks:
 *   - mongo_session_requests_reuse_one_client
 *   - mongo_session_round_trips_through_the_shared_client
 *   - connection_probe_sees_a_new_client (control: the instrument can see growth)
 *
 * Run with: npx tsx test/sessionMongoSharedClient.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import { closeBridges } from "../packages/core/src/sessionHandlers/syncBridge.js";
import http from "node:http";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const MONGO_HOST = process.env.TINA4_TEST_MONGO_HOST ?? "127.0.0.1";
const MONGO_PORT = parseInt(process.env.TINA4_TEST_MONGO_PORT ?? "27017", 10);
const DATABASE = "tina4_issue136_node";
const COLLECTION = `sessions_${process.pid}`;
const REQUESTS = 40;

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

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolveReach) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolveReach(ok); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/** ESTABLISHED connections from THIS process to the Mongo port, per the kernel. */
function mongoConnections(): number {
  const inodes = new Set<string>();
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      const m = target.match(/^socket:\[(\d+)\]$/);
      if (m) inodes.add(m[1]);
    } catch { /* fd closed while we looked */ }
  }
  const portHex = MONGO_PORT.toString(16).toUpperCase().padStart(4, "0");
  let count = 0;
  for (const table of ["/proc/self/net/tcp", "/proc/self/net/tcp6"]) {
    if (!existsSync(table)) continue;
    for (const line of readFileSync(table, "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const remotePort = cols[2].split(":")[1];
      const state = cols[3];
      if (remotePort === portHex && state === "01" && inodes.has(cols[9])) count++;
    }
  }
  return count;
}

console.log("=== MongoDB session backend reuses one client (tina4-python#136 parity) ===\n");

if (!existsSync("/proc/self/net/tcp")) {
  console.log("  \x1b[33mSKIP\x1b[0m connection count needs the Linux /proc filesystem (runs on the lab and CI)");
  console.log(`\n  Results: 0 passed, 0 failed, 1 skipped\n`);
  process.exit(0);
}

if (!(await reachable(MONGO_HOST, MONGO_PORT))) {
  assert("mongo_session_requests_reuse_one_client", false, `mongo not reachable at ${MONGO_HOST}:${MONGO_PORT}`);
  process.exit(1);
}

const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-mongo-shared-client-"));
const PORT = await freePort();

mkdirSync(join(TEST_DIR, "src/routes/visit"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/visit/get.ts"), `
export default async function (req: any, res: any) {
  const visits = Number(req.session.get("visits") ?? 0) + 1;
  req.session.set("visits", visits);
  return res.json({ visits });
}
`);

process.env.TINA4_SESSION_BACKEND = "mongodb";
process.env.TINA4_SESSION_MONGO_HOST = MONGO_HOST;
process.env.TINA4_SESSION_MONGO_PORT = String(MONGO_PORT);
process.env.TINA4_SESSION_MONGO_DB = DATABASE;
process.env.TINA4_SESSION_MONGO_COLLECTION = COLLECTION;
delete process.env.TINA4_SESSION_MONGO_URI;
delete process.env.TINA4_SESSION_MONGO_URL;
delete process.env.TINA4_MONGO_FORCE_RAW;
process.env.TINA4_DEBUG = "false";
process.env.TINA4_RATE_LIMIT = "100000";

function visit(cookie = ""): Promise<{ status: number; cookie: string; visits: number }> {
  return new Promise((resolveVisit, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path: "/visit", method: "GET", headers: cookie ? { Cookie: cookie } : {} },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          const raw = res.headers["set-cookie"];
          const set = (Array.isArray(raw) ? raw : raw ? [raw] : [])
            .map((c) => c.split(";")[0]).find((c) => c.startsWith("tina4_session=")) ?? "";
          let visits = NaN;
          try { visits = Number(JSON.parse(data).visits); } catch { /* not JSON */ }
          resolveVisit({ status: res.statusCode ?? 0, cookie: set, visits });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const server = await startServer({ port: PORT, basePath: TEST_DIR });
const { MongoClient } = await import("mongodb");

try {
  const before = mongoConnections();

  // Warm the backend: the first session command builds the one client.
  const first = await visit();
  const warm = mongoConnections();

  // Every further request is a NEW visitor, so every one builds a new Session
  // and a new handler - the exact per-request shape Python leaked a client on.
  const statuses: number[] = [];
  for (let i = 0; i < REQUESTS; i++) statuses.push((await visit()).status);
  const after = mongoConnections();

  assert("mongo_session_requests_reuse_one_client (every request served)", first.status === 200 && statuses.every((s) => s === 200),
    `statuses=${JSON.stringify([first.status, ...statuses])}`);
  assert("mongo_session_requests_reuse_one_client (the backend did connect)", warm > before,
    `before=${before} after warm-up=${warm}`);
  assert(`mongo_session_requests_reuse_one_client (no growth over ${REQUESTS} new sessions)`, after <= warm,
    `after warm-up=${warm} after ${REQUESTS} more requests=${after}`);

  // The shared client really carries the sessions: a replayed cookie resumes.
  const again = await visit(first.cookie);
  const third = await visit(first.cookie);
  assert("mongo_session_round_trips_through_the_shared_client", again.visits === 2 && third.visits === 3,
    `visits: first=${first.visits} replay=${again.visits} replay2=${third.visits}`);

  // CONTROL: the instrument must be able to see a new client, or a flat count
  // would prove nothing.
  const baseline = mongoConnections();
  const extra = new MongoClient(`mongodb://${MONGO_HOST}:${MONGO_PORT}/?directConnection=true`);
  await extra.connect();
  await extra.db(DATABASE).command({ ping: 1 });
  const withExtra = mongoConnections();
  assert("connection_probe_sees_a_new_client", withExtra > baseline, `baseline=${baseline} with extra client=${withExtra}`);

  // Clean up the database this suite created.
  await extra.db(DATABASE).dropDatabase();
  await extra.close();
} finally {
  server.close();
  closeBridges();
  for (const key of ["TINA4_SESSION_BACKEND", "TINA4_SESSION_MONGO_HOST", "TINA4_SESSION_MONGO_PORT",
    "TINA4_SESSION_MONGO_DB", "TINA4_SESSION_MONGO_COLLECTION", "TINA4_RATE_LIMIT"]) delete process.env[key];
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

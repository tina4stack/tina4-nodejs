/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * PostgreSQL: a connection the server drops is replaced, not reused forever
 * (parity with the Python master #236/#242; issue #244).
 *
 * BUG (pre-fix): the Node adapter never re-established a dropped PostgreSQL
 * link. pg's Client emits an async 'error' event when the server closes the
 * connection (failover, idle reap, pg_terminate_backend); with no listener Node
 * threw it as an uncaught exception and crashed the process, and even caught,
 * every later statement failed until a restart.
 *
 * FIX: connect() absorbs the 'error' event and marks the link dead; runQuery()
 * rebuilds a dead link BEFORE opening a query on it, and on a connection error
 * reconnects and retries once when nothing uncommitted went down with it (never
 * inside an explicit transaction). A reconnect that itself fails leaves the link
 * dead, so the NEXT statement retries and recovers once a server returns (#242).
 *
 * NO MOCKS — a REAL PostgreSQL. The drop is a real pg_terminate_backend from a
 * second connection; the failed reconnect aims the adapter's own connect target
 * at a dead port (what a failover looks like before the new primary answers).
 * Env-gated like the other pg tests; skips cleanly when no PostgreSQL is reachable.
 *
 * Run with: npx tsx test/postgresReconnect.test.ts
 */
import net from "node:net";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "5432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}
function summaryAndExit(code = 0): never {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(code);
}
function pgReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
    socket.connect(PG_PORT, PG_HOST, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

console.log("=== PostgreSQL reconnect after a dropped link (#244) ===\n");

if (!(await pgReachable())) {
  console.log(`  \x1b[33mSKIP\x1b[0m PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} — skipping [needs:postgres]`);
  summaryAndExit(0);
}
try { await import("pg"); } catch {
  console.log(`  \x1b[33mSKIP\x1b[0m 'pg' package not installed — npm install pg`);
  summaryAndExit(0);
}

const { PostgresAdapter } = await import("../packages/orm/src/adapters/postgres.ts");
const URL = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;
const TABLE = "t4_pg_reconnect";

async function newAdapter() { const a = new PostgresAdapter(URL); await a.connect(); return a; }
async function pid(a: InstanceType<typeof PostgresAdapter>): Promise<number> {
  return Number((await a.queryAsync<{ p: number }>("SELECT pg_backend_pid() AS p"))[0].p);
}

const observer = await newAdapter();
const tested = await newAdapter();
try {
  await observer.executeAsync(`DROP TABLE IF EXISTS ${TABLE}`);
  await observer.executeAsync(`CREATE TABLE ${TABLE} (id SERIAL PRIMARY KEY, note TEXT)`);

  // ── 1. #236 — a dropped link is replaced and the statement recovers ─────
  {
    const before = await pid(tested);
    await observer.executeAsync("SELECT pg_terminate_backend(?)", [before]);
    await tested.executeAsync(`INSERT INTO ${TABLE} (note) VALUES (?)`, ["after-drop"]);
    const after = await pid(tested);
    assert("a dropped link reconnects on the next statement", after !== before, `pid ${before}->${after}`);
    const rows = await observer.queryAsync<{ note: string }>(`SELECT note FROM ${TABLE} ORDER BY id`);
    assert("the write after the drop landed exactly once", rows.length === 1 && rows[0].note === "after-drop",
      JSON.stringify(rows));
  }

  // ── 2. #242 — a reconnect that itself fails does not wedge the adapter ───
  {
    const good = (tested as unknown as { config: string }).config;
    const deadPort = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:1/${PG_DB}`;
    (tested as unknown as { config: string }).config = deadPort; // new primary not up yet
    await observer.executeAsync("SELECT pg_terminate_backend(?)", [await pid(tested)]);

    let firstFailed = false, secondFailed = false;
    try { await tested.executeAsync(`INSERT INTO ${TABLE} (note) VALUES (?)`, ["x"]); } catch { firstFailed = true; }
    try { await tested.executeAsync(`INSERT INTO ${TABLE} (note) VALUES (?)`, ["x"]); } catch { secondFailed = true; }
    assert("a failed reconnect surfaces as an error (not a crash)", firstFailed && secondFailed);

    (tested as unknown as { config: string }).config = good; // the new primary is reachable now
    await tested.executeAsync(`INSERT INTO ${TABLE} (note) VALUES (?)`, ["after-failed-reconnect"]);
    const rows = await observer.queryAsync<{ note: string }>(`SELECT note FROM ${TABLE} WHERE note = 'after-failed-reconnect'`);
    assert("the adapter recovers once a reachable server returns", rows.length === 1);
  }
} finally {
  try { await observer.executeAsync(`DROP TABLE IF EXISTS ${TABLE}`); } catch { /* best effort */ }
  observer.close();
  tested.close();
}
summaryAndExit(fail === 0 ? 0 : 1);

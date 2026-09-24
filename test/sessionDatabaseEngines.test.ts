/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * SESSION CONTRACT: the database backend works on every engine it claims.
 * Run with: npx tsx test/sessionDatabaseEngines.test.ts
 *
 * ADR-0024's founding scenario, in the subsystem that decides whether anyone is
 * logged in: develop on sqlite, deploy on postgres, and the app does not start.
 * ADR-0028 records the decision and, more usefully, records the WRONG PREMISE
 * that nearly froze it - see that ADR before changing anything here.
 *
 * MEASURED at v3 HEAD: resolveDbPath() THREW on any non-sqlite
 * TINA4_DATABASE_URL, and two assertions in sessionExpiryContract.test.ts
 * pinned that throw. The backend now follows the CONFIGURED connection on
 * sqlite, postgres, mysql, mssql and firebird, riding the SAME syncBridge that
 * RESP, memcached and MongoDB already use - no second bridge was built,
 * because the first one already existed with four consumers.
 *
 * WHAT THE OLD THROW WAS REALLY PROTECTING, and what is still asserted here:
 * before it, resolveDbPath() stripped a `sqlite://` prefix and otherwise
 * returned the literal "data/tina4_sessions.db", so a postgres URL round-tripped
 * happily while writing SQLite files into the process cwd. Every horizontally
 * scaled instance then had its own private session store and a user was logged
 * out on every request that landed elsewhere - an outage that looks exactly like
 * success. Case 3 is that guard, kept.
 *
 * NO MOCKS. Real PostgreSQL 16, real MySQL 8, real SQLite files, and - when the
 * lab exports TINA4_TEST_FIREBIRD_URL - a real Firebird 5, every round trip
 * verified OUT OF BAND through a connection this test owns rather than through
 * the handler that wrote it.
 *
 * FIREBIRD EARNS ITS PLACE in the list, not just fills it out: it is the one
 * engine with NO TEXT type (its payload column is VARCHAR(8191)) AND the one
 * that folds unquoted identifiers to UPPER, so it is the only engine that
 * exercises BOTH the per-engine CREATE TABLE branch and the case-insensitive
 * column() read path - the two places databaseHandler.ts special-cases it. It
 * is gated on TINA4_TEST_FIREBIRD_URL: unset in CI (which provisions no
 * Firebird), set on the lab. So CI still runs sqlite+postgres+mysql and the lab
 * runs all four - the ran.length >= 3 floor below holds either way.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";

import { DatabaseSessionHandler } from "../packages/core/src/sessionHandlers/databaseHandler.js";
import { sqlCommandSync } from "../packages/core/src/sessionHandlers/sqlClient.js";
import type { SqlTarget } from "../packages/core/src/sessionHandlers/sqlClient.js";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function skipLoudly(name: string, reason: string): void {
  if (process.env.TINA4_REQUIRE_SERVICES) {
    assert(name, false, `TINA4_REQUIRE_SERVICES is set but ${reason}`);
    return;
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} - ${reason}`);
  skipped++;
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection({ host, port });
    probe.setTimeout(2500);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
    probe.once("timeout", () => { probe.destroy(); resolve(false); });
  });
}

const PG_URL = `postgres://${process.env.TINA4_TEST_PG_USERNAME ?? "tina4"}:`
  + `${process.env.TINA4_TEST_PG_PASSWORD ?? "tina4"}@`
  + `${process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1"}:`
  + `${process.env.TINA4_TEST_PG_PORT ?? "55432"}/tina4_node`;
// The database name must be the CONFIGURED one (TINA4_TEST_MYSQL_DB, same
// default "tina4_test" every sibling suite uses), not a bare "tina4" — CI's
// MySQL user is scoped to "tina4_test" only (GRANT ALL ON tina4_test.* TO
// tina4@%), so a hardcoded "tina4" fails "Access denied ... to database
// 'tina4'" there. It only ever worked on the lab because the lab's MySQL
// creds default to root (a superuser, any database), masking the mismatch.
const MYSQL_URL = `mysql://${process.env.TINA4_TEST_MYSQL_USERNAME ?? "root"}:`
  + `${process.env.TINA4_TEST_MYSQL_PASSWORD ?? "tina4"}@127.0.0.1:3306/`
  + `${process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test"}`;
// Firebird carries its whole target in ONE URL (the lab exports it), not a
// host/port pair like PG/MySQL, so the reachability probe parses host + port
// straight out of it below. Unset off the lab -> the Firebird engine row is
// never added, and the loop sees exactly sqlite+postgres+mysql.
const FB_URL = process.env.TINA4_TEST_FIREBIRD_URL;

const MSSQL_HOST = process.env.TINA4_TEST_MSSQL_HOST ?? "127.0.0.1";
const MSSQL_PORT = Number(process.env.TINA4_TEST_MSSQL_PORT ?? 1433);

const originalUrl = process.env.TINA4_DATABASE_URL;
const originalUsername = process.env.TINA4_DATABASE_USERNAME;
const originalPassword = process.env.TINA4_DATABASE_PASSWORD;
const originalCwd = process.cwd();

type RaceScenario = {
  name: string;
  url: string;
  username?: string;
  password?: string;
  workers: number;
  holdNamedLock?: boolean;
};

/** Point the env at one engine, the way an app's .env does. */
function pointAt(scenario: RaceScenario): void {
  process.env.TINA4_DATABASE_URL = scenario.url;
  if (scenario.username === undefined) delete process.env.TINA4_DATABASE_USERNAME;
  else process.env.TINA4_DATABASE_USERNAME = scenario.username;
  if (scenario.password === undefined) delete process.env.TINA4_DATABASE_PASSWORD;
  else process.env.TINA4_DATABASE_PASSWORD = scenario.password;
}

/**
 * Run a statement on this process's OWN connection to the scenario's engine -
 * independent of every racing worker. SQLite is opened directly.
 */
function runOutOfBand(scenario: RaceScenario, sql: string): Record<string, unknown>[] {
  if (scenario.url.startsWith("sqlite:")) {
    const connection = new DatabaseSync(scenario.url.replace(/^sqlite:(\/\/)?/, ""));
    try {
      return connection.prepare(sql).all() as Record<string, unknown>[];
    } finally {
      connection.close();
    }
  }
  pointAt(scenario);
  const target = (new DatabaseSessionHandler() as unknown as { target: SqlTarget }).target;
  return sqlCommandSync(target, sql, []);
}

function dropSessionTable(scenario: RaceScenario): void {
  try {
    runOutOfBand(scenario, "DROP TABLE tina4_session");
  } catch { /* absent already - which is the state the race needs */ }
}

/**
 * CASE 4. Every app that starts more than one process races to create
 * tina4_session on first use, and the loser must not take a request down. PHP
 * has always run this race with real processes; Node had no such case, and
 * MEASURED on the lab before the fix, six processes lost one to five of them on
 * PostgreSQL, SQLite and Firebird (no rescue after the CREATE), and on SQL
 * Server whenever two landed inside the IF OBJECT_ID window.
 *
 * MySQL runs twice. The second pass holds a named lock in every worker: MySQL
 * backs the loser of the metadata-lock deadlock inside CREATE TABLE IF NOT
 * EXISTS off silently only when the session holds no other metadata lock, so
 * without one the losing path is reached rarely (tina4-php CI run 35972320442)
 * and with one it is reached every run.
 */
async function concurrentFirstUse(workDir: string): Promise<void> {
  const name = "concurrent_first_use_is_safe_with_real_processes_on_every_engine";
  if (!(await reachable(MSSQL_HOST, MSSQL_PORT))) {
    skipLoudly(name, `mssql is not reachable at ${MSSQL_HOST}:${MSSQL_PORT}`);
    return;
  }
  const mysqlDb = process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test";
  const mysqlUser = process.env.TINA4_TEST_MYSQL_USERNAME ?? "root";
  const mysqlPass = process.env.TINA4_TEST_MYSQL_PASSWORD ?? "tina4";
  const scenarios: RaceScenario[] = [
    { name: "sqlite", url: `sqlite://${join(workDir, "race.db")}`, workers: 6 },
    { name: "postgres", url: PG_URL, workers: 6 },
    { name: "mysql", url: `mysql://127.0.0.1:3306/${mysqlDb}`, username: mysqlUser, password: mysqlPass, workers: 6 },
    { name: "mysql+named-lock", url: `mysql://127.0.0.1:3306/${mysqlDb}`, username: mysqlUser,
      password: mysqlPass, workers: 12, holdNamedLock: true },
    { name: "mssql", url: `mssql://${MSSQL_HOST}:${MSSQL_PORT}/${process.env.TINA4_TEST_MSSQL_DB ?? "tina4_test"}`,
      username: process.env.TINA4_TEST_MSSQL_USERNAME ?? "sa",
      password: process.env.TINA4_TEST_MSSQL_PASSWORD ?? "TinaSQL123!Secure", workers: 6 },
  ];
  if (FB_URL) scenarios.push({ name: "firebird", url: FB_URL, workers: 6 });

  const workerScript = join(import.meta.dirname, "fixtures", "sessionConcurrentFirstUse.ts");
  const tsx = join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");
  const survived: string[] = [];
  const failures: string[] = [];

  for (const scenario of scenarios) {
    try {
      dropSessionTable(scenario);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TINA4_DATABASE_URL: scenario.url,
        TINA4_DATABASE_USERNAME: scenario.username ?? "",
        TINA4_DATABASE_PASSWORD: scenario.password ?? "",
        T4_RACE_HOLD_NAMED_LOCK: scenario.holdNamedLock ? "1" : "",
      };
      if (scenario.username === undefined) delete env.TINA4_DATABASE_USERNAME;
      if (scenario.password === undefined) delete env.TINA4_DATABASE_PASSWORD;
      // Enough lead for every worker to boot tsx and CONNECT first - a worker
      // still connecting is not in the race.
      const startAt = (Date.now() / 1000 + 6).toFixed(3);
      const exits = await Promise.all(Array.from({ length: scenario.workers }, (_, index) =>
        new Promise<string | null>((resolveExit) => {
          const child = spawn(tsx, [workerScript, startAt, `race-${scenario.name}-${index}`],
            { env, stdio: ["ignore", "ignore", "pipe"] });
          let errorOutput = "";
          child.stderr.on("data", (chunk) => { errorOutput += String(chunk); });
          child.on("close", (code) => resolveExit(code === 0
            ? null
            : `${scenario.name} worker ${index} exited ${code}: ${errorOutput.trim().slice(-300)}`));
        })));
      failures.push(...exits.filter((exit): exit is string => exit !== null));

      // OUT OF BAND on this process's own connection: a worker that swallowed
      // its own failure would otherwise look exactly like one that wrote.
      const row = runOutOfBand(scenario, "SELECT COUNT(*) AS n FROM tina4_session")[0] ?? {};
      const rows = Number(Object.values(row)[0] ?? -1);
      if (rows === scenario.workers) survived.push(scenario.name);
      else failures.push(`${scenario.name} ended the race with ${rows} of ${scenario.workers} rows`);
    } catch (err) {
      failures.push(`${scenario.name} (${String((err as Error).message).slice(0, 200)})`);
    } finally {
      dropSessionTable(scenario);
    }
  }

  assert(
    name,
    failures.length === 0 && survived.length === scenarios.length,
    failures.length
      ? `concurrent first use is NOT safe on: ${failures.join("; ")}`
      : `the race did not run on every engine (ran: ${survived.join(", ")})`,
  );
  console.log(`     concurrent first use survived on: ${survived.join(", ")}`);
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "tina4-engines-"));

  try {
    // -- 1. every engine it claims ------------------------------------------
    console.log("\n-- 1. a real round trip on every engine, verified out of band --\n");

    const engines: Array<[string, string, () => Promise<boolean>]> = [
      ["sqlite", `sqlite://${join(workDir, "engines.db")}`, async () => true],
      ["postgres", PG_URL, () => reachable(process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1",
        Number(process.env.TINA4_TEST_PG_PORT ?? 55432))],
      ["mysql", MYSQL_URL, () => reachable("127.0.0.1", 3306)],
    ];
    // Firebird only when the lab exports its URL. Its whole target lives in the
    // one URL, so the reachability probe parses host+port straight out of it.
    if (FB_URL) {
      const fb = FB_URL.match(/^firebird:\/\/(?:[^@]*@)?([^:/]+):(\d+)/);
      const fbHost = fb?.[1] ?? "127.0.0.1";
      const fbPort = Number(fb?.[2] ?? 3050);
      engines.push(["firebird", FB_URL, () => reachable(fbHost, fbPort)]);
    }

    const broken: string[] = [];
    const ran: string[] = [];
    for (const [name, url, isUp] of engines) {
      if (!(await isUp())) {
        skipLoudly("the_database_session_backend_works_on_every_engine_it_claims",
          `${name} is not reachable`);
        return;
      }
      const sessionId = `engine-${name}-${Math.random().toString(16).slice(2, 10)}`;
      try {
        process.env.TINA4_DATABASE_URL = url;
        const writer = new DatabaseSessionHandler();
        writer.write(sessionId, { seeded: true, engine: name }, 60);

        // A FRESH handler, so nothing in-process can be answering from memory.
        const reader = new DatabaseSessionHandler();
        const got = reader.read(sessionId);
        const roundTripped = JSON.stringify(got) === JSON.stringify({ seeded: true, engine: name });
        if (!roundTripped) broken.push(`${name} (read ${JSON.stringify(got)})`);
        else ran.push(name);
        reader.destroy(sessionId);
      } catch (err) {
        broken.push(`${name} (${String((err as Error).message).slice(0, 90)})`);
      }
    }

    assert(
      "the_database_session_backend_works_on_every_engine_it_claims",
      broken.length === 0 && ran.length >= 3,
      broken.length
        ? `these engines did NOT work: ${broken.join("; ")}`
        : `only ${ran.length} engine(s) ran (${ran.join(", ")}) - one engine passing is not the invariant`,
    );
    console.log(`     engines exercised: ${ran.join(", ")}`);

    // -- 2. an unsupported engine refuses by name ---------------------------
    console.log("\n-- 2. what it cannot do, it refuses loudly --\n");

    let threw = false;
    let message = "";
    process.env.TINA4_DATABASE_URL = "notareal://user:pass@127.0.0.1:1234/db";
    try {
      new DatabaseSessionHandler();
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    assert(
      "an_unsupported_engine_refuses_by_name_instead_of_degrading",
      threw && message.includes("notareal"),
      `threw=${threw} message=${message} - the refusal must name the scheme it got, `
      + "or the operator cannot tell a typo from an unsupported engine",
    );

    // -- 3. never a silent local file ---------------------------------------
    console.log("\n-- 3. the anti-demotion guard the old throw existed for --\n");

    const cleanCwd = mkdtempSync(join(tmpdir(), "tina4-engines-cwd-"));
    mkdirSync(join(cleanCwd, "data"), { recursive: true });
    process.chdir(cleanCwd);

    let remoteRoundTripped = false;
    const probeId = `nolocal-${Math.random().toString(16).slice(2, 10)}`;
    try {
      process.env.TINA4_DATABASE_URL = PG_URL;
      const handler = new DatabaseSessionHandler();
      handler.write(probeId, { seeded: true }, 60);
      remoteRoundTripped = JSON.stringify(handler.read(probeId)) === JSON.stringify({ seeded: true });
      handler.destroy(probeId);
    } catch { /* recorded by the assertion below */ }

    // The whole point: a postgres session must leave NOTHING on local disk.
    const leaked = existsSync(join(cleanCwd, "data", "tina4_sessions.db"))
      || existsSync(join(cleanCwd, "data", "tina4_sessions.db-wal"))
      || existsSync(join(cleanCwd, "data", "tina4_sessions.db-shm"));

    process.chdir(originalCwd);
    assert(
      "the_database_session_backend_never_silently_uses_a_local_file",
      remoteRoundTripped && !leaked,
      `postgresRoundTripped=${remoteRoundTripped} leakedLocalSqlite=${leaked} - a silent `
      + "demotion to a local file is indistinguishable from working until users start "
      + "losing sessions across instances",
    );
    rmSync(cleanCwd, { recursive: true, force: true });

    // -- 4. concurrent first use with real processes -------------------------
    console.log("\n-- 4. real processes race to create tina4_session on every engine --\n");
    await concurrentFirstUse(workDir);
  } finally {
    process.chdir(originalCwd);
    if (originalUrl === undefined) delete process.env.TINA4_DATABASE_URL;
    else process.env.TINA4_DATABASE_URL = originalUrl;
    if (originalUsername === undefined) delete process.env.TINA4_DATABASE_USERNAME;
    else process.env.TINA4_DATABASE_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.TINA4_DATABASE_PASSWORD;
    else process.env.TINA4_DATABASE_PASSWORD = originalPassword;
    rmSync(workDir, { recursive: true, force: true });
    try {
      const { closeSyncSockets } = await import("../packages/core/src/sessionHandlers/syncSocket.js");
      closeSyncSockets();
    } catch { /* nothing to reap */ }
    try {
      const { closeBridges } = await import("../packages/core/src/sessionHandlers/syncBridge.js");
      (closeBridges as () => void)();
    } catch { /* nothing to reap */ }
  }
}

await main();

console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`
  + (skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : ""),
);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import { DatabaseSessionHandler } from "../packages/core/src/sessionHandlers/databaseHandler.js";

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

const originalUrl = process.env.TINA4_DATABASE_URL;
const originalCwd = process.cwd();

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
  } finally {
    process.chdir(originalCwd);
    if (originalUrl === undefined) delete process.env.TINA4_DATABASE_URL;
    else process.env.TINA4_DATABASE_URL = originalUrl;
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

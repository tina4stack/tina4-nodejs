/**
 * DATABASE CONTRACT: a connect attempt is BOUNDED, and it fails loudly when the
 * bound expires.
 *
 * THE DEFECT, measured 2026-08-06. The Firebird adapter awaited `fb.attach()` in
 * a bare promise with no timeout, so a driver that never calls back hung the app
 * on connect with no log, no error and no signal. A probe reproduced it exactly:
 * 16 minutes at 0.0% CPU, a process that looked alive to every health check and
 * served nothing.
 *
 * THE SHARED CONTRACT, identical in all four frameworks:
 *
 *     name:      TINA4_DATABASE_CONNECT_TIMEOUT
 *     unit:      SECONDS
 *     default:   10
 *     <= 0:      disables the bound (unbounded, the old behaviour)
 *     garbage:   warn and use 10
 *     on expiry: throw an error naming the host, the port, the elapsed seconds,
 *                and the variable that tunes it
 *
 * NO MOCKS. The block is produced by a REAL TCP server (`net.createServer`) that
 * accepts the connection and never writes a byte - the same thing a wedged
 * database does, and the same thing the original probe hit. Nothing here stands
 * in for a driver, a socket or a server: node-firebird really dials it, really
 * completes the TCP handshake, and really waits forever for a reply that is
 * never coming.
 *
 * EVERY CASE IS RACED AGAINST A TEST-SIDE DEADLINE that is far longer than the
 * configured bound. That is deliberate: without it, an unbounded connect would
 * HANG this file instead of failing it, and a hang is not a test result. The
 * deadline decides only WHO answered first.
 *
 * THE CASES, and why each is load-bearing:
 *   1. a hung server is bounded                 - the defect itself.
 *   2. the error names host, port, elapsed, var  - an operator who cannot see
 *                                                 WHICH server hung is no better
 *                                                 off than with the silent hang.
 *   3. a healthy connect still succeeds          - THE NEGATIVE CONTROL, against
 *                                                 a real PostgreSQL and a real
 *                                                 Firebird. A bound that fires
 *                                                 too eagerly breaks every
 *                                                 slow-but-healthy connect, and
 *                                                 cases 1 and 2 cannot see that.
 *   4. <= 0 really disables it                   - the documented escape hatch.
 *                                                 A bound with no way out is a
 *                                                 new hang for anyone whose
 *                                                 connect legitimately runs long.
 *   5. garbage warns and falls back to 10        - a typo must not silently
 *                                                 disable the bound (0) or set
 *                                                 it to NaN (never fires).
 */
import { createServer, type Server } from "node:net";
import { FirebirdAdapter } from "../packages/orm/src/adapters/firebird.js";
import { PostgresAdapter } from "../packages/orm/src/adapters/postgres.js";
import { MysqlAdapter } from "../packages/orm/src/adapters/mysql.js";
import { MssqlAdapter } from "../packages/orm/src/adapters/mssql.js";
import { MongodbAdapter } from "../packages/orm/src/adapters/mongodb.js";
import {
  DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS,
  connectTimeoutMillis,
} from "../packages/orm/src/connectTimeout.js";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * A REAL server that accepts and never replies.
 *
 * The sockets are kept so they can be destroyed on the way out - a connection
 * this test abandoned would otherwise keep the process alive after the last
 * assertion.
 */
function hungServer(): Promise<{ server: Server; port: number; close: () => void }> {
  const sockets: import("node:net").Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => { /* the peer going away is the expected ending */ });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

/** Race an attempt against a test-side deadline so an unbounded connect FAILS rather than hangs. */
async function raceAgainstDeadline(
  attempt: Promise<unknown>,
  deadlineMs: number,
): Promise<{ outcome: "resolved" | "rejected" | "deadline"; error?: Error; elapsedMs: number }> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  try {
    const result = await Promise.race([
      attempt.then(() => "resolved" as const, (error: Error) => ({ error })),
      deadline,
    ]);
    if (result === "deadline") return { outcome: "deadline", elapsedMs: Date.now() - startedAt };
    if (result === "resolved") return { outcome: "resolved", elapsedMs: Date.now() - startedAt };
    return { outcome: "rejected", error: result.error, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

console.log("\n== database connect timeout ==\n");

const savedTimeout = process.env.TINA4_DATABASE_CONNECT_TIMEOUT;
const hung = await hungServer();

try {
  // -- 5. resolution: garbage, valid, and the documented opt-out -------------
  //
  // A pure function over one environment variable - no dependency, no double.
  // Resolved ONCE per case and reused: the resolver warns, so calling it again
  // inside the failure message would log a second warning for one lookup.
  const resolved = (value: string | undefined): number | null => {
    setEnv("TINA4_DATABASE_CONNECT_TIMEOUT", value);
    return connectTimeoutMillis();
  };

  const whenUnset = resolved(undefined);
  assert(
    "database_connect_timeout_defaults_to_ten_seconds",
    whenUnset === DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS * 1000,
    `unset must resolve to ${DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS}s, got ${whenUnset}ms`,
  );

  const whenGarbage = resolved("banana");
  assert(
    "database_connect_timeout_garbage_warns_and_falls_back_to_ten_seconds",
    whenGarbage === DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS * 1000,
    `a non-numeric value must fall back to ${DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS}s rather than `
    + `disabling the bound or resolving to NaN (a NaN setTimeout fires immediately); got ${whenGarbage}ms`,
  );

  const whenZero = resolved("0");
  assert(
    "database_connect_timeout_zero_resolves_to_disabled",
    whenZero === null,
    `0 must mean unbounded, got ${whenZero}ms`,
  );

  const whenNegative = resolved("-5");
  assert(
    "database_connect_timeout_negative_resolves_to_disabled",
    whenNegative === null,
    `a negative value must mean unbounded, got ${whenNegative}ms`,
  );

  const whenSeven = resolved("7");
  assert(
    "database_connect_timeout_honours_a_configured_value",
    whenSeven === 7000,
    `7 seconds must resolve to 7000ms, got ${whenSeven}ms`,
  );

  // -- 1 + 2. the defect: a hung server is bounded, and says so --------------
  setEnv("TINA4_DATABASE_CONNECT_TIMEOUT", "2");
  const bounded = await raceAgainstDeadline(
    new FirebirdAdapter({
      host: "127.0.0.1",
      port: hung.port,
      database: "/tmp/tina4-connect-timeout-probe.fdb",
      user: "SYSDBA",
      password: "masterkey",
    }).connect(),
    15000,
  );

  assert(
    "database_connect_timeout_bounds_a_firebird_server_that_accepts_and_never_replies",
    bounded.outcome === "rejected",
    `connect() to a real never-replying server on 127.0.0.1:${hung.port} was still pending after `
    + `${bounded.elapsedMs}ms with TINA4_DATABASE_CONNECT_TIMEOUT=2, so the connect is unbounded - `
    + "this is the 16-minute silent hang",
  );

  const message = bounded.error?.message ?? "";
  assert(
    "database_connect_timeout_error_names_host_port_elapsed_and_the_variable",
    message.includes("127.0.0.1")
      && message.includes(String(hung.port))
      && /\d+(\.\d+)?s/.test(message)
      && message.includes("TINA4_DATABASE_CONNECT_TIMEOUT"),
    `the message must name the host, the port, the elapsed seconds and the variable that tunes it; got: ${message}`,
  );

  // -- 2b. EVERY driver-knob adapter must produce OUR message ---------------
  //
  // THE BUG THIS CATCHES, found in the mutation pass before release. With the
  // driver's own knob set to exactly the budget, the DRIVER won the race - its
  // timer starts inside connect(), a hair before withConnectTimeout arms ours -
  // and an expiring PostgreSQL connect reported pg's bare `timeout expired`. No
  // host, no port, no elapsed seconds, no variable: most of the contract gone,
  // and an operator no better off than before. The knob now carries a grace so
  // the Tina4 bound always expires first.
  //
  // Real adapters, the same real never-replying server, one case each.
  const knobAdapters: { name: string; connect: () => Promise<unknown> }[] = [
    {
      name: "postgres",
      connect: () => new PostgresAdapter({ host: "127.0.0.1", port: hung.port, database: "probe" }).connect(),
    },
    {
      name: "mysql",
      connect: () => new MysqlAdapter({ host: "127.0.0.1", port: hung.port, database: "probe" }).connect(),
    },
    {
      name: "mssql",
      connect: () => new MssqlAdapter({ host: "127.0.0.1", port: hung.port, database: "probe" }).connect(),
    },
    {
      name: "mongodb",
      connect: () => new MongodbAdapter(`mongodb://127.0.0.1:${hung.port}/probe`).connect(),
    },
  ];

  for (const adapter of knobAdapters) {
    setEnv("TINA4_DATABASE_CONNECT_TIMEOUT", "2");
    const outcome = await raceAgainstDeadline(adapter.connect(), 15000);
    const text = outcome.error?.message ?? "";
    assert(
      `database_connect_timeout_${adapter.name}_reports_the_tina4_message_not_the_drivers`,
      outcome.outcome === "rejected"
        && text.includes("127.0.0.1")
        && text.includes(String(hung.port))
        && text.includes("TINA4_DATABASE_CONNECT_TIMEOUT"),
      `the ${adapter.name} adapter ${outcome.outcome} after ${outcome.elapsedMs}ms with: "${text}". `
      + "The driver's own timeout beat the Tina4 bound, so the operator gets a bare driver message "
      + "naming no host, no port and no variable",
    );
  }

  // -- 4. NEGATIVE CONTROL: <= 0 really disables the bound ------------------
  //
  // Same real hung server. With the bound off, the attempt must STILL be pending
  // when the deadline expires. If this rejects, the escape hatch does not exist
  // and an operator whose connect legitimately runs long has no way out.
  //
  // THE DEADLINE IS 12s ON PURPOSE, past the 10s DEFAULT. At 5s this case
  // survived a mutation that made `<= 0` fall back to the default instead of
  // disabling - the deadline simply won the race first, so the case could not
  // fail and proved nothing. Past 10s, a `<= 0` that quietly resolves to the
  // default rejects at 10s and turns this red, which is the whole point of it.
  setEnv("TINA4_DATABASE_CONNECT_TIMEOUT", "0");
  const unbounded = await raceAgainstDeadline(
    new FirebirdAdapter({
      host: "127.0.0.1",
      port: hung.port,
      database: "/tmp/tina4-connect-timeout-probe.fdb",
      user: "SYSDBA",
      password: "masterkey",
    }).connect().catch((error: Error) => {
      // Swallowed here only so tearing the server down at the end of the file
      // does not surface as an unhandled rejection; the race below has already
      // recorded the outcome by then.
      throw error;
    }),
    12000,
  );
  assert(
    "database_connect_timeout_zero_leaves_the_connect_unbounded",
    unbounded.outcome === "deadline",
    `with TINA4_DATABASE_CONNECT_TIMEOUT=0 the connect must stay pending; it ${unbounded.outcome} `
    + `after ${unbounded.elapsedMs}ms (${unbounded.error?.message ?? ""})`,
  );

  // -- 3. NEGATIVE CONTROL: a healthy connect still succeeds ---------------
  //
  // Real servers, real handshakes, default bound. A timeout that fires too
  // eagerly breaks every slow-but-healthy connect, and no case above can see it.
  setEnv("TINA4_DATABASE_CONNECT_TIMEOUT", undefined);

  // ONE spelling. The test-env contract (ADR-0038) lists TINA4_TEST_PG_URL and
  // nothing else for this service; a second name here would be the fourteenth
  // spelling of a test PostgreSQL URL, which is the rot that gate exists to stop.
  const postgresUrl = process.env.TINA4_TEST_PG_URL;
  if (!postgresUrl) {
    const reason = "postgres not configured (TINA4_TEST_PG_URL)";
    if (process.env.TINA4_REQUIRE_SERVICES) {
      assert("database_connect_timeout_does_not_break_a_healthy_postgres_connect", false, reason);
    } else {
      console.log(`  \x1b[33mSKIP\x1b[0m ${reason}`);
    }
  } else {
    const adapter = new PostgresAdapter(postgresUrl);
    let connected = false;
    let why = "";
    try {
      await adapter.connect();
      connected = true;
    } catch (error) {
      why = (error as Error).message;
    } finally {
      try { adapter.close(); } catch { /* never connected */ }
    }
    assert(
      "database_connect_timeout_does_not_break_a_healthy_postgres_connect",
      connected,
      `a real PostgreSQL connect failed under the default ${DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS}s `
      + `bound: ${why}`,
    );
  }

  const firebirdUrl = process.env.TINA4_TEST_FIREBIRD_URL;
  if (!firebirdUrl) {
    const reason = "firebird not configured (TINA4_TEST_FIREBIRD_URL)";
    console.log(`  \x1b[33mSKIP\x1b[0m ${reason}`);
  } else {
    const adapter = new FirebirdAdapter(firebirdUrl);
    let connected = false;
    let why = "";
    try {
      await adapter.connect();
      connected = true;
    } catch (error) {
      why = (error as Error).message;
    } finally {
      try { adapter.close(); } catch { /* never connected */ }
    }
    assert(
      "database_connect_timeout_does_not_break_a_healthy_firebird_connect",
      connected,
      `a real Firebird connect - the adapter this change touches most - failed under the default `
      + `${DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS}s bound: ${why}`,
    );
  }
} finally {
  setEnv("TINA4_DATABASE_CONNECT_TIMEOUT", savedTimeout);
  // Reap what we spawned: destroy the abandoned sockets, then free the port.
  hung.close();
}

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m\n`);
if (fail > 0) process.exitCode = 1;

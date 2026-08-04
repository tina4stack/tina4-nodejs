/**
 * SESSION CONTRACT: a handler constructor performs NO I/O.
 * Run with: npx tsx test/sessionHandlerConstruction.test.ts
 *
 * ADR-0021: connection happens on FIRST USE, inside the log-loud-and-degrade
 * policy. A constructor sits OUTSIDE that policy, so anything it does cannot be
 * logged, cannot be degraded, and cannot be re-raised by TINA4_SESSION_STRICT.
 *
 * WHY THIS MATTERS, stated as the operator sees it: the one place the failure
 * policy cannot protect is the FIRST thing that runs. An unreachable backend
 * takes the app down at construction instead of degrading per request as
 * designed - so the very scenario the policy exists for is the one it never
 * sees. Node just closed invariant 3 by guarding handler construction on the
 * request path; this invariant removes the reason that guard has to fire.
 *
 * MEASURED at v3 HEAD, packages/core/src/sessionHandlers/databaseHandler.ts:
 *
 *     this.db = new DatabaseSync(dbPath);
 *     this.db.exec("PRAGMA journal_mode = WAL");
 *
 * Both are real work against real storage: opening the database CREATES the
 * file, and switching to WAL creates its -wal and -shm siblings. Merely
 * constructing the handler left three files on disk before a single session was
 * read or written.
 *
 * HOW THIS IS PROVED WITHOUT MOCKS. Two independent real measurements:
 *
 *   * A real TCP server this test starts, which COUNTS accepted connections.
 *     Construct a handler pointed at it and the count must still be zero; do one
 *     real operation and the count must rise. That is a direct observation of
 *     network behaviour decided by the kernel, not an assertion about code shape
 *     - a handler cannot connect without completing an accept() we can see. It
 *     speaks no protocol and pretends to be nothing, so it is a real server,
 *     not a double.
 *
 *   * For the database backend, which owns no socket, the SIDE EFFECT on a real
 *     filesystem: the database file must not exist after construction, and must
 *     exist after first use.
 *
 * The third case is the one that stops a false fix: deferring the connection
 * must not mean never connecting. Without it, "do no I/O in the constructor" is
 * trivially satisfied by a handler that does no I/O at all, and a completely
 * broken handler would pass.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import { DatabaseSessionHandler } from "../packages/core/src/sessionHandlers/databaseHandler.js";
import { RedisSessionHandler } from "../packages/core/src/session.js";
import { ValkeySessionHandler } from "../packages/core/src/sessionHandlers/valkeyHandler.js";
import { MemcachedSessionHandler } from "../packages/core/src/sessionHandlers/memcachedHandler.js";
import { MongoSessionHandler } from "../packages/core/src/sessionHandlers/mongoHandler.js";

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

/**
 * Real elapsed time that YIELDS THE EVENT LOOP. This must not be the blocking
 * Atomics.wait used elsewhere in this suite.
 *
 * The counting listener's accept callback runs on the main thread's event loop.
 * A blocking sleep therefore stops it from ever firing, and the count stays at
 * zero no matter who connected - which made case 1 pass VACUOUSLY on the first
 * run here. Case 2 is what exposed it: nothing could ever be observed to dial,
 * including a handler that definitely did.
 */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A REAL TCP server that counts the connections it accepts.
 *
 * Not a mock of a backend - it speaks no protocol and claims to be nothing. It
 * is a socket, and the only thing it reports is a fact the kernel decided:
 * whether anybody actually connected. That is exactly the question this file
 * asks, and no test double can answer it honestly.
 */
class CountingListener {
  accepted = 0;
  port = 0;
  private server: net.Server;

  constructor() {
    this.server = net.createServer((socket) => {
      this.accepted++;
      socket.destroy(); // accept, count, hang up
    });
    this.server.unref();
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  const listener = new CountingListener();
  await listener.listen();
  const workDir = mkdtempSync(join(tmpdir(), "tina4-construction-"));

  try {
    // -- 1. a session handler constructor performs no network io -------------
    console.log("\n-- 1. constructing a handler must touch nothing --\n");

    // EACH handler names its host/port differently. Redis reads redisHost /
    // redisPort; the other three read host / port. Passing the wrong key is not
    // an error - the value is simply ignored and the handler falls back to the
    // REAL service on its default port, so every construction dials something
    // this listener never sees and case 1 passes VACUOUSLY. That happened twice
    // while writing this file, and case 2 is what caught it both times.
    const socketHandlers: Array<[string, () => unknown]> = [
      ["redis", () => new RedisSessionHandler({ redisHost: "127.0.0.1", redisPort: listener.port } as any)],
      ["valkey", () => new ValkeySessionHandler({ host: "127.0.0.1", port: listener.port } as any)],
      ["memcached", () => new MemcachedSessionHandler({ host: "127.0.0.1", port: listener.port } as any)],
      ["mongodb", () => new MongoSessionHandler({ host: "127.0.0.1", port: listener.port } as any)],
    ];

    const dialledAtConstruction: string[] = [];
    for (const [name, build] of socketHandlers) {
      const before = listener.accepted;
      build();
      await settle(250); // give any background connect a real chance to land
      if (listener.accepted !== before) dialledAtConstruction.push(name);
    }

    // The database backend owns no socket, so it is measured by its side effect
    // on a REAL filesystem instead: opening the database creates the file.
    const dbPath = join(workDir, "construction.db");
    new DatabaseSessionHandler({ dbPath });
    const fileCreatedAtConstruction = existsSync(dbPath);

    assert(
      "a_session_handler_constructor_performs_no_network_io",
      dialledAtConstruction.length === 0 && !fileCreatedAtConstruction,
      [
        dialledAtConstruction.length
          ? `these CONSTRUCTORS opened a connection: ${dialledAtConstruction.join(", ")}`
          : "",
        fileCreatedAtConstruction
          ? "the database CONSTRUCTOR created its file (plus -wal and -shm) before any session was read or written"
          : "",
      ].filter(Boolean).join("; ")
        + ". Connection belongs on first use, inside the failure policy - a constructor sits outside it.",
    );

    // -- 2. the backend connection happens on first use ----------------------
    console.log("\n-- 2. deferred is not the same as never --\n");

    const beforeFirstUse = listener.accepted;
    const redis = new RedisSessionHandler({ redisHost: "127.0.0.1", redisPort: listener.port } as any);
    await settle(150);
    try {
      // The listener answers nothing useful, so this fails - that is fine and
      // expected. We are measuring the DIAL, not the conversation.
      redis.read(`construction-probe-${Math.random().toString(16).slice(2, 10)}`);
    } catch { /* the dial is the measurement */ }
    await settle(400);
    const redisDialled = listener.accepted > beforeFirstUse;

    const lazyDbPath = join(workDir, "first-use.db");
    const lazyHandler = new DatabaseSessionHandler({ dbPath: lazyDbPath });
    lazyHandler.write(`probe-${Math.random().toString(16).slice(2, 10)}`, { seeded: true }, 60);
    const dbFileCreatedOnUse = existsSync(lazyDbPath);

    assert(
      "the_backend_connection_happens_on_first_use_not_construction",
      redisDialled && dbFileCreatedOnUse,
      !redisDialled
        ? "the first redis operation opened NO connection - the handler is not lazy, it is inert, "
          + "and case 1 would pass on a store that never talks to anything"
        : "the first database operation created NO file - the handler is inert, not lazy",
    );

    // -- 3. a healthy backend still works after lazy connection --------------
    console.log("\n-- 3. deferring the connection must not break it --\n");

    const realRedisHost = process.env.TINA4_SESSION_REDIS_HOST ?? "127.0.0.1";
    const realRedisPort = Number(process.env.TINA4_SESSION_REDIS_PORT ?? 6379);
    const reachable = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection({ host: realRedisHost, port: realRedisPort });
      probe.setTimeout(2000);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => resolve(false));
      probe.once("timeout", () => { probe.destroy(); resolve(false); });
    });

    if (!reachable) {
      skipLoudly(
        "a_healthy_backend_still_works_after_lazy_connection",
        `redis is not reachable at ${realRedisHost}:${realRedisPort}`,
      );
    } else {
      const sessionId = `lazyok-${Math.random().toString(16).slice(2, 10)}`;
      const healthyRedis = new RedisSessionHandler({ redisHost: realRedisHost, redisPort: realRedisPort } as any);
      healthyRedis.write(sessionId, { seeded: true }, 60);
      const redisRoundTrip = JSON.stringify(healthyRedis.read(sessionId)) === JSON.stringify({ seeded: true });
      healthyRedis.destroy(sessionId);

      const healthyDbPath = join(workDir, "healthy.db");
      const healthyDb = new DatabaseSessionHandler({ dbPath: healthyDbPath });
      healthyDb.write(sessionId, { seeded: true }, 60);
      const dbRoundTrip = JSON.stringify(healthyDb.read(sessionId)) === JSON.stringify({ seeded: true });

      assert(
        "a_healthy_backend_still_works_after_lazy_connection",
        redisRoundTrip && dbRoundTrip,
        !redisRoundTrip
          ? "the redis round-trip broke - 'no I/O in the constructor' is not an achievement if the handler no longer works"
          : "the database round-trip broke - the table is created on first use, so a deferred open that never runs shows up exactly here",
      );
    }
  } finally {
    await listener.close();
    rmSync(workDir, { recursive: true, force: true });
    const { closeSyncSockets } = await import("../packages/core/src/sessionHandlers/syncSocket.js");
    try { closeSyncSockets(); } catch { /* nothing to reap */ }
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

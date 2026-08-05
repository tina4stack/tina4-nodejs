/**
 * SESSION CONTRACT: TINA4_SESSION_TTL is honoured by EVERY backend.
 *
 * ADR-0024: swapping file for redis, valkey, mongodb, memcached or database
 * changes ONE env var and NOTHING ELSE. The configured session lifetime is part
 * of that contract. An operator who sets a 15-minute session must GET a
 * 15-minute session, whichever backend is selected.
 *
 * Run with: npx tsx test/sessionTtlContract.test.ts
 *
 * WHERE NODE HONOURS THE ENV VAR, AND WHY THESE GATES DRIVE `Session`.
 * This file is the Node port of tina4-ruby's spec/session_ttl_contract_spec.rb.
 * Ruby's cases 1-3 drive the HANDLERS directly, because Ruby's Session#save
 * called safe_write(@id, @data) with NO ttl, so the handler default was the only
 * place TINA4_SESSION_TTL could possibly be read; the Ruby fix therefore made
 * every handler default from it.
 *
 * Node resolves the SAME invariant at a DIFFERENT layer, and deliberately so.
 * `Session` reads TINA4_SESSION_TTL once (session.ts:409-410) and FORWARDS it on
 * every write - start(), save(), set(), regenerate() all call
 * safeWrite(id, data, this.ttl). The handlers below it treat a ttl of 0 or less
 * as "never expires" (databaseHandler.ts:146-149, mongoHandler.ts:138, and the
 * file/redis/valkey handlers alike), which is itself a deliberate fix: those
 * handlers "used to silently substitute 3600, so asking for a non-expiring
 * session quietly got a one-hour one". Only the memcached handler carries its
 * own TINA4_SESSION_TTL default (memcachedHandler.ts:73-75).
 *
 * So in Node the env var's honouring point is `Session`, and a gate named
 * "session_ttl_env_var_..." has to go through `Session` or it is not measuring
 * TINA4_SESSION_TTL at all for five of the six backends - it would be measuring
 * a handler default that Node deliberately does not have. Driving `Session` is
 * also the STRICTER gate: it covers the forwarding AND the handler, so it still
 * catches the exact bug the Ruby original was written for (a save() that drops
 * the ttl leaves the record outliving its configured lifetime).
 *
 * NO MOCKS. Every backend here is the real service - real Redis, real Valkey,
 * real memcached, real MongoDB, a real node:sqlite file, real files on disk -
 * and every expiry is real wall-clock time. No clock mocking, no doubles.
 * A missing service SKIPS LOUDLY naming host and port, unless
 * TINA4_REQUIRE_SERVICES is set, and then it is a FAILURE, because a suite that
 * silently skips its only real verification is not verification.
 *
 * THE FOUR CASES, and why each is load-bearing:
 *   1. positive     - a short TINA4_SESSION_TTL really expires the record.
 *   2. negative     - a long TINA4_SESSION_TTL really does NOT expire it.
 *                     Without this, "delete the expiry logic" passes case 1.
 *   3. out of band  - the stored deadline is read back with an INDEPENDENT
 *                     client and is now+TTL. Cases 1 and 2 both ask the code
 *                     under test whether the record is alive; this one does not.
 *   4. ttl option   - an explicit ttl on the Session beats the env var IN THE
 *                     STORE, not just in the cookie. Without it, a save() that
 *                     drops the ttl is an inert mutation cases 1-3 stay green on.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../packages/core/src/session.js";
import { mongoCommandSync } from "../packages/core/src/sessionHandlers/mongoClient.js";
import { closeBridges } from "../packages/core/src/sessionHandlers/syncBridge.js";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
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

/** Real blocking sleep - wall clock, no clock mocking. */
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// -- env handling: every var this file touches is restored on the way out -----

const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

// -- service targets ---------------------------------------------------------

const REDIS_HOST = process.env.TINA4_SESSION_REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.TINA4_SESSION_REDIS_PORT ?? 6379);
// ValkeySessionHandler defaults to port 6379 - REDIS's port - and shares the
// exact same "tina4:session:" key prefix, so without an explicit port the valkey
// rows land in Redis and the two backends are indistinguishable. Point it at the
// real Valkey so this file genuinely covers six distinct backends.
const VALKEY_HOST = process.env.TINA4_SESSION_VALKEY_HOST ?? "127.0.0.1";
const VALKEY_PORT = Number(process.env.TINA4_SESSION_VALKEY_PORT ?? 6380);
const MEMCACHED_HOST = process.env.TINA4_SESSION_MEMCACHED_HOST
  ?? process.env.TINA4_TEST_MEMCACHED_HOST ?? "127.0.0.1";
const MEMCACHED_PORT = Number(
  process.env.TINA4_SESSION_MEMCACHED_PORT ?? process.env.TINA4_TEST_MEMCACHED_PORT ?? 11211,
);
const MONGO_HOST = process.env.TINA4_SESSION_MONGO_HOST
  ?? process.env.TINA4_TEST_MONGO_HOST ?? "127.0.0.1";
const MONGO_PORT = Number(
  process.env.TINA4_SESSION_MONGO_PORT ?? process.env.TINA4_TEST_MONGO_PORT ?? 27017,
);

async function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

// -- workspace ---------------------------------------------------------------

const runTag = randomBytes(4).toString("hex");
const workDir = mkdtempSync(join(tmpdir(), "tina4-ttl-contract-"));
const fileDir = join(workDir, "sessions");
const dbFile = join(workDir, "ttl_contract.db");
// A unique collection per run so two runs (or a shared lab Mongo) never see each
// other's documents.
const MONGO_DB = "tina4_ttl_contract";
const MONGO_COLLECTION = `sessions_${runTag}`;

// The database backend is SQLite-only by construction and takes its path from
// TINA4_DATABASE_URL - SessionConfig carries no dbPath, so this is how the
// public Session is pointed at a real temp SQLite file.
setEnv("TINA4_DATABASE_URL", `sqlite://${dbFile}`);
setEnv("TINA4_SESSION_REDIS_HOST", REDIS_HOST);
setEnv("TINA4_SESSION_REDIS_PORT", String(REDIS_PORT));
setEnv("TINA4_SESSION_VALKEY_HOST", VALKEY_HOST);
setEnv("TINA4_SESSION_VALKEY_PORT", String(VALKEY_PORT));
setEnv("TINA4_SESSION_MEMCACHED_HOST", MEMCACHED_HOST);
setEnv("TINA4_SESSION_MEMCACHED_PORT", String(MEMCACHED_PORT));
setEnv("TINA4_SESSION_MONGO_HOST", MONGO_HOST);
setEnv("TINA4_SESSION_MONGO_PORT", String(MONGO_PORT));
setEnv("TINA4_SESSION_MONGO_DB", MONGO_DB);
setEnv("TINA4_SESSION_MONGO_COLLECTION", MONGO_COLLECTION);

console.log("\n=== Session TTL contract: TINA4_SESSION_TTL on every backend ===\n");

// file and database need no service; the other four are probed for real.
const available: Record<string, boolean> = {
  file: true,
  database: true,
  redis: await reachable(REDIS_HOST, REDIS_PORT),
  valkey: await reachable(VALKEY_HOST, VALKEY_PORT),
  memcached: await reachable(MEMCACHED_HOST, MEMCACHED_PORT),
  mongodb: await reachable(MONGO_HOST, MONGO_PORT),
};

const endpoints: Record<string, string> = {
  redis: `${REDIS_HOST}:${REDIS_PORT}`,
  valkey: `${VALKEY_HOST}:${VALKEY_PORT}`,
  memcached: `${MEMCACHED_HOST}:${MEMCACHED_PORT}`,
  mongodb: `${MONGO_HOST}:${MONGO_PORT}`,
};

for (const [backend, up] of Object.entries(available)) {
  if (!up) {
    skipLoudly(
      `session_ttl_contract_requires_${backend}`,
      `${backend} is not reachable at ${endpoints[backend]}`,
    );
  }
}

const backends = ["file", "database", "redis", "valkey", "memcached", "mongodb"]
  .filter((backend) => available[backend]);

/**
 * Build the session the way an operator gets it: `TINA4_SESSION_BACKEND=<name>`
 * plus TINA4_SESSION_TTL, and nothing else. Only the file backend needs a config
 * value at all, because its storage directory has no env var equivalent here.
 */
function sessionFor(backend: string, ttl?: number): Session {
  const config = ttl === undefined ? {} : { ttl };
  if (backend === "file") return new Session("file", { ...config, path: fileDir });
  return new Session(backend, config);
}

/** Write a marked session through the public API and hand back its id. */
function seedSession(backend: string): string {
  const session = sessionFor(backend);
  const sessionId = session.start();
  session.set("seeded", true);
  return sessionId;
}

/** Resume through a FRESH Session, exactly as the next request would. */
function resumedValue(backend: string, sessionId: string): unknown {
  const session = sessionFor(backend);
  session.start(sessionId);
  return session.get("seeded");
}

// -- 1. POSITIVE: a short TINA4_SESSION_TTL really expires the record ---------
//
// ONE shared real sleep for every backend keeps the wall-clock cost at ~4s
// instead of ~24s, and a single sleep cannot accidentally give one backend more
// grace than another.
console.log("\n-- 1. a short TINA4_SESSION_TTL expires the record everywhere --\n");
{
  setEnv("TINA4_SESSION_TTL", "2");

  const ids: Record<string, string> = {};
  const neverStored: string[] = [];
  for (const backend of backends) {
    // NO explicit ttl anywhere: the lifetime must come from TINA4_SESSION_TTL.
    // Passing one would test the argument, and the argument already works.
    ids[backend] = seedSession(backend);
    if (resumedValue(backend, ids[backend]) !== true) neverStored.push(backend);
  }

  sleep(4000); // REAL wall clock, past the configured 2s. No clock mocking.

  const stillAlive = backends.filter((backend) => resumedValue(backend, ids[backend]) === true);

  assert(
    "session_ttl_env_var_expires_the_record_on_every_backend",
    neverStored.length === 0 && stillAlive.length === 0,
    `not stored at all: [${neverStored.join(", ")}] | `
    + `TINA4_SESSION_TTL=2 ignored, record survived 4 real seconds on: [${stillAlive.join(", ")}]`,
  );
}

// -- 2. NEGATIVE CONTROL: a long TINA4_SESSION_TTL must NOT expire ------------
//
// Without this, deleting all expiry logic passes case 1 and ships a session
// store that throws every session away.
console.log("\n-- 2. a long TINA4_SESSION_TTL keeps the record everywhere --\n");
{
  setEnv("TINA4_SESSION_TTL", "3600");

  const ids: Record<string, string> = {};
  const neverStored: string[] = [];
  for (const backend of backends) {
    ids[backend] = seedSession(backend);
    if (resumedValue(backend, ids[backend]) !== true) neverStored.push(backend);
  }

  sleep(4000); // the SAME real sleep that reaped everything in case 1

  const died = backends.filter((backend) => resumedValue(backend, ids[backend]) !== true);

  assert(
    "session_ttl_env_var_keeps_a_long_lived_record_on_every_backend",
    neverStored.length === 0 && died.length === 0,
    `not stored at all: [${neverStored.join(", ")}] | `
    + `TINA4_SESSION_TTL=3600 still expired the record on: [${died.join(", ")}]`,
  );
}

// -- 3. OUT OF BAND: the stored deadline is now+TTL, read by another client ----
//
// Cases 1 and 2 both ask the code under test whether the record is alive. This
// one asks the STORE, through a client the session handler does not own, so a
// handler that lies about expiry cannot pass it. memcached is absent by design:
// its text protocol exposes no per-key TTL to read back, so it is proven
// behaviourally by cases 1 and 2 rather than asserted through the code under test.
console.log("\n-- 3. the stored deadline is now+TINA4_SESSION_TTL (out of band) --\n");
{
  const configured = 1800;
  setEnv("TINA4_SESSION_TTL", String(configured));

  const now = Date.now() / 1000;
  const observed: Record<string, number> = {};
  const probeErrors: string[] = [];

  if (available.file) {
    const sessionId = seedSession("file");
    // Plain readFileSync off disk. ADR-0021 makes the filename the SHA-256 hex
    // digest of the id, so the derivation is followed rather than the raw id.
    const path = join(fileDir, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
    if (!existsSync(path)) probeErrors.push("file: no record was written to disk");
    else observed.file = Number(JSON.parse(readFileSync(path, "utf-8"))._expires) - now;
  }

  if (available.database) {
    const sessionId = seedSession("database");
    // A SEPARATE node:sqlite connection, not the handler's.
    const probe = new DatabaseSync(dbFile);
    const row = probe
      .prepare("SELECT expires_at FROM tina4_session WHERE session_id = ?")
      .get(sessionId) as { expires_at: number } | undefined;
    probe.close();
    if (!row) probeErrors.push(`database: no row was written for ${sessionId}`);
    else observed.database = Number(row.expires_at) - now;
  }

  for (const [backend, host, port] of [
    ["redis", REDIS_HOST, REDIS_PORT],
    ["valkey", VALKEY_HOST, VALKEY_PORT],
  ] as Array<[string, string, number]>) {
    if (!available[backend]) continue;
    const sessionId = seedSession(backend);
    // Our OWN socket, speaking RESP, asking the server for the key's remaining
    // TTL. Nothing here goes through the handler's transport.
    try {
      const probeDb = Number(
        process.env[backend === "valkey" ? "TINA4_SESSION_VALKEY_DB" : "TINA4_SESSION_REDIS_DB"] ?? 0,
      );
      observed[backend] = await respTtl(host, port, `tina4:session:${sessionId}`, probeDb);
    } catch (err) {
      probeErrors.push(`${backend}: TTL probe failed - ${(err as Error).message}`);
    }
  }

  if (available.mongodb) {
    const sessionId = seedSession("mongodb");
    // An independent find that returns the RAW document, so the deadline is read
    // straight off the stored record instead of through MongoSessionHandler.read()
    // and its expiry interpretation.
    const raw = mongoCommandSync(
      { host: MONGO_HOST, port: MONGO_PORT, database: MONGO_DB, collection: MONGO_COLLECTION },
      "find",
      { filter: { _id: sessionId } },
    );
    if (!raw || raw === "__EMPTY__") probeErrors.push(`mongodb: no document was written for ${sessionId}`);
    else observed.mongodb = Number(JSON.parse(raw).expires_at ?? 0) - now;
  }

  const wrong = Object.entries(observed)
    .filter(([, delta]) => Math.abs(delta - configured) >= 60)
    .map(([backend, delta]) => `${backend} stored now+${Math.round(delta)}s`);

  assert(
    "session_ttl_env_var_reaches_the_stored_deadline_out_of_band",
    probeErrors.length === 0 && wrong.length === 0,
    `probe errors: [${probeErrors.join("; ")}] | `
    + `the stored deadline did not come from TINA4_SESSION_TTL=${configured}: [${wrong.join(", ")}]`,
  );
}

// -- 4. an explicit ttl on the Session reaches the STORE, not just the cookie --
//
// The env says one hour. The Session says two seconds. The Session must win in
// the STORE. Node's save() forwards this.ttl to safeWrite; revert that
// forwarding and the record outlives its own ttl while the cookie still claims
// Max-Age=2, which is the shape of the Ruby bug this contract was written for.
console.log("\n-- 4. an explicit Session ttl beats the env var in the store --\n");
{
  setEnv("TINA4_SESSION_TTL", "3600");

  const dir = join(workDir, "session-option");
  const session = new Session("file", { path: dir, ttl: 2 });
  const sessionId = session.start();
  session.set("seeded", true);
  const saved = session.save();

  const immediate = new Session("file", { path: dir, ttl: 2 });
  immediate.start(sessionId);
  const resumedNow = immediate.get("seeded") === true;

  sleep(4000); // REAL wall clock, past the Session's own 2s ttl

  const fresh = new Session("file", { path: dir, ttl: 2 });
  fresh.start(sessionId);
  const afterSleep = fresh.get("seeded");

  assert(
    "session_ttl_option_on_the_session_reaches_the_stored_record",
    saved && resumedNow && afterSleep === undefined,
    `save()=${saved} resumedImmediately=${resumedNow} afterSleep=${JSON.stringify(afterSleep)} `
    + "(a defined value means Session ttl=2 never reached the store - the record "
    + "outlived its own ttl because the write dropped it)",
  );
}

// -- teardown ----------------------------------------------------------------
//
// closeBridges() shuts the persistent redis/valkey/memcached/mongo worker
// threads down. Without it they hold the event loop open and the file never
// exits, which wedges the piped run in test/run-all.ts.
closeBridges();
restoreEnv();
rmSync(workDir, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`
  + (skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : ""),
);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Ask a Redis/Valkey server for a key's remaining TTL over our OWN socket.
 *
 * Deliberately hand-rolled rather than routed through the framework's
 * respCommandSync: the whole point of case 3 is a client the code under test
 * does not own. The lab servers are unauthenticated on db 0, which is also what
 * the handlers default to, so no AUTH/SELECT is needed.
 *
 * @returns the remaining lifetime in seconds (-1 no expiry set, -2 no such key)
 */
async function respTtl(host: string, port: number, key: string, db = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = "";
    const finish = (action: () => void) => { socket.destroy(); action(); };
    socket.setTimeout(3000);
    socket.once("connect", () => {
      // SELECT the SAME db the handler wrote to before asking for the TTL. A
      // fresh connection is always db 0, so probing db 0 while the handler
      // honoured TINA4_SESSION_REDIS_DB found nothing - redis answers TTL on a
      // missing key with -2, and the assertion then blamed TINA4_SESSION_TTL.
      // The comment above this function used to say no SELECT was needed; that
      // was true only until the suites got their own db numbers.
      if (db > 0) {
        const d = String(db);
        socket.write(`*2\r\n$6\r\nSELECT\r\n$${Buffer.byteLength(d)}\r\n${d}\r\n`);
      }
      socket.write(`*2\r\n$3\r\nTTL\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`);
    });
    // With SELECT pipelined ahead of TTL the server sends TWO replies, and the
    // TTL is the SECOND. Reading the first line would hand back "+OK" and
    // reject with "unexpected TTL reply".
    const wanted = db > 0 ? 2 : 1;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\r\n").filter((l) => l.length > 0);
      if (lines.length < wanted) return;
      if (db > 0 && !lines[0].startsWith("+OK")) {
        return finish(() => reject(new Error(`SELECT ${db} refused: ${JSON.stringify(lines[0])}`)));
      }
      const line = lines[wanted - 1];
      finish(() => {
        if (line.startsWith(":")) resolve(Number(line.slice(1)));
        else reject(new Error(`unexpected TTL reply ${JSON.stringify(line)}`));
      });
    });
    socket.once("error", (err) => finish(() => reject(err)));
    socket.once("timeout", () => finish(() => reject(new Error("TTL probe timed out"))));
  });
}

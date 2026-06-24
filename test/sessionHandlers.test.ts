/**
 * Behavioural tests for the Session Handler classes (MongoDB and Valkey).
 * Run with: npx tsx test/sessionHandlers.test.ts
 *
 * These exercise the handlers against the REAL services that the CI/dev infra
 * provisions: MongoDB on 127.0.0.1:27017 and a Redis/Valkey (RESP) server on
 * 127.0.0.1:6379. There are NO mocks, stubs, or fakes — every assertion drives
 * the actual handler code path over a real TCP socket to a real server.
 *
 * History: both handlers used to talk to the server through a child `node -e`
 * script that read the reply on the socket "end" event. Redis/Valkey/MongoDB all
 * keep the connection OPEN after a normal command, so "end" never fired — the
 * child waited out its timeout and EVERY write/read/destroy was reported as a
 * transport failure. The Mongo encoder also put `$db` first (so the server read
 * it as the command name) and never encoded arrays/booleans. Both handlers now
 * round-trip for real: the RESP transport parses replies incrementally on "data"
 * (respClient.ts), and the Mongo transport uses the `mongodb` driver when present
 * with a corrected raw OP_MSG fallback (mongoClient.ts). These tests assert the
 * real round-trip — write succeeds, read returns the written data, a miss returns
 * null, and a destroyed session reads back as null.
 */
import {
  MongoSessionHandler, ValkeySessionHandler,
} from "../packages/core/src/index.ts";

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

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Run a handler op against the live server, capturing whether it threw and what it returned. */
function probe<T>(fn: () => T): { threw: boolean; value: T | undefined; error?: string } {
  try {
    return { threw: false, value: fn() };
  } catch (err) {
    return { threw: true, value: undefined, error: (err as Error).message };
  }
}

// A payload with a nested array + boolean, so the lifecycle locks in the BSON
// codec (arrays 0x04, booleans 0x08, little-endian doubles) and the RESP JSON
// round-trip, not just flat scalars.
const sessionData = { _created: 1, _accessed: 2, userId: 7, k: "v", nested: { a: [1, 2, 3], flag: true } } as const;

console.log("=== Session Handlers Tests ===\n");

// --- MongoDB Handler ---
console.log("--- MongoDB Session Handler (live 127.0.0.1:27017) ---");

const mongo = new MongoSessionHandler({
  host: "127.0.0.1",
  port: 27017,
  database: "test_sessions",
  collection: "sessions",
});

const mWrite = probe(() => mongo.write("sid-m", { ...sessionData }, 0));
const mReadHit = probe(() => mongo.read("sid-m"));
const mReadMiss = probe(() => mongo.read("missing-sid"));
const mDestroy = probe(() => mongo.destroy("sid-m"));
const mReadAfterDestroy = probe(() => mongo.read("sid-m"));

// 1. write → persists a real document to live Mongo (no transport failure).
assert(
  "MongoSessionHandler.write persists to live Mongo (no error)",
  !mWrite.threw,
  `err=${mWrite.error}`,
);

// 2. read → returns the just-written session, deep-equal to what was written.
assert(
  "MongoSessionHandler.read returns the written session from live Mongo",
  !mReadHit.threw && deepEqual(mReadHit.value, sessionData),
  `value=${JSON.stringify(mReadHit.value)} err=${mReadHit.error}`,
);

// 3. read of an absent id → null (a genuine miss, NOT a transport error).
assert(
  "MongoSessionHandler.read of an absent id returns null",
  !mReadMiss.threw && mReadMiss.value === null,
  `value=${JSON.stringify(mReadMiss.value)} err=${mReadMiss.error}`,
);

// 4. destroy → removes the document (no transport failure).
assert(
  "MongoSessionHandler.destroy removes the session on live Mongo (no error)",
  !mDestroy.threw,
  `err=${mDestroy.error}`,
);

// 5. read after destroy → null (the document is really gone).
assert(
  "MongoSessionHandler.read after destroy returns null",
  !mReadAfterDestroy.threw && mReadAfterDestroy.value === null,
  `value=${JSON.stringify(mReadAfterDestroy.value)} err=${mReadAfterDestroy.error}`,
);

// 6. default config → defaults point at the live Mongo; prove it round-trips.
const mongoDefaults = new MongoSessionHandler();
const mdWrite = probe(() => mongoDefaults.write("d1", { ...sessionData }, 0));
const mdRead = probe(() => mongoDefaults.read("d1"));
probe(() => mongoDefaults.destroy("d1"));
assert(
  "MongoSessionHandler default config round-trips against live Mongo",
  !mdWrite.threw && !mdRead.threw && deepEqual(mdRead.value, sessionData),
  `write-err=${mdWrite.error} read=${JSON.stringify(mdRead.value)} read-err=${mdRead.error}`,
);

// 7. URI config → the URI host/port is honoured; prove it round-trips.
const mongoUri = new MongoSessionHandler({ uri: "mongodb://127.0.0.1:27017/test_sessions" });
const muWrite = probe(() => mongoUri.write("u1", { ...sessionData }, 0));
const muRead = probe(() => mongoUri.read("u1"));
probe(() => mongoUri.destroy("u1"));
assert(
  "MongoSessionHandler honours a mongodb:// URI and round-trips",
  !muWrite.threw && !muRead.threw && deepEqual(muRead.value, sessionData),
  `write-err=${muWrite.error} read=${JSON.stringify(muRead.value)} read-err=${muRead.error}`,
);

// Backend-failure policy: an UNREACHABLE server is a transport FAILURE — the
// handler must SURFACE it (throw) so the Session boundary can log-loud + degrade,
// rather than swallowing it into a null (indistinguishable from a genuine miss).
let mongoThrew = false;
try {
  new MongoSessionHandler({ host: "127.0.0.1", port: 59999 }).read("nonexistent-session");
} catch {
  mongoThrew = true;
}
assert("MongoSessionHandler.read THROWS when server unreachable (transport failure surfaced)", mongoThrew);

// --- Valkey Handler ---
console.log("\n--- Valkey Session Handler (live RESP 127.0.0.1:6379) ---");

const valkey = new ValkeySessionHandler({
  host: "127.0.0.1",
  port: 6379,
  prefix: "test:session:",
  db: 0,
});

const vWrite = probe(() => valkey.write("sid-v", { ...sessionData }, 0));
const vReadHit = probe(() => valkey.read("sid-v"));
const vReadMiss = probe(() => valkey.read("missing-sid"));
const vDestroy = probe(() => valkey.destroy("sid-v"));
const vReadAfterDestroy = probe(() => valkey.read("sid-v"));

// 8. write → SET persists to live Valkey (no transport failure).
assert(
  "ValkeySessionHandler.write persists to live Valkey (no error)",
  !vWrite.threw,
  `err=${vWrite.error}`,
);

// 9. read → returns the written session, deep-equal to what was written.
assert(
  "ValkeySessionHandler.read returns the written session from live Valkey",
  !vReadHit.threw && deepEqual(vReadHit.value, sessionData),
  `value=${JSON.stringify(vReadHit.value)} err=${vReadHit.error}`,
);

// 10. read of an absent key → null (a genuine miss, NOT a transport error).
assert(
  "ValkeySessionHandler.read of an absent key returns null",
  !vReadMiss.threw && vReadMiss.value === null,
  `value=${JSON.stringify(vReadMiss.value)} err=${vReadMiss.error}`,
);

// 11. write WITH a TTL (SETEX path) → persists and round-trips.
const vTtlWrite = probe(() => valkey.write("sid-ttl", { ...sessionData }, 60));
const vTtlRead = probe(() => valkey.read("sid-ttl"));
probe(() => valkey.destroy("sid-ttl"));
assert(
  "ValkeySessionHandler.write (TTL/SETEX) persists and round-trips on live Valkey",
  !vTtlWrite.threw && !vTtlRead.threw && deepEqual(vTtlRead.value, sessionData),
  `write-err=${vTtlWrite.error} read=${JSON.stringify(vTtlRead.value)}`,
);

// 12. destroy → DEL removes the key (no transport failure).
assert(
  "ValkeySessionHandler.destroy removes the key on live Valkey (no error)",
  !vDestroy.threw,
  `err=${vDestroy.error}`,
);

// 13. read after destroy → null (the key is really gone).
assert(
  "ValkeySessionHandler.read after destroy returns null",
  !vReadAfterDestroy.threw && vReadAfterDestroy.value === null,
  `value=${JSON.stringify(vReadAfterDestroy.value)} err=${vReadAfterDestroy.error}`,
);

// 14. default config → defaults point at the live Valkey; prove it round-trips.
const valkeyDefaults = new ValkeySessionHandler();
const vdWrite = probe(() => valkeyDefaults.write("d1", { ...sessionData }, 0));
const vdRead = probe(() => valkeyDefaults.read("d1"));
probe(() => valkeyDefaults.destroy("d1"));
assert(
  "ValkeySessionHandler default config round-trips against live Valkey",
  !vdWrite.threw && !vdRead.threw && deepEqual(vdRead.value, sessionData),
  `write-err=${vdWrite.error} read=${JSON.stringify(vdRead.value)}`,
);

// 15. password config → the password is really transmitted (AUTH on the wire).
// The infra Valkey/Redis is NOT password-protected, so a handler that sends
// `AUTH <pwd>` gets a RESP error ("ERR Client sent AUTH, but no password is
// set"); the handler surfaces that as a thrown transport failure. A handler that
// ignored the password would instead succeed — so the throw proves transmission.
const valkeyWithAuth = new ValkeySessionHandler({
  host: "127.0.0.1",
  port: 6379,
  password: "secret",
  prefix: "app:sess:",
  db: 2,
});
const vaWrite = probe(() => valkeyWithAuth.write("a1", { ...sessionData }, 0));
assert(
  "ValkeySessionHandler transmits the configured password to live Valkey (AUTH error surfaced)",
  vaWrite.threw,
  `password-config op did not surface the AUTH error: err=${vaWrite.error}`,
);

// Backend-failure policy: an unreachable Valkey is a transport FAILURE — throw.
let valkeyThrew = false;
try {
  new ValkeySessionHandler({ host: "127.0.0.1", port: 59999 }).read("nonexistent-session");
} catch {
  valkeyThrew = true;
}
assert("ValkeySessionHandler.read THROWS when server unreachable (transport failure surfaced)", valkeyThrew);

// --- Interface Parity (full lifecycle against the live services) ---
console.log("\n--- Interface Parity ---");

// 16. MongoDB full lifecycle: write → read(==data) → destroy → read(null).
assert(
  "MongoDB handler runs a real write→read→destroy→read lifecycle against live Mongo",
  !mWrite.threw && deepEqual(mReadHit.value, sessionData) && !mDestroy.threw && mReadAfterDestroy.value === null,
  `write=${!mWrite.threw} read=${JSON.stringify(mReadHit.value)} destroy=${!mDestroy.threw} readAfter=${JSON.stringify(mReadAfterDestroy.value)}`,
);

// 17. Valkey full lifecycle: write → read(==data) → destroy → read(null).
assert(
  "Valkey handler runs a real write→read→destroy→read lifecycle against live Valkey",
  !vWrite.threw && deepEqual(vReadHit.value, sessionData) && !vDestroy.threw && vReadAfterDestroy.value === null,
  `write=${!vWrite.threw} read=${JSON.stringify(vReadHit.value)} destroy=${!vDestroy.threw} readAfter=${JSON.stringify(vReadAfterDestroy.value)}`,
);

// 18. A miss and a hit are now DISTINCT code paths (a hit returns the doc, a miss
// returns null) — proving the handler really reads a reply rather than failing on
// every call. This is the exact behaviour change from the old "miss==hit" bug.
assert(
  "MongoSessionHandler distinguishes a miss (null) from a hit (the session) on live Mongo",
  mReadMiss.value === null && deepEqual(mReadHit.value, sessionData),
  `miss=${JSON.stringify(mReadMiss.value)} hit=${JSON.stringify(mReadHit.value)}`,
);
assert(
  "ValkeySessionHandler distinguishes a miss (null) from a hit (the session) on live Valkey",
  vReadMiss.value === null && deepEqual(vReadHit.value, sessionData),
  `miss=${JSON.stringify(vReadMiss.value)} hit=${JSON.stringify(vReadHit.value)}`,
);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

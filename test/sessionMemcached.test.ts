/**
 * Memcached session backend — against a REAL memcached server.
 *
 * Memcached was one of the seven CACHE backends in all four frameworks but was
 * not a session backend in any of them, even though it is the classic PHP
 * session store. This is the parity feature that closes that gap.
 *
 * NO MOCKS. Every assertion drives a live memcached over TCP. If the server is
 * not reachable the file skips, unless TINA4_REQUIRE_SERVICES is set — then a
 * missing service is a FAILURE, because a suite that silently skips its only
 * real verification is not verification.
 *
 * Run with: npx tsx test/sessionMemcached.test.ts
 */
import { execFileSync } from "node:child_process";
import { MemcachedSessionHandler } from "../packages/core/src/sessionHandlers/memcachedHandler.js";
import { Session } from "../packages/core/src/session.js";

const HOST = process.env.TINA4_TEST_MEMCACHED_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.TINA4_TEST_MEMCACHED_PORT ?? "11211", 10);

let pass = 0;
let fail = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

/** Real TCP reachability probe — no mock, no assumption. */
function reachable(): boolean {
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `const net=require("node:net");const s=net.createConnection({host:${JSON.stringify(HOST)},port:${PORT}});
         s.on("connect",()=>{s.destroy();process.exit(0)});
         s.on("error",()=>process.exit(1));
         setTimeout(()=>process.exit(1),2000);`,
      ],
      { stdio: "ignore", timeout: 4000 },
    );
    return true;
  } catch {
    return false;
  }
}

console.log(`=== Memcached session backend (live ${HOST}:${PORT}) ===\n`);

if (!reachable()) {
  if (process.env.TINA4_REQUIRE_SERVICES) {
    console.log(
      `  \x1b[31m-\x1b[0m TINA4_REQUIRE_SERVICES is set but memcached is not reachable at ${HOST}:${PORT}`,
    );
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m memcached not reachable at ${HOST}:${PORT}`);
  process.exit(0);
}

const h = new MemcachedSessionHandler({ host: HOST, port: PORT, prefix: "tina4:test:session:" });
const SESSION = {
  _created: 1,
  _accessed: 2,
  userId: 7,
  nested: { a: [1, 2, 3], flag: true },
} as const;

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// --- lifecycle -----------------------------------------------------------
h.write("sid-basic", { ...SESSION }, 60);
assert("write then read returns the same session", deepEqual(h.read("sid-basic"), SESSION));
h.destroy("sid-basic");

// A miss and a failure must be different outcomes. Collapsing them is how a
// dead cache silently logs every user out instead of surfacing an outage.
assert("a miss returns null, not an error", h.read("sid-definitely-not-present") === null);

h.write("sid-destroy", { ...SESSION }, 60);
const beforeDestroy = h.read("sid-destroy") !== null;
h.destroy("sid-destroy");
assert("destroy removes the session", beforeDestroy && h.read("sid-destroy") === null);

let idempotent = true;
try {
  h.destroy("sid-never-existed");   // logging out twice must not throw
} catch {
  idempotent = false;
}
assert("destroying an absent session is not an error", idempotent);

h.write("sid-over", { ...SESSION, v: 1 } as never, 60);
h.write("sid-over", { ...SESSION, v: 2 } as never, 60);
assert(
  "a write overwrites the previous value",
  (h.read("sid-over") as { v?: number } | null)?.v === 2,
);
h.destroy("sid-over");

// --- key safety ----------------------------------------------------------
// Memcached rejects keys over 250 bytes. Truncating would let two different
// sessions collide on one key — one user reading another's session.
const longA = "x".repeat(400);
const longB = "x".repeat(399) + "y";
h.write(longA, { ...SESSION, who: "a" } as never, 60);
h.write(longB, { ...SESSION, who: "b" } as never, 60);
assert(
  "an over-long session id is hashed, not truncated (no collision)",
  (h.read(longA) as { who?: string } | null)?.who === "a" &&
    (h.read(longB) as { who?: string } | null)?.who === "b",
);
h.destroy(longA);
h.destroy(longB);

// A space is illegal in a memcached key and would be a protocol error.
h.write("has a space", { ...SESSION, ok: true } as never, 60);
assert(
  "a session id containing a space is still usable",
  (h.read("has a space") as { ok?: boolean } | null)?.ok === true,
);
h.destroy("has a space");

// --- backend-failure policy ---------------------------------------------
// The whole point of the miss/failure split: an unreachable backend must THROW
// so the Session layer logs loud and degrades. Returning null would be
// indistinguishable from "no session yet", silently logging every user out.
const dead = new MemcachedSessionHandler({ host: "127.0.0.1", port: 59999 });
let readThrew = false;
try {
  dead.read("sid-any");
} catch {
  readThrew = true;
}
assert("an unreachable server THROWS on read rather than reading empty", readThrew);

let writeThrew = false;
try {
  dead.write("sid-any", { ...SESSION }, 60);
} catch {
  writeThrew = true;
}
assert("an unreachable server THROWS on write", writeThrew);

let gcOk = true;
try {
  h.gc(3600);   // no-op: memcached expires its own keys
} catch {
  gcOk = false;
}
assert("gc is a no-op because memcached expires its own keys", gcOk);

// --- selectable as a backend --------------------------------------------
// A handler nothing can select is not a backend.
// Session takes the backend as its FIRST positional argument; the handler picks
// up host/port from the TINA4_SESSION_MEMCACHED_* env vars, exactly as the
// Redis/Valkey handlers do.
process.env.TINA4_SESSION_MEMCACHED_HOST = HOST;
process.env.TINA4_SESSION_MEMCACHED_PORT = String(PORT);

for (const spelling of ["memcached", "memcache"]) {
  const s = new Session(spelling);
  assert(
    `TINA4_SESSION_BACKEND="${spelling}" selects the memcached handler`,
    (s as unknown as { handler: unknown }).handler instanceof MemcachedSessionHandler,
  );
}

// The env var itself must select it too — that is how a deployment configures it.
{
  process.env.TINA4_SESSION_BACKEND = "memcached";
  const s = new Session();
  assert(
    "the TINA4_SESSION_BACKEND env var alone selects memcached",
    (s as unknown as { handler: unknown }).handler instanceof MemcachedSessionHandler,
  );
  delete process.env.TINA4_SESSION_BACKEND;
}

// --- end to end through Session -----------------------------------------
{
  const s = new Session("memcached");
  const sid = s.start();
  s.set("userId", 42);
  s.save();

  const reopened = new Session("memcached");
  reopened.start(sid);
  assert("a full lifecycle round-trips through Session", reopened.get("userId") === 42);
  reopened.destroy();

  const afterDestroy = new Session("memcached");
  afterDestroy.start(sid);
  assert("a destroyed session no longer returns its data", afterDestroy.get("userId") === undefined);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

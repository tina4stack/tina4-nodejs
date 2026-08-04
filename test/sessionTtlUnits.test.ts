/**
 * SESSION CONTRACT: a TTL is expressed in ONE unit by the caller, whatever the provider.
 * Run with: npx tsx test/sessionTtlUnits.test.ts
 *
 * ADR-0024: the developer writes against the CONTRACT, never the PROVIDER. A ttl
 * is a number of SECONDS. Each backend converts that to whatever its own wire
 * protocol needs. Providers differ; the contract must not.
 *
 * WHY THIS FILE EXISTS - the memcached 30-day cliff, MEASURED, not read.
 *
 * memcached's `set` command takes an `exptime` field with a documented dual
 * meaning: a value up to 2592000 (30 days) is RELATIVE seconds, and ANY LARGER
 * VALUE IS AN ABSOLUTE UNIX TIMESTAMP. Tina4 interpolated the caller's ttl into
 * that field raw, in all four frameworks, with no conversion anywhere - a grep
 * for 2592000 across python, php, ruby and nodejs returned ZERO hits on
 * 2026-08-04.
 *
 * So TINA4_SESSION_TTL=2592001 - "about a month", an entirely ordinary
 * remember-me setting - was sent as the absolute timestamp 2592001, which is
 * 1970-01-31. The item was already expired at the moment it was stored.
 * memcached still answers STORED, so the write looks successful and the very
 * next read is a miss. Measured against real memcached 1.6.45:
 *
 *     ttl=60        read -> the payload   SURVIVES
 *     ttl=2592000   read -> the payload   SURVIVES
 *     ttl=2592001   read -> null          VANISHED INSTANTLY
 *     ttl=4000000   read -> null          VANISHED INSTANTLY
 *
 * That is a silent logout on every request, from a config value that looks
 * perfectly reasonable, and nothing anywhere reports it.
 *
 * The fix CONVERTS a ttl past the boundary into the absolute stamp the protocol
 * is asking for, rather than CLAMPING to 2592000 - clamping would silently
 * shorten a session the operator explicitly asked to be longer, which is the
 * same class of lie in the other direction.
 *
 * NO MOCKS. Every assertion runs against a real memcached, and the out-of-band
 * checks open their OWN socket rather than asking the code under test.
 *
 * A missing service SKIPS LOUDLY naming host and port, unless
 * TINA4_REQUIRE_SERVICES is set - then it is a FAILURE, because a suite that
 * silently skips its only real verification is not verification.
 */
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { MemcachedSessionHandler } from "../packages/core/src/sessionHandlers/memcachedHandler.js";

const HOST = process.env.TINA4_TEST_MEMCACHED_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.TINA4_TEST_MEMCACHED_PORT ?? "11211", 10);

/** The protocol boundary. At or below: relative seconds. Above: absolute stamp. */
const MAX_RELATIVE_EXPTIME = 2592000;

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

/** Real blocking sleep - wall clock, no clock mocking. */
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

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

/**
 * Run one memcached command on a socket THIS TEST owns - never the handler's.
 *
 * A handler that lied about what it stored could not be caught by asking that
 * same handler to read it back.
 */
function rawCommand(payload: string, isComplete: (buf: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port: PORT });
    let buf = "";
    socket.setTimeout(5000);
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      if (isComplete(buf)) { socket.destroy(); resolve(buf); }
    });
    socket.once("error", (err: Error) => { socket.destroy(); reject(err); });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`timed out reading the reply to ${JSON.stringify(payload)}`));
    });
    // The server hanging up before our terminator resolves with whatever
    // arrived, so the assertion reports the truncated reply instead of hanging.
    socket.once("close", () => resolve(buf));
  });
}

/** Raw `get` over our own socket. `VALUE ...` when held, exactly `END\r\n` when gone. */
const rawGet = (key: string): Promise<string> =>
  rawCommand(`get ${key}\r\n`, (buf) => buf.includes("END\r\n"));

/**
 * Ask the SERVER how long it thinks the key has left, over our own socket.
 *
 * memcached 1.6's meta-get reports the remaining ttl: `mg <key> t v` answers
 * `VA <size> t<seconds>`. This is what makes the difference between CONVERTING
 * a long ttl and CLAMPING it visible - both survive a round-trip, but only one
 * still has the lifetime the caller asked for.
 */
async function rawRemainingTtl(key: string): Promise<number> {
  const reply = await rawCommand(`mg ${key} t v\r\n`, (buf) => buf.includes("\r\n"));
  for (const token of reply.split(/\s+/)) {
    const match = /^t(-?\d+)$/.exec(token);
    if (match) return parseInt(match[1], 10);
  }
  throw new Error(`no ttl in meta-get reply for ${key}: ${JSON.stringify(reply)}`);
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const PAYLOAD = { seeded: true };

console.log(`\n=== Session TTL units (live memcached ${HOST}:${PORT}) ===\n`);

if (!(await reachable(HOST, PORT))) {
  const reason = `memcached is not reachable at ${HOST}:${PORT}`;
  skipLoudly("session_ttl_above_the_memcached_thirty_day_boundary_survives", reason);
  skipLoudly("session_ttl_at_the_memcached_thirty_day_boundary_survives", reason);
  skipLoudly("session_ttl_below_the_boundary_still_really_expires", reason);
} else {
  const handler = new MemcachedSessionHandler({
    host: HOST,
    port: PORT,
    prefix: "tina4:test:ttlunits:",
  });
  // key() is TypeScript-private, not runtime-private: the out-of-band reads must
  // address the SAME key the handler writes, or they prove nothing.
  const storedKey = (sessionId: string): string =>
    (handler as unknown as { key(id: string): string }).key(sessionId);
  const created: string[] = [];
  const newSessionId = (tag: string): string => {
    const sessionId = `units-${tag}-${randomBytes(4).toString("hex")}`;
    created.push(sessionId);
    return sessionId;
  };

  // ── 1. A ttl past 30 days must still mean "that many SECONDS from now" ──
  //
  // The headline gate. Before the fix the record vanished the instant it was
  // written, because 2592001 was read as a moment in 1970.
  //
  // The 60-day value is what stops a CLAMP being mistaken for a fix. Clamping to
  // 2592000 also survives the round-trip, so a survival-only assertion cannot
  // tell the two apart - but a clamp silently turns the 60-day session the
  // operator asked for into a 30-day one. Asking the SERVER for the remaining
  // ttl makes that visible: convert reports ~5184000, clamp reports 2592000.
  {
    let ok = true;
    const detail: string[] = [];
    for (const overTheBoundary of [MAX_RELATIVE_EXPTIME + 1, 5184000]) {
      const sessionId = newSessionId("over");
      handler.write(sessionId, { ...PAYLOAD } as never, overTheBoundary);

      const readBack = handler.read(sessionId);
      if (!deepEqual(readBack, PAYLOAD)) {
        ok = false;
        detail.push(
          `a ttl of ${overTheBoundary}s expired the session instantly `
          + `(read=${JSON.stringify(readBack)}) - memcached read it as an absolute `
          + "timestamp in 1970",
        );
        continue;
      }

      // Out of band: the server really holds it, on a socket we opened.
      const held = await rawGet(storedKey(sessionId));
      if (!held.startsWith("VALUE")) {
        ok = false;
        detail.push(
          `ttl=${overTheBoundary}: the handler claimed the session was stored but `
          + `the server does not have it (get=${JSON.stringify(held)})`,
        );
        continue;
      }

      const remaining = await rawRemainingTtl(storedKey(sessionId));
      if (Math.abs(remaining - overTheBoundary) >= 60) {
        ok = false;
        detail.push(
          `asked for a ${overTheBoundary}s session; the server says ${remaining}s `
          + "remain. A clamp to the 30-day ceiling silently shortens a lifetime the "
          + "operator explicitly asked to be longer.",
        );
      }
    }
    assert(
      "session_ttl_above_the_memcached_thirty_day_boundary_survives",
      ok,
      detail.join(" | "),
    );
  }

  // ── 2. BOUNDARY CONTROL: exactly 2592000 is still legal relative seconds ──
  //
  // Pins which side of the cliff the conversion starts on. A fix that converted
  // at or below the boundary would still be wrong, just less obviously so.
  {
    const sessionId = newSessionId("at");
    handler.write(sessionId, { ...PAYLOAD } as never, MAX_RELATIVE_EXPTIME);
    const readBack = handler.read(sessionId);
    const held = await rawGet(storedKey(sessionId));
    assert(
      "session_ttl_at_the_memcached_thirty_day_boundary_survives",
      deepEqual(readBack, PAYLOAD) && held.startsWith("VALUE"),
      `a ttl of exactly ${MAX_RELATIVE_EXPTIME}s is the largest legal RELATIVE exptime `
      + `and must round-trip untouched (read=${JSON.stringify(readBack)} `
      + `serverHolds=${held.startsWith("VALUE")})`,
    );
  }

  // ── 3. NEGATIVE CONTROL: a short ttl must still expire, for real ──
  //
  // Without this, "never send an expiry at all" passes both cases above and
  // ships a session store where nothing ever expires - which on a session store
  // is a security defect, not a convenience.
  {
    const sessionId = newSessionId("short");
    handler.write(sessionId, { ...PAYLOAD } as never, 1);
    const storedOk = deepEqual(handler.read(sessionId), PAYLOAD);

    sleep(3000); // REAL wall clock, past the 1s ttl. No clock mocking.

    const afterExpiry = handler.read(sessionId);
    const held = await rawGet(storedKey(sessionId));
    assert(
      "session_ttl_below_the_boundary_still_really_expires",
      storedOk && afterExpiry === null && held === "END\r\n",
      `stored=${storedOk} afterExpiry=${JSON.stringify(afterExpiry)} `
      + `serverStillHolds=${JSON.stringify(held)} - a 1-second ttl must expire; a `
      + "conversion that turned every ttl into 'never expires' would pass the gates above",
    );
  }

  // Destroy what we created. Cleaning up a record we are throwing away must
  // never fail the run.
  for (const sessionId of created) {
    try {
      handler.destroy(sessionId);
    } catch {
      /* already gone, or the server went away after the assertions ran */
    }
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`
  + (skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : ""),
);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

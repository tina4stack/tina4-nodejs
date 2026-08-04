/**
 * CACHE CONTRACT - memcached's 30-day exptime cliff.
 *
 * memcached reads the `set` exptime field as RELATIVE seconds at or below
 * 2592000 (30 days), and as an ABSOLUTE UNIX TIMESTAMP above it.
 *
 * THE MEASURED DEFECT
 *     MemcachedBackend.set() interpolated the caller's ttl RAW:
 *         const exptime = ttl > 0 ? ttl : 0;
 *         `set ${mcKey} 0 ${exptime} ...`
 *     So any TINA4_CACHE_TTL over 30 days made every cache write vanish the
 *     instant it landed: the caller wrote a number of seconds and the server
 *     read a date in 1970. memcached still answers STORED, so it presents as a
 *     100% miss rate with nothing logged - a cache that looks like it is
 *     working and never returns a hit.
 *
 * CONVERT, NEVER CLAMP
 *     Clamping to 2592000 also makes the entry survive, and is ALSO wrong: it
 *     silently discards more than half the lifetime the operator explicitly
 *     configured - the same class of silent-wrong-answer as the bug it
 *     replaces. Survival alone therefore cannot tell the right fix from the
 *     wrong one, so the cases below read the SERVER'S OWN reported remaining
 *     lifetime via the meta-get command (`mg <key> t v` -> `VA <len> t<secs>`,
 *     memcached 1.6+). The 60-day case is the load-bearing one: at the boundary
 *     |2592000 - 2592001| = 1, inside any sane tolerance, so a just-past-the-
 *     cliff value passes a clamp check.
 *
 * WHAT A ROUND TRIP CANNOT TELL YOU
 *     A relative 2592000 and an absolute now+2592000 describe the SAME INSTANT.
 *     memcached reports an identical remaining lifetime for both, so no
 *     round-trip assertion can distinguish `ttl > MAX` from `ttl >= MAX` - it
 *     is blind to that off-by-one by construction. Measured, not theorised:
 *     the boundary case was first written that way and the `>=` mutation left
 *     the whole file green. The boundary case therefore also asserts on the
 *     COMPUTED exptime, which is a pure function of its inputs.
 *
 * NOTHING HERE IS MOCKED. Every assertion is answered by a real memcached over
 * a real socket, and the expiry control sleeps for real wall-clock time.
 *
 * Run with: npx tsx test/cacheMemcachedExptime.test.ts
 */
import * as net from "node:net";
import * as crypto from "node:crypto";
import { createBackend } from "../packages/core/src/index.ts";
import { requireServices } from "./_serviceGate.ts";

const MEMCACHED_URL = process.env.TINA4_TEST_CACHE_MEMCACHED_URL ?? "memcached://127.0.0.1:11211";
/** memcached's own cliff: at or below this, exptime is relative seconds. */
const MAX_RELATIVE_EXPTIME = 2592000;
/** 60 days - comfortably past the cliff, and NOT within tolerance of it. */
const BEYOND_CLIFF_TTL = 5184000;

let pass = 0;
let fail = 0;
let skipped = 0;
let cases = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} (${reason})`);
  skipped++;
}

function uniqueKey(label: string): string {
  return `exptime-${label}-${crypto.randomBytes(12).toString("hex")}`;
}

function hostPort(url: string, defaultPort: number): { host: string; port: number } {
  const bits = url.replace(/^[a-z+]+:\/\//, "").split("/")[0].split(":");
  return { host: bits[0] || "127.0.0.1", port: bits[1] ? parseInt(bits[1], 10) || defaultPort : defaultPort };
}

const MC = hostPort(MEMCACHED_URL, 11211);

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(false); }, 2000);
    if (timer.unref) timer.unref();
  });
}

/** Sleep for real. NOT unref'd - an unref'd timer lets Node exit mid-run. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * One real round trip on an INDEPENDENT socket. Used to ask the server what it
 * thinks the remaining lifetime is, so the assertion comes from memcached
 * itself rather than from the code under test. A separate connection also keeps
 * this out of the backend's own command queue.
 */
function rawCommand(payload: string, waitMs = 500): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const sock = net.createConnection({ host: MC.host, port: MC.port }, () => sock.write(payload));
    sock.on("data", (chunk) => { out += chunk.toString("utf-8"); });
    sock.on("error", () => { try { sock.destroy(); } catch { /* noop */ } resolve(out); });
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(out); }, waitMs);
    if (timer.unref) timer.unref();
  });
}

/**
 * The SERVER's own view of a key's remaining lifetime, in seconds.
 * `mg <key> t v` -> `VA <len> t<seconds>` (memcached 1.6+). Returns null when
 * the key is absent, and -1 is memcached's "never expires".
 */
async function serverRemainingTtl(mcKey: string): Promise<number | null> {
  const reply = await rawCommand(`mg ${mcKey} t v\r\n`);
  if (!reply || reply.startsWith("EN")) return null;
  const match = reply.match(/\bt(-?\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Build a REAL memcached backend and refuse a silent fallback to file. */
async function realMemcached(): Promise<any> {
  const made: any = await createBackend({ backend: "memcached", cacheUrl: MEMCACHED_URL });
  if (made.name() !== "memcached") {
    throw new Error(
      `createBackend('memcached') returned '${made.name()}' - the service was unreachable ` +
      "and the cache fell back; these assertions would prove nothing",
    );
  }
  return made;
}

/**
 * The server-side key the backend actually wrote. The backend namespaces and
 * hashes its keys, so the meta-get has to target the same string - taken from
 * the backend's own write log rather than reconstructed here.
 */
function lastWrittenKey(backend: any): string | undefined {
  const own: Map<string, number> = backend.own;
  return own && own.size > 0 ? [...own.keys()][own.size - 1] : undefined;
}

// -- cases -----------------------------------------------------------

async function aTtlBeyondTheThirtyDayCliffSurvives(backend: any): Promise<void> {
  cases++;
  const key = uniqueKey("survives");
  await backend.set(key, { v: "beyond" }, BEYOND_CLIFF_TTL);
  const readBack = await backend.get(key);
  assert(
    "a ttl beyond the thirty day cliff survives",
    JSON.stringify(readBack) === JSON.stringify({ v: "beyond" }),
    `a ${BEYOND_CLIFF_TTL}s ttl was written raw, so memcached read it as a 1970 timestamp and the entry vanished on write (got ${JSON.stringify(readBack)})`,
  );
}

async function aTtlBeyondTheCliffKeepsItsFullLifetime(backend: any): Promise<void> {
  cases++;
  // THE LOAD-BEARING CASE. A clamp to 2592000 also survives, so only the
  // server's own reported lifetime can tell CONVERT from CLAMP.
  const key = uniqueKey("lifetime");
  await backend.set(key, { v: "full" }, BEYOND_CLIFF_TTL);
  const mcKey = lastWrittenKey(backend);
  const remaining = mcKey ? await serverRemainingTtl(mcKey) : null;
  assert(
    "a ttl beyond the cliff keeps its full lifetime",
    remaining !== null && Math.abs(remaining - BEYOND_CLIFF_TTL) <= 60,
    `the server reports ${remaining}s remaining, expected about ${BEYOND_CLIFF_TTL}s ` +
    `(${MAX_RELATIVE_EXPTIME}s would mean the ttl was CLAMPED, discarding more than half the configured lifetime)`,
  );
}

async function theThirtyDayBoundaryItselfStaysRelative(backend: any): Promise<void> {
  cases++;
  // Exactly at the cliff: memcached still reads this as relative seconds, so it
  // must NOT be converted.
  //
  // WHY THIS CASE ASSERTS ON THE COMPUTED EXPTIME AND NOT JUST THE ROUND TRIP.
  // A relative 2592000 and an absolute now+2592000 describe the SAME INSTANT,
  // so memcached reports an identical t2592000 for both and the entry survives
  // either way. A boundary assertion built only on the server's reported
  // lifetime is therefore blind to the off-by-one BY CONSTRUCTION - measured,
  // not theorised: this case was originally written that way, and mutating
  // `ttl > MAX` to `ttl >= MAX` left the whole file GREEN. The earlier comment
  // claiming it caught that off-by-one was simply false.
  //
  // The exptime computation is a pure function of its inputs, so it can be
  // asserted directly - no service, no double, nothing simulated.
  const boundary = backend.exptimeFor(MAX_RELATIVE_EXPTIME);
  const justPast = backend.exptimeFor(MAX_RELATIVE_EXPTIME + 1);
  const justUnder = backend.exptimeFor(MAX_RELATIVE_EXPTIME - 1);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const key = uniqueKey("boundary");
  await backend.set(key, { v: "boundary" }, MAX_RELATIVE_EXPTIME);
  const mcKey = lastWrittenKey(backend);
  const readBack = await backend.get(key);
  const remaining = mcKey ? await serverRemainingTtl(mcKey) : null;

  assert(
    "the thirty day boundary itself stays relative",
    boundary === MAX_RELATIVE_EXPTIME
      && justUnder === MAX_RELATIVE_EXPTIME - 1
      && justPast > nowSeconds
      && JSON.stringify(readBack) === JSON.stringify({ v: "boundary" })
      && remaining !== null && Math.abs(remaining - MAX_RELATIVE_EXPTIME) <= 60,
    `exptimeFor(${MAX_RELATIVE_EXPTIME})=${boundary} (must be exactly ${MAX_RELATIVE_EXPTIME}, i.e. still RELATIVE), ` +
    `exptimeFor(${MAX_RELATIVE_EXPTIME - 1})=${justUnder} (must be exactly ${MAX_RELATIVE_EXPTIME - 1}), ` +
    `exptimeFor(${MAX_RELATIVE_EXPTIME + 1})=${justPast} (must be an ABSOLUTE stamp, i.e. > ${nowSeconds}); ` +
    `round trip read back ${JSON.stringify(readBack)} with ${remaining}s reported remaining`,
  );
}

async function aShortTtlStillExpires(backend: any): Promise<void> {
  cases++;
  // NEGATIVE CONTROL: the conversion must not turn every ttl into a long one.
  // A real wall-clock sleep - the entry has to actually be gone.
  const key = uniqueKey("short");
  await backend.set(key, { v: "brief" }, 1);
  const immediately = await backend.get(key);
  await wait(2200);
  const afterExpiry = await backend.get(key);
  assert(
    "a short ttl still expires",
    JSON.stringify(immediately) === JSON.stringify({ v: "brief" }) && afterExpiry === undefined,
    `immediately after the write: ${JSON.stringify(immediately)} (expected the value); after the ttl lapsed: ${JSON.stringify(afterExpiry)} (expected undefined)`,
  );
}

async function theLocalWriteLogUsesTheRawTtl(backend: any): Promise<void> {
  cases++;
  // THE TRAP. The shadow map turns its stored number into a wall-clock deadline
  // with `Date.now() + value * 1000`, so it must keep the RAW ttl. Fed the
  // CONVERTED exptime it computes Date.now() + <a unix timestamp> * 1000 -
  // roughly 166 years out - and then the map never expires anything and stats()
  // reports expired entries as live forever.
  const key = uniqueKey("writelog");
  const before = Date.now();
  await backend.set(key, { v: "log" }, BEYOND_CLIFF_TTL);
  const mcKey = lastWrittenKey(backend);
  const deadline: number | undefined = mcKey ? backend.own.get(mcKey) : undefined;
  const expected = before + BEYOND_CLIFF_TTL * 1000;
  const driftSeconds = deadline === undefined ? NaN : Math.abs(deadline - expected) / 1000;
  assert(
    "the local write log uses the raw ttl",
    deadline !== undefined && driftSeconds <= 60,
    `the write log recorded a deadline ${Number.isNaN(driftSeconds) ? "(absent)" : `${Math.round(driftSeconds)}s`} away from ` +
    `now + ${BEYOND_CLIFF_TTL}s - it was fed the CONVERTED exptime, not the raw ttl`,
  );
}

async function main(): Promise<void> {
  console.log("\nCACHE CONTRACT: memcached exptime cliff (30 days / 2592000)");

  const suite: Array<[string, (backend: any) => Promise<void>]> = [
    ["a ttl beyond the thirty day cliff survives", aTtlBeyondTheThirtyDayCliffSurvives],
    ["a ttl beyond the cliff keeps its full lifetime", aTtlBeyondTheCliffKeepsItsFullLifetime],
    ["the thirty day boundary itself stays relative", theThirtyDayBoundaryItselfStaysRelative],
    ["a short ttl still expires", aShortTtlStillExpires],
    ["the local write log uses the raw ttl", theLocalWriteLogUsesTheRawTtl],
  ];

  const gate = requireServices();
  const up = await reachable(MC.host, MC.port);
  if (!up) {
    for (const [name] of suite) {
      cases++;
      if (gate) assert(name, false, "memcached not reachable and TINA4_REQUIRE_SERVICES is set");
      else skip(name, "memcached not reachable");
    }
  } else {
    for (const [name, run] of suite) {
      // A fresh backend per case: each keeps its own write log, so
      // lastWrittenKey() names this case's key and nothing else.
      let backend: any;
      try {
        backend = await realMemcached();
      } catch (err) {
        cases++;
        assert(name, false, `could not build a real memcached backend: ${(err as Error).message}`);
        continue;
      }
      try {
        await run(backend);
      } catch (err) {
        assert(name, false, `threw against real memcached: ${(err as Error).message}`);
      }
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Cases executed: ${cases}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Test harness error:", err);
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(1);
});

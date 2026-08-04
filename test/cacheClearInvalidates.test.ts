/**
 * CACHE CONTRACT - clear() really invalidates, on EVERY provider.
 *
 * Pins `clear-really-invalidates-on-every-provider` from
 * plan/v3/fixtures/cache_contract.json (ADR-0024):
 *
 *     clear() removes every entry this cache can serve, on EVERY provider. It
 *     is never a no-op, and never limited to the keys the local process
 *     happens to have written.
 *
 * WHY THIS FILE EXISTS AND THE EXISTING CACHE TESTS DID NOT CATCH IT
 *     MemcachedBackend.clear() deleted only the keys in its own in-process
 *     write log, so a SECOND instance sharing the same memcached kept serving
 *     rows the first had just invalidated. Every existing memcached assertion
 *     used ONE backend instance, so "clear removed my key" was true and the
 *     cross-instance half of the contract had no coverage at all.
 *
 *     Redis was closer - it did a scoped KEYS + DEL - but KEYS is O(N) and
 *     blocks the whole server for its duration, and clear() runs on EVERY
 *     WRITE in persistent DB-cache mode. Redis's own documentation says to
 *     prefer SCAN. A truncated or half-parsed multi-bulk SCAN reply would
 *     clear only some keys and still look green on a small test, so the page
 *     case below writes 250 keys and demands ZERO survivors.
 *
 * NOTHING HERE IS MOCKED. Every assertion is answered by a real Redis, Valkey
 * or memcached over a real TCP socket. The raw-socket helpers below are real
 * clients speaking the real wire protocol, used to prove a key OUTSIDE our
 * namespace survives a clear() - they stand in for nothing.
 *
 * SERVICE ADDRESSES (override per service to point at your own containers):
 *     TINA4_TEST_CACHE_REDIS_URL      (default redis://127.0.0.1:6379)
 *     TINA4_TEST_CACHE_VALKEY_URL     (default valkey://127.0.0.1:6380)
 *     TINA4_TEST_CACHE_MEMCACHED_URL  (default memcached://127.0.0.1:11211)
 *
 * Run with: npx tsx test/cacheClearInvalidates.test.ts
 */
import * as net from "node:net";
import * as crypto from "node:crypto";
import { createBackend } from "../packages/core/src/index.ts";
import { requireServices } from "./_serviceGate.ts";

const REDIS_URL = process.env.TINA4_TEST_CACHE_REDIS_URL ?? "redis://127.0.0.1:6379";
const VALKEY_URL = process.env.TINA4_TEST_CACHE_VALKEY_URL ?? "valkey://127.0.0.1:6380";
const MEMCACHED_URL = process.env.TINA4_TEST_CACHE_MEMCACHED_URL ?? "memcached://127.0.0.1:11211";

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

function uniqueId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function hostPort(url: string, defaultPort: number): { host: string; port: number } {
  const cleaned = url.replace(/^[a-z]+:\/\//, "").split("/")[0];
  const bits = cleaned.split(":");
  return { host: bits[0] || "127.0.0.1", port: bits[1] ? parseInt(bits[1], 10) || defaultPort : defaultPort };
}

/** Real TCP reachability probe. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(false); }, 2000);
    if (timer.unref) timer.unref();
  });
}

/**
 * One real round trip on a real socket: write the payload, collect whatever the
 * server sends back. Used ONLY to read/write keys OUTSIDE the tina4 namespace,
 * so the negative cases are answered by an INDEPENDENT client rather than by
 * the backend under test.
 */
function socketRoundTrip(host: string, port: number, payload: string, waitMs = 500): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const sock = net.createConnection({ host, port }, () => sock.write(payload));
    sock.on("data", (chunk) => { out += chunk.toString("utf-8"); });
    sock.on("error", () => { try { sock.destroy(); } catch { /* noop */ } resolve(out); });
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(out); }, waitMs);
    if (timer.unref) timer.unref();
  });
}

/** Encode one RESP command (array of bulk strings) for the raw helper above. */
function respEncode(...args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const arg of args) out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  return out;
}

/**
 * Build a backend through the REAL public factory and refuse a silent
 * downgrade. createBackend() falls back to the file backend when the service is
 * unreachable, which would make every assertion below pass against local disk
 * and prove nothing about redis/valkey/memcached. Checking name() makes that
 * false green impossible.
 */
async function realBackend(backend: string, cacheUrl: string): Promise<any> {
  const made: any = await createBackend({ backend, cacheUrl });
  if (made.name() !== backend) {
    throw new Error(
      `createBackend('${backend}') returned '${made.name()}' - the service was ` +
      "unreachable and the cache fell back; these assertions would prove nothing",
    );
  }
  return made;
}

// -- redis / valkey -------------------------------------------------

async function clearOnTheRawRespTransportIsNotANoOp(): Promise<void> {
  cases++;
  const backend = await realBackend("redis", REDIS_URL);
  const key = `contract-${uniqueId()}`;
  await backend.set(key, { row: "before" }, 300);
  assert(
    "clear on the raw resp transport is not a no op: precondition, the value is cached",
    JSON.stringify(await backend.get(key)) === JSON.stringify({ row: "before" }),
  );

  await backend.clear();

  assert(
    "clear on the raw resp transport is not a no op",
    (await backend.get(key)) === undefined,
    "clear() left the entry readable, so a write never invalidates the cache",
  );
}

async function clearRemovesEntriesWrittenByAnotherInstance(): Promise<void> {
  cases++;
  // Two independent backends, two independent sockets - the shape of two Tina4
  // instances sharing one Redis.
  const writer = await realBackend("redis", REDIS_URL);
  const clearer = await realBackend("redis", REDIS_URL);

  const key = `contract-${uniqueId()}`;
  await writer.set(key, { row: "from-instance-a" }, 300);
  assert(
    "clear removes entries written by another instance: precondition, shared visibility",
    JSON.stringify(await clearer.get(key)) === JSON.stringify({ row: "from-instance-a" }),
  );

  await clearer.clear();

  assert(
    "clear removes entries written by another instance",
    (await writer.get(key)) === undefined,
    "clear() on instance B left instance A's entry readable",
  );
}

async function clearLeavesAnotherTenantsKeysUntouched(): Promise<void> {
  cases++;
  // NEGATIVE: removing every entry THIS cache can serve is the rule; removing
  // every key on a shared Redis is a different and far worse thing.
  const { host, port } = hostPort(REDIS_URL, 6379);
  const backend = await realBackend("redis", REDIS_URL);
  const outsiderKey = `someone-elses-app:${uniqueId()}`;
  await socketRoundTrip(host, port, respEncode("SET", outsiderKey, "not-ours"));

  await backend.set(`contract-${uniqueId()}`, { row: 1 }, 300);
  await backend.clear();

  const survived = await socketRoundTrip(host, port, respEncode("GET", outsiderKey));
  assert(
    "clear leaves another tenants keys untouched",
    survived.includes("not-ours"),
    `clear() destroyed a key outside the tina4 prefix (reply: ${JSON.stringify(survived.slice(0, 40))})`,
  );
  await socketRoundTrip(host, port, respEncode("DEL", outsiderKey));
}

async function clearRemovesManyEntriesNotJustTheFirstPage(): Promise<void> {
  cases++;
  // A single SCAN page, or a multi-bulk reply the parser truncates, would clear
  // some of these and still look green on a one-key test.
  //
  // TWO ROUNDS, and the second one is the one that earns this case its name.
  // MEASURED against a real Redis 7.4.10: 250 keys come back in exactly ONE
  // SCAN page at COUNT 500, so a single-page implementation passes the 250-key
  // round. 2000 keys span FOUR pages, so only that round can catch a scan that
  // stops at the first page or a cursor loop that never iterates.
  const backend = await realBackend("redis", REDIS_URL);

  for (const total of [250, 2000]) {
    const marker = uniqueId();
    const keys = Array.from({ length: total }, (_unused, index) => `contract-${marker}-${index}`);
    // Chunked so a burst of pipelined commands cannot outrun the socket.
    for (let start = 0; start < keys.length; start += 100) {
      await Promise.all(keys.slice(start, start + 100).map((key) => backend.set(key, { i: key }, 300)));
    }

    await backend.clear();

    let survivors = 0;
    for (let start = 0; start < keys.length; start += 100) {
      const readBack = await Promise.all(keys.slice(start, start + 100).map((key) => backend.get(key)));
      survivors += readBack.filter((value) => value !== undefined).length;
    }
    const label = total === 250
      ? "clear removes many entries not just the first page"
      : "clear removes many entries not just the first page: 2000 keys span several SCAN pages";
    assert(
      label,
      survivors === 0,
      `${survivors} of ${keys.length} entries survived clear() - the reply was truncated or the scan stopped after one page`,
    );
  }
}

async function statsReportsARealSizeOnBothTransports(): Promise<void> {
  cases++;
  // PARITY REGRESSION TEST, not one of the declared contract invariants.
  // stats().size used to come from DBSIZE, which counts the WHOLE database
  // index - so on a shared Redis it reported every other tenant's keys too.
  // Ruby and Python had the same rule broken the other way round (a constant
  // 0). The number must describe THIS cache.
  const { host, port } = hostPort(REDIS_URL, 6379);
  const backend = await realBackend("redis", REDIS_URL);

  await backend.clear();
  const emptySize = (await backend.stats()).size;

  const marker = uniqueId();
  for (let index = 0; index < 3; index++) {
    await backend.set(`contract-${marker}-${index}`, { i: index }, 300);
  }
  const populatedSize = (await backend.stats()).size;

  // NEGATIVE: a key OUTSIDE our prefix must not be counted. This is the exact
  // failure DBSIZE produced.
  const outsiderKey = `someone-elses-app:${uniqueId()}`;
  await socketRoundTrip(host, port, respEncode("SET", outsiderKey, "not-ours"));
  const sizeWithOutsider = (await backend.stats()).size;
  await socketRoundTrip(host, port, respEncode("DEL", outsiderKey));

  await backend.clear();
  const clearedSize = (await backend.stats()).size;

  assert(
    "stats reports a real size on both transports",
    emptySize === 0 && populatedSize === 3 && sizeWithOutsider === 3 && clearedSize === 0,
    `size was ${emptySize} when empty (expected 0), ${populatedSize} after 3 writes (expected 3), ` +
    `${sizeWithOutsider} with another tenant's key present (expected 3 - it is counting keys outside our prefix), ` +
    `${clearedSize} after clear() (expected 0)`,
  );
}

async function clearInvalidatesOnValkeyToo(): Promise<void> {
  cases++;
  const backend = await realBackend("valkey", VALKEY_URL);
  const key = `contract-${uniqueId()}`;
  await backend.set(key, { row: "before" }, 300);
  assert(
    "clear invalidates on valkey too: precondition, the value is cached",
    JSON.stringify(await backend.get(key)) === JSON.stringify({ row: "before" }),
  );

  await backend.clear();

  assert(
    "clear invalidates on valkey too",
    (await backend.get(key)) === undefined,
    "clear() is a no-op on valkey",
  );
}

// -- memcached ------------------------------------------------------

async function memcachedClearInvalidatesForASecondInstance(): Promise<void> {
  cases++;
  // THE MEASURED DEFECT: clear() deleted only the keys the LOCAL process wrote,
  // so a second instance kept serving stale rows.
  const writer = await realBackend("memcached", MEMCACHED_URL);
  const clearer = await realBackend("memcached", MEMCACHED_URL);

  const key = `contract-${uniqueId()}`;
  await writer.set(key, { row: "from-instance-a" }, 300);
  assert(
    "memcached clear invalidates for a second instance: precondition, shared visibility",
    JSON.stringify(await clearer.get(key)) === JSON.stringify({ row: "from-instance-a" }),
  );

  await clearer.clear();

  assert(
    "memcached clear invalidates for a second instance",
    (await writer.get(key)) === undefined,
    "clear() on instance B left instance A's entry readable - no cross-instance invalidation",
  );
}

async function memcachedClearLeavesAnotherTenantsKeysUntouched(): Promise<void> {
  cases++;
  // NEGATIVE: clear() must never be a global flush_all. flush_all wipes every
  // key on the instance, including every other application's.
  const { host, port } = hostPort(MEMCACHED_URL, 11211);
  const backend = await realBackend("memcached", MEMCACHED_URL);
  const outsiderKey = `someone-elses-app-${uniqueId()}`;
  const payload = "not-ours";
  await socketRoundTrip(host, port, `set ${outsiderKey} 0 300 ${payload.length}\r\n${payload}\r\n`);

  await backend.set(`contract-${uniqueId()}`, { row: 1 }, 300);
  await backend.clear();

  const survived = await socketRoundTrip(host, port, `get ${outsiderKey}\r\n`);
  assert(
    "memcached clear leaves another tenants keys untouched",
    survived.includes("not-ours"),
    `clear() destroyed a key outside the tina4 namespace (reply: ${JSON.stringify(survived.slice(0, 40))})`,
  );
  await socketRoundTrip(host, port, `delete ${outsiderKey}\r\n`);
}

async function memcachedEntriesWrittenBeforeAClearStayInvalid(): Promise<void> {
  cases++;
  // Guards the namespace generation against an in-process cache going stale: a
  // brand-new instance (a fresh process) must miss too, and the namespace must
  // stay usable rather than permanently poisoned.
  const writer = await realBackend("memcached", MEMCACHED_URL);
  const key = `contract-${uniqueId()}`;
  await writer.set(key, { row: "before" }, 300);
  await writer.clear();

  const fresh = await realBackend("memcached", MEMCACHED_URL);
  assert(
    "memcached entries written before a clear stay invalid",
    (await fresh.get(key)) === undefined,
    "a process that started AFTER the clear can still read the cleared entry",
  );

  await writer.set(key, { row: "after" }, 300);
  const afterReader = await realBackend("memcached", MEMCACHED_URL);
  assert(
    "memcached entries written before a clear stay invalid: the namespace is still usable",
    JSON.stringify(await afterReader.get(key)) === JSON.stringify({ row: "after" }),
    "a value written AFTER the clear is unreadable - the namespace was poisoned",
  );
}

async function memcachedClearDoesNotStrandLiveEntriesFromOtherKeys(): Promise<void> {
  cases++;
  // NEGATIVE: a generation bump must not break later writes/reads (the classic
  // off-by-one where the reader and the writer disagree about the generation).
  const backend = await realBackend("memcached", MEMCACHED_URL);
  await backend.clear();
  const keys = Array.from({ length: 5 }, () => `contract-${uniqueId()}`);
  for (let index = 0; index < keys.length; index++) {
    await backend.set(keys[index], { i: index }, 300);
  }
  let allReadBack = true;
  for (let index = 0; index < keys.length; index++) {
    if (JSON.stringify(await backend.get(keys[index])) !== JSON.stringify({ i: index })) allReadBack = false;
  }
  assert(
    "memcached clear does not strand live entries from other keys",
    allReadBack,
    "write and read disagree after a clear",
  );
  const size = (await backend.stats()).size;
  assert(
    "memcached clear does not strand live entries from other keys: stats count our live entries",
    size === keys.length,
    `stats().size was ${size}, expected ${keys.length}`,
  );
}

// -- driver ---------------------------------------------------------

async function main(): Promise<void> {
  const gate = requireServices();
  console.log("\nCACHE CONTRACT: clear-really-invalidates-on-every-provider (ADR-0024)");
  console.log(`  redis=${REDIS_URL} valkey=${VALKEY_URL} memcached=${MEMCACHED_URL}`);

  const redis = hostPort(REDIS_URL, 6379);
  const valkey = hostPort(VALKEY_URL, 6379);
  const memcached = hostPort(MEMCACHED_URL, 11211);
  const redisUp = await reachable(redis.host, redis.port);
  const valkeyUp = await reachable(valkey.host, valkey.port);
  const memcachedUp = await reachable(memcached.host, memcached.port);

  const redisCases: Array<[string, () => Promise<void>]> = [
    ["clear on the raw resp transport is not a no op", clearOnTheRawRespTransportIsNotANoOp],
    ["clear removes entries written by another instance", clearRemovesEntriesWrittenByAnotherInstance],
    ["clear leaves another tenants keys untouched", clearLeavesAnotherTenantsKeysUntouched],
    ["clear removes many entries not just the first page", clearRemovesManyEntriesNotJustTheFirstPage],
    ["stats reports a real size on both transports", statsReportsARealSizeOnBothTransports],
  ];
  const valkeyCases: Array<[string, () => Promise<void>]> = [
    ["clear invalidates on valkey too", clearInvalidatesOnValkeyToo],
  ];
  const memcachedCases: Array<[string, () => Promise<void>]> = [
    ["memcached clear invalidates for a second instance", memcachedClearInvalidatesForASecondInstance],
    ["memcached clear leaves another tenants keys untouched", memcachedClearLeavesAnotherTenantsKeysUntouched],
    ["memcached entries written before a clear stay invalid", memcachedEntriesWrittenBeforeAClearStayInvalid],
    ["memcached clear does not strand live entries from other keys", memcachedClearDoesNotStrandLiveEntriesFromOtherKeys],
  ];

  const plan: Array<[string, boolean, string, Array<[string, () => Promise<void>]>]> = [
    ["redis", redisUp, "redis not reachable", redisCases],
    ["valkey", valkeyUp, "valkey not reachable", valkeyCases],
    ["memcached", memcachedUp, "memcached not reachable", memcachedCases],
  ];

  for (const [service, up, reason, group] of plan) {
    for (const [name, run] of group) {
      if (!up) {
        // A skip is a failure when the services are required - never a quiet pass.
        if (gate) assert(name, false, `${reason} and TINA4_REQUIRE_SERVICES is set`);
        else skip(name, reason);
        continue;
      }
      try {
        await run();
      } catch (err) {
        assert(name, false, `threw against real ${service}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Cases executed: ${cases}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  // Flush before exiting: process.exit() truncates a pipe mid-write, and the
  // runner reads this file's summary line out of that pipe.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Test harness error:", err);
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(1);
});

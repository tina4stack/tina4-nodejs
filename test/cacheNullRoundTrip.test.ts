/**
 * CACHE CONTRACT - a cached null round-trips as null.
 *
 * Pins `a-cached-null-round-trips-as-null` from
 * plan/v3/fixtures/cache_contract.json (ADR-0024):
 *
 *     A value stored as null comes back as null on every provider. The cache
 *     never turns a stored absence into a presence, and never leaks its own
 *     storage envelope to the caller.
 *
 * THE MEASURED DEFECT (Node's file backend)
 *     FileBackend.get() ended `return data.value ?? data`. `data` is the
 *     STORAGE ENVELOPE {key, value, expiresAt}. For a cached null, data.value
 *     is null, so `??` fell through and handed the caller the envelope: an
 *     OBJECT, which is truthy, where the caller had stored nothing. Every
 *     `if (cached)` then took the hit branch with a meaningless object, so the
 *     cache converted "this lookup found nothing" into "this lookup found
 *     something". Caching a negative lookup is the most common reason to cache
 *     a null at all, so it was wrong exactly where the feature gets used.
 *
 * THE NEGATIVE HALF THAT MATTERS
 *     false, 0, "" and [] are VALUES, not absences. A fix built on falsiness
 *     (`data.value === undefined ? ...` is fine, `if (!data.value)` is not)
 *     breaks every one of them, so they are asserted on every provider too.
 *
 * NOTHING HERE IS MOCKED - all SEVEN providers are real: in-process memory,
 * real files on disk, a real SQLite database, and real Redis / Valkey /
 * memcached / MongoDB over real sockets.
 *
 * Run with: npx tsx test/cacheNullRoundTrip.test.ts
 */
import * as crypto from "node:crypto";
import { providerSpecs, reachable, makeReal, type ProviderSpec } from "./_cacheProviders.ts";
import { requireServices } from "./_serviceGate.ts";

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
  return `nullrt-${label}-${crypto.randomBytes(12).toString("hex")}`;
}

// -- the five cases, each run against every real provider ------------

async function aCachedNullComesBackAsNull(backend: any, provider: string): Promise<void> {
  const key = uniqueKey("plain");
  await backend.set(key, null, 300);
  const got = await backend.get(key);
  assert(
    `a cached null comes back as null [${provider}]`,
    got === null,
    `expected null, got ${JSON.stringify(got)} (typeof ${typeof got})`,
  );
}

async function aCachedNullIsNotTheStorageEnvelope(backend: any, provider: string): Promise<void> {
  // THE DEFECT, stated directly: the caller must never receive the storage
  // envelope. An object here is truthy, so `if (cached)` turns a cached
  // absence into a presence.
  const key = uniqueKey("envelope");
  await backend.set(key, null, 300);
  const got: any = await backend.get(key);
  const leaked = got !== null && typeof got === "object"
    && ("expiresAt" in got || "value" in got || "key" in got);
  assert(
    `a cached null is not the storage envelope [${provider}]`,
    !leaked,
    `the backend leaked its envelope: ${JSON.stringify(got)}`,
  );
  assert(
    `a cached null is not the storage envelope: it is falsy to the caller [${provider}]`,
    !got,
    `a cached null must not be truthy, got ${JSON.stringify(got)}`,
  );
}

async function aCachedNullIsAHitNotAMiss(backend: any, provider: string): Promise<void> {
  const key = uniqueKey("hit");
  await backend.set(key, null, 300);
  const before = await backend.stats();
  await backend.get(key);
  const after = await backend.stats();
  assert(
    `a cached null is a hit not a miss [${provider}]`,
    after.hits === before.hits + 1 && after.misses === before.misses,
    `hits ${before.hits}->${after.hits}, misses ${before.misses}->${after.misses}`,
  );
}

async function aMissingKeyIsStillAMiss(backend: any, provider: string): Promise<void> {
  // NEGATIVE: a stored null and a key that was never written are DIFFERENT.
  // A fix that made everything return null would pass the cases above and
  // destroy the distinction the cache exists to draw.
  const key = uniqueKey("absent");
  const before = await backend.stats();
  const got = await backend.get(key);
  const after = await backend.stats();
  assert(
    `a missing key is still a miss [${provider}]`,
    got === undefined && after.misses === before.misses + 1 && after.hits === before.hits,
    `expected undefined + a miss, got ${JSON.stringify(got)} (hits ${before.hits}->${after.hits}, misses ${before.misses}->${after.misses})`,
  );
}

async function otherFalsyValuesRoundTripIntact(backend: any, provider: string): Promise<void> {
  // NEGATIVE: false / 0 / "" / [] / {} are VALUES. A null fix built on
  // truthiness silently breaks all of them.
  const falsy: Array<[string, unknown]> = [
    ["false", false],
    ["zero", 0],
    ["empty string", ""],
    ["empty array", []],
    ["empty object", {}],
  ];
  let allIntact = true;
  const broken: string[] = [];
  for (const [label, value] of falsy) {
    const key = uniqueKey(`falsy-${label.replace(/\s+/g, "-")}`);
    await backend.set(key, value, 300);
    const got = await backend.get(key);
    const same = JSON.stringify(got) === JSON.stringify(value) && typeof got === typeof value;
    if (!same) {
      allIntact = false;
      broken.push(`${label}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`);
    }
  }
  assert(
    `other falsy values round trip intact [${provider}]`,
    allIntact,
    broken.join("; "),
  );
}

const CASES: Array<[string, (backend: any, provider: string) => Promise<void>]> = [
  ["a cached null comes back as null", aCachedNullComesBackAsNull],
  ["a cached null is not the storage envelope", aCachedNullIsNotTheStorageEnvelope],
  ["a cached null is a hit not a miss", aCachedNullIsAHitNotAMiss],
  ["a missing key is still a miss", aMissingKeyIsStillAMiss],
  ["other falsy values round trip intact", otherFalsyValuesRoundTripIntact],
];

async function main(): Promise<void> {
  const gate = requireServices();
  console.log("\nCACHE CONTRACT: a-cached-null-round-trips-as-null (ADR-0024)");

  for (const spec of providerSpecs() as ProviderSpec[]) {
    const up = await reachable(spec);
    if (!up) {
      for (const [name] of CASES) {
        cases++;
        // A skip is a failure when the services are required - never a quiet pass.
        if (gate) assert(`${name} [${spec.name}]`, false, `${spec.name} not reachable and TINA4_REQUIRE_SERVICES is set`);
        else skip(`${name} [${spec.name}]`, `${spec.name} not reachable`);
      }
      continue;
    }
    let backend: any;
    try {
      backend = await makeReal(spec);
    } catch (err) {
      for (const [name] of CASES) {
        cases++;
        assert(`${name} [${spec.name}]`, false, `could not build a real backend: ${(err as Error).message}`);
      }
      continue;
    }
    for (const [name, run] of CASES) {
      cases++;
      try {
        await run(backend, spec.name);
      } catch (err) {
        assert(`${name} [${spec.name}]`, false, `threw against real ${spec.name}: ${(err as Error).message}`);
      }
    }
    try { await backend.clear(); } catch { /* best effort cleanup */ }
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

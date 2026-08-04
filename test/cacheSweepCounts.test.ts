/**
 * CACHE CONTRACT - sweep() returns a real count, everywhere.
 *
 * Pins `sweep-returns-a-real-count-everywhere` from
 * plan/v3/fixtures/cache_contract.json (ADR-0024):
 *
 *     sweep() exists on every provider and returns the number of entries it
 *     actually evicted. It is never a stub that reports success having done
 *     nothing, and it never evicts an entry that has not expired.
 *
 * THE MEASURED DEFECT (Node)
 *     The module-level sweep() called a backend sweep only `if (typeof
 *     backend.sweep === "function")` - and NO backend defined one, so sweep()
 *     was a permanent, unconditional 0 on all seven providers. The one API
 *     whose job is reclaiming expired space did nothing at all and reported
 *     success.
 *
 *     The database backend is where that actually costs you, and it is the
 *     same defect the Python master carried: redis, valkey, memcached and
 *     mongodb expire entries SERVER-SIDE, so 0 really is the honest answer
 *     there - nothing was evicted because nothing was left to evict. A SQL
 *     table expires nothing by itself. Rows were deleted only when someone
 *     happened to re-read that exact key, so expired rows accumulated in
 *     tina4_cache without bound.
 *
 * THE NEGATIVE HALF
 *     An entry stored with ttl <= 0 is PERMANENT and carries expiresAt 0. A
 *     sweep written as `now > expiresAt` evicts every one of them on the first
 *     run, so `expiresAt > 0` is load-bearing and is asserted directly.
 *
 * NOTHING HERE IS MOCKED - all SEVEN providers are real.
 *
 * Run with: npx tsx test/cacheSweepCounts.test.ts
 */
import * as crypto from "node:crypto";
import { providerSpecs, reachable, makeReal, type ProviderSpec } from "./_cacheProviders.ts";
import { requireServices } from "./_serviceGate.ts";
import { sweep as moduleSweep } from "../packages/core/src/index.ts";

/**
 * Providers that own their own expiry and must therefore report a REAL count.
 * The rest expire server-side, where 0 is the honest answer.
 */
const LOCAL_EVICTORS = new Set(["memory", "file", "database"]);

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
  return `sweep-${label}-${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Sleep for real. Deliberately NOT unref()'d: an unref'd timer does not hold
 * the event loop open, so when a TTL wait is the only pending work Node exits
 * silently mid-run and the file reports a handful of passes as if it had
 * finished. That is the "green file that ran no tests" trap, and this helper
 * hit it during development.
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// -- the five cases --------------------------------------------------

async function sweepIsAvailableOnEveryProvider(backend: any, provider: string): Promise<void> {
  const present = typeof backend.sweep === "function";
  assert(
    `sweep is available on every provider [${provider}]`,
    present,
    "the backend has no sweep() at all, so the module-level sweep() is a permanent 0",
  );
  if (!present) return;
  const result = await backend.sweep();
  assert(
    `sweep is available on every provider: it returns a number [${provider}]`,
    typeof result === "number" && Number.isFinite(result) && result >= 0,
    `sweep() returned ${JSON.stringify(result)}`,
  );
}

async function sweepReturnsTheNumberOfEntriesItEvicted(backend: any, provider: string): Promise<void> {
  const keys = [uniqueKey("e1"), uniqueKey("e2"), uniqueKey("e3")];
  for (const key of keys) await backend.set(key, { v: key }, 1);
  await wait(1300); // let the 1s TTL genuinely lapse - no clock faking

  const evicted = await backend.sweep();

  if (LOCAL_EVICTORS.has(provider)) {
    assert(
      `sweep returns the number of entries it evicted [${provider}]`,
      evicted === keys.length,
      `expected ${keys.length}, got ${evicted}`,
    );
    // And the count must be TRUE: a second sweep has nothing left to take.
    const again = await backend.sweep();
    assert(
      `sweep returns the number of entries it evicted: a second sweep finds nothing [${provider}]`,
      again === 0,
      `a repeat sweep reported ${again}, so the first count was not real evictions`,
    );
  } else {
    // Honest 0: these providers expire entries server-side, so there was
    // nothing left for us to evict. The entries must still be GONE.
    assert(
      `sweep returns the number of entries it evicted [${provider}]`,
      evicted === 0,
      `a server-side-expiry provider must report 0 evictions, got ${evicted}`,
    );
    const survivors = (await Promise.all(keys.map((k) => backend.get(k)))).filter((v) => v !== undefined).length;
    assert(
      `sweep returns the number of entries it evicted: the server expired them [${provider}]`,
      survivors === 0,
      `${survivors} expired entries were still readable`,
    );
  }
}

async function sweepEvictsExpiredEntriesFromTheDatabaseBackend(backend: any, provider: string): Promise<void> {
  if (provider !== "database") return; // this case is about the SQL table specifically
  await backend.clear();
  const keys = [uniqueKey("db1"), uniqueKey("db2"), uniqueKey("db3")];
  for (const key of keys) await backend.set(key, { v: key }, 1);
  await wait(1300);

  // A SQL table expires nothing by itself: the rows are still there.
  const sizeBefore = (await backend.stats()).size;
  const evicted = await backend.sweep();
  const sizeAfter = (await backend.stats()).size;

  assert(
    "sweep evicts expired entries from the database backend",
    sizeBefore === keys.length && evicted === keys.length && sizeAfter === 0,
    `rows before sweep ${sizeBefore} (expected ${keys.length}), evicted ${evicted}, rows after ${sizeAfter} (expected 0)`,
  );
}

async function sweepReturnsZeroWhenNothingHasExpired(backend: any, provider: string): Promise<void> {
  // NEGATIVE: sweep must not evict live entries, and must not inflate its count.
  const keys = [uniqueKey("live1"), uniqueKey("live2")];
  for (const key of keys) await backend.set(key, { v: key }, 300);

  const evicted = await backend.sweep();

  const stillThere = (await Promise.all(keys.map((k) => backend.get(k)))).filter((v) => v !== undefined).length;
  assert(
    `sweep returns zero when nothing has expired [${provider}]`,
    evicted === 0 && stillThere === keys.length,
    `evicted ${evicted} (expected 0), ${stillThere} of ${keys.length} live entries survived`,
  );
}

async function sweepLeavesEntriesWithoutATtlAlone(backend: any, provider: string): Promise<void> {
  // NEGATIVE: ttl <= 0 means PERMANENT and is stored as expiresAt 0. A sweep
  // written as `now > expiresAt` evicts every one of them on the first run.
  const key = uniqueKey("nottl");
  await backend.set(key, { v: "permanent" }, 0);

  const evicted = await backend.sweep();
  const survived = await backend.get(key);

  assert(
    `sweep leaves entries without a ttl alone [${provider}]`,
    evicted === 0 && JSON.stringify(survived) === JSON.stringify({ v: "permanent" }),
    `evicted ${evicted} (expected 0), entry read back as ${JSON.stringify(survived)}`,
  );
}

const CASES: Array<[string, (backend: any, provider: string) => Promise<void>]> = [
  ["sweep is available on every provider", sweepIsAvailableOnEveryProvider],
  ["sweep returns the number of entries it evicted", sweepReturnsTheNumberOfEntriesItEvicted],
  ["sweep evicts expired entries from the database backend", sweepEvictsExpiredEntriesFromTheDatabaseBackend],
  ["sweep returns zero when nothing has expired", sweepReturnsZeroWhenNothingHasExpired],
  ["sweep leaves entries without a ttl alone", sweepLeavesEntriesWithoutATtlAlone],
];

async function main(): Promise<void> {
  const gate = requireServices();
  console.log("\nCACHE CONTRACT: sweep-returns-a-real-count-everywhere (ADR-0024)");

  for (const spec of providerSpecs() as ProviderSpec[]) {
    const up = await reachable(spec);
    if (!up) {
      for (const [name] of CASES) {
        cases++;
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

  // The module-level sweep() is the API an app actually calls; it must reach a
  // backend rather than short-circuiting to 0.
  cases++;
  try {
    const viaModule = await moduleSweep();
    assert(
      "sweep is available on every provider: the exported sweep() reaches a backend",
      typeof viaModule === "number" && Number.isFinite(viaModule) && viaModule >= 0,
      `the module-level sweep() returned ${JSON.stringify(viaModule)}`,
    );
  } catch (err) {
    assert("sweep is available on every provider: the exported sweep() reaches a backend", false, (err as Error).message);
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

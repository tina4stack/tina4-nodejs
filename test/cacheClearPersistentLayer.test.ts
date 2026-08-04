/**
 * CACHE CONTRACT - cache clear clears the PERSISTENT layer.
 *
 * Pins `cache-clear-clears-the-persistent-layer` from
 * plan/v3/fixtures/cache_contract.json (ADR-0024):
 *
 *     Database.cacheClear() empties BOTH layers - the in-process query cache
 *     and the shared persistent backend. It is not a no-op in the mode where
 *     the cache is shared.
 *
 * NODE WAS ALREADY CORRECT HERE - measured, not assumed. The defect this
 * invariant was written for is the Python master's: its cache_clear() cleared
 * only the in-process dict, so with TINA4_DB_CACHE=true it was a no-op on every
 * provider - clearing after a bulk import appeared to work in development
 * (where the cache IS in-process) and did nothing in production (where it is
 * shared). Node's cacheClear() already routed to the backend. These cases are
 * therefore PARITY LOCK-IN, and they are mutation-proved to be real gates, not
 * decoration.
 *
 * HOW THE ASSERTION IS MADE: by counting entries in the REAL Redis over a real
 * socket, never by reconstructing the cache key. A test that rebuilds the key
 * goes quietly green the day the key format changes - which it just did, in the
 * database-identity commit.
 *
 * FIRE-AND-FORGET: Node's cacheClear() is synchronous by contract and dispatches
 * the backend clear without awaiting it. The suite measures that window and
 * prints it as a NOTE rather than asserting it, because locking the race in as
 * expected behaviour would be the wrong thing to pin.
 *
 * Run with: npx tsx test/cacheClearPersistentLayer.test.ts
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.ts";
import { REDIS_URL } from "./_cacheProviders.ts";
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

const RUN_ID = `${process.pid}_${Date.now()}`;
const tempFiles: string[] = [];

/** FOUR slashes: `sqlite://` + an absolute path is the RELATIVE form. */
function sqliteUrl(label: string): string {
  const file = path.join(os.tmpdir(), `tina4_clearpersist_${RUN_ID}_${label}.db`);
  tempFiles.push(file);
  return `sqlite:///${file}`;
}

function hostPort(url: string, defaultPort: number): { host: string; port: number } {
  const bits = url.replace(/^[a-z+]+:\/\//, "").split("/")[0].split(":");
  return { host: bits[0] || "127.0.0.1", port: bits[1] ? parseInt(bits[1], 10) || defaultPort : defaultPort };
}

const REDIS = hostPort(REDIS_URL, 6379);

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(false); }, 2000);
    if (timer.unref) timer.unref();
  });
}

/**
 * Count the cache entries that actually exist in the REAL Redis, by asking the
 * server over its own protocol. Independent of the framework's key format on
 * purpose: reconstructing the key would make this test agree with whatever the
 * code does instead of checking it.
 */
function countCacheKeys(): Promise<number> {
  return new Promise((resolve) => {
    const payload = "*2\r\n$4\r\nKEYS\r\n$13\r\ntina4:cache:*\r\n";
    let out = "";
    const sock = net.createConnection({ host: REDIS.host, port: REDIS.port }, () => sock.write(payload));
    sock.on("data", (chunk) => {
      out += chunk.toString("utf-8");
      const head = out.split("\r\n")[0];
      if (!head.startsWith("*")) return;
      const declared = parseInt(head.slice(1), 10);
      if (!Number.isFinite(declared)) { sock.destroy(); resolve(0); return; }
      // A complete reply has 2 lines per key after the header, plus a trailer.
      if (out.split("\r\n").length >= 1 + declared * 2) { sock.destroy(); resolve(declared); }
    });
    sock.on("error", () => { try { sock.destroy(); } catch { /* noop */ } resolve(-1); });
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(-1); }, 4000);
    if (timer.unref) timer.unref();
  });
}

function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function persistentRedisEnv(): Record<string, string | undefined> {
  return {
    TINA4_DB_CACHE: "true",
    TINA4_DB_CACHE_BACKEND: "redis",
    TINA4_DB_CACHE_URL: REDIS_URL,
    TINA4_DB_CACHE_TTL: "300",
    TINA4_AUTO_CACHING: undefined,
  };
}

/** A database with one table and one cached read already in the shared backend. */
async function seeded(label: string): Promise<any> {
  const db = await initDatabase({ url: sqliteUrl(label) });
  await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
  await db.execute("INSERT INTO t (n) VALUES ('one')");
  return db;
}

// -- cases -----------------------------------------------------------

async function cacheClearClearsThePersistentBackend(): Promise<void> {
  cases++;
  await withEnv(persistentRedisEnv(), async () => {
    closeDatabase();
    const db = await seeded("a");
    db.cacheClear();
    await settle();

    await db.fetch("SELECT n FROM t ORDER BY id");
    await settle();
    const populated = await countCacheKeys();

    db.cacheClear();
    // The immediate read measures the fire-and-forget window; the settled read
    // is the invariant.
    const immediate = await countCacheKeys();
    await settle();
    const afterClear = await countCacheKeys();

    assert(
      "cache clear clears the persistent backend",
      populated > 0 && afterClear === 0,
      `entries in the real redis: ${populated} after a cached read, ${afterClear} after cacheClear() (expected >0 then 0)`,
    );
    console.log(
      `  \x1b[36mNOTE\x1b[0m cacheClear() is fire-and-forget: ${immediate} entr${immediate === 1 ? "y" : "ies"} still present ` +
      "the instant it returned, 0 after settling. A caller cannot observe the clear deterministically.",
    );
    closeDatabase();
  });
}

async function cacheClearIsVisibleToAnotherInstance(): Promise<void> {
  cases++;
  await withEnv(persistentRedisEnv(), async () => {
    closeDatabase();
    const writer = await seeded("b");
    await writer.fetch("SELECT n FROM t ORDER BY id");
    await settle();
    const populated = await countCacheKeys();

    // A DIFFERENT Database instance clears - the shape of a second worker.
    const clearer = await initDatabase({ url: sqliteUrl("b2") });
    clearer.cacheClear();
    await settle();
    const afterClear = await countCacheKeys();

    assert(
      "cache clear is visible to another instance",
      populated > 0 && afterClear === 0,
      `entries in the real redis: ${populated} before, ${afterClear} after another instance cleared (expected >0 then 0)`,
    );
    closeDatabase();
  });
}

async function cacheClearLeavesTheBackendUsable(): Promise<void> {
  cases++;
  // NEGATIVE: clearing must not poison the cache. A clear that left the backend
  // unusable would look identical to a working one until the next read.
  await withEnv(persistentRedisEnv(), async () => {
    closeDatabase();
    const db = await seeded("c");
    db.cacheClear();
    await settle();

    const rows: any = await db.fetch("SELECT n FROM t ORDER BY id");
    await settle();
    const repopulated = await countCacheKeys();
    const value = (rows?.records ?? rows ?? [])[0]?.n;

    assert(
      "cache clear leaves the backend usable",
      value === "one" && repopulated > 0,
      `read back '${value}' (expected 'one') and ${repopulated} entries were re-cached (expected >0)`,
    );
    closeDatabase();
  });
}

async function cacheClearWithoutAPersistentBackendIsSafe(): Promise<void> {
  cases++;
  // NEGATIVE: the no-persistent-backend path must not throw. Python's bug was
  // the mirror of this - it only ever touched the in-process layer.
  await withEnv({
    TINA4_DB_CACHE: undefined,
    TINA4_DB_CACHE_BACKEND: undefined,
    TINA4_DB_CACHE_URL: undefined,
    TINA4_AUTO_CACHING: "true",
    TINA4_AUTO_CACHING_TTL: "5",
  }, async () => {
    closeDatabase();
    const db = await seeded("d");
    await db.fetch("SELECT n FROM t ORDER BY id");

    let threw = "";
    try {
      db.cacheClear();
      db.cacheClear(); // twice: an idempotent clear must stay safe
    } catch (err) {
      threw = (err as Error).message;
    }

    // The re-read must be a MISS. Reading cacheStats() BEFORE re-reading is the
    // trap: cacheClear() resets the counters either way, so a stats check on its
    // own passes even when the in-process cache was never emptied. Only the
    // read AFTER the clear can tell those apart - it is a hit if the entry
    // survived, a miss if the clear was real.
    const rows: any = await db.fetch("SELECT n FROM t ORDER BY id");
    const stats = db.cacheStats();
    const value = (rows?.records ?? rows ?? [])[0]?.n;

    assert(
      "cache clear without a persistent backend is safe",
      threw === "" && stats.hits === 0 && stats.misses >= 1 && value === "one",
      `threw="${threw}", stats=${JSON.stringify(stats)} (expected hits 0 and misses >= 1 - a hit means the in-process cache was not cleared), read back '${value}' (expected 'one')`,
    );
    closeDatabase();
  });
}

async function main(): Promise<void> {
  console.log("\nCACHE CONTRACT: cache-clear-clears-the-persistent-layer (ADR-0024)");

  const suite: Array<[string, () => Promise<void>]> = [
    ["cache clear clears the persistent backend", cacheClearClearsThePersistentBackend],
    ["cache clear is visible to another instance", cacheClearIsVisibleToAnotherInstance],
    ["cache clear leaves the backend usable", cacheClearLeavesTheBackendUsable],
    ["cache clear without a persistent backend is safe", cacheClearWithoutAPersistentBackendIsSafe],
  ];

  const gate = requireServices();
  const redisUp = await reachable(REDIS.host, REDIS.port);
  for (const [name, run] of suite) {
    // Only the last case runs without redis; the rest need the shared backend.
    if (!redisUp && name !== "cache clear without a persistent backend is safe") {
      cases++;
      if (gate) assert(name, false, "redis not reachable and TINA4_REQUIRE_SERVICES is set");
      else skip(name, "redis not reachable");
      continue;
    }
    try {
      await run();
    } catch (err) {
      assert(name, false, `threw: ${(err as Error).message}`);
    }
  }

  try { closeDatabase(); } catch { /* noop */ }
  for (const file of tempFiles) { try { fs.rmSync(file, { force: true }); } catch { /* noop */ } }

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

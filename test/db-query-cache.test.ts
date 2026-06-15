/**
 * Request-scoped DB query cache (default-on) — protects the DB from rapid
 * identical reads. Mirrors tina4_python/tests/test_db_query_cache.py.
 *
 * Layers (see packages/orm/src/cachedDatabase.ts):
 *   • request-scoped (DEFAULT ON, off-switch TINA4_QUERY_CACHE=false) — dedupes
 *     identical SELECTs, cleared per request + on writes, short safety TTL.
 *   • persistent (opt-in TINA4_DB_CACHE=true) — cross-request TTL cache, NOT
 *     cleared per request.
 *
 * Run with: npx tsx test/db-query-cache.test.ts
 */
import {
  initDatabase,
  closeDatabase,
  resetRequestCaches,
  Database,
  CachedDatabaseAdapter,
} from "../packages/orm/src/index.ts";

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

/**
 * Build a fresh in-memory DB. Each call resets the env knobs the caller set,
 * closes any prior connection, and constructs a Database. `env` lets a test
 * pin TINA4_DB_CACHE / TINA4_QUERY_CACHE before the adapter is wrapped (the
 * mode is decided at wrap time, exactly like Python decides it in __init__).
 */
async function makeDb(env: Record<string, string | undefined> = {}): Promise<Database> {
  delete process.env.TINA4_DB_CACHE;
  delete process.env.TINA4_QUERY_CACHE;
  delete process.env.TINA4_DB_CACHE_TTL;
  delete process.env.TINA4_QUERY_CACHE_TTL;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  closeDatabase();
  const db = await initDatabase({ url: "sqlite://:memory:" });
  await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
  await db.execute("INSERT INTO t (n) VALUES ('a'), ('b')");
  return db;
}

async function main() {
  console.log("=== DB Query Cache Tests ===\n");

  // ── Request-scoped default ──────────────────────────────
  console.log("--- Request-scoped (default ON) ---");
  {
    const db = await makeDb();
    const stats = db.cacheStats();
    assert("on by default: enabled", stats.enabled === true, JSON.stringify(stats));
    assert("on by default: mode === 'request'", stats.mode === "request", JSON.stringify(stats));
  }

  {
    const db = await makeDb();
    await db.fetch("SELECT * FROM t"); // miss -> populates
    await db.fetch("SELECT * FROM t"); // hit
    const stats = db.cacheStats();
    assert("identical fetches dedupe: hits >= 1", stats.hits >= 1, JSON.stringify(stats));
    assert("identical fetches dedupe: size === 1", stats.size === 1, JSON.stringify(stats));
  }

  {
    const db = await makeDb();
    await db.fetch("SELECT * FROM t");
    assert("write invalidates: size 1 before write", db.cacheStats().size === 1);
    await db.execute("INSERT INTO t (n) VALUES ('c')");
    assert("write invalidates: size 0 after write", db.cacheStats().size === 0);
  }

  {
    const db = await makeDb();
    await db.fetch("SELECT * FROM t");
    assert("insert helper invalidates: size 1 before", db.cacheStats().size === 1);
    await db.insert("t", { n: "d" });
    assert("insert helper invalidates: size 0 after", db.cacheStats().size === 0);
  }

  // ── Request boundary ────────────────────────────────────
  console.log("\n--- Request boundary ---");
  {
    const db = await makeDb();
    await db.fetch("SELECT * FROM t");
    assert("reset clears request cache: size 1 before", db.cacheStats().size === 1);
    // Simulate the dispatcher firing at the start of the next request.
    resetRequestCaches();
    assert("reset clears request cache: size 0 after", db.cacheStats().size === 0);
  }

  {
    const db = await makeDb();
    await db.fetch("SELECT * FROM t");
    await db.fetch("SELECT * FROM t"); // one hit
    const hitsBefore = db.cacheStats().hits;
    db.cacheNewRequest();
    const after = db.cacheStats();
    assert("reset preserves counters: hits survive", after.hits === hitsBefore, JSON.stringify(after));
    assert("reset preserves counters: size 0", after.size === 0, JSON.stringify(after));
  }

  // ── Off-switch ──────────────────────────────────────────
  console.log("\n--- Off-switch (TINA4_QUERY_CACHE=false) ---");
  {
    const db = await makeDb({ TINA4_QUERY_CACHE: "false" });
    let stats = db.cacheStats();
    assert("query cache false disables: enabled false", stats.enabled === false, JSON.stringify(stats));
    assert("query cache false disables: mode 'off'", stats.mode === "off", JSON.stringify(stats));
    await db.fetch("SELECT * FROM t");
    await db.fetch("SELECT * FROM t");
    stats = db.cacheStats();
    assert("query cache false disables: nothing cached (size 0)", stats.size === 0, JSON.stringify(stats));
    assert("query cache false disables: no hits", stats.hits === 0, JSON.stringify(stats));
  }

  // ── Persistent mode ─────────────────────────────────────
  console.log("\n--- Persistent mode (TINA4_DB_CACHE=true) ---");
  {
    const db = await makeDb({ TINA4_DB_CACHE: "true" });
    const stats = db.cacheStats();
    assert("db cache true is persistent: enabled", stats.enabled === true, JSON.stringify(stats));
    assert("db cache true is persistent: mode 'persistent'", stats.mode === "persistent", JSON.stringify(stats));
    assert("db cache true is persistent: ttl 30", stats.ttl === 30, JSON.stringify(stats));
  }

  {
    const db = await makeDb({ TINA4_DB_CACHE: "true" });
    await db.fetch("SELECT * FROM t");
    assert("persistent survives reset: size 1 before", db.cacheStats().size === 1);
    resetRequestCaches(); // no-op in persistent mode
    assert("persistent survives reset: size 1 after", db.cacheStats().size === 1);
  }

  // ── ORM reads are cached too (the dead-cache fix) ───────
  console.log("\n--- ORM reads share the same cache ---");
  {
    const db = await makeDb();
    const { BaseModel, getAdapter } = await import("../packages/orm/src/index.ts");
    class T extends BaseModel {
      static tableName = "t";
      static fields = {
        id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
        n: { type: "string" as const },
      };
    }
    const adapter = getAdapter();
    assert("bound adapter is cache-wrapped", adapter instanceof CachedDatabaseAdapter, adapter.constructor.name);

    const sizeBefore = db.cacheStats().size;
    await (T as any).all();
    await (T as any).all(); // identical ORM read -> should hit cache
    const stats = db.cacheStats();
    assert("ORM read populates cache", stats.size > sizeBefore, JSON.stringify(stats));
    assert("ORM read dedupes (hits grew)", stats.hits >= 1, JSON.stringify(stats));

    await db.insert("t", { n: "z" }); // write flushes ORM-cached rows
    assert("ORM-cached rows flushed on write", db.cacheStats().size === 0);
  }

  closeDatabase();

  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

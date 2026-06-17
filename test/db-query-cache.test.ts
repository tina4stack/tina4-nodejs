/**
 * Request-scoped DB query cache (default-on) — protects the DB from rapid
 * identical reads. Mirrors tina4_python/tests/test_db_query_cache.py.
 *
 * Layers (see packages/orm/src/cachedDatabase.ts):
 *   • request-scoped (DEFAULT ON, off-switch TINA4_AUTO_CACHING=false) — dedupes
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
  createAdapterFromUrl,
} from "../packages/orm/src/index.ts";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0;
let fail = 0;

/** True if a redis/valkey server answers PING on localhost:6379 (RESP over TCP). */
function redisReachable(host = "localhost", port = 6379, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; try { sock.destroy(); } catch {} resolve(ok); } };
    const timer = setTimeout(() => done(false), timeoutMs);
    if (timer.unref) timer.unref();
    sock.once("error", () => done(false));
    sock.once("connect", () => { sock.write("PING\r\n"); });
    sock.once("data", (d) => done(d.toString().startsWith("+PONG")));
  });
}

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
 * pin TINA4_DB_CACHE / TINA4_AUTO_CACHING before the adapter is wrapped (the
 * mode is decided at wrap time, exactly like Python decides it in __init__).
 */
async function makeDb(env: Record<string, string | undefined> = {}): Promise<Database> {
  delete process.env.TINA4_DB_CACHE;
  delete process.env.TINA4_AUTO_CACHING;
  delete process.env.TINA4_DB_CACHE_TTL;
  delete process.env.TINA4_AUTO_CACHING_TTL;
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
  console.log("\n--- Off-switch (TINA4_AUTO_CACHING=false) ---");
  {
    const db = await makeDb({ TINA4_AUTO_CACHING: "false" });
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

  // ── Per-query cache bypass: { noCache: true } ───────────
  // A single read can bypass the query cache: no lookup, no store, run
  // directly (mirrors the Python master's no_cache). The option is a SEPARATE
  // trailing argument, never the params array.
  console.log("\n--- Per-query cache bypass (noCache) ---");
  {
    // noCache read does NOT populate the cache.
    const db = await makeDb();
    assert("noCache: cache empty to start", db.cacheStats().size === 0);
    const rows = await db.fetchAll("SELECT * FROM t", [], undefined, undefined, { noCache: true });
    assert("noCache fetchAll still returns rows", rows.length === 2, JSON.stringify(rows));
    const stats = db.cacheStats();
    assert("noCache read does NOT populate the cache (size 0)", stats.size === 0, JSON.stringify(stats));
    assert("noCache read is not counted as a hit or miss", stats.hits === 0 && stats.misses === 0, JSON.stringify(stats));
  }

  {
    // noCache does NOT return a previously-cached value — it runs live and
    // sees a row a normal cached read would have missed inside the same request.
    const db = await makeDb();
    await db.fetchAll("SELECT * FROM t");            // miss -> caches 2 rows
    assert("noCache: 2 rows cached before write", db.cacheStats().size === 1);
    // Insert directly on the raw adapter so the cache is NOT invalidated
    // (db.insert would flush). This leaves a stale 2-row entry in the cache.
    const { getAdapter } = await import("../packages/orm/src/index.ts");
    const raw = (getAdapter() as any).getAdapter();   // unwrap CachedDatabaseAdapter
    raw.execute("INSERT INTO t (n) VALUES ('bypass')");
    // A normal cached read returns the STALE 2 rows (served from cache).
    const cached = await db.fetchAll("SELECT * FROM t");
    assert("normal cached read returns stale 2 rows", cached.length === 2, JSON.stringify(cached));
    // A noCache read bypasses the cache and sees all 3 rows live.
    const live = await db.fetchAll("SELECT * FROM t", [], undefined, undefined, { noCache: true });
    assert("noCache read bypasses cache and sees 3 live rows", live.length === 3, JSON.stringify(live));
    // The noCache read also did not overwrite the cached entry.
    const after = await db.fetchAll("SELECT * FROM t");
    assert("noCache read left the cache untouched (still stale 2)", after.length === 2, JSON.stringify(after));
  }

  {
    // fetchOne honours noCache the same way.
    const db = await makeDb();
    await db.fetchOne("SELECT * FROM t WHERE id = ?", [1]);   // miss -> caches
    const sizeAfterCachedOne = db.cacheStats().size;
    assert("fetchOne cached a row", sizeAfterCachedOne === 1);
    const hitsBefore = db.cacheStats().hits;
    const one = await db.fetchOne("SELECT * FROM t WHERE id = ?", [1], { noCache: true });
    assert("noCache fetchOne returns the row", one !== null && (one as any).id === 1, JSON.stringify(one));
    const stats = db.cacheStats();
    assert("noCache fetchOne did not add a hit", stats.hits === hitsBefore, JSON.stringify(stats));
    assert("noCache fetchOne did not grow the cache", stats.size === sizeAfterCachedOne, JSON.stringify(stats));
  }

  {
    // Default (no opts) preserves today's caching behaviour.
    const db = await makeDb();
    await db.fetchAll("SELECT * FROM t");   // miss
    await db.fetchAll("SELECT * FROM t");   // hit
    const stats = db.cacheStats();
    assert("default fetchAll still caches (hits >= 1)", stats.hits >= 1, JSON.stringify(stats));
    assert("default fetchAll still caches (size 1)", stats.size === 1, JSON.stringify(stats));
  }

  closeDatabase();

  // ── Persistent DB cache via redis: cross-instance sharing ───────
  // TINA4_DB_CACHE_BACKEND=redis routes the persistent DB query cache through
  // the unified async backend, so two SEPARATE Database instances (own
  // connections, own in-process caches) over the SAME data share results via
  // redis. A write on either instance invalidates the shared backend. Uses
  // redis db index 3 for isolation; self-skips if redis is unreachable.
  console.log("\n--- Persistent DB cache cross-instance via redis (db 3) ---");
  {
    const { wrapWithCache } = await import("../packages/orm/src/index.ts");
    const reachable = await redisReachable();
    if (!reachable) {
      console.log("  \x1b[33mSKIP\x1b[0m redis unreachable on localhost:6379 — skipping cross-instance DB cache test");
    } else {
      // Reset the env knobs and pin persistent + redis before wrapping.
      delete process.env.TINA4_AUTO_CACHING;
      const prev = {
        DB_CACHE: process.env.TINA4_DB_CACHE,
        BACKEND: process.env.TINA4_DB_CACHE_BACKEND,
        URL: process.env.TINA4_DB_CACHE_URL,
      };
      process.env.TINA4_DB_CACHE = "true";
      process.env.TINA4_DB_CACHE_BACKEND = "redis";
      process.env.TINA4_DB_CACHE_URL = "redis://localhost:6379/3";

      // A shared sqlite FILE so two independent connections see the same data.
      const dbFile = path.join(os.tmpdir(), `tina4_dbcache_${Date.now()}.db`);
      const url = `sqlite:///${dbFile}`;

      // Two separate Database instances over the same file (own adapters, own
      // in-process caches, same redis backend).
      const dbA = new Database(wrapWithCache(await createAdapterFromUrl(url)));
      const dbB = new Database(wrapWithCache(await createAdapterFromUrl(url)));

      await dbA.execute("CREATE TABLE IF NOT EXISTS shared (id INTEGER PRIMARY KEY, n TEXT)");
      await dbA.execute("DELETE FROM shared");
      await dbA.execute("INSERT INTO shared (n) VALUES ('alpha'), ('beta')");

      // Clear any stale redis state from a previous run for this exact query.
      // (A.fetch will MISS the DB, store in redis.)
      const sql = "SELECT * FROM shared ORDER BY id";
      const aResult = await dbA.fetch(sql);
      assert("redis DB cache: A reads 2 rows", aResult.records.length === 2, JSON.stringify(aResult.records));
      const aStats = dbA.cacheStats();
      assert("redis DB cache: A reports backend redis", aStats.backend === "redis", JSON.stringify(aStats));

      // Let A's async backend.set settle.
      await new Promise((r) => setTimeout(r, 60));

      // B has a COLD in-process cache. Its fetch should HIT redis (populated by
      // A), not the DB — proving cross-instance sharing.
      const bHitsBefore = dbB.cacheStats().hits;
      const bResult = await dbB.fetch(sql);
      const bStats = dbB.cacheStats();
      assert("redis DB cache: B reads same 2 rows", bResult.records.length === 2, JSON.stringify(bResult.records));
      assert(
        "redis DB cache: B served from shared redis (hits grew, never queried DB itself first)",
        bStats.hits > bHitsBefore,
        JSON.stringify(bStats),
      );
      assert(
        "redis DB cache: B's first read was a HIT (misses still 0)",
        bStats.misses === 0,
        JSON.stringify(bStats),
      );

      // A write on A must invalidate the SHARED redis backend so B no longer
      // serves the stale row set.
      await dbA.execute("INSERT INTO shared (n) VALUES ('gamma')");
      await new Promise((r) => setTimeout(r, 60));
      const bAfterWrite = await dbB.fetch(sql);
      assert(
        "redis DB cache: write on A invalidates B's shared cache (B now sees 3 rows)",
        bAfterWrite.records.length === 3,
        JSON.stringify(bAfterWrite.records),
      );

      dbA.close();
      dbB.close();
      try { fs.rmSync(dbFile, { force: true }); } catch {}

      // Restore env.
      const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      restore("TINA4_DB_CACHE", prev.DB_CACHE);
      restore("TINA4_DB_CACHE_BACKEND", prev.BACKEND);
      restore("TINA4_DB_CACHE_URL", prev.URL);
      closeDatabase();
    }
  }

  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

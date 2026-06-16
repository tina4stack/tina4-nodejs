/**
 * Unified cache backend set — memory / file / database / redis / valkey /
 * memcached / mongodb. Mirrors the Python master
 * (tina4_python/tests/test_cache_backends.py and test_db_query_cache.py).
 *
 * The response/KV cache is ASYNC on Node: createBackend() returns a Promise and
 * every backend op (get/set/delete/clear/stats) is awaited. Network backends use
 * NATIVE async node:net clients (RESP / memcached text protocol) and the optional
 * mongodb driver — NO child process / execFileSync.
 *
 * Network backends SKIP when their service is unreachable, so CI without those
 * services stays green; locally (docker harness up) they run for real.
 *
 * Parallel isolation (the docker containers are shared with other agents):
 *   - redis  via DB index 3 (redis://localhost:6379/3)
 *   - valkey via DB index 3 (valkey://localhost:6380/3)
 *   - redis-auth on 6381 (requirepass s3cret), DB index 3
 *   - mongo db/collection: tina4_cache_node / cache
 *   - memcached: uniquely-prefixed keys + targeted delete (no flush_all)
 *
 * Run with: npx tsx test/cache-backends.test.ts
 */
import { createBackend } from "../packages/core/src/index.ts";
import * as fs from "node:fs";
import * as net from "node:net";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string) {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} (${reason})`);
  skipped++;
}

/** Async TCP reachability probe (native node:net, no child process). */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    const t = setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 1000);
    if (t.unref) t.unref();
  });
}

/** Round-trip contract shared by every backend (mirrors Python's _roundtrip). */
async function roundtrip(b: any, expectName: string) {
  await b.clear();
  await b.set("k1", { v: 1, name: "Alice" }, 60);
  assert(`${expectName}: get round-trips object`, JSON.stringify(await b.get("k1")) === JSON.stringify({ v: 1, name: "Alice" }));
  assert(`${expectName}: miss returns undefined`, (await b.get("missing_xyz_123")) === undefined);
  const st = await b.stats();
  assert(`${expectName}: stats.backend === '${expectName}'`, st.backend === expectName, JSON.stringify(st));
  for (const field of ["hits", "misses", "size"]) {
    assert(`${expectName}: stats has '${field}'`, field in st);
  }
  assert(`${expectName}: delete returns true`, (await b.delete("k1")) === true);
  assert(`${expectName}: get after delete returns undefined`, (await b.get("k1")) === undefined);
}

async function main() {
  console.log("=== Unified Cache Backend Tests ===\n");

  // ── Local backends — always available ───────────────────────────
  console.log("--- Local backends ---");

  await roundtrip(await createBackend({ backend: "memory" }), "memory");

  {
    const dir = `/tmp/tina4_cache_node_file_${Date.now()}`;
    await roundtrip(await createBackend({ backend: "file", cacheDir: dir }), "file");
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }

  {
    const dbFile = `/tmp/tina4_cache_node_db_${Date.now()}.db`;
    await roundtrip(await createBackend({ backend: "database", cacheUrl: `sqlite:///${dbFile}` }), "database");
    try { fs.rmSync(dbFile); } catch {}
  }

  // ── Factory edge cases ──────────────────────────────────────────
  console.log("\n--- Factory edge cases ---");

  assert("unknown backend falls back to memory", (await createBackend({ backend: "bogus" })).name() === "memory");

  {
    // A configured backend whose service is unreachable degrades to the file
    // backend (a real working cache), not a silent no-op.
    const dir = `/tmp/tina4_cache_node_fallback_${Date.now()}`;
    const b = await createBackend({ backend: "redis", cacheUrl: "redis://localhost:6399", cacheDir: dir });
    assert("unreachable backend falls back to file", b.name() === "file");
    await b.set("k", { v: 1 }, 60);
    assert("file fallback is a real cache (round-trips)", JSON.stringify(await b.get("k")) === JSON.stringify({ v: 1 }));
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }

  // ── Credential parsing — verified without a live server ─────────
  // Credentials come from the URL (user:pass@) or TINA4_CACHE_USERNAME /
  // TINA4_CACHE_PASSWORD (parity with TINA4_DATABASE_USERNAME / _PASSWORD).
  console.log("\n--- Credential parsing ---");

  // parseCacheUrl is internal, so we assert its observable effect: a backend
  // pointed at a dead port still constructs and falls back, and authenticated
  // behaviour is covered by the live redis-auth test below. Here we verify the
  // WHATWG URL path handles each credential form without throwing.
  {
    const forms = [
      "redis://alice:s3cret@127.0.0.1:6399",
      "redis://:justpass@127.0.0.1:6399",
      "redis://127.0.0.1:6399",
      "redis://127.0.0.1:6399/3",
    ];
    let ok = true;
    for (const url of forms) {
      try {
        const b = await createBackend({ backend: "redis", cacheUrl: url, cacheDir: `/tmp/tina4_cred_${Date.now()}` });
        if (b.name() !== "file") ok = false; // dead port → file fallback
      } catch {
        ok = false;
      }
    }
    assert("all credential URL forms parse + fall back cleanly", ok);
  }

  {
    // Env-var credentials fill the gap left by the URL.
    const prevU = process.env.TINA4_CACHE_USERNAME;
    const prevP = process.env.TINA4_CACHE_PASSWORD;
    process.env.TINA4_CACHE_USERNAME = "bob";
    process.env.TINA4_CACHE_PASSWORD = "pw";
    let threw = false;
    try {
      await createBackend({ backend: "redis", cacheUrl: "redis://127.0.0.1:6399", cacheDir: `/tmp/tina4_cred_env_${Date.now()}` });
    } catch {
      threw = true;
    }
    assert("env-var credentials parse without throwing", !threw);
    if (prevU === undefined) delete process.env.TINA4_CACHE_USERNAME; else process.env.TINA4_CACHE_USERNAME = prevU;
    if (prevP === undefined) delete process.env.TINA4_CACHE_PASSWORD; else process.env.TINA4_CACHE_PASSWORD = prevP;
  }

  // ── Network backends — skip when unreachable (async native clients) ──
  console.log("\n--- Network backends (skip when unreachable) ---");

  if (await reachable("localhost", 6379)) {
    await roundtrip(await createBackend({ backend: "redis", cacheUrl: "redis://localhost:6379/3" }), "redis");
  } else {
    skip("redis backend", "redis not running on 6379");
  }

  if (await reachable("localhost", 6380)) {
    await roundtrip(await createBackend({ backend: "valkey", cacheUrl: "valkey://localhost:6380/3" }), "valkey");
  } else {
    skip("valkey backend", "valkey not running on 6380");
  }

  if (await reachable("localhost", 11211)) {
    await roundtrip(await createBackend({ backend: "memcached", cacheUrl: "memcached://localhost:11211" }), "memcached");
  } else {
    skip("memcached backend", "memcached not running on 11211");
  }

  if (await reachable("localhost", 27017)) {
    // mongodb driver is OPTIONAL; if absent the backend no-ops → file fallback.
    const mongo = await createBackend({ backend: "mongodb", cacheUrl: "mongodb://localhost:27017/tina4_cache_node/cache" });
    if (mongo.name() === "mongodb") {
      await roundtrip(mongo, "mongodb");
    } else {
      skip("mongodb backend", "mongodb driver not installed — fell back to file");
    }
  } else {
    skip("mongodb backend", "mongodb not running on 27017");
  }

  // ── Authenticated redis (redis-auth, 6381, requirepass s3cret) ──
  console.log("\n--- Authenticated redis (6381) ---");

  if (await reachable("localhost", 6381)) {
    // Real authenticated round-trip — must connect (not fall back to file).
    const b = await createBackend({ backend: "redis", cacheUrl: "redis://:s3cret@localhost:6381/3" });
    assert("auth redis connects (name === redis)", b.name() === "redis");
    await roundtrip(b, "redis");

    // Wrong password → graceful fallback to file, not a no-op.
    const dir = `/tmp/tina4_cache_node_badauth_${Date.now()}`;
    const bad = await createBackend({ backend: "redis", cacheUrl: "redis://:wrongpass@localhost:6381/3", cacheDir: dir });
    assert("wrong password falls back to file", bad.name() === "file");
    await bad.set("k", { v: 1 }, 60);
    assert("bad-auth file fallback round-trips", JSON.stringify(await bad.get("k")) === JSON.stringify({ v: 1 }));
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  } else {
    skip("authenticated redis", "redis-auth not running on 6381");
  }

  // ── Persistent DB cache → unified async backend (distributed) ──
  // Node's read path (db.fetch → fetchAsync) is ASYNC, so the persistent
  // DB-query cache now routes through the unified backend: TINA4_DB_CACHE_BACKEND
  // selects memory (default, in-process) / file / redis / valkey / memcached /
  // mongodb / database. A network backend distributes cross-instance with global
  // write-invalidation (full parity with Python/PHP/Ruby).
  console.log("\n--- Persistent DB cache → unified async backend (distributed) ---");

  await persistentBackendDistributed();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

async function persistentBackendDistributed() {
  const { initDatabase, closeDatabase, CachedDatabaseAdapter } = await import("../packages/orm/src/index.ts");

  // Save + pin env: persistent mode + a NETWORK DB-cache backend selection.
  const saved: Record<string, string | undefined> = {
    TINA4_DB_CACHE: process.env.TINA4_DB_CACHE,
    TINA4_AUTO_CACHING: process.env.TINA4_AUTO_CACHING,
    TINA4_DB_CACHE_BACKEND: process.env.TINA4_DB_CACHE_BACKEND,
    TINA4_DB_CACHE_URL: process.env.TINA4_DB_CACHE_URL,
  };

  // ── (a) Default memory backend: persistent layer stays in-process ──
  // No backend env set → memory → behaviour unchanged (in-process, fast).
  process.env.TINA4_DB_CACHE = "true";
  delete process.env.TINA4_AUTO_CACHING;
  delete process.env.TINA4_DB_CACHE_BACKEND;
  delete process.env.TINA4_DB_CACHE_URL;
  try {
    const dbFile = `/tmp/tina4_cache_node_persist_mem_${Date.now()}.db`;
    const url = `sqlite:///${dbFile}`;
    closeDatabase();
    const db = await initDatabase({ url });
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
    await db.execute("INSERT INTO t (n) VALUES ('x'), ('y')");
    db.cacheClear();

    const adapter = (db as any).getNextAdapter?.() ?? null;
    assert("persistent(memory): wrapped adapter present", adapter instanceof CachedDatabaseAdapter);
    assert("persistent(memory): mode is 'persistent'", db.cacheStats().mode === "persistent", JSON.stringify(db.cacheStats()));
    assert("persistent(memory): default backend reports 'memory'", db.cacheStats().backend === "memory", JSON.stringify(db.cacheStats()));

    const r1 = await db.fetch("SELECT * FROM t ORDER BY id");
    const rows1 = (r1 as any[]) ?? [];
    assert("persistent(memory): first read returns rows", rows1.length === 2 && rows1[0].n === "x" && rows1[1].n === "y", JSON.stringify(rows1));
    assert("persistent(memory): in-process cache populated after read", db.cacheStats().size >= 1, JSON.stringify(db.cacheStats()));
    await db.fetch("SELECT * FROM t ORDER BY id");
    assert("persistent(memory): second read is an in-process hit", db.cacheStats().hits >= 1, JSON.stringify(db.cacheStats()));
    await db.execute("INSERT INTO t (n) VALUES ('z')");
    assert("persistent(memory): write flushes in-process cache (size 0)", db.cacheStats().size === 0, JSON.stringify(db.cacheStats()));

    db.cacheClear();
    closeDatabase();
    try { fs.rmSync(dbFile); } catch {}
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // ── (b) Redis backend: persistent layer routes through the backend ──
  // Now that the read path is async, a network backend is the AUTHORITATIVE
  // store — db.cacheStats() reports 'redis' and the read flows through it.
  // Self-skip when redis is unreachable.
  if (!(await reachable("localhost", 6379))) {
    skip("persistent DB cache via redis", "redis not running on 6379");
    return;
  }
  process.env.TINA4_DB_CACHE = "true";
  delete process.env.TINA4_AUTO_CACHING;
  process.env.TINA4_DB_CACHE_BACKEND = "redis";
  process.env.TINA4_DB_CACHE_URL = "redis://localhost:6379/3";
  try {
    const dbFile = `/tmp/tina4_cache_node_persist_redis_${Date.now()}.db`;
    const url = `sqlite:///${dbFile}`;
    closeDatabase();
    const db = await initDatabase({ url });
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
    await db.execute("INSERT INTO t (n) VALUES ('x'), ('y')");
    db.cacheClear();
    await new Promise((r) => setTimeout(r, 40)); // let the async clear settle

    assert("persistent(redis): mode is 'persistent'", db.cacheStats().mode === "persistent", JSON.stringify(db.cacheStats()));
    assert("persistent(redis): reports backend 'redis' (distributed)", db.cacheStats().backend === "redis", JSON.stringify(db.cacheStats()));

    const sql = "SELECT * FROM t ORDER BY id";
    const r1 = await db.fetch(sql); // MISS → query DB, store in redis
    const rows1 = (r1 as any[]) ?? [];
    assert("persistent(redis): first read returns rows", rows1.length === 2 && rows1[0].n === "x" && rows1[1].n === "y", JSON.stringify(rows1));
    await new Promise((r) => setTimeout(r, 40));
    const r2 = await db.fetch(sql); // HIT from redis
    assert("persistent(redis): second read still returns rows", ((r2 as any[]) ?? []).length === 2);
    assert("persistent(redis): second read is a redis HIT (hits >= 1)", db.cacheStats().hits >= 1, JSON.stringify(db.cacheStats()));

    // A write invalidates the shared redis backend, so the next read re-queries.
    await db.execute("INSERT INTO t (n) VALUES ('z')");
    await new Promise((r) => setTimeout(r, 40));
    const r3 = await db.fetch(sql);
    assert("persistent(redis): write invalidates shared backend (3 rows)", ((r3 as any[]) ?? []).length === 3, JSON.stringify(r3));

    db.cacheClear();
    closeDatabase();
    try { fs.rmSync(dbFile); } catch {}
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

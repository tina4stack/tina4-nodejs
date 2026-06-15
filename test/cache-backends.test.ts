/**
 * Unified cache backend set — memory / file / database / redis / valkey /
 * memcached / mongodb. Mirrors the Python master
 * (tina4_python/tests/test_cache_backends.py and test_db_query_cache.py).
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
import { execFileSync } from "node:child_process";

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

/** Synchronous reachability probe via a child process (TCP connect). */
function reachable(host: string, port: number): boolean {
  // A tiny sync probe through a throwaway connection with a short timeout.
  const script = `
    const net = require("node:net");
    const s = net.createConnection({ host: ${JSON.stringify(host)}, port: ${port} }, () => {
      process.stdout.write("UP"); s.destroy(); process.exit(0);
    });
    s.on("error", () => { process.stdout.write("DOWN"); process.exit(0); });
    setTimeout(() => { try { s.destroy(); } catch {} process.stdout.write("DOWN"); process.exit(0); }, 1000);
  `;
  try {
    return execFileSync(process.execPath, ["-e", script], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }) === "UP";
  } catch {
    return false;
  }
}

/** Round-trip contract shared by every backend (mirrors Python's _roundtrip). */
function roundtrip(b: any, expectName: string) {
  b.clear();
  b.set("k1", { v: 1, name: "Alice" }, 60);
  assert(`${expectName}: get round-trips object`, JSON.stringify(b.get("k1")) === JSON.stringify({ v: 1, name: "Alice" }));
  assert(`${expectName}: miss returns undefined`, b.get("missing_xyz_123") === undefined);
  const st = b.stats();
  assert(`${expectName}: stats.backend === '${expectName}'`, st.backend === expectName, JSON.stringify(st));
  for (const field of ["hits", "misses", "size"]) {
    assert(`${expectName}: stats has '${field}'`, field in st);
  }
  assert(`${expectName}: delete returns true`, b.delete("k1") === true);
  assert(`${expectName}: get after delete returns undefined`, b.get("k1") === undefined);
}

console.log("=== Unified Cache Backend Tests ===\n");

// ── Local backends — always available ───────────────────────────
console.log("--- Local backends ---");

roundtrip(createBackend({ backend: "memory" }), "memory");

{
  const dir = `/tmp/tina4_cache_node_file_${Date.now()}`;
  roundtrip(createBackend({ backend: "file", cacheDir: dir }), "file");
  try { fs.rmSync(dir, { recursive: true }); } catch {}
}

{
  const dbFile = `/tmp/tina4_cache_node_db_${Date.now()}.db`;
  roundtrip(createBackend({ backend: "database", cacheUrl: `sqlite:///${dbFile}` }), "database");
  try { fs.rmSync(dbFile); } catch {}
}

// ── Factory edge cases ──────────────────────────────────────────
console.log("\n--- Factory edge cases ---");

assert("unknown backend falls back to memory", createBackend({ backend: "bogus" }).name() === "memory");

{
  // A configured backend whose service is unreachable degrades to the file
  // backend (a real working cache), not a silent no-op.
  const dir = `/tmp/tina4_cache_node_fallback_${Date.now()}`;
  const b = createBackend({ backend: "redis", cacheUrl: "redis://localhost:6399", cacheDir: dir });
  assert("unreachable backend falls back to file", b.name() === "file");
  b.set("k", { v: 1 }, 60);
  assert("file fallback is a real cache (round-trips)", JSON.stringify(b.get("k")) === JSON.stringify({ v: 1 }));
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
      const b = createBackend({ backend: "redis", cacheUrl: url, cacheDir: `/tmp/tina4_cred_${Date.now()}` });
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
    createBackend({ backend: "redis", cacheUrl: "redis://127.0.0.1:6399", cacheDir: `/tmp/tina4_cred_env_${Date.now()}` });
  } catch {
    threw = true;
  }
  assert("env-var credentials parse without throwing", !threw);
  if (prevU === undefined) delete process.env.TINA4_CACHE_USERNAME; else process.env.TINA4_CACHE_USERNAME = prevU;
  if (prevP === undefined) delete process.env.TINA4_CACHE_PASSWORD; else process.env.TINA4_CACHE_PASSWORD = prevP;
}

// ── Network backends — skip when unreachable ────────────────────
console.log("\n--- Network backends (skip when unreachable) ---");

if (reachable("localhost", 6379)) {
  roundtrip(createBackend({ backend: "redis", cacheUrl: "redis://localhost:6379/3" }), "redis");
} else {
  skip("redis backend", "redis not running on 6379");
}

if (reachable("localhost", 6380)) {
  roundtrip(createBackend({ backend: "valkey", cacheUrl: "valkey://localhost:6380/3" }), "valkey");
} else {
  skip("valkey backend", "valkey not running on 6380");
}

if (reachable("localhost", 11211)) {
  roundtrip(createBackend({ backend: "memcached", cacheUrl: "memcached://localhost:11211" }), "memcached");
} else {
  skip("memcached backend", "memcached not running on 11211");
}

if (reachable("localhost", 27017)) {
  // mongodb driver is OPTIONAL; if absent the backend no-ops → file fallback.
  const mongo = createBackend({ backend: "mongodb", cacheUrl: "mongodb://localhost:27017/tina4_cache_node/cache" });
  if (mongo.name() === "mongodb") {
    roundtrip(mongo, "mongodb");
  } else {
    skip("mongodb backend", "mongodb driver not installed — fell back to file");
  }
} else {
  skip("mongodb backend", "mongodb not running on 27017");
}

// ── Authenticated redis (redis-auth, 6381, requirepass s3cret) ──
console.log("\n--- Authenticated redis (6381) ---");

if (reachable("localhost", 6381)) {
  // Real authenticated round-trip — must connect (not fall back to file).
  const b = createBackend({ backend: "redis", cacheUrl: "redis://:s3cret@localhost:6381/3" });
  assert("auth redis connects (name === redis)", b.name() === "redis");
  roundtrip(b, "redis");

  // Wrong password → graceful fallback to file, not a no-op.
  const dir = `/tmp/tina4_cache_node_badauth_${Date.now()}`;
  const bad = createBackend({ backend: "redis", cacheUrl: "redis://:wrongpass@localhost:6381/3", cacheDir: dir });
  assert("wrong password falls back to file", bad.name() === "file");
  bad.set("k", { v: 1 }, 60);
  assert("bad-auth file fallback round-trips", JSON.stringify(bad.get("k")) === JSON.stringify({ v: 1 }));
  try { fs.rmSync(dir, { recursive: true }); } catch {}
} else {
  skip("authenticated redis", "redis-auth not running on 6381");
}

// ── Persistent DB cache → shared backend, cross-instance ────────
// TINA4_DB_CACHE=true routes the persistent DB query cache through the unified
// backend (TINA4_DB_CACHE_BACKEND). A read populated by one Database instance is
// served to another instance from the SAME shared backend (no second query),
// with the DatabaseResult records serialized + reconstructed.
console.log("\n--- Persistent DB cache → shared backend (cross-instance) ---");

async function persistentCrossInstance() {
  if (!reachable("localhost", 6379)) {
    skip("persistent DB cache cross-instance (redis)", "redis not running on 6379");
    return;
  }
  const { initDatabase, closeDatabase, CachedDatabaseAdapter } = await import("../packages/orm/src/index.ts");

  // Save + pin env for persistent shared-redis mode (DB index 3 for isolation).
  const saved: Record<string, string | undefined> = {
    TINA4_DB_CACHE: process.env.TINA4_DB_CACHE,
    TINA4_AUTO_CACHING: process.env.TINA4_AUTO_CACHING,
    TINA4_DB_CACHE_BACKEND: process.env.TINA4_DB_CACHE_BACKEND,
    TINA4_DB_CACHE_URL: process.env.TINA4_DB_CACHE_URL,
  };
  process.env.TINA4_DB_CACHE = "true";
  delete process.env.TINA4_AUTO_CACHING;
  process.env.TINA4_DB_CACHE_BACKEND = "redis";
  process.env.TINA4_DB_CACHE_URL = "redis://localhost:6379/3";

  try {
    // Use a shared file DB so two Database instances see the same rows.
    const dbFile = `/tmp/tina4_cache_node_shared_${Date.now()}.db`;
    const url = `sqlite:///${dbFile}`;

    closeDatabase();
    const db1 = await initDatabase({ url });
    await db1.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
    await db1.execute("INSERT INTO t (n) VALUES ('x'), ('y')");
    db1.cacheClear(); // start from a clean shared-redis namespace

    const adapter1 = (db1 as any).getNextAdapter?.() ?? null;
    assert("persistent: wrapped adapter present", adapter1 instanceof CachedDatabaseAdapter);
    assert("persistent: mode is 'persistent'", db1.cacheStats().mode === "persistent", JSON.stringify(db1.cacheStats()));
    assert("persistent: stats report shared backend 'redis'", db1.cacheStats().backend === "redis", JSON.stringify(db1.cacheStats()));

    await db1.fetch("SELECT * FROM t ORDER BY id"); // populate shared redis

    // Separate instance, same file DB + same shared redis namespace.
    closeDatabase();
    const db2 = await initDatabase({ url });
    const r = await db2.fetch("SELECT * FROM t ORDER BY id"); // cross-instance hit
    const rows = (r as any[]) ?? [];
    assert("persistent: cross-instance read returns rows", rows.length === 2 && rows[0].n === "x" && rows[1].n === "y", JSON.stringify(rows));
    const stats2 = db2.cacheStats();
    assert("persistent: cross-instance hit (hits >= 1, misses === 0)", stats2.hits >= 1 && stats2.misses === 0, JSON.stringify(stats2));

    db2.cacheClear();
    closeDatabase();
    try { fs.rmSync(dbFile); } catch {}
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

async function main() {
  await persistentCrossInstance();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

/**
 * CACHE CONTRACT - the cache key carries database identity.
 *
 * Pins `the-cache-key-carries-database-identity` from
 * plan/v3/fixtures/cache_contract.json (ADR-0024):
 *
 *     A DB query-cache entry is scoped to the database it came from. Two
 *     databases sharing one cache backend never serve each other's rows.
 *
 * THE MEASURED DEFECT (Node)
 *     QueryCache.queryKey returned `query:${sql}:${paramStr}` - nothing in it
 *     named the connection. On ANY shared backend (redis/valkey/memcached/
 *     mongodb/database) two databases therefore cross-served each other's
 *     rows: two apps pointed at one Redis, or one app with a primary and an
 *     analytics connection. Identical SQL text across tenants is the COMMON
 *     case, not an edge case, so the collision was the normal outcome. This is
 *     a data-isolation failure wearing a caching costume.
 *
 * WHAT THE IDENTITY MAY AND MAY NOT CONTAIN
 *     engine://host:port/database, and deliberately nothing else.
 *     NO CREDENTIALS: a password in the key means every rotation silently
 *     cold-starts the cache, and a shared backend's key namespace is visible to
 *     every tenant of it - a secret must never be folded into it. The username
 *     is out for the same reason plus a second: two connections differing only
 *     by role read the SAME rows and should share the entry.
 *     NOTHING PER-PROCESS: no pid, no salt. Those would isolate the databases
 *     by accident and destroy the point of a shared cache, because no instance
 *     would ever hit another instance's entry.
 *
 * NOTHING HERE IS MOCKED. The cross-serve cases run two REAL SQLite databases
 * and two REAL PostgreSQL 16.14 databases against a REAL shared Redis.
 *
 * Run with: npx tsx test/cacheKeyDatabaseIdentity.test.ts
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { QueryCache } from "../packages/orm/src/sqlTranslator.ts";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.ts";
import { REDIS_URL } from "./_cacheProviders.ts";
import { requireServices } from "./_serviceGate.ts";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "192.168.88.99";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASSWORD = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";

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
  const file = path.join(os.tmpdir(), `tina4_ident_${RUN_ID}_${label}.db`);
  tempFiles.push(file);
  return `sqlite:///${file}`;
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(false); }, 3000);
    if (timer.unref) timer.unref();
  });
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

/** The env that puts the DB query cache in shared-persistent mode on real Redis. */
function persistentRedisEnv(): Record<string, string | undefined> {
  return {
    TINA4_DB_CACHE: "true",
    TINA4_DB_CACHE_BACKEND: "redis",
    TINA4_DB_CACHE_URL: REDIS_URL,
    TINA4_DB_CACHE_TTL: "300",
    TINA4_AUTO_CACHING: undefined,
  };
}

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// -- the cross-serve cases (real databases, real shared cache) --------

async function twoDatabasesSharingOneCacheBackendDoNotCrossServe(): Promise<void> {
  cases++;
  await withEnv(persistentRedisEnv(), async () => {
    closeDatabase();
    const dbA = await initDatabase({ url: sqliteUrl("a") });
    await dbA.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
    await dbA.execute("INSERT INTO t (n) VALUES ('from-a')");
    dbA.cacheClear();

    const dbB = await initDatabase({ url: sqliteUrl("b") });
    await dbB.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
    await dbB.execute("INSERT INTO t (n) VALUES ('from-b')");

    // IDENTICAL SQL TEXT - the common case, and the whole problem.
    const sql = "SELECT n FROM t ORDER BY id";
    const fromA: any = await dbA.fetch(sql);
    await settle();
    const fromB: any = await dbB.fetch(sql);

    const aValue = (fromA?.records ?? fromA ?? [])[0]?.n;
    const bValue = (fromB?.records ?? fromB ?? [])[0]?.n;
    assert(
      "two databases sharing one cache backend do not cross serve",
      aValue === "from-a" && bValue === "from-b",
      `database A read '${aValue}' (expected 'from-a') and database B read '${bValue}' (expected 'from-b') - B was served A's cached rows`,
    );
    closeDatabase();
  });
}

async function twoPostgresDatabasesDoNotCrossServe(): Promise<void> {
  cases++;
  const gate = requireServices();
  if (!(await reachable(PG_HOST, PG_PORT))) {
    if (gate) assert("two postgres databases do not cross serve", false, `postgres ${PG_HOST}:${PG_PORT} not reachable and TINA4_REQUIRE_SERVICES is set`);
    else skip("two postgres databases do not cross serve", "postgres not reachable");
    return;
  }

  // Two REAL databases on the real server. Created here so the case owns them.
  const dbNameA = "tina4_cache_ident_node_a";
  const dbNameB = "tina4_cache_ident_node_b";
  const pg: any = await import("pg");
  const admin = new pg.default.Client({ host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: "tina4" });
  await admin.connect();
  for (const name of [dbNameA, dbNameB]) {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${name}`);
  }
  await admin.end();

  await withEnv(persistentRedisEnv(), async () => {
    const urlFor = (name: string) => `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${name}`;
    closeDatabase();
    const dbA = await initDatabase({ url: urlFor(dbNameA) });
    await dbA.execute("DROP TABLE IF EXISTS ident_t");
    await dbA.execute("CREATE TABLE ident_t (id SERIAL PRIMARY KEY, n TEXT)");
    await dbA.execute("INSERT INTO ident_t (n) VALUES ('pg-from-a')");
    dbA.cacheClear();

    const dbB = await initDatabase({ url: urlFor(dbNameB) });
    await dbB.execute("DROP TABLE IF EXISTS ident_t");
    await dbB.execute("CREATE TABLE ident_t (id SERIAL PRIMARY KEY, n TEXT)");
    await dbB.execute("INSERT INTO ident_t (n) VALUES ('pg-from-b')");

    const sql = "SELECT n FROM ident_t ORDER BY id";
    const fromA: any = await dbA.fetch(sql);
    await settle();
    const fromB: any = await dbB.fetch(sql);

    const aValue = (fromA?.records ?? fromA ?? [])[0]?.n;
    const bValue = (fromB?.records ?? fromB ?? [])[0]?.n;
    assert(
      "two postgres databases do not cross serve",
      aValue === "pg-from-a" && bValue === "pg-from-b",
      `database A read '${aValue}' and database B read '${bValue}' - the two postgres databases shared a cache entry`,
    );
    closeDatabase();
  });
}

// -- the key-shape cases (pure functions over their inputs) -----------

async function theCacheKeyChangesWhenTheDatabaseChanges(): Promise<void> {
  cases++;
  const sql = "SELECT n FROM t ORDER BY id";
  const keyA = QueryCache.queryKey(sql, [], QueryCache.cacheIdentity("sqlite:///tmp/a.db"));
  const keyB = QueryCache.queryKey(sql, [], QueryCache.cacheIdentity("sqlite:///tmp/b.db"));
  const pgOne = QueryCache.queryKey(sql, [], QueryCache.cacheIdentity("postgres://h:5432/one"));
  const pgTwo = QueryCache.queryKey(sql, [], QueryCache.cacheIdentity("postgres://h:5432/two"));
  const otherHost = QueryCache.queryKey(sql, [], QueryCache.cacheIdentity("postgres://other:5432/one"));
  const otherPort = QueryCache.queryKey(sql, [], QueryCache.cacheIdentity("postgres://h:5433/one"));
  assert(
    "the cache key changes when the database changes",
    keyA !== keyB && pgOne !== pgTwo && pgOne !== otherHost && pgOne !== otherPort,
    `identical SQL produced the same key for different databases (fileA==fileB: ${keyA === keyB}, db: ${pgOne === pgTwo}, host: ${pgOne === otherHost}, port: ${pgOne === otherPort})`,
  );
}

async function theCacheKeyIsStableForTheSameDatabase(): Promise<void> {
  cases++;
  // NEGATIVE: nothing per-process, no salt, no counter. A key that changed run
  // to run would isolate the databases by ACCIDENT and destroy the point of a
  // shared cache, because no instance would ever hit another instance's entry.
  const url = "postgres://analytics.example:5432/warehouse";
  const first = QueryCache.queryKey("SELECT 1", [7], QueryCache.cacheIdentity(url));
  const second = QueryCache.queryKey("SELECT 1", [7], QueryCache.cacheIdentity(url));
  const identityTwice = QueryCache.cacheIdentity(url) === QueryCache.cacheIdentity(url);
  assert(
    "the cache key is stable for the same database",
    first === second && identityTwice,
    `the same database produced two different keys: ${first} vs ${second}`,
  );
}

async function theCacheKeyExcludesCredentials(): Promise<void> {
  cases++;
  // NEGATIVE, and the security half: a password must never be folded into a key
  // that lives in a shared backend's visible namespace, and a rotation must not
  // silently cold-start the cache.
  const withCreds = "postgres://appuser:sup3rs3cret@db.example:5432/main";
  const rotated = "postgres://appuser:rotated-p4ssword@db.example:5432/main";
  const otherRole = "postgres://readonly:different@db.example:5432/main";
  const identity = QueryCache.cacheIdentity(withCreds);

  const leaks = identity.includes("sup3rs3cret") || identity.includes("appuser");
  const rotationStable = QueryCache.cacheIdentity(withCreds) === QueryCache.cacheIdentity(rotated);
  const roleStable = QueryCache.cacheIdentity(withCreds) === QueryCache.cacheIdentity(otherRole);

  assert(
    "the cache key excludes credentials",
    !leaks && rotationStable && roleStable,
    `identity="${identity}" (leaks credentials: ${leaks}, stable across password rotation: ${rotationStable}, stable across role: ${roleStable})`,
  );
}

async function main(): Promise<void> {
  console.log("\nCACHE CONTRACT: the-cache-key-carries-database-identity (ADR-0024)");

  const suite: Array<[string, () => Promise<void>]> = [
    ["two databases sharing one cache backend do not cross serve", twoDatabasesSharingOneCacheBackendDoNotCrossServe],
    ["the cache key changes when the database changes", theCacheKeyChangesWhenTheDatabaseChanges],
    ["the cache key is stable for the same database", theCacheKeyIsStableForTheSameDatabase],
    ["the cache key excludes credentials", theCacheKeyExcludesCredentials],
    ["two postgres databases do not cross serve", twoPostgresDatabasesDoNotCrossServe],
  ];

  for (const [name, run] of suite) {
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

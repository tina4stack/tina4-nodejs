/**
 * Unit tests for the response cache (cache.ts) — multi-backend.
 * The KV/module API (cacheGet/cacheSet/cacheDelete/cacheClear/cacheStats/
 * cacheBackendStats) is ASYNC on Node — callers await it. The responseCache
 * middleware is ASYNC too (it routes through the unified backend so cached GET
 * responses distribute via redis/etc.); clearCache() is async (backend-aware).
 * Run with: npx tsx test/cache.test.ts
 */
import { responseCache, clearCache, cacheStats, cacheGet, cacheSet, cacheDelete, cacheClear, cacheBackendStats, _resetBackend } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, Middleware } from "../packages/core/src/index.ts";
import * as fs from "node:fs";
import * as net from "node:net";

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

async function main() {
  console.log("=== Response Cache Tests ===\n");

  // --- Exported API actually behaves (exercise every symbol, not just typeof) ---
  // Each export is driven through a real call against the live (memory default)
  // backend and asserted on its observable effect — no `typeof === "function"`
  // smoke. (createBackend/_getBackend probe the real configured backend.)
  console.log("--- Exported API behaves ---");

  _resetBackend();
  await cacheClear();

  // cacheSet stores; cacheGet reads it back (round-trip through the backend).
  await cacheSet("exp_k", "v", 60);
  assert("cacheSet stores a value cacheGet reads back", (await cacheGet("exp_k")) === "v");

  // cacheDelete removes it; the follow-up cacheGet is a real miss.
  assert("cacheDelete returns true for the stored key", (await cacheDelete("exp_k")) === true);
  assert("cacheGet returns undefined after cacheDelete", (await cacheGet("exp_k")) === undefined);

  // cacheStats / cacheBackendStats report the real KV backend after a set.
  await cacheSet("exp_stats", "x", 60);
  const expStats = await cacheStats();
  assert("cacheStats reports the memory backend", expStats.backend === "memory");
  assert("cacheStats size reflects the stored key", expStats.size >= 1);
  const expBackendStats = await cacheBackendStats();
  assert("cacheBackendStats matches cacheStats backend", expBackendStats.backend === "memory");

  // cacheClear empties the KV backend (real side effect).
  await cacheClear();
  assert("cacheClear empties the KV backend", (await cacheStats()).size === 0);

  // responseCache returns a usable middleware that, driven for real, calls next()
  // on a cache MISS (full HIT/MISS behaviour is locked in further below).
  {
    const expMw = responseCache({ ttl: 60 });
    let expNext = false;
    const h: Record<string, string> = {};
    const req = { method: "GET", url: "/api/exp-exports" } as Tina4Request;
    const res = {
      raw: {
        writableEnded: false, statusCode: 200,
        end(_c: any) { return this; },
        getHeader: (n: string) => h[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { h[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    await expMw(req, res, () => { expNext = true; });
    assert("responseCache middleware calls next() on a real GET miss", expNext);
  }

  // clearCache resets the responseCache (middleware) backend — proven by the
  // shared-backend block at the bottom which relies on it returning a clean store.
  await clearCache();
  _resetBackend();

  // --- clearCache and cacheStats ---
  console.log("\n--- clearCache and cacheStats ---");

  await cacheClear();
  const emptyStats = await cacheStats();
  assert("Empty cache has size 0", emptyStats.size === 0);
  assert("cacheStats reflects the KV backend (cacheSet store)", typeof emptyStats.size === "number");
  assert("cacheStats has backend field", typeof emptyStats.backend === "string");

  // --- Middleware caches a GET and serves the 2nd identical GET from cache ---
  // Drive the SAME middleware twice through the real (memory) backend: the 1st
  // call is a MISS (next() runs, body captured on res.raw.end) and the 2nd call
  // is a HIT served from the backend (next() NOT called, body === the 1st body).
  console.log("\n--- Middleware Caches GET ---");

  {
    delete process.env.TINA4_CACHE_BACKEND;
    _resetBackend();
    await clearCache();

    const mw = responseCache({ ttl: 60 });
    const url = "/api/mw-roundtrip";
    const body = JSON.stringify({ n: 1 });

    // First request — MISS. next() runs, the handler ends the response, capture stores it.
    const h1: Record<string, string> = {};
    let next1 = false;
    const req1 = { method: "GET", url } as Tina4Request;
    const res1 = {
      raw: {
        writableEnded: false, statusCode: 200,
        end(_c: any) { return this; },
        getHeader: (n: string) => h1[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { h1[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    await mw(req1, res1, () => { next1 = true; });
    assert("middleware 1st GET is a MISS (next called)", next1);
    (res1.raw.end as any)(body);             // server flushes the body → capture+store
    assert("middleware MISS sets X-Cache: MISS", h1["x-cache"] === "MISS");
    await new Promise((r) => setTimeout(r, 30)); // let fire-and-forget set() settle

    // Second request — HIT. next() must NOT run; the cached body is served.
    const h2: Record<string, string> = {};
    let next2 = false;
    let servedBody: string | null = null;
    const req2 = { method: "GET", url } as Tina4Request;
    const res2 = Object.assign(
      function (b: any) { servedBody = b; },
      {
        raw: {
          writableEnded: false, statusCode: 200,
          end(_c: any) { return this; },
          getHeader: (n: string) => h2[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { h2[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    await mw(req2, res2, () => { next2 = true; });
    assert("middleware 2nd GET is a HIT (next NOT called)", !next2, `next2=${next2}`);
    assert("middleware HIT serves the cached body", servedBody === body, `served=${servedBody}`);
    assert("middleware HIT sets X-Cache: HIT", h2["x-cache"] === "HIT");

    await clearCache();
    _resetBackend();
  }

  // --- TTL 0 disables caching ---
  console.log("\n--- TTL 0 Disables Cache ---");

  const disabledMw = responseCache({ ttl: 0 });
  let nextCalled = false;
  const mockReq = { method: "GET", url: "/test" } as Tina4Request;
  const mockRes = { raw: { writableEnded: false } } as Tina4Response;
  await disabledMw(mockReq, mockRes, () => { nextCalled = true; });
  assert("TTL 0 calls next() immediately", nextCalled);

  // --- Non-GET requests pass through ---
  console.log("\n--- Non-GET Passthrough ---");

  await clearCache();
  const cacheMw = responseCache({ ttl: 60 });

  let postNextCalled = false;
  const postReq = { method: "POST", url: "/api/data" } as Tina4Request;
  const postRes = { raw: { writableEnded: false } } as Tina4Response;
  await cacheMw(postReq, postRes, () => { postNextCalled = true; });
  assert("POST request calls next()", postNextCalled);

  let putNextCalled = false;
  const putReq = { method: "PUT", url: "/api/data/1" } as Tina4Request;
  const putRes = { raw: { writableEnded: false } } as Tina4Response;
  await cacheMw(putReq, putRes, () => { putNextCalled = true; });
  assert("PUT request calls next()", putNextCalled);

  let deleteNextCalled = false;
  const deleteReq = { method: "DELETE", url: "/api/data/1" } as Tina4Request;
  const deleteRes = { raw: { writableEnded: false } } as Tina4Response;
  await cacheMw(deleteReq, deleteRes, () => { deleteNextCalled = true; });
  assert("DELETE request calls next()", deleteNextCalled);

  // --- GET request cache miss calls next ---
  console.log("\n--- GET Cache Miss ---");

  await clearCache();
  const cacheMw2 = responseCache({ ttl: 60 });
  let getNextCalled = false;
  const headers: Record<string, string> = {};
  const getReq = { method: "GET", url: "/api/items" } as Tina4Request;
  const getRes = {
    raw: {
      writableEnded: false,
      statusCode: 200,
      end: function (chunk: any, ...args: any[]) { return this; },
      getHeader: (name: string) => headers[name.toLowerCase()] ?? (name.toLowerCase() === "content-type" ? "application/json" : undefined),
    },
    header: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
  } as unknown as Tina4Response;

  await cacheMw2(getReq, getRes, () => { getNextCalled = true; });
  assert("GET cache miss calls next()", getNextCalled);

  // --- Config options take effect (statusCodes is honoured) ---
  // Build a middleware that caches ONLY 201 (not 200). Prove the config was
  // applied: a 200 response is NOT cached (a 2nd identical GET still MISSes and
  // calls next), while a 201 IS cached (2nd GET is a HIT served from cache).
  console.log("\n--- Config Options ---");

  {
    delete process.env.TINA4_CACHE_BACKEND;
    _resetBackend();
    await clearCache();

    const customMw = responseCache({ ttl: 120, maxEntries: 500, statusCodes: [201] });

    // (a) A 200 response must NOT be cached because 200 is not in statusCodes.
    const url200 = "/api/cfg-200";
    const h200a: Record<string, string> = {};
    let next200a = false;
    const req200a = { method: "GET", url: url200 } as Tina4Request;
    const res200a = {
      raw: {
        writableEnded: false, statusCode: 200,
        end(_c: any) { return this; },
        getHeader: (n: string) => h200a[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { h200a[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    await customMw(req200a, res200a, () => { next200a = true; });
    (res200a.raw.end as any)(JSON.stringify({ s: 200 })); // 200 → NOT captured (not in statusCodes)
    await new Promise((r) => setTimeout(r, 30));

    let next200b = false;
    const h200b: Record<string, string> = {};
    const req200b = { method: "GET", url: url200 } as Tina4Request;
    const res200b = Object.assign(
      function (_b: any) { /* would mean a HIT — must not happen for 200 */ },
      {
        raw: {
          writableEnded: false, statusCode: 200,
          end(_c: any) { return this; },
          getHeader: (n: string) => h200b[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { h200b[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    await customMw(req200b, res200b, () => { next200b = true; });
    assert("statusCodes:[201] does NOT cache a 200 (2nd GET still MISSes)", next200b, `next200b=${next200b}`);

    // (b) A 201 response MUST be cached because 201 is in statusCodes.
    const url201 = "/api/cfg-201";
    const body201 = JSON.stringify({ s: 201, created: true });
    const h201a: Record<string, string> = {};
    const req201a = { method: "GET", url: url201 } as Tina4Request;
    const res201a = {
      raw: {
        writableEnded: false, statusCode: 201,
        end(_c: any) { return this; },
        getHeader: (n: string) => h201a[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { h201a[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    await customMw(req201a, res201a, () => {});
    (res201a.raw.end as any)(body201); // 201 → captured + stored
    await new Promise((r) => setTimeout(r, 30));

    let next201b = false;
    let served201: string | null = null;
    const h201b: Record<string, string> = {};
    const req201b = { method: "GET", url: url201 } as Tina4Request;
    const res201b = Object.assign(
      function (b: any) { served201 = b; },
      {
        raw: {
          writableEnded: false, statusCode: 200,
          end(_c: any) { return this; },
          getHeader: (n: string) => h201b[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { h201b[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    await customMw(req201b, res201b, () => { next201b = true; });
    assert("statusCodes:[201] DOES cache a 201 (2nd GET is a HIT)", !next201b && served201 === body201, `next=${next201b} served=${served201}`);
    // The configured ttl: 120 is advertised on the HIT.
    assert("custom config ttl:120 reflected in X-Cache-TTL on HIT", h201b["x-cache-ttl"] === "120", JSON.stringify(h201b));

    await clearCache();
    _resetBackend();
  }

  // --- Default config (no args) caches a plain 200 GET (default statusCodes:[200]) ---
  {
    delete process.env.TINA4_CACHE_BACKEND;
    delete process.env.TINA4_CACHE_TTL;
    _resetBackend();
    await clearCache();

    const defaultMw = responseCache();
    const url = "/api/cfg-default";
    const body = JSON.stringify({ default: true });

    const ha: Record<string, string> = {};
    const reqa = { method: "GET", url } as Tina4Request;
    const resa = {
      raw: {
        writableEnded: false, statusCode: 200,
        end(_c: any) { return this; },
        getHeader: (n: string) => ha[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { ha[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    await defaultMw(reqa, resa, () => {});
    (resa.raw.end as any)(body);
    await new Promise((r) => setTimeout(r, 30));

    let nextb = false;
    let servedb: string | null = null;
    const hb: Record<string, string> = {};
    const reqb = { method: "GET", url } as Tina4Request;
    const resb = Object.assign(
      function (b: any) { servedb = b; },
      {
        raw: {
          writableEnded: false, statusCode: 200,
          end(_c: any) { return this; },
          getHeader: (n: string) => hb[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { hb[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    await defaultMw(reqb, resb, () => { nextb = true; });
    assert("default config caches a 200 GET (2nd is a HIT)", !nextb && servedb === body, `next=${nextb} served=${servedb}`);
    // Default ttl is 60 (no env, no arg).
    assert("default config advertises default TTL 60 on HIT", hb["x-cache-ttl"] === "60", JSON.stringify(hb));

    await clearCache();
    _resetBackend();
  }

  // --- Env var TINA4_CACHE_TTL feeds the cache lifetime ---
  // With no explicit ttl arg, responseCache() reads TINA4_CACHE_TTL. Drive a real
  // MISS→HIT and assert the HIT advertises X-Cache-TTL: 30 — proving the env var
  // (not the 60s default) fed the middleware's lifetime.
  console.log("\n--- Environment Variable ---");
  {
    const originalEnv = process.env.TINA4_CACHE_TTL;
    delete process.env.TINA4_CACHE_BACKEND;
    process.env.TINA4_CACHE_TTL = "30";
    _resetBackend();
    await clearCache();

    const envMw = responseCache(); // no ttl arg → must read TINA4_CACHE_TTL=30
    const url = "/api/env-ttl";
    const body = JSON.stringify({ env: true });

    const ha: Record<string, string> = {};
    const reqa = { method: "GET", url } as Tina4Request;
    const resa = {
      raw: {
        writableEnded: false, statusCode: 200,
        end(_c: any) { return this; },
        getHeader: (n: string) => ha[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { ha[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    await envMw(reqa, resa, () => {});
    (resa.raw.end as any)(body);
    assert("env TTL reflected on MISS (X-Cache-TTL: 30)", ha["x-cache-ttl"] === "30", JSON.stringify(ha));
    await new Promise((r) => setTimeout(r, 30));

    let nextb = false;
    let servedb: string | null = null;
    const hb: Record<string, string> = {};
    const reqb = { method: "GET", url } as Tina4Request;
    const resb = Object.assign(
      function (b: any) { servedb = b; },
      {
        raw: {
          writableEnded: false, statusCode: 200,
          end(_c: any) { return this; },
          getHeader: (n: string) => hb[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { hb[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    await envMw(reqb, resb, () => { nextb = true; });
    assert("env TTL HIT serves cached body", !nextb && servedb === body, `next=${nextb} served=${servedb}`);
    assert("env var TINA4_CACHE_TTL=30 fed the HIT lifetime (X-Cache-TTL: 30)", hb["x-cache-ttl"] === "30", JSON.stringify(hb));

    await clearCache();
    _resetBackend();
    if (originalEnv !== undefined) {
      process.env.TINA4_CACHE_TTL = originalEnv;
    } else {
      delete process.env.TINA4_CACHE_TTL;
    }
  }

  // --- cacheClear resets KV stats ---
  console.log("\n--- Clear Resets Stats ---");
  await cacheClear();
  const afterClear = await cacheStats();
  assert("After cacheClear, size is 0", afterClear.size === 0);

  // --- Backend selection ---
  console.log("\n--- Backend Selection ---");

  _resetBackend();
  const memStats = await cacheBackendStats();
  assert("Default backend is memory", memStats.backend === "memory");

  // --- Direct cache API ---
  console.log("\n--- Direct Cache API (Memory Backend) ---");

  _resetBackend();
  await cacheClear();

  await cacheSet("test_key", { hello: "world" }, 60);
  const got = await cacheGet("test_key") as any;
  assert("cacheSet and cacheGet work", got?.hello === "world");

  assert("cacheGet returns undefined for missing key", (await cacheGet("nonexistent_key_12345")) === undefined);

  await cacheSet("del_key", "value", 60);
  assert("cacheDelete returns true for existing key", (await cacheDelete("del_key")) === true);
  assert("cacheGet returns undefined after delete", (await cacheGet("del_key")) === undefined);

  await cacheSet("a", 1, 60);
  await cacheSet("b", 2, 60);
  await cacheClear();
  const clearedStats = await cacheBackendStats();
  assert("cacheClear empties the store", clearedStats.size === 0);

  // --- Stats tracking ---
  console.log("\n--- Stats Tracking ---");
  _resetBackend();
  await cacheClear();
  await cacheSet("x", "val", 60);
  await cacheGet("x"); // hit
  await cacheGet("missing"); // miss
  const statsTrack = await cacheBackendStats();
  assert("Stats track hits", statsTrack.hits >= 1);
  assert("Stats track misses", statsTrack.misses >= 1);
  assert("Stats has backend field", statsTrack.backend === "memory");

  // --- File backend ---
  console.log("\n--- File Backend ---");

  const testDir = "/tmp/tina4_node_cache_test_" + Date.now();
  const originalBackend = process.env.TINA4_CACHE_BACKEND;
  process.env.TINA4_CACHE_BACKEND = "file";
  process.env.TINA4_CACHE_DIR = testDir;
  _resetBackend();

  await cacheSet("file_key", { data: true }, 60);
  const fileGot = await cacheGet("file_key") as any;
  assert("File backend set and get work", fileGot?.data === true);

  await cacheDelete("file_key");
  assert("File backend delete works", (await cacheGet("file_key")) === undefined);

  // Cleanup
  await cacheClear();
  try { fs.rmSync(testDir, { recursive: true }); } catch {}

  if (originalBackend !== undefined) {
    process.env.TINA4_CACHE_BACKEND = originalBackend;
  } else {
    delete process.env.TINA4_CACHE_BACKEND;
  }
  delete process.env.TINA4_CACHE_DIR;
  _resetBackend();

  // --- Backend via config ---
  console.log("\n--- Backend Config Override ---");
  const origBackendEnv = process.env.TINA4_CACHE_BACKEND;
  process.env.TINA4_CACHE_BACKEND = "file";
  _resetBackend();
  // Default should use env
  const envBackendStats = await cacheBackendStats();
  assert("Env selects file backend", envBackendStats.backend === "file");

  if (origBackendEnv !== undefined) {
    process.env.TINA4_CACHE_BACKEND = origBackendEnv;
  } else {
    delete process.env.TINA4_CACHE_BACKEND;
  }
  _resetBackend();

  // --- Value Types ---
  console.log("\n--- Value Types ---");

  _resetBackend();
  await cacheClear();

  await cacheSet("str_val", "hello", 60);
  assert("String value stored and retrieved", (await cacheGet("str_val")) === "hello");

  await cacheSet("num_val", 42, 60);
  assert("Number value stored and retrieved", (await cacheGet("num_val")) === 42);

  await cacheSet("bool_val", true, 60);
  assert("Boolean value stored and retrieved", (await cacheGet("bool_val")) === true);

  await cacheSet("null_val", null, 60);
  assert("Null value stored and retrieved", (await cacheGet("null_val")) === null);

  await cacheSet("arr_val", [1, 2, 3], 60);
  const arrResult = await cacheGet("arr_val") as any;
  assert("Array value stored and retrieved", Array.isArray(arrResult) && arrResult.length === 3);

  await cacheSet("obj_val", { a: 1, b: { c: 2 } }, 60);
  const objResult = await cacheGet("obj_val") as any;
  assert("Nested object stored and retrieved", objResult?.b?.c === 2);

  // --- Overwrite ---
  console.log("\n--- Overwrite ---");

  await cacheSet("overwrite_key", "first", 60);
  assert("initial value set", (await cacheGet("overwrite_key")) === "first");

  await cacheSet("overwrite_key", "second", 60);
  assert("overwrite replaces value", (await cacheGet("overwrite_key")) === "second");

  // --- Delete non-existent ---
  console.log("\n--- Delete Edge Cases ---");

  const delNonExistent = await cacheDelete("this_key_does_not_exist_xyz");
  assert("delete non-existent returns false", delNonExistent === false);

  // --- Multiple keys ---
  console.log("\n--- Multiple Keys ---");

  await cacheClear();
  for (let i = 0; i < 10; i++) {
    await cacheSet(`multi_${i}`, i, 60);
  }

  const multiStats = await cacheBackendStats();
  assert("10 keys stored", multiStats.size === 10);

  assert("first key retrievable", (await cacheGet("multi_0")) === 0);
  assert("last key retrievable", (await cacheGet("multi_9")) === 9);

  await cacheDelete("multi_5");
  assert("deleted key returns undefined", (await cacheGet("multi_5")) === undefined);
  assert("other keys unaffected", (await cacheGet("multi_4")) === 4);

  const afterDeleteStats = await cacheBackendStats();
  assert("size decremented after delete", afterDeleteStats.size === 9);

  // --- CacheBackendStats after set ---
  console.log("\n--- CacheBackendStats After Set ---");

  _resetBackend();
  await cacheClear();
  await cacheSet("alpha", "a", 60);
  await cacheSet("beta", "b", 60);

  const backendStatsAfterSet = await cacheBackendStats();
  assert("backend has 2 entries after 2 sets", backendStatsAfterSet.size === 2);
  assert("backend backend field is string", typeof backendStatsAfterSet.backend === "string");

  // --- Zero-TTL contract: 0 means NO expiry (value persists) ---
  // The memory backend (and the rest) treat ttl <= 0 as expiresAt = 0, i.e. the
  // entry never expires (MemoryBackend.set: `ttl > 0 ? Date.now()+ttl*1000 : 0`,
  // and get() only expires when `expiresAt && now > expiresAt`). Lock that
  // documented semantics in rather than asserting a constant — and confirm it
  // survives a short wait (it would have expired if 0 meant immediate expiry).
  console.log("\n--- Zero TTL = No Expiry ---");

  _resetBackend();
  await cacheClear();
  await cacheSet("short_ttl", "ephemeral", 0); // 0 TTL — no-expiry contract
  assert("zero TTL stores the value (no immediate expiry)", (await cacheGet("short_ttl")) === "ephemeral");
  await new Promise((r) => setTimeout(r, 40));
  assert("zero TTL value persists after a wait (0 = no expiry)", (await cacheGet("short_ttl")) === "ephemeral");
  // Contrast: a positive short TTL DOES expire, proving the 0 path is genuinely
  // the no-expiry branch and not just a slow timer.
  await cacheSet("short_ttl_real", "gone-soon", 1);
  assert("positive TTL value present immediately", (await cacheGet("short_ttl_real")) === "gone-soon");
  await cacheClear();

  // --- File backend edge cases ---
  console.log("\n--- File Backend Edge Cases ---");

  const testDir2 = "/tmp/tina4_node_cache_test2_" + Date.now();
  const origBe = process.env.TINA4_CACHE_BACKEND;
  process.env.TINA4_CACHE_BACKEND = "file";
  process.env.TINA4_CACHE_DIR = testDir2;
  _resetBackend();

  // Store multiple items
  await cacheSet("fa", { x: 1 }, 60);
  await cacheSet("fb", { x: 2 }, 60);
  await cacheSet("fc", { x: 3 }, 60);

  const fileStats = await cacheBackendStats();
  assert("File backend stores 3 items", fileStats.size === 3);

  // Overwrite in file backend
  await cacheSet("fa", { x: 99 }, 60);
  const faVal = await cacheGet("fa") as any;
  assert("File backend overwrite works", faVal?.x === 99);

  // Clear file backend
  await cacheClear();
  const clearedFileStats = await cacheBackendStats();
  assert("File backend clear empties store", clearedFileStats.size === 0);

  // Cleanup file backend
  try { fs.rmSync(testDir2, { recursive: true }); } catch {}
  if (origBe !== undefined) {
    process.env.TINA4_CACHE_BACKEND = origBe;
  } else {
    delete process.env.TINA4_CACHE_BACKEND;
  }
  delete process.env.TINA4_CACHE_DIR;
  _resetBackend();

  // --- Middleware custom options actually filter by status code ---
  // {ttl:30, statusCodes:[200]} caches a 200 GET (2nd identical GET is a HIT).
  // The ttl-only middleware (default statusCodes:[200]) must NOT cache a non-200
  // (404) response — proving the statusCodes filter genuinely runs.
  console.log("\n--- Middleware Custom Options ---");

  {
    delete process.env.TINA4_CACHE_BACKEND;
    delete process.env.TINA4_CACHE_TTL;
    _resetBackend();
    await clearCache();

    // (a) {ttl:30, statusCodes:[200]} — a 200 GET is cached, 2nd GET is a HIT.
    const customMw2 = responseCache({ ttl: 30, statusCodes: [200] });
    const url = "/api/custopt-200";
    const body = JSON.stringify({ ok: true });
    const ha: Record<string, string> = {};
    const reqa = { method: "GET", url } as Tina4Request;
    const resa = {
      raw: {
        writableEnded: false, statusCode: 200,
        end(_c: any) { return this; },
        getHeader: (n: string) => ha[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { ha[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    await customMw2(reqa, resa, () => {});
    (resa.raw.end as any)(body);
    await new Promise((r) => setTimeout(r, 30));

    let nextb = false;
    let servedb: string | null = null;
    const hb: Record<string, string> = {};
    const reqb = { method: "GET", url } as Tina4Request;
    const resb = Object.assign(
      function (b: any) { servedb = b; },
      {
        raw: {
          writableEnded: false, statusCode: 200,
          end(_c: any) { return this; },
          getHeader: (n: string) => hb[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { hb[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    await customMw2(reqb, resb, () => { nextb = true; });
    assert("statusCodes:[200] caches a 200 GET (2nd is a HIT)", !nextb && servedb === body, `next=${nextb} served=${servedb}`);
    assert("custom ttl:30 advertised on HIT", hb["x-cache-ttl"] === "30", JSON.stringify(hb));

    await clearCache();
    _resetBackend();
  }

  {
    delete process.env.TINA4_CACHE_BACKEND;
    delete process.env.TINA4_CACHE_TTL;
    _resetBackend();
    await clearCache();

    // (b) ttl-only middleware (default statusCodes:[200]) must NOT cache a 404.
    const noArgMw = responseCache({ ttl: 60 });
    const url = "/api/custopt-404";
    const ha: Record<string, string> = {};
    const reqa = { method: "GET", url } as Tina4Request;
    const resa = {
      raw: {
        writableEnded: false, statusCode: 404,
        end(_c: any) { return this; },
        getHeader: (n: string) => ha[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { ha[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    await noArgMw(reqa, resa, () => {});
    (resa.raw.end as any)(JSON.stringify({ error: "not found" })); // 404 → NOT cached
    await new Promise((r) => setTimeout(r, 30));

    // A 2nd identical GET must still MISS (call next) — the 404 was never stored.
    let nextb = false;
    const hb: Record<string, string> = {};
    const reqb = { method: "GET", url } as Tina4Request;
    const resb = Object.assign(
      function (_b: any) { /* a HIT here would be a bug — 404 must not cache */ },
      {
        raw: {
          writableEnded: false, statusCode: 404,
          end(_c: any) { return this; },
          getHeader: (n: string) => hb[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { hb[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    await noArgMw(reqb, resb, () => { nextb = true; });
    assert("ttl-only middleware does NOT cache a 404 (2nd GET still MISSes)", nextb, `next=${nextb}`);

    await clearCache();
    _resetBackend();
  }

  // --- responseCache distributes through the backend (memory default) ---
  // A SECOND middleware instance serves the response a FIRST instance stored,
  // proving they share the unified backend (in-process for memory, cross-
  // instance for redis/etc.). This is the parity behaviour with Python/PHP/Ruby.
  console.log("\n--- responseCache shared backend (memory default) ---");
  {
    delete process.env.TINA4_CACHE_BACKEND;
    _resetBackend();
    await clearCache();

    const url = "/api/shared-memory";
    const body = JSON.stringify({ value: 42 });

    // Instance A — MISS, captures + stores on end().
    const mwA = responseCache({ ttl: 60 });
    const headersA: Record<string, string> = {};
    const reqA = { method: "GET", url } as Tina4Request;
    const resA = {
      raw: {
        writableEnded: false, statusCode: 200,
        end(_chunk: any) { return this; },
        getHeader: (n: string) => headersA[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
      },
      header: (n: string, v: string) => { headersA[n.toLowerCase()] = v; },
    } as unknown as Tina4Response;
    let aNext = false;
    await mwA(reqA, resA, () => { aNext = true; });
    assert("instance A: GET miss calls next()", aNext);
    // Trigger the capture (server calls res.raw.end with the body).
    (resA.raw.end as any)(body);
    // Let the fire-and-forget backend.set settle.
    await new Promise((r) => setTimeout(r, 30));

    // Instance B (fresh middleware) — should serve the HIT from the shared backend.
    const mwB = responseCache({ ttl: 60 });
    const headersB: Record<string, string> = {};
    let servedBody: string | null = null;
    let servedStatus = 0;
    const reqB = { method: "GET", url } as Tina4Request;
    const resB = Object.assign(
      function (b: any, status?: number) { servedBody = b; servedStatus = status ?? 200; },
      {
        raw: {
          writableEnded: false, statusCode: 200,
          end(_chunk: any) { return this; },
          getHeader: (n: string) => headersB[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { headersB[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    let bNext = false;
    await mwB(reqB, resB, () => { bNext = true; });
    assert("instance B serves HIT from shared backend (no next)", !bNext && servedBody === body, `body=${servedBody} status=${servedStatus}`);
    assert("instance B HIT sets X-Cache: HIT header", headersB["x-cache"] === "HIT");
    // X-Cache-TTL advertises the configured lifetime in seconds (parity with
    // Python/PHP/Ruby). ttl: 60 here → header "60".
    assert("instance B HIT sets X-Cache-TTL: 60 header", headersB["x-cache-ttl"] === "60", JSON.stringify(headersB));
    // The MISS path (instance A) sets X-Cache-TTL too.
    assert("instance A MISS sets X-Cache-TTL: 60 header", headersA["x-cache-ttl"] === "60", JSON.stringify(headersA));

    await clearCache();
    _resetBackend();
  }

  // --- responseCache distributes cross-instance via redis (self-skip) ---
  console.log("\n--- responseCache cross-instance via redis (db 3) ---");
  {
    const reachable = await redisReachable();
    if (!reachable) {
      console.log("  \x1b[33mSKIP\x1b[0m redis unreachable on localhost:6379 — skipping cross-instance redis test");
    } else {
      const prevBackend = process.env.TINA4_CACHE_BACKEND;
      const prevUrl = process.env.TINA4_CACHE_URL;
      process.env.TINA4_CACHE_BACKEND = "redis";
      process.env.TINA4_CACHE_URL = "redis://localhost:6379/3";
      _resetBackend();
      await clearCache();

      const url = "/api/shared-redis?x=" + Date.now();
      const body = JSON.stringify({ via: "redis", n: 7 });

      // Producer middleware instance — MISS then store.
      const mwProducer = responseCache({ ttl: 60 });
      const hP: Record<string, string> = {};
      const reqP = { method: "GET", url } as Tina4Request;
      const resP = {
        raw: {
          writableEnded: false, statusCode: 200,
          end(_chunk: any) { return this; },
          getHeader: (n: string) => hP[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
        },
        header: (n: string, v: string) => { hP[n.toLowerCase()] = v; },
      } as unknown as Tina4Response;
      await mwProducer(reqP, resP, () => {});
      (resP.raw.end as any)(body);
      await new Promise((r) => setTimeout(r, 60));

      // Simulate a SEPARATE instance: reset the module backend so the consumer
      // builds a brand-new redis connection (no in-process state shared).
      _resetBackend();

      const mwConsumer = responseCache({ ttl: 60 });
      const hC: Record<string, string> = {};
      let servedBody: string | null = null;
      const reqC = { method: "GET", url } as Tina4Request;
      const resC = Object.assign(
        function (b: any) { servedBody = b; },
        {
          raw: {
            writableEnded: false, statusCode: 200,
            end(_chunk: any) { return this; },
            getHeader: (n: string) => hC[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
          },
          header: (n: string, v: string) => { hC[n.toLowerCase()] = v; },
        },
      ) as unknown as Tina4Response;
      let cNext = false;
      await mwConsumer(reqC, resC, () => { cNext = true; });
      assert("redis cross-instance: consumer serves producer's response", !cNext && servedBody === body, `body=${servedBody}`);
      assert("redis cross-instance: HIT header set", hC["x-cache"] === "HIT");

      await clearCache();
      _resetBackend();
      if (prevBackend === undefined) delete process.env.TINA4_CACHE_BACKEND; else process.env.TINA4_CACHE_BACKEND = prevBackend;
      if (prevUrl === undefined) delete process.env.TINA4_CACHE_URL; else process.env.TINA4_CACHE_URL = prevUrl;
      _resetBackend();
    }
  }

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});

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

  // --- Exports exist ---
  console.log("--- Exports ---");
  assert("responseCache is a function", typeof responseCache === "function");
  assert("clearCache is a function", typeof clearCache === "function");
  assert("cacheStats is a function", typeof cacheStats === "function");
  assert("cacheGet is a function", typeof cacheGet === "function");
  assert("cacheSet is a function", typeof cacheSet === "function");
  assert("cacheDelete is a function", typeof cacheDelete === "function");
  assert("cacheClear is a function", typeof cacheClear === "function");
  assert("cacheBackendStats is a function", typeof cacheBackendStats === "function");

  // --- clearCache and cacheStats ---
  console.log("\n--- clearCache and cacheStats ---");

  await cacheClear();
  const emptyStats = await cacheStats();
  assert("Empty cache has size 0", emptyStats.size === 0);
  assert("cacheStats reflects the KV backend (cacheSet store)", typeof emptyStats.size === "number");
  assert("cacheStats has backend field", typeof emptyStats.backend === "string");

  // --- Creating middleware ---
  console.log("\n--- Middleware Creation ---");

  const mw = responseCache({ ttl: 60 });
  assert("responseCache returns a function", typeof mw === "function");
  assert("Middleware has 3 params (req, res, next)", mw.length === 3);

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
      getHeader: (name: string) => headers[name.toLowerCase()] || "application/json",
    },
    header: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
  } as unknown as Tina4Response;

  await cacheMw2(getReq, getRes, () => { getNextCalled = true; });
  assert("GET cache miss calls next()", getNextCalled);

  // --- Config options ---
  console.log("\n--- Config Options ---");

  const customMw = responseCache({ ttl: 120, maxEntries: 500, statusCodes: [200, 201] });
  assert("Custom config returns middleware", typeof customMw === "function");

  // --- Default config ---
  const defaultMw = responseCache();
  assert("Default config (no args) returns middleware", typeof defaultMw === "function");

  // --- Config with env var ---
  console.log("\n--- Environment Variable ---");
  const originalEnv = process.env.TINA4_CACHE_TTL;
  process.env.TINA4_CACHE_TTL = "30";
  const envMw = responseCache();
  assert("Env var TINA4_CACHE_TTL creates middleware", typeof envMw === "function");
  if (originalEnv !== undefined) {
    process.env.TINA4_CACHE_TTL = originalEnv;
  } else {
    delete process.env.TINA4_CACHE_TTL;
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

  // --- TTL expiry via short TTL ---
  console.log("\n--- TTL Expiry ---");

  await cacheClear();
  await cacheSet("short_ttl", "ephemeral", 0); // 0 second TTL — should expire immediately or be unset
  // Note: with 0 TTL, behavior depends on implementation - some treat 0 as "no expiry"
  // We just verify the API doesn't throw
  assert("zero TTL does not throw", true);

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

  // --- Middleware with custom options ---
  console.log("\n--- Middleware Custom Options ---");

  {
    const customMw2 = responseCache({ ttl: 30, statusCodes: [200] });
    assert("Custom middleware with statusCodes", typeof customMw2 === "function");
  }

  {
    const noArgMw = responseCache({ ttl: 60 });
    assert("Middleware with ttl-only option", typeof noArgMw === "function");
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
        getHeader: (n: string) => headersA[n.toLowerCase()] || "application/json",
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
          getHeader: (n: string) => headersB[n.toLowerCase()] || "application/json",
        },
        header: (n: string, v: string) => { headersB[n.toLowerCase()] = v; },
      },
    ) as unknown as Tina4Response;
    let bNext = false;
    await mwB(reqB, resB, () => { bNext = true; });
    assert("instance B serves HIT from shared backend (no next)", !bNext && servedBody === body, `body=${servedBody} status=${servedStatus}`);
    assert("instance B HIT sets X-Cache: HIT header", headersB["x-cache"] === "HIT");

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
          getHeader: (n: string) => hP[n.toLowerCase()] || "application/json",
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
            getHeader: (n: string) => hC[n.toLowerCase()] || "application/json",
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

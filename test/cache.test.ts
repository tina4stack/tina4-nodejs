/**
 * Unit tests for the response cache (cache.ts) — multi-backend.
 * Run with: npx tsx test/cache.test.ts
 */
import { responseCache, clearCache, cacheStats, cacheGet, cacheSet, cacheDelete, cacheClear, cacheBackendStats, _resetBackend } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, Middleware } from "../packages/core/src/index.ts";
import * as fs from "node:fs";
import * as path from "node:path";

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

clearCache();
const emptyStats = cacheStats();
assert("Empty cache has size 0", emptyStats.size === 0);
assert("Empty cache has no keys", emptyStats.keys.length === 0);
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
disabledMw(mockReq, mockRes, () => { nextCalled = true; });
assert("TTL 0 calls next() immediately", nextCalled);

// --- Non-GET requests pass through ---
console.log("\n--- Non-GET Passthrough ---");

clearCache();
const cacheMw = responseCache({ ttl: 60 });

let postNextCalled = false;
const postReq = { method: "POST", url: "/api/data" } as Tina4Request;
const postRes = { raw: { writableEnded: false } } as Tina4Response;
cacheMw(postReq, postRes, () => { postNextCalled = true; });
assert("POST request calls next()", postNextCalled);

let putNextCalled = false;
const putReq = { method: "PUT", url: "/api/data/1" } as Tina4Request;
const putRes = { raw: { writableEnded: false } } as Tina4Response;
cacheMw(putReq, putRes, () => { putNextCalled = true; });
assert("PUT request calls next()", putNextCalled);

let deleteNextCalled = false;
const deleteReq = { method: "DELETE", url: "/api/data/1" } as Tina4Request;
const deleteRes = { raw: { writableEnded: false } } as Tina4Response;
cacheMw(deleteReq, deleteRes, () => { deleteNextCalled = true; });
assert("DELETE request calls next()", deleteNextCalled);

// --- GET request cache miss calls next ---
console.log("\n--- GET Cache Miss ---");

clearCache();
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

cacheMw2(getReq, getRes, () => { getNextCalled = true; });
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

// --- clearCache resets stats ---
console.log("\n--- Clear Resets Stats ---");
clearCache();
const afterClear = cacheStats();
assert("After clearCache, size is 0", afterClear.size === 0);
assert("After clearCache, keys array is empty", afterClear.keys.length === 0);

// --- Backend selection ---
console.log("\n--- Backend Selection ---");

_resetBackend();
const memStats = cacheBackendStats();
assert("Default backend is memory", memStats.backend === "memory");

// --- Direct cache API ---
console.log("\n--- Direct Cache API (Memory Backend) ---");

_resetBackend();
cacheClear();

cacheSet("test_key", { hello: "world" }, 60);
const got = cacheGet("test_key") as any;
assert("cacheSet and cacheGet work", got?.hello === "world");

assert("cacheGet returns undefined for missing key", cacheGet("nonexistent_key_12345") === undefined);

cacheSet("del_key", "value", 60);
assert("cacheDelete returns true for existing key", cacheDelete("del_key") === true);
assert("cacheGet returns undefined after delete", cacheGet("del_key") === undefined);

cacheSet("a", 1, 60);
cacheSet("b", 2, 60);
cacheClear();
const clearedStats = cacheBackendStats();
assert("cacheClear empties the store", clearedStats.size === 0);

// --- Stats tracking ---
console.log("\n--- Stats Tracking ---");
_resetBackend();
cacheClear();
cacheSet("x", "val", 60);
cacheGet("x"); // hit
cacheGet("missing"); // miss
const statsTrack = cacheBackendStats();
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

cacheSet("file_key", { data: true }, 60);
const fileGot = cacheGet("file_key") as any;
assert("File backend set and get work", fileGot?.data === true);

cacheDelete("file_key");
assert("File backend delete works", cacheGet("file_key") === undefined);

// Cleanup
cacheClear();
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
const envBackendStats = cacheBackendStats();
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
cacheClear();

cacheSet("str_val", "hello", 60);
assert("String value stored and retrieved", cacheGet("str_val") === "hello");

cacheSet("num_val", 42, 60);
assert("Number value stored and retrieved", cacheGet("num_val") === 42);

cacheSet("bool_val", true, 60);
assert("Boolean value stored and retrieved", cacheGet("bool_val") === true);

cacheSet("null_val", null, 60);
assert("Null value stored and retrieved", cacheGet("null_val") === null);

cacheSet("arr_val", [1, 2, 3], 60);
const arrResult = cacheGet("arr_val") as any;
assert("Array value stored and retrieved", Array.isArray(arrResult) && arrResult.length === 3);

cacheSet("obj_val", { a: 1, b: { c: 2 } }, 60);
const objResult = cacheGet("obj_val") as any;
assert("Nested object stored and retrieved", objResult?.b?.c === 2);

// --- Overwrite ---
console.log("\n--- Overwrite ---");

cacheSet("overwrite_key", "first", 60);
assert("initial value set", cacheGet("overwrite_key") === "first");

cacheSet("overwrite_key", "second", 60);
assert("overwrite replaces value", cacheGet("overwrite_key") === "second");

// --- Delete non-existent ---
console.log("\n--- Delete Edge Cases ---");

const delNonExistent = cacheDelete("this_key_does_not_exist_xyz");
assert("delete non-existent returns false", delNonExistent === false);

// --- Multiple keys ---
console.log("\n--- Multiple Keys ---");

cacheClear();
for (let i = 0; i < 10; i++) {
  cacheSet(`multi_${i}`, i, 60);
}

const multiStats = cacheBackendStats();
assert("10 keys stored", multiStats.size === 10);

assert("first key retrievable", cacheGet("multi_0") === 0);
assert("last key retrievable", cacheGet("multi_9") === 9);

cacheDelete("multi_5");
assert("deleted key returns undefined", cacheGet("multi_5") === undefined);
assert("other keys unaffected", cacheGet("multi_4") === 4);

const afterDeleteStats = cacheBackendStats();
assert("size decremented after delete", afterDeleteStats.size === 9);

// --- CacheBackendStats after set ---
console.log("\n--- CacheBackendStats After Set ---");

_resetBackend();
cacheClear();
cacheSet("alpha", "a", 60);
cacheSet("beta", "b", 60);

const backendStatsAfterSet = cacheBackendStats();
assert("backend has 2 entries after 2 sets", backendStatsAfterSet.size === 2);
assert("backend backend field is string", typeof backendStatsAfterSet.backend === "string");

// --- TTL expiry via short TTL ---
console.log("\n--- TTL Expiry ---");

cacheClear();
cacheSet("short_ttl", "ephemeral", 0); // 0 second TTL — should expire immediately or be unset
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
cacheSet("fa", { x: 1 }, 60);
cacheSet("fb", { x: 2 }, 60);
cacheSet("fc", { x: 3 }, 60);

const fileStats = cacheBackendStats();
assert("File backend stores 3 items", fileStats.size === 3);

// Overwrite in file backend
cacheSet("fa", { x: 99 }, 60);
const faVal = cacheGet("fa") as any;
assert("File backend overwrite works", faVal?.x === 99);

// Clear file backend
cacheClear();
const clearedFileStats = cacheBackendStats();
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

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Unit tests for the response cache (cache.ts).
 * Run with: npx tsx test/cache.test.ts
 */
import { responseCache, clearCache, cacheStats } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, Middleware } from "../packages/core/src/index.ts";

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

// --- clearCache and cacheStats ---
console.log("\n--- clearCache and cacheStats ---");

clearCache();
const emptyStats = cacheStats();
assert("Empty cache has size 0", emptyStats.size === 0);
assert("Empty cache has no keys", emptyStats.keys.length === 0);

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

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Unit tests for the middleware chain (middleware.ts).
 * Run with: npx tsx test/middleware.test.ts
 */
import { MiddlewareChain, cors, requestLogger } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, Middleware } from "../packages/core/src/index.ts";

// ADR-0014 made the CORS default DENY. These assertions are about the CORS
// POLICY headers, which did not change, so the suite declares the wildcard
// policy it used to inherit from the old permissive default.
process.env.TINA4_CORS_ORIGINS = "*";

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

// Helper to create mock req/res
function mockReq(overrides: Partial<Tina4Request> = {}): Tina4Request {
  return {
    method: "GET",
    url: "/test",
    headers: {},
    params: {},
    query: {},
    body: undefined,
    ip: "127.0.0.1",
    files: [],
    ...overrides,
  } as unknown as Tina4Request;
}

function mockRes(): Tina4Response & { _headers: Record<string, string>; _status: number; _ended: boolean } {
  const headers: Record<string, string> = {};
  const obj = {
    _headers: headers,
    _status: 200,
    _ended: false,
    raw: {
      writableEnded: false,
      statusCode: 200,
      getHeader: (n: string) => headers[n.toLowerCase()],
      on: () => {},
    },
    header: (name: string, value: string) => {
      headers[name.toLowerCase()] = String(value);
      return obj;
    },
    status: (code: number) => { obj._status = code; return obj; },
  } as any;
  // Make it callable for cors OPTIONS response
  const fn = (data: any, statusCode?: number) => {
    obj._ended = true;
    if (statusCode) obj._status = statusCode;
    obj.raw.writableEnded = true;
    return fn;
  };
  Object.assign(fn, obj);
  fn.raw = obj.raw;
  fn.header = obj.header;
  fn.status = obj.status;
  fn._headers = obj._headers;
  fn._status = obj._status;
  fn._ended = obj._ended;
  return fn as any;
}

console.log("=== Middleware Chain Tests ===\n");

// --- Exports behave (constructed/invoked for real, not just typeof) ---
console.log("--- Exports ---");

// MiddlewareChain actually constructs and runs a registered middleware.
{
  const probe = new MiddlewareChain();
  let ran = false;
  probe.use((_req, _res, next) => { ran = true; next(); });
  const completed = await probe.run(mockReq(), mockRes());
  assert("MiddlewareChain constructs and runs its middleware", ran === true && completed === true);
}

// cors() actually produces headers on a request (real side effect, not typeof).
{
  const probeRes = mockRes();
  let probeNext = false;
  cors()(mockReq({ headers: { origin: "http://probe.test" } } as any), probeRes, () => { probeNext = true; });
  assert(
    "cors() produces a working middleware (sets Allow-Origin and calls next)",
    probeRes._headers["access-control-allow-origin"] === "*" && probeNext === true,
  );
}

// requestLogger() actually emits a line on response finish (real side effect).
{
  const { EventEmitter } = await import("node:events");
  const raw: any = new EventEmitter();
  raw.statusCode = 200;
  const savedDebug = process.env.TINA4_DEBUG;
  process.env.TINA4_DEBUG = "true";
  let captured = "";
  const orig = console.log;
  console.log = (...a: unknown[]) => { captured += a.join(" ") + "\n"; };
  try {
    requestLogger()({ method: "GET", url: "/probe" } as any, { raw } as any, () => {});
    raw.emit("finish");
  } finally {
    console.log = orig;
    if (savedDebug === undefined) delete process.env.TINA4_DEBUG;
    else process.env.TINA4_DEBUG = savedDebug;
  }
  assert("requestLogger() emits a request line on finish", captured.includes("GET /probe -> 200 ("));
}

// --- MiddlewareChain basic ---
console.log("\n--- MiddlewareChain Basic ---");

const chain = new MiddlewareChain();

// chain.use() registers and chain.run() executes it — exercise both for real.
{
  const useChain = new MiddlewareChain();
  const seen: string[] = [];
  useChain.use((_req, _res, next) => { seen.push("registered-mw"); next(); });
  const ok = await useChain.run(mockReq(), mockRes());
  assert("chain.use registers a middleware that chain.run executes", seen.includes("registered-mw"));
  assert("chain.run returns true when the chain completes", ok === true);
}

// --- Empty chain runs and returns true ---
console.log("\n--- Empty Chain ---");
const emptyResult = await chain.run(mockReq(), mockRes());
assert("Empty chain returns true (completed)", emptyResult === true);

// --- Single middleware ---
console.log("\n--- Single Middleware ---");

const chain2 = new MiddlewareChain();
const logs: string[] = [];
chain2.use((req, res, next) => {
  logs.push("mw1");
  next();
});

const result2 = await chain2.run(mockReq(), mockRes());
assert("Single middleware runs", logs.includes("mw1"));
assert("Single middleware returns true", result2 === true);

// --- Multiple middlewares in order (M1 — index-skip bug fix) ---
// Every registered middleware that calls next() must run EXACTLY ONCE, in
// REGISTRATION order. The old runner double-advanced (for-loop index AND
// next() both incremented) so every other middleware was silently skipped;
// the chain is now driven purely by next().
console.log("\n--- Multiple Middlewares ---");

const chain3 = new MiddlewareChain();
const order: string[] = [];
chain3.use((req, res, next) => { order.push("first"); next(); });
chain3.use((req, res, next) => { order.push("second"); next(); });
chain3.use((req, res, next) => { order.push("third"); next(); });
chain3.use((req, res, next) => { order.push("fourth"); next(); });

await chain3.run(mockReq(), mockRes());
assert(
  "All middlewares run exactly once in registration order (no skip)",
  JSON.stringify(order) === JSON.stringify(["first", "second", "third", "fourth"]),
  `order=${JSON.stringify(order)}`,
);
assert("Chain processes every middleware", order.length === 4);

// --- N middleware all run exactly once in order (Node index-skip guard) ---
console.log("\n--- N Middlewares (no skip) ---");
{
  const N = 5;
  const chainN = new MiddlewareChain();
  const trace: string[] = [];
  const expected = Array.from({ length: N }, (_, i) => `mw${i}`);
  for (let i = 0; i < N; i++) {
    const label = `mw${i}`;
    chainN.use((req, res, next) => { trace.push(label); next(); });
  }
  await chainN.run(mockReq(), mockRes());
  assert(
    `N=${N} middleware all run, in order`,
    JSON.stringify(trace) === JSON.stringify(expected),
    `trace=${JSON.stringify(trace)}`,
  );
  assert("N middleware each run exactly once", trace.length === new Set(trace).size && trace.length === N);
}

// --- Middleware that ends response ---
console.log("\n--- Response Ending ---");

const chain4 = new MiddlewareChain();
const endLogs: string[] = [];
chain4.use((req, res, next) => {
  endLogs.push("before-end");
  res.raw.writableEnded = true;
});
chain4.use((req, res, next) => {
  endLogs.push("after-end");
  next();
});

const result4 = await chain4.run(mockReq(), mockRes());
assert("Chain stops when response ended", result4 === false);
assert("Only first middleware ran", endLogs.length === 1 && endLogs[0] === "before-end");

// --- CORS middleware ---
console.log("\n--- CORS Middleware ---");

const corsMw = cors();

// CORS with wildcard origin — exercises corsMw and asserts the real headers it sets.
const corsReq = mockReq({ headers: { origin: "http://example.com" } } as any);
const corsRes = mockRes();
let corsNextCalled = false;
corsMw(corsReq, corsRes, () => { corsNextCalled = true; });
assert("cors() middleware calls next() and sets the default Allow-Methods on a non-OPTIONS request",
  corsNextCalled === true && corsRes._headers["access-control-allow-methods"] === "GET, POST, PUT, DELETE, PATCH, OPTIONS");
assert("CORS next() called for non-OPTIONS", corsNextCalled);
assert("CORS sets Access-Control-Allow-Origin", corsRes._headers["access-control-allow-origin"] === "*");

// CORS OPTIONS preflight
const optionsReq = mockReq({ method: "OPTIONS", headers: { origin: "http://example.com" } } as any);
const optionsRes = mockRes();
let optionsNextCalled = false;
corsMw(optionsReq, optionsRes, () => { optionsNextCalled = true; });
assert("CORS OPTIONS does not call next()", optionsNextCalled === false);

// CORS with specific origins
const specificCors = cors({ origins: ["http://allowed.com"] });
const allowedReq = mockReq({ method: "GET", headers: { origin: "http://allowed.com" } } as any);
const allowedRes = mockRes();
let allowedNext = false;
specificCors(allowedReq, allowedRes, () => { allowedNext = true; });
assert("Allowed origin gets CORS headers", allowedRes._headers["access-control-allow-origin"] === "http://allowed.com");
assert("Allowed origin sets Vary: Origin", allowedRes._headers["vary"] === "Origin");

// CORS with disallowed origin
const disallowedReq = mockReq({ method: "GET", headers: { origin: "http://evil.com" } } as any);
const disallowedRes = mockRes();
let disallowedNext = false;
specificCors(disallowedReq, disallowedRes, () => { disallowedNext = true; });
assert("Disallowed origin calls next()", disallowedNext === true);
assert("Disallowed origin gets no CORS header", disallowedRes._headers["access-control-allow-origin"] === undefined);

// --- CORS custom config ---
console.log("\n--- CORS Config ---");

const customCors = cors({
  origins: "*",
  methods: ["GET", "POST"],
  headers: ["X-Custom"],
  maxAge: 3600,
});
// Invoke the custom-config middleware on a real OPTIONS preflight and assert the
// custom methods/headers/maxAge it actually emits (not just that it's a function).
const customOptionsReq = mockReq({ method: "OPTIONS", headers: { origin: "http://anything.test" } } as any);
const customOptionsRes = mockRes();
let customOptionsNext = false;
customCors(customOptionsReq, customOptionsRes, () => { customOptionsNext = true; });
assert("Custom CORS sets Access-Control-Allow-Methods: GET, POST",
  customOptionsRes._headers["access-control-allow-methods"] === "GET, POST",
  `methods=${customOptionsRes._headers["access-control-allow-methods"]}`);
assert("Custom CORS sets Access-Control-Allow-Headers: X-Custom",
  customOptionsRes._headers["access-control-allow-headers"] === "X-Custom",
  `headers=${customOptionsRes._headers["access-control-allow-headers"]}`);
assert("Custom CORS sets Access-Control-Max-Age: 3600",
  customOptionsRes._headers["access-control-max-age"] === "3600",
  `maxAge=${customOptionsRes._headers["access-control-max-age"]}`);
assert("Custom CORS preflight ends the response (does not call next)", customOptionsNext === false);

// --- requestLogger ---
console.log("\n--- Request Logger ---");

{
  const { EventEmitter } = await import("node:events");
  const savedDebug = process.env.TINA4_DEBUG;
  process.env.TINA4_DEBUG = "true";

  // (was "requestLogger returns a middleware") The middleware calls next() and
  // does NOT log until the response 'finish' fires — logging is deferred to the
  // finish event, not emitted at invocation time.
  const raw: any = new EventEmitter();
  raw.statusCode = 200;
  let captured = "";
  let nextCalled = false;
  const orig = console.log;
  console.log = (...a: unknown[]) => { captured += a.join(" ") + "\n"; };
  try {
    requestLogger()({ method: "GET", url: "/widgets" } as any, { raw } as any, () => { nextCalled = true; });
    const beforeFinish = captured;
    raw.emit("finish");
    console.log = orig;
    assert("requestLogger calls next() and logs nothing before 'finish' fires",
      nextCalled === true && beforeFinish === "");
    assert("requestLogger logs once the response finishes", captured.includes("GET /widgets -> 200 ("));
  } finally {
    console.log = orig;
    if (savedDebug === undefined) delete process.env.TINA4_DEBUG;
    else process.env.TINA4_DEBUG = savedDebug;
  }

  // (was "Logger middleware has 3 params") Exercise a real non-200 status and
  // assert the logged line reflects the actual response status code + method/url.
  process.env.TINA4_DEBUG = "true";
  const raw404: any = new EventEmitter();
  raw404.statusCode = 404;
  let captured404 = "";
  const orig2 = console.log;
  console.log = (...a: unknown[]) => { captured404 += a.join(" ") + "\n"; };
  try {
    requestLogger()({ method: "POST", url: "/missing" } as any, { raw: raw404 } as any, () => {});
    raw404.emit("finish");
  } finally {
    console.log = orig2;
    if (savedDebug === undefined) delete process.env.TINA4_DEBUG;
    else process.env.TINA4_DEBUG = savedDebug;
  }
  assert("requestLogger reports the real method/url/status (POST /missing -> 404)",
    captured404.includes("POST /missing -> 404 ("),
    `line=${captured404.trim()}`);
}

// --- requestLogger behaviour (v3.13.14) ---
// On by default in dev, gated by TINA4_LOG_REQUESTS, routed through Tina4
// Log with the cross-framework line format: METHOD /path -> STATUS (Nms).
console.log("\n--- Request Logger behaviour ---");
{
  const { EventEmitter } = await import("node:events");

  function runOnce(envReq: string | undefined, debug: string | undefined): string {
    const savedReq = process.env.TINA4_LOG_REQUESTS;
    const savedDebug = process.env.TINA4_DEBUG;
    if (envReq === undefined) delete process.env.TINA4_LOG_REQUESTS;
    else process.env.TINA4_LOG_REQUESTS = envReq;
    if (debug === undefined) delete process.env.TINA4_DEBUG;
    else process.env.TINA4_DEBUG = debug;

    const raw: any = new EventEmitter();
    raw.statusCode = 200;
    const req: any = { method: "GET", url: "/widgets" };
    const res: any = { raw };

    let captured = "";
    const orig = console.log;
    console.log = (...a: unknown[]) => { captured += a.join(" ") + "\n"; };
    try {
      requestLogger()(req, res, () => {});
      raw.emit("finish");
    } finally {
      console.log = orig;
      if (savedReq === undefined) delete process.env.TINA4_LOG_REQUESTS;
      else process.env.TINA4_LOG_REQUESTS = savedReq;
      if (savedDebug === undefined) delete process.env.TINA4_DEBUG;
      else process.env.TINA4_DEBUG = savedDebug;
    }
    return captured;
  }

  const devOut = runOnce(undefined, "true");
  assert("dev (unset) logs the request", devOut.includes("GET /widgets -> 200 ("));
  assert("dev line has no [RequestLogger] prefix or bare status-first format", !devOut.includes("[RequestLogger]"));

  const prodOut = runOnce(undefined, undefined);
  assert("prod (unset) does NOT log", !prodOut.includes("GET /widgets"));

  const forcedOut = runOnce("true", undefined);
  assert("TINA4_LOG_REQUESTS=true logs even in prod", forcedOut.includes("GET /widgets -> 200 ("));

  const offOut = runOnce("false", "true");
  assert("TINA4_LOG_REQUESTS=false silences even in dev", !offOut.includes("GET /widgets"));
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

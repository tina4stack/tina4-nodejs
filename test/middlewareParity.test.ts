/**
 * Middleware parity tests — ports tina4-python's test_middleware_parity.py.
 *
 * Covers:
 *   PY-10-02 — @middleware must NOT silently disable auth_required on write routes
 *   PY-10-03 — request.headers must support case-insensitive lookups
 *   PY-10-01 regression — function-style middleware with `next()` still wraps the handler
 *   Class-based middleware (beforeX statics) still runs
 *
 * Run with: npx tsx test/middlewareParity.test.ts
 */
import type { IncomingMessage } from "node:http";
import {
  Router,
  MiddlewareRunner,
  createRequest,
  makeCaseInsensitiveHeaders,
  runRouteMiddlewares,
} from "../packages/core/src/index.ts";
import type {
  Tina4Request,
  Tina4Response,
  Middleware,
} from "../packages/core/src/index.ts";

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

// ── Mocks ────────────────────────────────────────────────────────

function mockRes(): Tina4Response & {
  _headers: Record<string, string>;
  _status: number;
  _ended: boolean;
} {
  const headers: Record<string, string> = {};
  const obj: any = {
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
    status: (code: number) => {
      obj._status = code;
      obj.raw.statusCode = code;
      return obj;
    },
    json: (data: any, statusCode?: number) => {
      obj._ended = true;
      obj.raw.writableEnded = true;
      if (statusCode) {
        obj._status = statusCode;
        obj.raw.statusCode = statusCode;
      }
      obj._body = data;
      return obj;
    },
  };
  return obj as any;
}

function mockReq(method = "GET", url = "/", headers: Record<string, string> = {}): Tina4Request {
  return {
    method,
    url,
    headers,
    params: {},
    query: {},
    body: undefined,
    ip: "127.0.0.1",
    files: {},
  } as unknown as Tina4Request;
}

console.log("=== Middleware Parity Tests (PY-10-01/02/03) ===\n");

// ────────────────────────────────────────────────────────────────
// PY-10-02 — @middleware must NOT disable secure-by-default
// ────────────────────────────────────────────────────────────────

console.log("--- PY-10-02: middleware does not disable auth ---");

{
  const router = new Router();
  const noopMw: Middleware = (_req, _res, next) => next();

  const handler = async (_req: Tina4Request, res: Tina4Response) => {
    res.json({ created: true });
  };

  router.post("/admin/api-keys", handler, [noopMw]);
  const match = router.match("POST", "/admin/api-keys");

  assert(
    "POST route with middleware still has secure === true",
    match !== null && match.secure === true,
    `got secure=${match?.secure}`,
  );
}

{
  const router = new Router();
  const noopMw: Middleware = (_req, _res, next) => next();
  const handler = async () => {};

  // .noAuth() above middleware should still open the route
  router.post("/api/webhook", handler, [noopMw]).noAuth();
  const match = router.match("POST", "/api/webhook");

  assert(
    "noAuth() above middleware opens the route",
    match !== null && match.noAuth === true,
    `got noAuth=${match?.noAuth}`,
  );
  // secure default still set — server.ts respects noAuth flag explicitly
  assert(
    "noAuth() leaves secure flag intact (server respects noAuth)",
    match !== null && match.secure === true,
  );
}

{
  const router = new Router();
  const noopMw: Middleware = (_req, _res, next) => next();
  const handler = async () => {};

  // .secure() above middleware locks a GET route
  router.get("/api/admin/stats", handler, [noopMw]).secure();
  const match = router.match("GET", "/api/admin/stats");

  assert(
    ".secure() above middleware locks a GET route",
    match !== null && match.secure === true,
  );
}

{
  const router = new Router();
  const noopMw: Middleware = (_req, _res, next) => next();
  const handler = async () => {};

  // PUT/PATCH/DELETE with middleware all stay secure
  router.put("/api/widgets/{id}", handler, [noopMw]);
  router.patch("/api/widgets/{id}", handler, [noopMw]);
  router.delete("/api/widgets/{id}", handler, [noopMw]);

  assert(
    "PUT with middleware stays secure",
    router.match("PUT", "/api/widgets/1")?.secure === true,
  );
  assert(
    "PATCH with middleware stays secure",
    router.match("PATCH", "/api/widgets/1")?.secure === true,
  );
  assert(
    "DELETE with middleware stays secure",
    router.match("DELETE", "/api/widgets/1")?.secure === true,
  );
}

{
  const router = new Router();
  const handler = async () => {};
  // No middleware — write route is still secure (baseline)
  router.post("/api/things", handler);
  assert(
    "POST without middleware is secure (baseline)",
    router.match("POST", "/api/things")?.secure === true,
  );
}

// ────────────────────────────────────────────────────────────────
// PY-10-03 — case-insensitive header lookup
// ────────────────────────────────────────────────────────────────

console.log("\n--- PY-10-03: case-insensitive headers ---");

{
  const raw = {
    "content-type": "application/json",
    "x-api-key": "key-abc-123",
    "authorization": "Bearer token-xyz",
    "user-agent": "Mozilla/5.0",
  };
  const h = makeCaseInsensitiveHeaders(raw as any) as any;

  assert("Lowercase lookup still works", h["content-type"] === "application/json");
  assert("Mixed-case lookup returns value", h["Content-Type"] === "application/json");
  assert("UPPERCASE lookup returns value", h["CONTENT-TYPE"] === "application/json");
  assert("Mixed-2 lookup returns value", h["Content-type"] === "application/json");
  assert("X-API-Key (mixed case) returns value", h["X-API-Key"] === "key-abc-123");
  assert("Authorization (Title case) returns value", h["Authorization"] === "Bearer token-xyz");
  assert("User-Agent (Title case) returns value", h["User-Agent"] === "Mozilla/5.0");
  assert("Missing header returns undefined", h["X-Missing"] === undefined);

  // `in` operator
  assert("'Content-Type' in headers is true", "Content-Type" in h);
  assert("'CONTENT-TYPE' in headers is true", "CONTENT-TYPE" in h);
  assert("'X-Missing' in headers is false", !("X-Missing" in h));
}

{
  // createRequest installs the case-insensitive wrapper on a real-ish IncomingMessage
  const fake = {
    method: "POST",
    url: "/api/widgets",
    headers: {
      "content-type": "application/json",
      "x-api-key": "secret",
    },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;

  const tReq = createRequest(fake);

  assert(
    "tReq.headers['Content-Type'] (mixed case) returns the value",
    (tReq.headers as any)["Content-Type"] === "application/json",
  );
  assert(
    "tReq.headers['content-type'] (lower) still works",
    (tReq.headers as any)["content-type"] === "application/json",
  );
  assert(
    "tReq.headers['X-Api-Key'] (mixed case) returns the value",
    (tReq.headers as any)["X-Api-Key"] === "secret",
  );
  assert(
    "tReq.contentType is populated from header",
    tReq.contentType === "application/json",
  );
}

// ────────────────────────────────────────────────────────────────
// PY-10-01 regression — function-style middleware runs with next()
// ────────────────────────────────────────────────────────────────

console.log("\n--- PY-10-01 regression: function middleware wraps handler ---");

{
  const trace: string[] = [];

  const fnMw: Middleware = async (_req, _res, next) => {
    trace.push("before");
    await next();
    trace.push("after");
  };

  const handler = async (_req: Tina4Request, _res: Tina4Response) => {
    trace.push("handler");
  };

  const req = mockReq();
  const res = mockRes();
  const proceed = await runRouteMiddlewares([fnMw], req, res);

  // The Node runner returns proceed=true → the server then invokes the handler.
  // Simulate that here.
  if (proceed) await handler(req, res);

  assert(
    "Function middleware ran before the handler",
    trace[0] === "before",
    `trace=${JSON.stringify(trace)}`,
  );
  assert(
    "Handler ran after the middleware",
    trace.includes("handler"),
    `trace=${JSON.stringify(trace)}`,
  );
}

{
  // Short-circuit: a middleware that ends the response (no next()) prevents handler.
  const trace: string[] = [];

  const gate: Middleware = (_req, res) => {
    trace.push("gate");
    res.json({ blocked: true }, 403);
  };

  const handler = async () => {
    trace.push("handler-should-not-run");
  };

  const req = mockReq();
  const res = mockRes();
  const proceed = await runRouteMiddlewares([gate], req, res);
  if (proceed) await handler();

  assert(
    "Short-circuit blocks the handler",
    trace.length === 1 && trace[0] === "gate",
    `trace=${JSON.stringify(trace)}`,
  );
  assert("Short-circuit returned proceed=false", proceed === false);
}

// ────────────────────────────────────────────────────────────────
// Class-based middleware (beforeX statics) still works
// ────────────────────────────────────────────────────────────────

console.log("\n--- Class-based middleware via MiddlewareRunner ---");

{
  const trace: string[] = [];

  class LogMw {
    static beforeLog(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
      trace.push("class.beforeLog");
      return [req, res];
    }
    static afterLog(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
      trace.push("class.afterLog");
      return [req, res];
    }
  }

  const req = mockReq();
  const res = mockRes();

  const [, , shouldContinue] = MiddlewareRunner.runBefore([LogMw], req, res);
  assert("Class beforeLog ran", trace.includes("class.beforeLog"));
  assert("Class middleware allows handler to continue", shouldContinue === true);

  MiddlewareRunner.runAfter([LogMw], req, res);
  assert("Class afterLog ran", trace.includes("class.afterLog"));
}

{
  // A 4xx status from a before* method short-circuits.
  class GateMw {
    static beforeGate(req: Tina4Request, res: Tina4Response): [Tina4Request, Tina4Response] {
      res.status(403);
      return [req, res];
    }
  }

  const req = mockReq();
  const res = mockRes();
  const [, , shouldContinue] = MiddlewareRunner.runBefore([GateMw], req, res);

  assert(
    "Class middleware short-circuits on 4xx status",
    shouldContinue === false,
  );
}

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`,
);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

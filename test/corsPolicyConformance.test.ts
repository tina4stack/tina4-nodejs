/**
 * CORS policy conformance - deny by default, no wildcard+credentials, Vary: Origin.
 *
 * Feature 10 (CORS middleware) conformance suite. See ADR-0014.
 *
 * Three rules, each pinned positive AND negative, driven through a REAL HTTP
 * server started by the REAL startServer() with REAL http.request calls.
 * NO MOCKS. One server per policy, because the middleware reads its config
 * when the server is built - exactly as it does in production.
 *
 * 1. DENY BY DEFAULT. With TINA4_CORS_ORIGINS unset, no
 *    Access-Control-Allow-Origin is emitted and the browser's own CORS check
 *    blocks the request. "*" still works, but must be asked for.
 *
 * 2. NEVER ACAO: * WITH CREDENTIALS. The Fetch Standard's CORS check treats
 *    "*" as a literal once the request's credentials mode is "include", so the
 *    pair is rejected by every browser. Node's DEFAULT pipeline used cors(),
 *    which never read TINA4_CORS_CREDENTIALS at all - a documented env var
 *    that silently did nothing (measured 2026-07-31).
 *
 * 3. VARY: ORIGIN WHENEVER ACAO IS COMPUTED FROM THE REQUEST. RFC 9110
 *    s12.5.5: a Vary field name list tells cache recipients they "MUST NOT use
 *    this response to satisfy a later request unless the later request has the
 *    same values for the listed header fields as the original request".
 *    Emitted on an allow-list MISS as well as a match - Node previously
 *    emitted it only on a match, which still lets a cache serve the no-ACAO
 *    response for origin B to origin A. NOT emitted for a constant "*".
 *
 * Access-Control-Allow-Methods / -Allow-Headers are static configured lists
 * here, never derived from the request's Access-Control-Request-* headers, so
 * those field names deliberately do NOT appear in Vary.
 *
 * Same case names in all four:
 *   tina4-python/tests/test_cors_policy_conformance.py
 *   tina4-php/tests/CorsPolicyConformanceTest.php
 *   tina4-ruby/spec/cors_policy_conformance_spec.rb
 */
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/src/index.ts";

const GOOD = "https://good.example";
const EVIL = "https://evil.example";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const root = mkdtempSync(join(tmpdir(), "tina4-cors-policy-"));
mkdirSync(join(root, "src/routes/api/thing"), { recursive: true });
writeFileSync(join(root, "package.json"), '{"type":"module"}');
writeFileSync(
  join(root, "src/routes/api/thing/get.ts"),
  "export default async function (req: any, res: any) { res.json({ ok: true }); }\n"
);

process.env.TINA4_RATE_LIMIT = "100000";
let port = 3411;

interface Result { status: number; headers: http.IncomingHttpHeaders; }

function request(p: number, method: string, headers: Record<string, string>): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: p, path: "/api/thing", method, headers },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Start a REAL server with an exact CORS policy, run the probes against it,
 * and shut it down. The policy is env-driven and read at construction, which
 * is why each policy needs its own server rather than a shared one.
 */
async function withPolicy(
  origins: string | undefined,
  credentials: string | undefined,
  body: (call: (method: string, headers?: Record<string, string>) => Promise<Result>) => Promise<void>
): Promise<void> {
  if (origins === undefined) delete process.env.TINA4_CORS_ORIGINS;
  else process.env.TINA4_CORS_ORIGINS = origins;
  if (credentials === undefined) delete process.env.TINA4_CORS_CREDENTIALS;
  else process.env.TINA4_CORS_CREDENTIALS = credentials;

  const thisPort = port++;
  const server = await startServer({
    port: thisPort,
    routesDir: join(root, "src/routes"),
    modelsDir: join(root, "src/models"),
    staticDir: join(root, "public"),
  });
  try {
    await body((method, headers = {}) => request(thisPort, method, headers));
  } finally {
    server.close();
  }
}

console.log("=== CORS policy conformance ===\n");

// ------------------------------------------------------------ deny by default

console.log("--- deny by default ---");

await withPolicy(undefined, undefined, async (call) => {
  const res = await call("GET", { Origin: EVIL });
  assert(
    "deny by default emits no allow origin",
    res.headers["access-control-allow-origin"] === undefined,
    `got "${res.headers["access-control-allow-origin"]}" - an unconfigured app must not hand out ACAO`
  );

  // CORS is a BROWSER mechanism. curl and server-to-server are unaffected.
  const plain = await call("GET");
  assert(
    "deny by default still serves non browser clients",
    plain.status === 200 && plain.headers["access-control-allow-origin"] === undefined,
    `status=${plain.status}`
  );

  const preflight = await call("OPTIONS", { Origin: EVIL, "Access-Control-Request-Method": "GET" });
  assert(
    "preflight status is unchanged when denied",
    preflight.status === 204 && preflight.headers["access-control-allow-origin"] === undefined,
    `status=${preflight.status} - denying must not change the status, the browser does the blocking`
  );
});

await withPolicy("*", undefined, async (call) => {
  const res = await call("GET", { Origin: EVIL });
  assert(
    "explicit wildcard still allows any origin",
    res.headers["access-control-allow-origin"] === "*",
    `got "${res.headers["access-control-allow-origin"]}"`
  );
  assert(
    "constant wildcard does not vary on origin",
    res.headers["vary"] === undefined || !String(res.headers["vary"]).toLowerCase().includes("origin"),
    `got vary="${res.headers["vary"]}" - a constant * is identical for everyone`
  );
});

// -------------------------------------------------- wildcard never + credentials

console.log("\n--- credentials ---");

await withPolicy("*", "true", async (call) => {
  const res = await call("GET", { Origin: EVIL });
  assert(
    "wildcard never pairs with credentials",
    res.headers["access-control-allow-origin"] === "*"
      && res.headers["access-control-allow-credentials"] === undefined,
    `ACAO="${res.headers["access-control-allow-origin"]}" ACAC="${res.headers["access-control-allow-credentials"]}" `
      + "- ACAO: * with ACAC: true is rejected by every browser; the framework must never emit the pair"
  );
});

await withPolicy(`${GOOD},https://other.example`, "true", async (call) => {
  const res = await call("GET", { Origin: GOOD });
  assert(
    "allow list match reflects origin and credentials",
    res.headers["access-control-allow-origin"] === GOOD
      && res.headers["access-control-allow-credentials"] === "true",
    `ACAO="${res.headers["access-control-allow-origin"]}" ACAC="${res.headers["access-control-allow-credentials"]}" `
      + "- TINA4_CORS_CREDENTIALS must actually be honoured by the default pipeline"
  );
});

await withPolicy(GOOD, "true", async (call) => {
  const res = await call("GET", { Origin: EVIL });
  assert(
    "allow list miss emits no allow origin",
    res.headers["access-control-allow-origin"] === undefined
      && res.headers["access-control-allow-credentials"] === undefined,
    `ACAO="${res.headers["access-control-allow-origin"]}"`
  );
});

// -------------------------------------------------------------------------- Vary

console.log("\n--- Vary ---");

await withPolicy(GOOD, undefined, async (call) => {
  const match = await call("GET", { Origin: GOOD });
  const miss = await call("GET", { Origin: EVIL });
  assert(
    "allow list always varies on origin",
    String(match.headers["vary"] ?? "").toLowerCase().includes("origin")
      && String(miss.headers["vary"] ?? "").toLowerCase().includes("origin"),
    `match vary="${match.headers["vary"]}" miss vary="${miss.headers["vary"]}" `
      + "- a MISS must vary too, or a shared cache can serve this no-ACAO response "
      + "to an origin that should have been allowed"
  );
});

// ------------------------------------- both middleware forms are ONE implementation

console.log("\n--- one implementation ---");

{
  const mod = await import("../packages/core/src/middleware.ts") as {
    cors: typeof import("../packages/core/src/middleware.ts").cors;
    CorsMiddleware: typeof import("../packages/core/src/middleware.ts").CorsMiddleware;
    resetCorsWarnings?: () => void;
  };
  const { cors, CorsMiddleware } = mod;

  process.env.TINA4_CORS_ORIGINS = GOOD;
  process.env.TINA4_CORS_CREDENTIALS = "true";
  // Tolerate the export's absence so this suite still RUNS against pre-fix
  // code - the red must be a real assertion failure, not a TypeError.
  mod.resetCorsWarnings?.();

  function capture(): { hd: Record<string, string>; res: any } {
    const hd: Record<string, string> = {};
    const res: any = (_b: unknown, s?: number) => { res.status = s; return res; };
    res.header = (k: string, v: string) => { hd[k.toLowerCase()] = String(v); return res; };
    res.raw = { getHeader: (n: string) => hd[n.toLowerCase()] };
    return { hd, res };
  }

  const req = { method: "GET", headers: { origin: GOOD }, url: "/api/thing" } as any;
  const a = capture();
  cors()(req, a.res, () => {});
  const b = capture();
  CorsMiddleware.beforeCors(req, b.res);

  assert(
    "both middleware forms produce identical headers",
    JSON.stringify(a.hd) === JSON.stringify(b.hd),
    `cors()=${JSON.stringify(a.hd)} CorsMiddleware=${JSON.stringify(b.hd)} `
      + "- two implementations of one feature is how TINA4_CORS_CREDENTIALS became "
      + "a silent no-op in the default pipeline"
  );
  assert(
    "the function form honours TINA4_CORS_CREDENTIALS",
    a.hd["access-control-allow-credentials"] === "true",
    `got "${a.hd["access-control-allow-credentials"]}" - cors() ignored this env var entirely`
  );
}

// Cleanup
delete process.env.TINA4_CORS_ORIGINS;
delete process.env.TINA4_CORS_CREDENTIALS;
delete process.env.TINA4_RATE_LIMIT;
rmSync(root, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

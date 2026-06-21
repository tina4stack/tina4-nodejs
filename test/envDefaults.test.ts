/**
 * Lock-in tests for environment-variable DEFAULTS.
 *
 * These assert the AUTHORITATIVE defaults baked into the framework so a silent
 * drift (e.g. a fallback flipped back to the unsafe value) is caught.
 *
 * Run with: npx tsx test/envDefaults.test.ts
 */
import { CorsMiddleware } from "../packages/core/src/middleware.ts";

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

/**
 * Minimal Tina4Request / Tina4Response doubles that capture set headers.
 * CorsMiddleware.beforeCors only touches req.headers / req.method and
 * res.header(...) — enough to observe the credentials default.
 */
function makeReqRes(method = "GET", origin = "http://example.com") {
  const headers: Record<string, string> = {};
  const req: any = { method, headers: { origin } };
  const res: any = (..._args: unknown[]) => res;
  res.header = (name: string, value: string) => {
    headers[name.toLowerCase()] = value;
    return res;
  };
  return { req, res, headers };
}

// --- CORS credentials default: must be FALSE when env var is unset ---------
delete process.env.TINA4_CORS_CREDENTIALS;
{
  const { req, res, headers } = makeReqRes("GET");
  CorsMiddleware.beforeCors(req, res);
  assert(
    "CORS credentials default is false (Allow-Credentials header NOT sent on a normal response)",
    headers["access-control-allow-credentials"] === undefined,
    `got ${headers["access-control-allow-credentials"]}`,
  );
}

// --- Explicit opt-in still works (guards the gate logic, non-wildcard origin) ---
process.env.TINA4_CORS_CREDENTIALS = "true";
process.env.TINA4_CORS_ORIGINS = "http://example.com";
{
  const { req, res, headers } = makeReqRes("GET", "http://example.com");
  CorsMiddleware.beforeCors(req, res);
  assert(
    "CORS credentials opt-in (TINA4_CORS_CREDENTIALS=true) sends Allow-Credentials",
    headers["access-control-allow-credentials"] === "true",
  );
}
delete process.env.TINA4_CORS_CREDENTIALS;
delete process.env.TINA4_CORS_ORIGINS;

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

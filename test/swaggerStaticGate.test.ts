/**
 * Lock-in: the BUNDLED Swagger UI static assets must honour the swagger gate.
 *
 * Regression this pins down
 * -------------------------
 * The framework ships the Swagger UI as static files under
 * packages/core/public/swagger/ (index.html + oauth2-redirect.html).
 * BUILTIN_PUBLIC_DIR is served BEFORE route matching and applies index
 * resolution ('/swagger' -> 'swagger/index.html'), so before the fix a
 * production server still served the Swagger UI on:
 *
 *     /swagger                       -> 200 (index resolution)
 *     /swagger/                      -> 200 (index resolution)
 *     /swagger/index.html            -> 200 (direct file)
 *     /swagger/oauth2-redirect.html  -> 200 (direct file)
 *
 * even with swagger disabled -- silently bypassing the documented
 * TINA4_SWAGGER_ENABLED / TINA4_DEBUG switch. The tell was /swagger returning
 * 200 (static file) while /swagger/openapi.json (the gated route) 404'd.
 *
 * This drives a REAL server over REAL HTTP (the gate lives inside dispatch, so
 * a unit call cannot prove it). No doubles.
 *
 * Run with: npx tsx test/swaggerStaticGate.test.ts
 */
import { startServer } from "../packages/core/src/server.ts";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_PUBLIC = resolve(__dirname, "..", "packages", "core", "public");

/** Request paths that MUST be gated. */
const GATED_PATHS = [
  "/swagger",
  "/swagger/",
  "/swagger/index.html",
  "/swagger/oauth2-redirect.html",
];

/** A bundled asset that is NOT swagger, proving the gate is surgical. */
const CONTROL_PATH = "/favicon.ico";

const SAVED: Record<string, string | undefined> = {
  TINA4_SWAGGER_ENABLED: process.env.TINA4_SWAGGER_ENABLED,
  TINA4_DEBUG: process.env.TINA4_DEBUG,
  TINA4_NO_AI_PORT: process.env.TINA4_NO_AI_PORT,
  TINA4_NO_BROWSER: process.env.TINA4_NO_BROWSER,
};

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Boot a real server with the given gate env and collect status codes. */
async function statusesFor(
  swaggerEnabled: string | undefined,
  debug: string,
  port: number,
): Promise<Record<string, number>> {
  if (swaggerEnabled === undefined) {
    delete process.env.TINA4_SWAGGER_ENABLED;
  } else {
    process.env.TINA4_SWAGGER_ENABLED = swaggerEnabled;
  }
  process.env.TINA4_DEBUG = debug;
  // Keep the test to ONE server: no AI side-port, no browser launch.
  process.env.TINA4_NO_AI_PORT = "true";
  process.env.TINA4_NO_BROWSER = "true";

  const base = mkdtempSync(join(tmpdir(), "t4-swagger-gate-"));
  mkdirSync(join(base, "src", "routes"), { recursive: true });

  const server = await startServer({ port, basePath: base });
  const out: Record<string, number> = {};
  try {
    for (const path of [...GATED_PATHS, CONTROL_PATH]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      out[path] = res.status;
      await res.arrayBuffer().catch(() => undefined);
    }
  } finally {
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(base, { recursive: true, force: true });
  }
  return out;
}

console.log("\nSwagger bundled-asset gate (real server, real HTTP)\n");

// GUARD: without the real files on disk the negative case below could pass
// vacuously (nothing to serve means nothing to leak) and would keep passing
// even if the gate were deleted.
assert(
  "guard: bundled swagger assets really ship",
  existsSync(join(FRAMEWORK_PUBLIC, "swagger", "index.html")) &&
    existsSync(join(FRAMEWORK_PUBLIC, "swagger", "oauth2-redirect.html")),
  `looked in ${FRAMEWORK_PUBLIC}/swagger`,
);
assert(
  "guard: control asset (favicon.ico) really ships",
  existsSync(join(FRAMEWORK_PUBLIC, "favicon.ico")),
);

// NEGATIVE — swagger explicitly disabled: nothing under /swagger may serve.
{
  const codes = await statusesFor("false", "false", 7931);
  for (const path of GATED_PATHS) {
    assert(
      `NEGATIVE swagger disabled: ${path} is not served`,
      codes[path] === 404,
      `got ${codes[path]}`,
    );
  }
  assert(
    "NEGATIVE swagger disabled: non-swagger asset still serves",
    codes[CONTROL_PATH] === 200,
    `got ${codes[CONTROL_PATH]}`,
  );
}

// POSITIVE — swagger enabled: the assets must still serve (dev must not break).
{
  const codes = await statusesFor("true", "true", 7932);
  for (const path of GATED_PATHS) {
    assert(
      `POSITIVE swagger enabled: ${path} serves`,
      codes[path] === 200,
      `got ${codes[path]}`,
    );
  }
}

// Documented fallback: flag unset -> follow TINA4_DEBUG.
{
  const codes = await statusesFor(undefined, "false", 7933);
  assert(
    "flag unset + debug off: /swagger/index.html is not served",
    codes["/swagger/index.html"] === 404,
    `got ${codes["/swagger/index.html"]}`,
  );
}

// Restore env so this file does not leak into other tests.
for (const [key, value] of Object.entries(SAVED)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

console.log(
  `\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`,
);
process.exit(fail > 0 ? 1 : 0);

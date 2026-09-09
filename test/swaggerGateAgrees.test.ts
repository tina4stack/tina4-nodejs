/**
 * The swagger gate must mean ONE thing.
 * Run with: npx tsx test/swaggerGateAgrees.test.ts
 *
 * `swaggerEnabled()` is the single source of truth for whether the API document
 * is served. Three things are supposed to follow from it in lockstep: the
 * startup banner advertises /swagger, the UI page is served there, and the
 * document that page asks for is routed.
 *
 * They stopped agreeing. `configureSwagger` read the value into a local, then
 * gated route registration on the MODULE-level `swaggerAssetsEnabled` — which is
 * that function's own return value and is therefore still false while it runs.
 * The guard was permanently true, the routes were never added, and the function
 * still returned true. The banner kept advertising /swagger; the bundled static
 * asset answered it as a fallback, and that asset asks for the never-substituted
 * `{SWAGGER_ROUTE}/swagger.json`. So the UI loaded and stayed empty while every
 * document path 404'd. Shipped that way in 3.13.134.
 *
 * A single "enabled serves 200" example would have caught this one instance.
 * This asserts the PROPERTY instead, over two axes:
 *
 *   - every input the documented gate vocabulary accepts, and inputs it must
 *     reject — including the production default of both vars unset;
 *   - every documented way to REACH the UI — /swagger and /swagger/ — and for
 *     each, the document URL taken FROM the page that was actually served, then
 *     fetched.
 *
 * That last point is the one that matters. Asserting a 200 on a hardcoded
 * /swagger/openapi.json would have passed while the browser was being handed a
 * page pointing at a placeholder. The test reads the URL out of the served HTML
 * and requires that exact URL to resolve.
 *
 * The trailing-slash form is in here for the same reason and it is not
 * hypothetical: matching "/foo/" against a "/foo" route is opt-in via
 * TINA4_TRAILING_SLASH_REDIRECT and off by default, so /swagger/ used to miss
 * the route and be answered by the bundled public/swagger/index.html, whose
 * {SWAGGER_ROUTE} token nothing substitutes. A 200 and a page, and the page
 * permanently empty. Redirects are followed rather than asserted against, so
 * either serving the UI directly or redirecting to it passes — what must never
 * pass is ending up on a page whose document does not resolve.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort } from "./freePort.ts";

const __dirname = import.meta.dirname;
const REPO = resolve(__dirname, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];

/** Smallest app that proves routing works at all: one plain route, no ORM. */
function scaffoldApp(): string {
  const root = mkdtempSync(join(tmpdir(), "t4-swagger-gate-"));
  dirs.push(root);
  mkdirSync(join(root, "src", "routes", "api", "items"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"swagger-gate-app","type":"module","private":true}\n');
  writeFileSync(
    join(root, "src", "routes", "api", "items", "get.ts"),
    "export default async function (_req: any, res: any) { return res.json([]); }\n",
  );
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
      `await startServer({ port: Number(process.env.PORT), basePath: '${root}' } as never);\n`,
  );
  return root;
}

/** One UI path form: what it answered, what its page asks for, and whether that resolves. */
interface PathSurface {
  status: number;
  /** The document URL the served page asks for, or null if no page/no url. */
  asks: string | null;
  /** Status of the URL the page itself asks for, or null if it asked for nothing. */
  round: number | null;
  /** First script the page loads — says WHICH UI implementation answered. */
  scriptSrc: string | null;
}

interface Surface {
  /** Did the startup banner advertise /swagger? */
  advertised: boolean;
  /** Keyed by path: every documented way to reach the UI. */
  ui: Record<string, PathSurface>;
  /** Status of GET /swagger/openapi.json fetched directly. */
  doc: number;
}

/**
 * Every way a request can end up on a Swagger UI page. All of them must agree
 * with the gate, and every one of them must hand over a page whose document
 * resolves.
 *
 * The last two are here because they were each measured serving a page that
 * could never work: a directory-index miss ("/swagger//" — and any deeper
 * trailing-slash miss) and the bundled asset requested by name, which the
 * shared contract requires to answer 200. A 404 would have been honest; a 200
 * carrying a permanently empty UI is the defect.
 */
const UI_PATHS = ["/swagger", "/swagger/", "/swagger//", "/swagger/index.html"] as const;

/** Boot with exactly the env under test and report the whole swagger surface. */
async function surfaceUnder(env: Record<string, string>): Promise<Surface> {
  const root = scaffoldApp();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logPath = join(root, "server.log");
  const fd = openSync(logPath, "w");

  // Start from a clean slate: any TINA4_SWAGGER_*/SWAGGER_*/TINA4_DEBUG leaking
  // in from the parent would decide the case instead of the case's own env.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("TINA4_SWAGGER_") && !k.startsWith("SWAGGER_") && k !== "TINA4_DEBUG") {
      childEnv[k] = v;
    }
  }
  Object.assign(childEnv, {
    PORT: String(port),
    TINA4_NO_AI_PORT: "true",
    TINA4_NO_BROWSER: "true",
    TINA4_OVERRIDE_CLIENT: "true",
    ...env,
  });

  const child = spawn(TSX, ["app.ts"], { cwd: root, detached: true, stdio: ["ignore", fd, fd], env: childEnv });
  closeSync(fd);

  try {
    // "Up" is a plain app route answering — never a swagger route, which is the
    // thing under test and must not be used to decide readiness. Capped, so a
    // server that never boots is a named failure rather than a wedged run.
    const deadline = Date.now() + 60_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/items`);
        await res.arrayBuffer().catch(() => undefined);
        if (res.status === 200) {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    if (!up) throw new Error(`server never came up:\n${readFileSync(logPath, "utf8").slice(-1500)}`);

    const advertised = /\n\s+Swagger:\s+http:\/\//.test(readFileSync(logPath, "utf8"));

    const ui: Record<string, PathSurface> = {};
    for (const path of UI_PATHS) {
      // Redirects followed: reaching the UI via a 308 is as correct as being
      // served it. What is measured is the page you END UP on.
      const res = await fetch(`${base}${path}`);
      const html = res.status === 200 ? await res.text() : (await res.arrayBuffer(), "");
      // Whatever the page hands the browser as its document. Taken from the HTML
      // that was actually served, so a page pointing at an unsubstituted
      // {SWAGGER_ROUTE} placeholder is a URL that must then fail to resolve.
      const match = html.match(/url:\s*"([^"]+)"/);
      const asks = match ? match[1] : null;

      let round: number | null = null;
      if (asks !== null) {
        // A placeholder is not a valid URL; count it as unreachable rather than
        // letting `new URL` throw and lose the case.
        try {
          const r = await fetch(new URL(asks, base));
          await r.arrayBuffer().catch(() => undefined);
          round = r.status;
        } catch {
          round = 0;
        }
      }
      const script = html.match(/<script[^>]+src="([^"]+)"/);
      ui[path] = { status: res.status, asks, round, scriptSrc: script ? script[1] : null };
    }

    const docRes = await fetch(`${base}/swagger/openapi.json`);
    await docRes.arrayBuffer().catch(() => undefined);

    return { advertised, ui, doc: docRes.status };
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ── The vocabulary ───────────────────────────────────────────────────────────
// swaggerEnabled() (packages/swagger/src/ui.ts) trims, lowercases, and accepts
// exactly ["true","1","yes","on"], falling back to TINA4_DEBUG when the switch
// is unset. Every accepted spelling is here, so the list cannot claim coverage
// it does not have; the rejected ones include a non-member and the PRODUCTION
// DEFAULT of both vars unset, which must serve nothing.
const ON: Array<[string, Record<string, string>]> = [
  ["TINA4_SWAGGER_ENABLED=true", { TINA4_SWAGGER_ENABLED: "true" }],
  ["TINA4_SWAGGER_ENABLED=1", { TINA4_SWAGGER_ENABLED: "1" }],
  ["TINA4_SWAGGER_ENABLED=yes", { TINA4_SWAGGER_ENABLED: "yes" }],
  ["TINA4_SWAGGER_ENABLED=ON (case-insensitive)", { TINA4_SWAGGER_ENABLED: "ON" }],
  ["TINA4_SWAGGER_ENABLED='  true  ' (trimmed)", { TINA4_SWAGGER_ENABLED: "  true  " }],
  ["unset + TINA4_DEBUG=true (the documented fallback)", { TINA4_DEBUG: "true" }],
];

const OFF: Array<[string, Record<string, string>]> = [
  ["TINA4_SWAGGER_ENABLED=false", { TINA4_SWAGGER_ENABLED: "false" }],
  ["TINA4_SWAGGER_ENABLED=off (not in the vocabulary)", { TINA4_SWAGGER_ENABLED: "off" }],
  ["TINA4_SWAGGER_ENABLED=maybe (garbage fails closed)", { TINA4_SWAGGER_ENABLED: "maybe" }],
  ["TINA4_SWAGGER_ENABLED=false beats TINA4_DEBUG=true", { TINA4_SWAGGER_ENABLED: "false", TINA4_DEBUG: "true" }],
  ["unset + TINA4_DEBUG=false", { TINA4_DEBUG: "false" }],
  ["both unset (the production default)", {}],
];

console.log("\n  swagger gate: banner, both UI paths and the document must all agree with the switch\n");

for (const [label, env] of ON) {
  const s = await surfaceUnder(env);
  assert(`ON  by ${label}: banner advertises /swagger`, s.advertised);
  assert(`ON  by ${label}: GET /swagger/openapi.json serves the document`, s.doc === 200, `got ${s.doc}`);
  for (const path of UI_PATHS) {
    const p = s.ui[path];
    assert(`ON  by ${label}: GET ${path} serves the UI`, p.status === 200, `got ${p.status}`);
    assert(
      `ON  by ${label}: the document the page at ${path} asks for resolves`,
      p.round === 200,
      `page asked for ${JSON.stringify(p.asks)}, which answered ${p.round}`,
    );
  }
}

for (const [label, env] of OFF) {
  const s = await surfaceUnder(env);
  assert(`OFF by ${label}: banner stays quiet`, !s.advertised);
  assert(`OFF by ${label}: no document is offered`, s.doc === 404, `got ${s.doc}`);
  for (const path of UI_PATHS) {
    const p = s.ui[path];
    assert(`OFF by ${label}: GET ${path} serves nothing`, p.status === 404, `got ${p.status}`);
  }
}

// ── Which implementation answers the canonical paths ─────────────────────────
// Two Swagger UI pages exist in the tree: the one the routes render, which loads
// from TINA4_SWAGGER_UI_CDN (jsdelivr by default, repointable at a self-hosted
// mirror for air-gapped deployments), and the bundled public/swagger asset,
// which hardcodes cdnjs. The canonical paths must be answered by the ROUTES, or
// setting the CDN silently stops working on one of them — which is exactly what
// happened while /swagger/ was falling through to the bundled file.
const MIRROR = "https://swagger-mirror.invalid/ui";
const mirrored = await surfaceUnder({ TINA4_SWAGGER_ENABLED: "true", TINA4_SWAGGER_UI_CDN: MIRROR });
for (const path of ["/swagger", "/swagger/"]) {
  const p = mirrored.ui[path];
  assert(
    `TINA4_SWAGGER_UI_CDN is honoured at ${path} (the routes answer it, not the bundled asset)`,
    p.scriptSrc !== null && p.scriptSrc.startsWith(MIRROR),
    `page loaded ${JSON.stringify(p.scriptSrc)}`,
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);

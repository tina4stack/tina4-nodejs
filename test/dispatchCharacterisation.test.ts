/**
 * Feature 6: dispatch characterisation + ADR-0010 (routes beat files).
 *
 * The Ruby half of this suite froze RackApp#call before the pipeline
 * extraction. This is the Node counterpart, and it carries the same case names
 * so the four can be compared line for line.
 *
 * It drives a REAL server over a REAL socket - `startServer` on an ephemeral
 * port, real routes, real files on disk, real HTTP. Node's dispatch writes to a
 * stream rather than returning a response, so there is no in-process seam that
 * exercises the whole path; a real request is the only honest way to test it.
 *
 * NO MOCKS. The server is reaped in a finally, so a failing assertion cannot
 * leave a listener holding the port.
 *
 * Identical case names in all four frameworks:
 *   tina4-ruby/spec/dispatch_characterisation_spec.rb
 *   tina4-python/tests/test_dispatch_characterisation.py
 *   tina4-php/tests/DispatchCharacterisationTest.php
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const root = mkdtempSync(join(tmpdir(), "tina4-dispatch-"));
const routesDir = join(root, "src", "routes");
const publicDir = join(root, "public");
mkdirSync(publicDir, { recursive: true });

// Routes are discovered from FILES here, which is how a real Tina4 Node app
// declares them - registering in-process would exercise a path no deployment
// takes.
function route(urlPath: string, body: string) {
  const dir = join(routesDir, ...urlPath.split("/").filter(Boolean));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "get.ts"),
    `export default async function (_req: any, res: any) { return res(${body}, 200); }\n`);
}
route("/hello", '"world"');
route("/only-get", '"ok"');
route("/clash", '{ from: "route" }');
route("/api/thing", '"routed"');

// A write route marked noAuth - the matched route's metadata has to reach the
// auth gate for the marker to be honoured. PHP shipped this bypass as DEAD
// CODE once, because the metadata was assigned after the check.
mkdirSync(join(routesDir, "public-write"), { recursive: true });
writeFileSync(join(routesDir, "public-write", "post.ts"),
  'export const noAuth = true;\n' +
  'export default async function (_req: any, res: any) { return res("open", 200); }\n');

// A file at the SAME path as a route - it would win under file-first.
writeFileSync(join(publicDir, "clash"), '{"from":"file"}');
// A file with no competing route.
writeFileSync(join(publicDir, "plain.json"), '{"from":"file"}');

const PORT = await freePort();
let server: Awaited<ReturnType<typeof startServer>> | undefined;

async function req(method: string, path: string, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, redirect: "manual" });
  return { status: r.status, headers: r.headers, body: await r.text() };
}

console.log("=== Dispatch characterisation (Node) ===\n");

try {
  server = await startServer({ port: PORT, routesDir, staticDir: publicDir } as never);

  // ── 1. The happy path ──────────────────────────────────────────
  {
    const r = await req("GET", "/hello");
    assert("dispatch get known route returns handler body",
      r.status === 200 && r.body.includes("world"), `${r.status} ${r.body.slice(0, 40)}`);
  }

  // ── 2. Unknown path is a 404, after static misses ──────────────
  {
    const r = await req("GET", "/definitely/not/a/route");
    assert("dispatch unknown path returns 404", r.status === 404, String(r.status));
  }

  // ── 3. Known path, wrong method: 405 with Allow ────────────────
  {
    const r = await req("POST", "/only-get");
    assert("dispatch known path wrong method returns 405 with allow",
      r.status === 405 && (r.headers.get("allow") ?? "").toUpperCase().includes("GET"),
      `${r.status} allow=${r.headers.get("allow")}`);
  }

  // ── 4. OPTIONS: RFC 9110 shape ─────────────────────────────────
  //
  // A BARE OPTIONS (no Origin) belongs to the RFC 9110 s9.3.7 handler and MUST
  // carry Allow - that header is the entire point of the method, since it is
  // how a client discovers the method set. A 204 without it cannot be told
  // apart from "this server does not say".
  //
  // Node used to answer EVERY OPTIONS from cors(), because the default origin
  // list is "*" so the preflight branch fired even with no Origin header. That
  // swallowed the RFC 9110 path and dropped Allow. Ruby, Python and PHP all
  // answered a bare OPTIONS correctly; Node was alone.
  {
    const r = await req("OPTIONS", "/only-get");
    assert("dispatch options on known path returns 204 with allow",
      (r.status === 204 || r.status === 200)
        && (r.headers.get("allow") ?? "").toUpperCase().includes("GET"),
      `${r.status} allow=${r.headers.get("allow")}`);
    assert("the 204 carries no body", r.body === "", JSON.stringify(r.body));
  }

  // ── 4b. NEGATIVE: a REAL preflight still short-circuits ────────
  //
  // The fix must not stop CORS working. A preflight carries an Origin and is
  // answered by cors() with the Access-Control-* headers a browser needs.
  {
    const r = await req("OPTIONS", "/only-get", {
      Origin: "https://example.com",
      "Access-Control-Request-Method": "GET",
    });
    const corsHeaders = [...r.headers.keys()].filter((k) => k.startsWith("access-control"));
    assert("a real preflight is still answered by cors",
      r.status === 204 && corsHeaders.length > 0,
      `${r.status} cors=${corsHeaders.join(",")}`);
  }

  // ── 5. ADR-0010: a route beats a file at the same path ─────────
  //
  // THE decided behaviour change. Static resolution moved after route
  // matching, so a file dropped into public/ can no longer shadow a
  // reviewed route.
  {
    const r = await req("GET", "/clash");
    assert("a route wins over a file at the same path",
      r.status === 200 && r.body.includes("route") && !r.body.includes('"file"'),
      `${r.status} ${r.body.slice(0, 40)} - a file shadowed a registered route`);
  }

  // ── 6. NEGATIVE: files are still served when no route matches ──
  {
    const r = await req("GET", "/plain.json");
    assert("a file is still served when no route matches",
      r.status === 200 && r.body.includes("file"),
      `${r.status} ${r.body.slice(0, 40)} - moving static after matching stopped files being served`);
  }

  // ── 7. An /api/ path needs no special case ─────────────────────
  //
  // Ruby carried `unless path.start_with?("/api/")` purely to stop files
  // shadowing API routes. Route-first retires that guard; Node never had it,
  // and must not need one either.
  {
    const hit = await req("GET", "/api/thing");
    const miss = await req("GET", "/api/nothing");
    assert("an api path needs no special case now that routes win",
      hit.status === 200 && hit.body.includes("routed") && miss.status === 404,
      `hit=${hit.status} miss=${miss.status}`);
  }

  // ── 8. HEAD carries no body, whatever produced it (ADR-0011) ───
  //
  // The CONTRACT is the outcome, not the mechanism. Node wraps write/end
  // early because it streams; Ruby and Python strip late at their single
  // return. Both must satisfy this on every path - handler, 404 and 405.
  {
    const onRoute = await req("HEAD", "/hello");
    const on404 = await req("HEAD", "/definitely/not/a/route");
    const on405 = await req("HEAD", "/only-get");
    assert("a head response carries no body on any path",
      onRoute.body === "" && on404.body === "" && on405.body === "",
      `route=${JSON.stringify(onRoute.body)} 404=${JSON.stringify(on404.body)} 405=${JSON.stringify(on405.body)}`);
  }

  // ── 9. Matched-route metadata is visible to the auth stage ─────
  //
  // A write route is secured by default; the noAuth marker on the MATCHED
  // route is what opens it, so the metadata must reach the gate. PHP's own
  // comment records that this assignment was once missing and the bypass was
  // dead code on a real dispatch.
  {
    const r = await req("POST", "/public-write");
    assert("dispatch noauth write route is not blocked by csrf",
      r.status === 200,
      `${r.status} - a route marked noAuth was still blocked; the matched route's ` +
      `metadata did not reach the auth stage`);
  }
} finally {
  // We started it, we own its death - a leaked listener holds the port forever.
  try { server?.close?.(); } catch { /* already down */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

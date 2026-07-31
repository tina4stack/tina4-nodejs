/**
 * Global middleware runs in TWO passes, split by what it depends on.
 *
 *   PRE-match  - must survive a short-circuit, needs no route metadata.
 *                CORS lives here: a browser shown a 401 with no CORS headers
 *                reports a CORS error, so the real status never reaches the
 *                developer debugging it.
 *   POST-match - reads the matched route's metadata. CSRF lives here, because
 *                it must honour a route marked noAuth. PHP shipped exactly
 *                that bypass as DEAD CODE once, because the metadata was not
 *                assigned yet on a real dispatch.
 *
 * Moving the whole pass before matching would have broken the second group -
 * measured, not assumed: Python's middleware reads request._handler/_noauth.
 *
 * Opt in with `static preMatch = true`; the default is unchanged.
 *
 * NO MOCKS: a real server over a real socket, reaped in a finally.
 *
 * Same case names as tina4-ruby/spec/global_middleware_split_spec.rb.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, MiddlewareRunner } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const root = mkdtempSync(join(tmpdir(), "tina4-mwsplit-"));
const routesDir = join(root, "src", "routes");
const publicDir = join(root, "public");
mkdirSync(publicDir, { recursive: true });
mkdirSync(join(routesDir, "secured"), { recursive: true });
writeFileSync(join(routesDir, "secured", "post.ts"),
  'export default async function (_req: any, res: any) { return res("x", 200); }\n');

// Stamps a header, the way CORS would.
class PreMatchStamp {
  static preMatch = true;
  static beforeStamp(req: any, res: any): [any, any] {
    res.header?.("X-Ran-Before-Match", "yes");
    return [req, res];
  }
}
class PlainStamp {
  // It MUST stamp, or the negative case below passes vacuously.
  static beforePlain(req: any, res: any): [any, any] {
    res.header?.("X-Ran-After-Match", "yes");
    return [req, res];
  }
}

const PORT = 7990 + (process.pid % 8);
let server: any;

async function req(method: string, path: string) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  return { status: r.status, headers: r.headers, body: await r.text() };
}

console.log("=== Global middleware pre/post split (Node) ===\n");

try {
  // ── The partition itself ────────────────────────────────────────
  {
    const { pre, post } = MiddlewareRunner.partitionByMatchPhase([PreMatchStamp, PlainStamp]);
    assert("pre match middleware is selected by the flag",
      pre.length === 1 && pre[0] === PreMatchStamp, `pre=${pre.length}`);
    // NEGATIVE: the default must be unchanged - no flag means post-match.
    assert("middleware without the flag still runs after matching",
      post.length === 1 && post[0] === PlainStamp, `post=${post.length}`);
  }

  MiddlewareRunner.use(PreMatchStamp);
  // PlainStamp is registered too: the ordering cases below need a REAL
  // post-match middleware in the chain, and it also proves the pre-match pass
  // does not drag the post-match set along with it.
  MiddlewareRunner.use(PlainStamp);
  server = await startServer({ port: PORT, routesDir, staticDir: publicDir } as never);

  // ── POSITIVE: it runs when NO route matches at all ──────────────
  {
    const r = await req("GET", "/no/such/route");
    assert("pre match middleware runs on a path with NO route at all",
      r.status === 404 && r.headers.get("x-ran-before-match") === "yes",
      `${r.status} stamp=${r.headers.get("x-ran-before-match")}`);
  }

  // ── POSITIVE: its work SURVIVES a short-circuited 401 ───────────
  //
  // The case the whole split exists for.
  {
    const r = await req("POST", "/secured");
    assert("pre match middleware output survives a 401",
      r.status === 401 && r.headers.get("x-ran-before-match") === "yes",
      `${r.status} stamp=${r.headers.get("x-ran-before-match")}`);
  }

  // ── NEGATIVE: the split must not weaken the auth gate ───────────
  {
    const r = await req("POST", "/secured");
    assert("pre match middleware does not open a secured route",
      r.status === 401, `${r.status} - registering pre-match middleware relaxed the auth gate`);
  }

  // ── The order: post-match globals -> auth gate -> route middleware ───
  //
  // Decided 2026-07-31 (ADR-0012) against how the mainstream frameworks build
  // the same pipeline. Python and Ruby ran the gate first, Node and PHP did
  // not; all four now run the globals first. Node additionally moved its
  // ROUTE middleware to after the gate, so middleware on a secured route no
  // longer processes a request that is about to be rejected.
  {
    const r = await req("POST", "/secured");
    assert("post match middleware runs on a 401",
      r.status === 401 && r.headers.get("x-ran-after-match") === "yes",
      `${r.status} stamp=${r.headers.get("x-ran-after-match")} - a global ` +
      `middleware did not run on a 401; the gate is ahead of the global pass`);
  }
  {
    // NEGATIVE, and the case that actually discriminates the two groups: a
    // post-match middleware CANNOT run when nothing matched. Not the 401,
    // which both groups now survive by design.
    const r = await req("GET", "/no/such/route");
    assert("post match middleware does not run when no route matched",
      r.status === 404 && r.headers.get("x-ran-after-match") === null,
      `${r.status} stamp=${r.headers.get("x-ran-after-match")}`);
  }
} finally {
  try { server?.close?.(); } catch { /* already down */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

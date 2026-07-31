/**
 * A global middleware's afterX hooks MUST run, for BOTH phases.
 *
 * REGRESSION. The after pass used to cover only the POST-match group, so a
 * `preMatch` middleware's afterX never ran on a successful request - measured
 * 0 runs in 5 requests. An acquire/release pair leaked one slot per request,
 * unbounded; a timer started in beforeX was never stopped; an access log saw
 * the request and never the response.
 *
 * It also inverted: the pre-match afterX DID run when the pre-match pass
 * short-circuited, so it fired on the error path and not the happy one. A
 * smoke test on a 401 would have shown it "working".
 *
 * Splitting the BEFORE pass by dependency (ADR-0012) says nothing about the
 * after pass: an after hook adds headers or logging and needs no route
 * metadata either way. Django unwinds its single MIDDLEWARE list in reverse,
 * Laravel runs the response phase for global, group AND route middleware.
 *
 * NO MOCKS: a real server over a real socket, reaped in a finally.
 *
 * Same case names in all four frameworks.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, MiddlewareRunner } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

/** Acquire in beforeX, release in afterX - the pair that leaked. */
class PreMatchAfter {
  static preMatch = true;
  static inFlight = 0;
  static runs = 0;
  static beforeAcquire(req: any, res: any): [any, any] { PreMatchAfter.inFlight++; return [req, res]; }
  static afterRelease(req: any, res: any): [any, any] {
    PreMatchAfter.inFlight--; PreMatchAfter.runs++; return [req, res];
  }
}
class PostMatchAfter {
  static runs = 0;
  static afterCount(req: any, res: any): [any, any] { PostMatchAfter.runs++; return [req, res]; }
}

const root = mkdtempSync(join(tmpdir(), "tina4-afterhooks-"));
const routesDir = join(root, "src", "routes");
mkdirSync(join(routesDir, "hello"), { recursive: true });
writeFileSync(join(routesDir, "hello", "get.ts"),
  'export default async function (_q: any, r: any) { return r("ok", 200); }\n');

const PORT = await freePort();
let server: any;

console.log("=== Global after-hook coverage (Node) ===\n");

try {
  MiddlewareRunner.use(PreMatchAfter);
  MiddlewareRunner.use(PostMatchAfter);
  server = await startServer({ port: PORT, routesDir } as never);

  {
    // POSITIVE: the post-match group, which always worked.
    await fetch(`http://127.0.0.1:${PORT}/hello`);
    assert("a global after hook runs on a matched route",
      PostMatchAfter.runs === 1, `runs=${PostMatchAfter.runs}`);
  }

  {
    // POSITIVE: the case that was broken.
    assert("a pre match middlewares after hook also runs",
      PreMatchAfter.runs === 1,
      `runs=${PreMatchAfter.runs} - a pre-match middleware was excluded from the ` +
      `after pass; the ADR-0012 split applies to the BEFORE pass only`);
  }

  {
    // The implication, asserted directly: a before/after pair must not leak.
    // This is what made the bug serious rather than cosmetic - the imbalance
    // grew by one per request, without bound, and nothing errored.
    PreMatchAfter.runs = 0;
    PreMatchAfter.inFlight = 0;
    for (let i = 0; i < 5; i++) await fetch(`http://127.0.0.1:${PORT}/hello`);
    assert("an acquire release pair stays balanced",
      PreMatchAfter.runs === 5 && PreMatchAfter.inFlight === 0,
      `runs=${PreMatchAfter.runs} leaked=${PreMatchAfter.inFlight} slots over 5 requests`);
  }

  {
    // NEGATIVE: the after pass belongs to the matched-route path.
    PostMatchAfter.runs = 0;
    const r = await fetch(`http://127.0.0.1:${PORT}/no/such/route`);
    assert("a global after hook does not run on an unmatched path",
      r.status === 404 && PostMatchAfter.runs === 0,
      `${r.status} runs=${PostMatchAfter.runs}`);
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

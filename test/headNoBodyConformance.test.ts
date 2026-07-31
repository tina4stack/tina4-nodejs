/**
 * RFC 9110 s9.3.2: a HEAD response MUST NOT carry content. On EVERY path.
 *
 * Node already behaves correctly - it wraps write/end EARLY, so every path is
 * covered by construction (ADR-0011: the CONTRACT is the outcome, the mechanism
 * stays idiomatic per runtime). This LOCKS IT IN, because Ruby did not.
 *
 * Ruby stripped the body for a routed response, a 404 and a 405, but NOT for a
 * static asset - its static and swagger branches returned early and skipped the
 * strip. Measured 2026-07-31: Ruby returned 15 bytes where Node, PHP and Python
 * all returned 0.
 *
 * Why it matters beyond conformance: HEAD is what link checkers, monitoring
 * probes and cache validators use precisely to AVOID transferring the body. A
 * HEAD that returns the body makes every one of those checks cost a full
 * download, silently.
 *
 * NO MOCKS: a real server over a real socket, reaped in a finally.
 *
 * Same case names in all four frameworks.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const root = mkdtempSync(join(tmpdir(), "tina4-headconf-"));
const routesDir = join(root, "src", "routes");
const publicDir = join(root, "public");
mkdirSync(publicDir, { recursive: true });
mkdirSync(join(routesDir, "routed"), { recursive: true });
writeFileSync(join(publicDir, "asset.css"), "body { color: red; }");
writeFileSync(join(routesDir, "routed", "get.ts"),
  'export default async function (_q: any, r: any) { return r("hello from the route", 200); }\n');

const PORT = 7650 + (process.pid % 35);
let server: any;

async function req(method: string, path: string) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  return { status: r.status, body: await r.text(), headers: r.headers };
}

console.log("=== HEAD carries no body, on every path (Node) ===\n");

try {
  server = await startServer({ port: PORT, routesDir, staticDir: publicDir } as never);

  {
    const r = await req("HEAD", "/asset.css");
    assert("a head on a static asset carries no body",
      r.status === 200 && r.body.length === 0,
      `${r.status} ${r.body.length} bytes - RFC 9110 s9.3.2 forbids content in a HEAD response`);
  }
  {
    const r = await req("HEAD", "/routed");
    assert("a head on a routed response carries no body",
      r.status === 200 && r.body.length === 0, `${r.status} ${r.body.length} bytes`);
  }
  {
    const r = await req("HEAD", "/definitely/not/a/route");
    assert("a head on a 404 carries no body",
      r.status === 404 && r.body.length === 0, `${r.status} ${r.body.length} bytes`);
  }
  {
    // s9.3.2 SHOULD: the same headers as the equivalent GET. That is the whole
    // point of a HEAD probe - a size estimate without the transfer.
    const r = await req("HEAD", "/asset.css");
    const length = r.headers.get("content-length");
    assert("a head still reports the content length the get would have sent",
      length !== null && Number(length) === statSync(join(publicDir, "asset.css")).size,
      `content-length=${length}`);
  }
  {
    // NEGATIVE: stripping HEAD must not have broken GET.
    const r = await req("GET", "/asset.css");
    assert("a get on a static asset still returns the body",
      r.status === 200 && r.body.includes("color: red"),
      `${r.status} ${JSON.stringify(r.body.slice(0, 40))}`);
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

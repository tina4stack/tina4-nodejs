/**
 * Medium security finding F5 — the configured Authorization token must never be
 * sent to a host other than the client's configured base origin.
 *
 * A path that is itself an absolute off-origin URL (e.g. `get("http://evil/x")`)
 * previously reused the base client's Authorization header, leaking a bearer
 * token to an attacker-chosen host. The cross-origin strip already existed for
 * REDIRECT following; this pins it for the initial request target too. Only
 * same-origin requests carry the token. Case names match the sibling
 * regressions in tina4-python/tests/test_api_cross_origin_token.py,
 * tina4-php/tests/ApiCrossOriginTokenTest.php and
 * tina4-ruby/spec/api_cross_origin_token_spec.rb.
 *
 * Real node:http servers, real Api client. No doubles.
 *
 * Run with: npx tsx test/apiCrossOriginToken.test.ts
 */
import http from "node:http";
import { Api } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

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

/** A server that records the Authorization header of the last request it saw. */
async function recordingServer(): Promise<{ port: number; lastAuth: () => string | undefined; close: () => Promise<void> }> {
  const port = await freePort();
  let seen: string | undefined;
  const server = http.createServer((req, res) => {
    seen = req.headers["authorization"] as string | undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    lastAuth: () => seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

console.log("\n  API cross-origin token leak (F5)\n");

const base = await recordingServer();
const evil = await recordingServer();

const api = new Api(`http://127.0.0.1:${base.port}`, "Bearer s3cret-token", 10);

// Negative: an absolute off-origin URL as the path must NOT carry the token.
await api.get(`http://127.0.0.1:${evil.port}/steal`);
assert(
  "absolute off-origin path does not leak the Authorization token",
  evil.lastAuth() === undefined,
  `token leaked to another host: ${evil.lastAuth()}`,
);

// Positive: a normal same-origin request still carries the token.
await api.get("/me");
assert(
  "same-origin request still carries the Authorization token",
  base.lastAuth() === "Bearer s3cret-token",
  `same-origin token missing/wrong: ${base.lastAuth()}`,
);

await base.close();
await evil.close();

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

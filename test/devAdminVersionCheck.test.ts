/**
 * The dev-admin version check must not report "up to date" for a check it never
 * made.
 *
 * It used to answer HTTP 200 with latest == current whenever the call to the
 * npm registry failed, and the toolbar renders that as a green
 * "Latest: vX — You are up to date!". A developer several releases behind, on a
 * machine with no route out, was told the opposite of the truth — and the
 * toolbar's own "Could not check for updates" branch could never fire, because
 * the failure arrived as a success.
 *
 * Real server, real handle() pipeline, as the rest of the dev-admin suite does.
 * The one thing replaced is the registry: global fetch is wrapped so calls to
 * registry.npmjs.org answer whatever the case under test needs, and every other
 * request — including this file's own — goes to the real one.
 *
 * Run with: npx tsx test/devAdminVersionCheck.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { freePort } from "./freePort.ts";

const TEST_DIR = "/tmp/tina4-devadmin-version-check-test";
let pass = 0;
let fail = 0;
function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
    fail++;
  }
}

console.log("=== DevAdmin version check ===\n");

rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(join(TEST_DIR, "src/routes"), { recursive: true });
process.env.TINA4_DEBUG = "true";
process.env.TINA4_NO_BROWSER = "true";

const realFetch = globalThis.fetch;
type Registry = { throws?: Error; status?: number; body?: unknown };
let registry: Registry = { throws: new Error("no route to host") };

globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  if (!url.includes("registry.npmjs.org")) return realFetch(input, init);
  if (registry.throws) throw registry.throws;
  return new Response(JSON.stringify(registry.body ?? {}), {
    status: registry.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const PORT = await freePort();
const boot = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});
await new Promise((r) => setTimeout(r, 40));

async function check(): Promise<any> {
  const resp = await realFetch(`http://127.0.0.1:${PORT}/__dev/api/version-check`);
  return resp.json();
}

// ── the registry cannot be reached ──────────────────────────
registry = { throws: new Error("no route to host") };
let payload = await check();
assert(
  "an unreachable registry does not answer with a version",
  payload.latest === null,
  JSON.stringify(payload),
);
assert(
  "and so cannot be read as 'you are up to date'",
  payload.latest !== payload.current,
  JSON.stringify(payload),
);
assert("the reason reaches the client", typeof payload.error === "string" && payload.error.length > 0);
assert("current is still reported", typeof payload.current === "string" && payload.current.length > 0);

// ── the registry answers, badly ─────────────────────────────
registry = { status: 503, body: {} };
payload = await check();
assert("a non-success response is not up to date", payload.latest === null, JSON.stringify(payload));
assert("and names the status", String(payload.error).includes("503"), JSON.stringify(payload));

registry = { status: 200, body: { name: "tina4-nodejs" } };
payload = await check();
assert(
  "an answer carrying no version is not up to date",
  payload.latest === null,
  JSON.stringify(payload),
);

// ── the registry answers properly ───────────────────────────
registry = { status: 200, body: { version: "9.9.9" } };
payload = await check();
assert("a healthy check reports the published version", payload.latest === "9.9.9", JSON.stringify(payload));
assert("and carries no error", payload.error === undefined, JSON.stringify(payload));

// ── the client half ─────────────────────────────────────────
const js = await (await realFetch(`http://127.0.0.1:${PORT}/__dev/toolbar.js`)).text();
assert("the toolbar has a branch for a check that did not happen", js.includes("couldNotCheck"));
assert("it acts on a missing latest", js.includes("if (!latest) { couldNotCheck"));
assert(
  "before the up-to-date comparison — a null would fall into it",
  js.indexOf("if (!latest)") < js.indexOf("if (latest === current)"),
);

// Reap what we spawned, the way the rest of the dev-admin suite does.
// Awaiting server.close()'s callback hangs forever here: the fetches above
// leave keep-alive sockets in undici's pool, and close() waits for every open
// connection to end before it fires.
boot.close();
await new Promise((r) => setTimeout(r, 40));
globalThis.fetch = realFetch;
delete process.env.TINA4_DEBUG;
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

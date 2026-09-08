/**
 * Mock-free regression: the dev-admin version check must not report "up to date"
 * for a check it never made.
 *
 * `handleVersionCheck` used to answer `latest = current` on any failure to reach
 * the registry, and the toolbar renders `latest === current` as a green "You are
 * up to date!" — so a developer several releases behind, on a machine with no
 * route out, was told the opposite of the truth, and the toolbar's own "Could
 * not check for updates" branch could never fire because the failure arrived as
 * a success.
 *
 * NO mocks: no fake fetch, no transport injection, no doubles. The REAL
 * `handleVersionCheck` runs behind a REAL `http.Server` (a real IncomingMessage
 * + ServerResponse, wrapped by createRequest/createResponse), and a REAL GET
 * reads the JSON it produced. The registry it reaches is chosen with
 * `TINA4_VERSION_CHECK_URL` — the same seam an operator points at a mirror with —
 * stood in by a REAL local http server (body controlled) or a REAL closed port
 * ("no route out"). Mirrors tina4-python tests/test_dev_admin_version_check.py.
 *
 * Run with: npx tsx test/devAdminVersionCheck.test.ts
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { handleVersionCheck, toolbarJs } from "../packages/core/src/devAdmin.ts";
import { createRequest } from "../packages/core/src/request.ts";
import { createResponse } from "../packages/core/src/response.ts";
import { TINA4_VERSION } from "../packages/core/src/version.ts";

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

interface VersionPayload {
  current?: string;
  latest?: string | null;
  error?: string;
}

/**
 * Run the REAL handler behind a REAL server with the registry URL pointed at
 * `registryUrl`; return the JSON the handler actually produced. Restores/removes
 * TINA4_VERSION_CHECK_URL and closes the server afterward.
 */
async function check(registryUrl: string): Promise<VersionPayload> {
  const previous = process.env.TINA4_VERSION_CHECK_URL;
  process.env.TINA4_VERSION_CHECK_URL = registryUrl;
  const server = http.createServer(async (req, res) => {
    await handleVersionCheck(createRequest(req), createResponse(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/__dev/api/version-check`);
    return (await resp.json()) as VersionPayload;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.TINA4_VERSION_CHECK_URL;
    else process.env.TINA4_VERSION_CHECK_URL = previous;
  }
}

/** Start a REAL local http server returning `body` (200). Returns url + stop. */
async function serveRegistry(
  body: string,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A real address with nothing listening — bind then close to free the port. */
function closedPortUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(`http://127.0.0.1:${port}/`)));
    });
  });
}

console.log("=== DevAdmin Version Check (mock-free) ===\n");

// ── An unreachable registry is not "up to date" ─────────────────────────────
console.log("--- unreachable registry (real closed port) ---");
{
  const payload = await check(await closedPortUrl());
  const body = JSON.stringify(payload);
  assert("a check that did not happen answers latest: null", payload.latest === null, body);
  assert(
    'the toolbar reads latest === current as "you are up to date"',
    payload.latest !== payload.current,
    body,
  );
  assert("the reason reaches the client", !!payload.error, body);
  assert("current is the running version", payload.current === TINA4_VERSION, body);
}

// ── An answer with no version is not "up to date" ───────────────────────────
console.log("\n--- reachable registry, no version (real local server) ---");
{
  const registry = await serveRegistry("{}");
  let payload: VersionPayload;
  try {
    payload = await check(registry.url);
  } finally {
    await registry.stop();
  }
  const body = JSON.stringify(payload);
  assert("reached-but-no-version answers latest: null", payload.latest === null, body);
  assert("no-version carries an error", !!payload.error, body);
}

// ── A reachable registry reports the version ────────────────────────────────
console.log("\n--- reachable registry with version (real local server) ---");
{
  const registry = await serveRegistry('{"version":"3.13.200"}');
  let payload: VersionPayload;
  try {
    payload = await check(registry.url);
  } finally {
    await registry.stop();
  }
  const body = JSON.stringify(payload);
  assert("the reported version is returned", payload.latest === "3.13.200", body);
  assert("a successful check carries no error key", !("error" in payload), body);
}

// ── The toolbar acts on a missing latest before comparing versions ──────────
console.log("\n--- toolbar JS ordering ---");
{
  const js = toolbarJs();
  assert("there is a branch for a check that did not happen", js.includes("couldNotCheck"));
  assert("the !latest branch calls couldNotCheck", js.includes("if (!latest) { couldNotCheck"));
  assert(
    "!latest is handled before latest === current",
    js.indexOf("if (!latest)") < js.indexOf("if (latest === current)"),
  );
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

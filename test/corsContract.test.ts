/**
 * CORS - the runner for cors_contract.json (ADR-0018, ADR-0048, ADR-0066).
 *
 * tina4-documentation/plan/v3/fixtures/cors_contract.json names these cases; the
 * Python, PHP and Ruby suites carry the same names.
 *
 *   - deny by default: no policy grants nobody; an allow-list grants only its own;
 *   - a same-origin request (Origin equals the request's own scheme + host) is
 *     neither warned about nor granted anything - with or without a policy;
 *   - the warning for a refused origin names it, says how to add THAT origin
 *     and never advises '*';
 *   - refusals are remembered by REASON, never by origin (bounded diagnostics).
 *
 * NO MOCKS: every case boots a REAL startServer() in a fresh child process (so
 * the warn-once ledger starts empty), makes real HTTP requests, reads the
 * child's REAL stdout where Log writes, and reads the ledger back from a route
 * running inside that same server.
 *
 * Run with: npx tsx test/corsContract.test.ts
 */
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const ALLOWED = "https://allowed.example";
const OTHER = "https://other.example";
const REASONS = new Set(["unconfigured", "denied", "wildcard-credentials"]);
const REPO = resolve(import.meta.dirname, "..");
const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-cors-contract-"));
mkdirSync(join(TEST_DIR, "src/routes/cors-contract/save"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/cors-contract/ledger"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/cors-contract/save/post.ts"), `
export const noAuth = true;
export default async function (req: any, res: any) {
  return res.json({ saved: true });
}
`);
writeFileSync(join(TEST_DIR, "src/routes/cors-contract/ledger/get.ts"), `
import { corsWarningReasons } from ${JSON.stringify(join(REPO, "packages/core/src/middleware.ts"))};
export default async function (req: any, res: any) {
  return res.json({ keys: corsWarningReasons() });
}
`);
writeFileSync(join(TEST_DIR, "server.ts"), `
import { startServer } from ${JSON.stringify(join(REPO, "packages/core/src/index.ts"))};
await startServer({ port: Number(process.env.PORT), basePath: ${JSON.stringify(TEST_DIR)} });
console.log("TEST-SERVER-READY");
`);

interface Server { port: number; child: ChildProcess; output: () => string }
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

async function boot(origins?: string): Promise<Server> {
  const port = await freePort();
  const childEnv: Record<string, string | undefined> = {
    ...process.env, PORT: String(port), TINA4_DEBUG: "false", TINA4_RATE_LIMIT: "100000",
    TINA4_OVERRIDE_CLIENT: "true", TINA4_NO_AI_PORT: "true", TINA4_NO_BROWSER: "true",
  };
  delete childEnv.TINA4_CORS_ORIGINS;
  delete childEnv.TINA4_CORS_CREDENTIALS;
  if (origins) childEnv.TINA4_CORS_ORIGINS = origins;
  const child = spawn(process.execPath, ["--import", "tsx", join(TEST_DIR, "server.ts")], {
    cwd: REPO, env: childEnv as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (chunk) => { out += chunk; });
  child.stderr!.on("data", (chunk) => { out += chunk; });
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 60000);
    const poll = setInterval(() => {
      if (out.includes("TEST-SERVER-READY")) { clearInterval(poll); clearTimeout(timer); ready(); }
    }, 50);
    child.on("exit", (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
  return { port, child, output: () => out };
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((done, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => done({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end(method === "POST" ? "{}" : undefined);
  });
}

const post = (server: Server, origin: string) =>
  send(server.port, "POST", "/cors-contract/save", { "Content-Type": "application/json", Origin: origin });

async function corsWarnings(server: Server): Promise<string[]> {
  await new Promise((settle) => setTimeout(settle, 150));
  return server.output().split("\n").filter((line) => line.includes("CORS"));
}

async function withServer(origins: string | undefined, body: (server: Server) => Promise<void>): Promise<void> {
  const server = await boot(origins);
  try {
    await body(server);
  } finally {
    server.child.kill("SIGKILL");
  }
}

const accessControl = (reply: Reply) => Object.keys(reply.headers).filter((name) => name.startsWith("access-control-"));

console.log("=== CORS contract (cors_contract.json) ===");

await withServer(undefined, async (server) => {
  const reply = await post(server, OTHER);
  assert("a cross origin request is denied by default",
    reply.status === 200 && reply.headers["access-control-allow-origin"] === undefined,
    `status=${reply.status} acao=${String(reply.headers["access-control-allow-origin"])}`);
});

await withServer(ALLOWED, async (server) => {
  const listed = await post(server, ALLOWED);
  const unlisted = await post(server, OTHER);
  assert("only a listed origin is granted",
    listed.headers["access-control-allow-origin"] === ALLOWED && unlisted.headers["access-control-allow-origin"] === undefined,
    `listed=${String(listed.headers["access-control-allow-origin"])} unlisted=${String(unlisted.headers["access-control-allow-origin"])}`);
});

for (const policy of [undefined, ALLOWED]) {
  await withServer(policy, async (server) => {
    const reply = await post(server, `http://127.0.0.1:${server.port}`);
    const warnings = await corsWarnings(server);
    assert(`a same origin request is neither warned about nor granted (policy=${policy ?? "unset"})`,
      reply.status === 200 && accessControl(reply).length === 0 && warnings.length === 0,
      `granted=${JSON.stringify(accessControl(reply))} warnings=${JSON.stringify(warnings)}`);
  });
}

await withServer(undefined, async (server) => {
  await post(server, `http://127.0.0.1:${server.port + 1}`);
  const portWarnings = await corsWarnings(server);
  await withServer(undefined, async (schemeServer) => {
    await post(schemeServer, `https://127.0.0.1:${schemeServer.port}`);
    const schemeWarnings = await corsWarnings(schemeServer);
    assert("a different port or scheme is cross origin", portWarnings.length === 1 && schemeWarnings.length === 1,
      `port=${JSON.stringify(portWarnings)} scheme=${JSON.stringify(schemeWarnings)}`);
  });
});

for (const policy of [undefined, ALLOWED]) {
  await withServer(policy, async (server) => {
    await post(server, OTHER);
    const warnings = await corsWarnings(server);
    const line = warnings[0] ?? "";
    assert(`a refused origin warning names the origin and never advises a wildcard (policy=${policy ?? "unset"})`,
      warnings.length === 1 && line.split(/\s+/).some((token) => token === OTHER) && line.includes("TINA4_CORS_ORIGINS") && !line.includes("*"),
      `warnings=${JSON.stringify(warnings)}`);
  });
}

for (const policy of [undefined, ALLOWED]) {
  await withServer(policy, async (server) => {
    for (let number = 0; number < 30; number++) await post(server, `https://probe${number}.attacker.example`);
    const warnings = await corsWarnings(server);
    const keys: string[] = JSON.parse((await send(server.port, "GET", "/cors-contract/ledger")).body).keys;
    assert(`many refused origins produce one warning per reason and no per origin ledger (policy=${policy ?? "unset"})`,
      warnings.length === 1 && keys.every((key) => REASONS.has(key)),
      `warnings=${warnings.length} ledger=${JSON.stringify(keys).slice(0, 200)}`);
  });
}

try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Feature 130 — dynamic framework version (single resolver + version
 * User-Agent). See tina4-documentation/plan/v3/features/130-dynamic-version.md
 * and OWNER-DECISIONS.md (Batch 5, VERSION-DEC-01/02/03). Shared fixture:
 * tina4-documentation/plan/v3/fixtures/version_contract.json.
 *
 * Node had ONE latent split the audit found: server.ts's readPackageVersion()
 * was a FIXED `../../../package.json` (three levels up from wherever this
 * file physically sits) with no fallback — correct in the monorepo dev tree,
 * silently "0.0.0" the moment @tina4/core is relocated (a published install,
 * a pnpm store symlink) because the fixed depth no longer lands on a
 * package.json at all. devAdmin.ts had its OWN two-fixed-path reader with the
 * same floor, and mcp.ts's default dev server never read a manifest at all
 * (the same generic '1.0.0' constructor-default gap the audit found in PHP).
 * VERSION-DEC-01 fixed all three by collapsing them onto ONE new module,
 * packages/core/src/version.ts, which ports the CLI's own robust algorithm
 * (packages/cli/src/bin.ts readCliVersion() — walk up to the NEAREST
 * package.json, not a fixed depth) into @tina4/core. server.ts, devAdmin.ts,
 * and mcp.ts's default server all import the SAME TINA4_VERSION constant now.
 *
 * Case names (shared with Python/PHP/Ruby):
 *   - runtime_version_equals_the_package_manifest
 *   - every_reporting_surface_agrees
 *   - no_surface_reports_a_placeholder_version
 *   - the_outbound_http_client_sends_a_tina4_version_user_agent
 *
 * NO MOCKS: a real startServer() (Node's own established in-process
 * convention — see dualPortContract.test.ts), real HTTP requests over real
 * sockets (health, dashboard, a real JSON-RPC POST to the MCP endpoint), a
 * real subprocess running the actual tina4nodejs CLI entrypoint for the
 * manifest, a real @tina4/core BUILD copied into a fresh temp directory with
 * no monorepo ancestor for the relocated-layout check, and a real local TCP
 * capture server the framework's own Api client makes a real outbound
 * request against.
 *
 * Run with: npx tsx test/versionContract.test.ts
 */
import net from "node:net";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_OVERRIDE_CLIENT = "true";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const corePkgDir = join(repoRoot, "packages", "core");
const cliBinPath = resolve(repoRoot, "packages/cli/src/bin.ts");

const PLACEHOLDER_VERSIONS = new Set(["0.0.0", "1.0.0"]);

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

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

/** Real JSON-RPC 'initialize' POST to the mounted MCP endpoint. */
function mcpInitializeVersion(port: number): Promise<string | undefined> {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "version-contract-test", version: "1.0" },
    },
  });
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/__dev/mcp", method: "POST", timeout: 8000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`MCP initialize -> HTTP ${res.statusCode}: ${body}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolvePromise(parsed?.result?.serverInfo?.version);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

function project(name: string): string {
  const dir = join(tmpdir(), `tina4-versioncontract-${process.pid}-${name}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  return dir;
}

/** Really bind a port, then release it — for a free base port. */
function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolvePromise(port));
    });
  });
}

async function boot(dir: string, port: number): Promise<any> {
  process.env.TINA4_DEBUG = "true";
  process.env.TINA4_NO_AI_PORT = "true";
  const { startServer } = await import("../packages/core/src/index.ts");
  return startServer({
    port,
    host: "127.0.0.1",
    routesDir: join(dir, "src/routes"),
    modelsDir: join(dir, "src/models"),
    staticDir: join(dir, "public"),
  } as any);
}

/** Capture console.log emitted while `fn` runs (async). */
async function captureLogAsync(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let buf = "";
  console.log = (...a: unknown[]) => { buf += a.map(String).join(" ") + "\n"; };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return buf;
}

console.log("=== Dynamic framework version (feature 130) ===\n");

// ── runtime_version_equals_the_package_manifest ────────────────────────────
{
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  const corePkg = JSON.parse(readFileSync(join(corePkgDir, "package.json"), "utf-8"));
  const { TINA4_VERSION } = await import("../packages/core/src/version.ts");
  assert(
    "runtime_version_equals_the_package_manifest: root package.json",
    TINA4_VERSION === rootPkg.version,
    `resolved=${TINA4_VERSION} root=${rootPkg.version}`,
  );
  assert(
    "runtime_version_equals_the_package_manifest: @tina4/core package.json",
    TINA4_VERSION === corePkg.version,
    `resolved=${TINA4_VERSION} core=${corePkg.version}`,
  );
}

// ── every_reporting_surface_agrees / no_surface_reports_a_placeholder_version ──
{
  const port = await freePort();
  const dir = project("surfaces");
  let server: any;
  let banner = "";
  try {
    banner = await captureLogAsync(async () => {
      server = await boot(dir, port);
    });

    const { TINA4_VERSION: resolved } = await import("../packages/core/src/version.ts");

    const health = await get(port, "/health");
    assert("every_reporting_surface_agrees: health status", health.status === 200, `status=${health.status}`);
    const healthVersion = JSON.parse(health.body).version;

    const dashboard = await get(port, "/__dev/api/status");
    assert("every_reporting_surface_agrees: dashboard status", dashboard.status === 200, `status=${dashboard.status}: ${dashboard.body}`);
    const dashboardFramework: string = JSON.parse(dashboard.body).framework ?? "";
    const dashboardMatch = dashboardFramework.match(/v(\d+\.\d+\.\d+)/);
    const dashboardVersion = dashboardMatch ? dashboardMatch[1] : undefined;

    const mcpVersion = await mcpInitializeVersion(port);

    const cliOut = execFileSync("npx", ["tsx", cliBinPath, "commands", "--json"], {
      cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000,
    });
    const cliVersion = JSON.parse(cliOut).version;

    const expectedBanner = `Tina4 Node.js v${resolved}`;
    assert("every_reporting_surface_agrees: banner", banner.includes(expectedBanner), `banner missing ${JSON.stringify(expectedBanner)}; got: ${JSON.stringify(banner)}`);
    assert("every_reporting_surface_agrees: health", healthVersion === resolved, `health=${healthVersion} runtime=${resolved}`);
    assert("every_reporting_surface_agrees: dashboard", dashboardVersion === resolved, `dashboard=${dashboardVersion} runtime=${resolved}`);
    assert("every_reporting_surface_agrees: mcp", mcpVersion === resolved, `mcp=${mcpVersion} runtime=${resolved}`);
    assert("every_reporting_surface_agrees: cli", cliVersion === resolved, `cli=${cliVersion} runtime=${resolved}`);

    assert("no_surface_reports_a_placeholder_version: health", !PLACEHOLDER_VERSIONS.has(healthVersion), `health=${healthVersion}`);
    assert("no_surface_reports_a_placeholder_version: dashboard", !PLACEHOLDER_VERSIONS.has(dashboardVersion ?? ""), `dashboard=${dashboardVersion}`);
    assert("no_surface_reports_a_placeholder_version: mcp", !PLACEHOLDER_VERSIONS.has(mcpVersion ?? ""), `mcp=${mcpVersion}`);
    assert("no_surface_reports_a_placeholder_version: cli", !PLACEHOLDER_VERSIONS.has(cliVersion), `cli=${cliVersion}`);
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── no_surface_reports_a_placeholder_version: Node's EXTRA relocated-layout check ──
{
  // Build @tina4/core (if not already built by the workspace's own `pretest`
  // hook), then copy dist/index.js + package.json into a temp dir with NO
  // monorepo ancestor -- only ONE level of nesting, not the real three -- the
  // exact layout the old fixed-depth-3 reader could not survive.
  const distIndex = join(corePkgDir, "dist", "index.js");
  if (!existsSync(distIndex)) {
    execFileSync("npm", ["run", "build"], { cwd: corePkgDir, stdio: "inherit" });
  }
  const relocated = mkdtempSync(join(tmpdir(), "tina4-relocated-core-"));
  try {
    mkdirSync(join(relocated, "dist"), { recursive: true });
    cpSync(distIndex, join(relocated, "dist", "index.js"));
    cpSync(join(corePkgDir, "package.json"), join(relocated, "package.json"));

    const mod = await import(pathToFileURL(join(relocated, "dist", "index.js")).href);
    assert(
      "no_surface_reports_a_placeholder_version: relocated layout resolves the real version",
      typeof mod.TINA4_VERSION === "string" && !PLACEHOLDER_VERSIONS.has(mod.TINA4_VERSION),
      `relocated TINA4_VERSION=${mod.TINA4_VERSION}`,
    );
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    assert(
      "no_surface_reports_a_placeholder_version: relocated layout matches the real version",
      mod.TINA4_VERSION === rootPkg.version,
      `relocated=${mod.TINA4_VERSION} root=${rootPkg.version}`,
    );
  } finally {
    rmSync(relocated, { recursive: true, force: true });
  }
}

// ── the_outbound_http_client_sends_a_tina4_version_user_agent ──────────────
{
  const { Api } = await import("../packages/core/src/api.ts");
  const { TINA4_VERSION: resolved } = await import("../packages/core/src/version.ts");

  let capturedUA: string | undefined;
  const captureServer = http.createServer((req, res) => {
    capturedUA = req.headers["user-agent"];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolvePromise) => captureServer.listen(0, "127.0.0.1", resolvePromise));
  const addr = captureServer.address();
  const capturePort = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const baseUrl = `http://127.0.0.1:${capturePort}`;

    // Default: no caller-supplied User-Agent.
    const api = new Api(baseUrl);
    const result = await api.get("/probe");
    assert("the_outbound_http_client_sends_a_tina4_version_user_agent: request ok", result.error === null, `error=${result.error}`);
    const expected = `Tina4/${resolved}`;
    assert(
      "the_outbound_http_client_sends_a_tina4_version_user_agent: default UA",
      capturedUA === expected,
      `got=${capturedUA} expected=${expected}`,
    );

    // Caller-supplied User-Agent must be preserved, not clobbered.
    capturedUA = undefined;
    const apiCustom = new Api(baseUrl, { headers: { "User-Agent": "MyApp/9.9" } });
    const result2 = await apiCustom.get("/probe");
    assert("the_outbound_http_client_sends_a_tina4_version_user_agent: request2 ok", result2.error === null, `error=${result2.error}`);
    assert(
      "the_outbound_http_client_sends_a_tina4_version_user_agent: caller UA preserved",
      capturedUA === "MyApp/9.9",
      `caller-supplied User-Agent was clobbered: got=${capturedUA}`,
    );
  } finally {
    captureServer.close();
  }
}

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);

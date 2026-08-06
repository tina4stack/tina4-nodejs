/**
 * Cluster mode has to actually serve traffic.
 *
 * `TINA4_PRODUCTION=true` makes the primary fork one worker per CPU core. That
 * path was unreachable from the CLI and so had never been exercised end to
 * end, and it did not work: every process - primary AND each worker - ran the
 * port-claiming step on the way up, and that step KILLS whatever already holds
 * the port. In a cluster the thing holding the port is the primary. So the
 * workers killed their own parent, then died themselves:
 *
 *     Port 7148 in use - killing existing process...   (x4)
 *     Error: write EPIPE
 *         at sendHelper (node:internal/cluster/utils:28:15)
 *         at cluster._getServer (node:internal/cluster/child:104:3)
 *
 * The server never answered a single request. A worker does not own the port -
 * the primary binds it once and hands the handle down - so a worker must never
 * touch it.
 *
 * Same defect family as the PHP fork bug: a child mishandling a socket the
 * parent owns.
 *
 * Real server, real child process, real HTTP, real port. No doubles.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");

const spawned = new Set<ChildProcess>();
const dirs: string[] = [];

afterEach(() => {
  for (const child of spawned) {
    try {
      if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  spawned.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startProductionServer(port: number): Promise<{ log: () => string }> {
  const root = mkdtempSync(join(tmpdir(), "tina4-cluster-"));
  dirs.push(root);
  const routes = join(root, "src", "routes");
  mkdirSync(join(routes, "ping"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"cluster-probe","type":"module","private":true}\n');
  // Report the pid so the test can see whether more than one process answers.
  writeFileSync(
    join(routes, "ping", "get.ts"),
    "export default async function (_req: any, res: any) { return res(String(process.pid), 200); }\n",
  );
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
      `await startServer({ port: ${port}, routesDir: '${routes}' } as never);\n`,
  );

  const logPath = join(root, "server.log");
  const logFd = openSync(logPath, "w");
  const child = spawn(TSX, ["app.ts"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      TINA4_OVERRIDE_CLIENT: "true",
      TINA4_PRODUCTION: "true",
      TINA4_NO_BROWSER: "true",
      TINA4_NO_AI_PORT: "true",
      TINA4_DEBUG: "false",
      TINA4_PORT: String(port),
    },
  });
  spawned.add(child);
  closeSync(logFd);
  return { log: () => readFileSync(logPath, "utf8") };
}

/** Poll until the server answers, or give up. Returns the body, or null. */
async function waitForBody(port: number, path: string, ms: number): Promise<string | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (res.ok) return await res.text();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return null;
}

describe("cluster mode (TINA4_PRODUCTION=true)", () => {
  it("serves requests instead of killing its own workers", async () => {
    const probe = await startProductionServer(7851);

    const body = await waitForBody(7851, "/ping", 45_000);
    expect(body, `server never answered:\n${probe.log().slice(-3000)}`).not.toBeNull();
    expect(Number(body)).toBeGreaterThan(0);

    // The specific old failure, named so a regression is unmistakable.
    expect(probe.log()).not.toContain("in use — killing existing process");
    expect(probe.log()).not.toContain("write EPIPE");
  }, 90_000);

  it("spreads requests across workers when the host has cores to spread over", async () => {
    const probe = await startProductionServer(7852);
    expect(await waitForBody(7852, "/ping", 45_000), `never answered:\n${probe.log().slice(-3000)}`).not.toBeNull();

    const pids = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const body = await fetch("http://127.0.0.1:7852/ping").then((r) => r.text());
      pids.add(body);
    }

    if (cpus().length > 1) {
      // The banner has to agree with reality: it claims a worker count, and
      // more than one pid must actually answer.
      expect(probe.log()).toContain("cluster,");
      expect(pids.size).toBeGreaterThan(1);
    } else {
      // A single-core host stays one process by design, and that is still a
      // correctly serving server - not a skip.
      expect(pids.size).toBe(1);
    }
  }, 90_000);
});

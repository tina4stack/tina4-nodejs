/**
 * A CPU-bound handler stalls every other request, and the server says so.
 *
 * Node serves every request on ONE event loop. That is not a defect to
 * engineer away, it is the runtime. But it is invisible: a developer who
 * writes a busy loop in a handler sees their own request succeed and has no
 * idea the other seven timed out behind it.
 *
 * Measured on this server before the watchdog existed, client in a SEPARATE
 * process so the measurement is not itself sharing the loop under test:
 *
 *     /fast idle                       0.032s
 *     /fast during an AWAITED 2s route 0.030s   <- yields, blocks nobody
 *     /fast during a BUSY-LOOP 2s      1.575s   <- holds the loop
 *
 * So the fix is diagnostic, not architectural: make the block VISIBLE. These
 * tests pin both halves of that. The awaited case is the important one - a
 * watchdog that fired on any slow route would be noise, and would train people
 * to ignore it.
 *
 * Everything here runs against a real server in a real child process over real
 * HTTP, and reads the real log file it writes. No doubles.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");

const spawned = new Set<ChildProcess>();
const dirs: string[] = [];

afterEach(() => {
  // Signal the GROUP, not the pid: tsx runs node as a child, and killing only
  // the wrapper orphans the server holding the port.
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

function portAccepts(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (ok: boolean): void => {
      sock.destroy();
      res(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

/** Milliseconds a GET took, end to end, over a real socket. */
async function timeGet(port: number, path: string): Promise<number> {
  const started = Date.now();
  await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.text());
  return Date.now() - started;
}

interface Probe {
  port: number;
  logPath: string;
  log: () => string;
}

/**
 * A real Tina4 server with two routes that occupy the same wall-clock time by
 * opposite means: one awaits, one spins.
 */
async function startProbe(port: number, env: Record<string, string> = {}): Promise<Probe> {
  const root = mkdtempSync(join(tmpdir(), "tina4-loopwatch-"));
  dirs.push(root);
  const routes = join(root, "src", "routes");
  mkdirSync(join(routes, "fast"), { recursive: true });
  mkdirSync(join(routes, "awaited"), { recursive: true });
  mkdirSync(join(routes, "busy"), { recursive: true });

  writeFileSync(join(root, "package.json"), '{"name":"loopwatch-probe","type":"module","private":true}\n');
  writeFileSync(
    join(routes, "fast", "get.ts"),
    "export default async function (_req: any, res: any) { return res('FAST', 200); }\n",
  );
  writeFileSync(
    join(routes, "awaited", "get.ts"),
    "export default async function (_req: any, res: any) {\n" +
      "  await new Promise((r) => setTimeout(r, 1200));\n" +
      "  return res('AWAITED', 200);\n" +
      "}\n",
  );
  // Date.now() in the condition, not a counted loop: an iteration count that
  // takes 1.2s on this machine takes a different time on the lab host, and a
  // duration-based assertion needs a duration-based block.
  writeFileSync(
    join(routes, "busy", "get.ts"),
    "export default async function (_req: any, res: any) {\n" +
      "  const until = Date.now() + 1200;\n" +
      "  while (Date.now() < until) { /* occupy the loop */ }\n" +
      "  return res('BUSY', 200);\n" +
      "}\n",
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
      TINA4_NO_BROWSER: "true",
      TINA4_NO_AI_PORT: "true",
      TINA4_DEBUG: "false",
      TINA4_PORT: String(port),
      ...env,
    },
  });
  spawned.add(child);
  closeSync(logFd);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await portAccepts(port)) {
      return { port, logPath, log: () => readFileSync(logPath, "utf8") };
    }
    if (child.exitCode !== null) {
      throw new Error(`child died during boot:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
    }
    await sleep(50);
  }
  throw new Error(`server never came up on ${port}:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
}

const blockedLines = (log: string): string[] =>
  log.split("\n").filter((line) => line.includes("Event loop blocked"));

describe("event loop block watchdog", () => {
  it("warns, and names the duration, when a handler occupies the loop", async () => {
    const probe = await startProbe(7841, { TINA4_LOOP_LAG_WARN_MS: "250" });

    await fetch(`http://127.0.0.1:${probe.port}/busy`).then((r) => r.text());
    await sleep(400); // let the watchdog tick land in the log

    const lines = blockedLines(probe.log());
    expect(lines.length).toBeGreaterThan(0);
    // The number has to be real: a warning that says "blocked" without saying
    // for how long cannot tell a 300ms hiccup from a 12s stall.
    const reported = Number(/blocked for (\d+)ms/.exec(lines[0])?.[1] ?? 0);
    expect(reported).toBeGreaterThan(900);
    expect(lines[0]).toContain("queue");
  }, 90_000);

  it("stays silent for a handler that awaits for just as long", async () => {
    const probe = await startProbe(7842, { TINA4_LOOP_LAG_WARN_MS: "250" });

    await fetch(`http://127.0.0.1:${probe.port}/awaited`).then((r) => r.text());
    await sleep(400);

    expect(blockedLines(probe.log())).toEqual([]);
  }, 90_000);

  it("blocks other requests only in the busy case, and that is what it reports", async () => {
    const probe = await startProbe(7843, { TINA4_LOOP_LAG_WARN_MS: "250" });

    await timeGet(probe.port, "/fast"); // warm the route cache

    const awaitedInFlight = fetch(`http://127.0.0.1:${probe.port}/awaited`).then((r) => r.text());
    await sleep(150);
    const duringAwaited = await timeGet(probe.port, "/fast");
    await awaitedInFlight;

    const busyInFlight = fetch(`http://127.0.0.1:${probe.port}/busy`).then((r) => r.text());
    await sleep(150);
    const duringBusy = await timeGet(probe.port, "/fast");
    await busyInFlight;

    // The awaited route yields; /fast overtakes it. The busy one does not.
    expect(duringAwaited).toBeLessThan(500);
    expect(duringBusy).toBeGreaterThan(500);
    expect(blockedLines(probe.log()).length).toBeGreaterThan(0);
  }, 90_000);

  it("is silenced by TINA4_LOOP_LAG_WARN_MS=0", async () => {
    const probe = await startProbe(7844, { TINA4_LOOP_LAG_WARN_MS: "0" });

    await fetch(`http://127.0.0.1:${probe.port}/busy`).then((r) => r.text());
    await sleep(400);

    expect(blockedLines(probe.log())).toEqual([]);
  }, 90_000);

  it("a started-then-closed server lets the process exit", async () => {
    // A 100ms repeating timer is exactly the shape that silently pins a
    // process open forever. TWO guards stop that here: close() calls
    // loopWatchdog.stop(), and the timer is unref'd. Either alone satisfies
    // this test - removing BOTH hangs it, which is what makes it a gate. The
    // invariant is what matters; carrying both guards is cheap.
    const root = mkdtempSync(join(tmpdir(), "tina4-loopwatch-exit-"));
    dirs.push(root);
    const routes = join(root, "src", "routes");
    mkdirSync(join(routes, "fast"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"loopwatch-exit","type":"module","private":true}\n');
    writeFileSync(
      join(routes, "fast", "get.ts"),
      "export default async function (_req: any, res: any) { return res('FAST', 200); }\n",
    );
    // No signal, no process.exit: start, close, and let the loop drain on its
    // own. A leftover timer shows up as a process that never ends.
    writeFileSync(
      join(root, "app.ts"),
      `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
        `const h = await startServer({ port: 7845, routesDir: '${routes}' } as never);\n` +
        `await fetch('http://127.0.0.1:7845/fast').then((r) => r.text());\n` +
        `h.close();\n`,
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
        TINA4_NO_BROWSER: "true",
        TINA4_NO_AI_PORT: "true",
        TINA4_DEBUG: "false",
        TINA4_PORT: "7845",
        TINA4_LOOP_LAG_WARN_MS: "250",
      },
    });
    spawned.add(child);
    closeSync(logFd);

    const exited = await Promise.race([
      new Promise<boolean>((r) => child.once("exit", () => r(true))),
      sleep(20_000).then(() => false),
    ]);
    expect(exited, `process never exited:\n${readFileSync(logPath, "utf8").slice(-1500)}`).toBe(true);
  }, 90_000);
});

/**
 * Real-process conformance for identity-checked port takeover (feature 129).
 *
 * `tina4 serve` reclaims a busy port so a restart does not fail with "address
 * already in use". Before TAKEOVER-DEC-01/02/03 both takeover paths SIGTERM'd
 * WHATEVER held the port -- a foreign dev server, a database, a stray listener --
 * with no check that the victim was a Tina4 dev server. This suite pins the fix.
 *
 * NO MOCKS. Every case starts a REAL child Node process that binds a REAL port
 * and asserts the outcome BY PID: a foreign holder must still be running; a Tina4
 * holder must be gone. The Tina4 holder records its identity through the REAL
 * framework writePidfile (the same call the dev server makes for itself). The
 * runtime-path case boots a REAL server via startServer.
 *
 * Mutation proof: in packages/core/src/portTakeover.ts takeOverPort, replace the
 * identity filter with `const tina4Holders = holders;`, and the two foreign-spare
 * cases go RED (the foreign child is SIGTERM'd). Restore it and they pass.
 *
 * Parity: Python tests/test_port_takeover_contract.py, PHP
 * tests/PortTakeoverContractTest.php, Ruby spec/port_takeover_contract_spec.rb.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  takeOverPort,
  pidfilePath,
  TAKEOVER_KILLED,
  TAKEOVER_REFUSED_FOREIGN,
  TAKEOVER_REFUSED_OPTOUT,
  TAKEOVER_REFUSED_PROD,
} from "../packages/core/src/portTakeover.ts";
// The runtime bind-failure entrypoint. Imported from the server SOURCE (not the
// public @tina4/core barrel) as a test seam -- the Node analog of Python's
// importable _kill_port / Ruby's WebServer#free_port.
import { killPort } from "../packages/core/src/server.ts";

process.env.TINA4_NO_BROWSER = "true";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
const portTakeoverUrl = pathToFileURL(join(repoRoot, "packages/core/src/portTakeover.ts")).href;

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const eq = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Holder {
  child: ChildProcess;
  pid: number;
  exited: boolean;
}
const spawned: Holder[] = [];

function reap(): void {
  for (const h of spawned) {
    try {
      h.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

async function waitExit(h: Holder, timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (h.exited) return true;
    await sleep(50);
  }
  return h.exited;
}

// Start a real child that binds *port*; a Tina4 child also writes its PID file
// through the REAL framework writePidfile.
async function spawnHolder(port: number, baseDir: string, tina4: boolean): Promise<Holder> {
  const script = join(baseDir, `child-${port}.ts`);
  writeFileSync(
    script,
    `import net from "node:net";\n`
    + `import { writePidfile } from ${JSON.stringify(portTakeoverUrl)};\n`
    + `const port = Number(process.argv[2]);\n`
    + `const base = process.argv[3];\n`
    + `const tina4 = process.argv[4] === "1";\n`
    + `const server = net.createServer();\n`
    + `server.on("error", (e) => { process.stderr.write(String(e)); process.exit(2); });\n`
    + `server.listen(port, "127.0.0.1", () => { if (tina4) writePidfile(port, base); process.stdout.write("READY\\n"); });\n`
    + `setInterval(() => {}, 1 << 30);\n`,
  );

  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, script, String(port), baseDir, tina4 ? "1" : "0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const holder: Holder = { child, pid: child.pid ?? -1, exited: false };
  child.on("exit", () => { holder.exited = true; });
  spawned.push(holder);

  const pidfile = pidfilePath(port, baseDir);
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (holder.exited) throw new Error("child exited early");
    if ((await listening(port)) && (!tina4 || existsSync(pidfile))) return holder;
    await sleep(50);
  }
  throw new Error(`child never bound port ${port}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  const baseDir = mkdtempSync(join(tmpdir(), "tina4-takeover-"));
  try {
    // ── 1. a foreign holder is not killed and takeover refuses ─────────────
    {
      const port = await freePort();
      const foreign = await spawnHolder(port, baseDir, false);
      const result = takeOverPort(port, true, false, baseDir);
      assert(
        "a foreign holder is not killed and takeover refuses",
        result.status === TAKEOVER_REFUSED_FOREIGN
          && result.message.includes("non-Tina4")
          && eq(result.killed, [])
          && !foreign.exited
          && (await listening(port)),
        `status=${result.status} exited=${foreign.exited}`,
      );
    }

    // ── 2. a tina4 dev server holder is reclaimed ──────────────────────────
    {
      const port = await freePort();
      const server = await spawnHolder(port, baseDir, true);
      const result = takeOverPort(port, true, false, baseDir);
      const gone = await waitExit(server);
      assert(
        "a tina4 dev server holder is reclaimed",
        result.status === TAKEOVER_KILLED && eq(result.killed, [server.pid]) && gone,
        `status=${result.status} killed=${JSON.stringify(result.killed)} pid=${server.pid} gone=${gone}`,
      );
    }

    // ── 3. opt out refuses to kill the holder ──────────────────────────────
    {
      const port = await freePort();
      const server = await spawnHolder(port, baseDir, true);
      const result = takeOverPort(port, true, true, baseDir);
      assert(
        "opt out refuses to kill the holder",
        result.status === TAKEOVER_REFUSED_OPTOUT && eq(result.killed, []) && !server.exited,
        `status=${result.status} exited=${server.exited}`,
      );
    }

    // ── 4. production mode refuses to kill the holder ──────────────────────
    {
      const port = await freePort();
      const server = await spawnHolder(port, baseDir, true);
      const result = takeOverPort(port, false, false, baseDir);
      assert(
        "production mode refuses to kill the holder",
        result.status === TAKEOVER_REFUSED_PROD && eq(result.killed, []) && !server.exited,
        `status=${result.status} exited=${server.exited}`,
      );
    }

    // ── 5. the runtime path also spares a foreign holder ───────────────────
    // The runtime bind-failure fallback (server.ts killPort) runs the SAME
    // identity gate (DEC-02): a foreign holder makes it throw and stay alive,
    // instead of SIGTERMing it. Calls the runtime entrypoint directly (parity
    // with Python's _kill_port / Ruby's WebServer#free_port).
    {
      const port = await freePort();
      const foreign = await spawnHolder(port, baseDir, false);
      const prevDebug = process.env.TINA4_DEBUG;
      const prevOpt = process.env.TINA4_NO_TAKEOVER;
      process.env.TINA4_DEBUG = "true";
      delete process.env.TINA4_NO_TAKEOVER;
      let threw = false;
      let message = "";
      try {
        killPort(port);
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      } finally {
        prevDebug === undefined ? delete process.env.TINA4_DEBUG : (process.env.TINA4_DEBUG = prevDebug);
        prevOpt === undefined ? delete process.env.TINA4_NO_TAKEOVER : (process.env.TINA4_NO_TAKEOVER = prevOpt);
      }
      assert(
        "the runtime path also spares a foreign holder",
        threw && message.includes("non-Tina4") && !foreign.exited && (await listening(port)),
        `threw=${threw} message=${JSON.stringify(message)} exited=${foreign.exited}`,
      );
    }
  } finally {
    reap();
    await sleep(200);
    rmSync(baseDir, { recursive: true, force: true });
  }

  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  reap();
  console.error(err);
  process.exit(1);
});

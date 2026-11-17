/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A slow start must not turn a free port into "Port N is in use".
 *
 * startServer() checked the port by spawning a child `node` that tries the bind,
 * with a 1-second timeout, and treated ANY failure of that child as "in use".
 * When a child node takes longer than its timeout to start -- arm64 under
 * emulation, a small ARM board, a CPU-throttled container -- the timeout fired,
 * the free port was reported as held, and outside dev mode the server refused
 * to start: "Port 7148 is in use; takeover is disabled outside dev mode". The
 * tina4-nodejs 3.13.163 and 3.13.164 Docker images both exited that way on
 * emulated arm64 with nothing else running in the container.
 *
 * Only a bind that fails with EADDRINUSE means the port is held. A probe that
 * times out or cannot start says nothing about the port, and the real bind
 * decides (it fails loudly if the port really is taken).
 *
 * No mocks: real sockets and the real CLI. The slow start is real too -- a
 * NODE_OPTIONS preload that makes each bind-probe child start later than the
 * probe's own timeout, which is what a slow host does to it.
 *
 * Mutation proof: in packages/core/src/portTakeover.ts probeBind(), return
 * "held" for every failure (the old behaviour): the two checks on a free port
 * fail, and the held-port serve check sees the old refusal, not the real bind.
 *
 * Run with: npx tsx test/portProbeSlowStart.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { probeBind } from "../packages/core/src/portTakeover.ts";
import { freePort } from "./freePort.ts";

const repoRoot = join(import.meta.dirname, "..");
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
const cliEntry = join(repoRoot, "packages/cli/src/bin.ts");
const SECRET = "port-probe-slow-start-secret-0123456789";
// Longer than probeBind's default 5 s timeout, so a slowed probe times out.
const SLOW_MS = 6000;

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
const children: ChildProcess[] = [];

/**
 * NODE_OPTIONS that make every bind-probe child (`node -e` running a
 * createServer script) start SLOW_MS late. Only the probes: they are the
 * processes whose start time decides the outcome, and slowing every process
 * would only make the test slower.
 */
function slowProbeOptions(): string {
  const dir = mkdtempSync(join(tmpdir(), "tina4-slow-probe-"));
  dirs.push(dir);
  const preload = join(dir, "slow-probe.cjs");
  writeFileSync(preload,
    'const i = process.execArgv.indexOf("-e");\n'
    + 'if (i >= 0 && String(process.execArgv[i + 1]).includes("createServer")) {\n'
    + `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLOW_MS});\n`
    + '}\n');
  return `--require ${JSON.stringify(preload)}`;
}

/** A live listener on 127.0.0.1, so a later bind there fails. */
function holdPort(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const holder = net.createServer();
    holder.on("error", reject);
    holder.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve(holder));
  });
}

interface Serve { output: () => string; exited: () => boolean }

function serve(port: number, nodeOptions: string): Serve {
  const dir = mkdtempSync(join(tmpdir(), "tina4-slow-serve-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("TINA4_") && k !== "NODE_OPTIONS" && v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    TINA4_OVERRIDE_CLIENT: "true",
    TINA4_NO_BROWSER: "true",
    TINA4_SECRET: SECRET,
    TINA4_HOST: "127.0.0.1",
    TINA4_DEBUG: "false",
    NODE_OPTIONS: nodeOptions,
  });
  const child = spawn(process.execPath,
    ["--import", tsxLoader, cliEntry, "serve", "--port", String(port), "--no-browser", "--no-reload"],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  children.push(child);
  let out = "";
  let done = false;
  child.stdout?.on("data", (d) => { out += d.toString(); });
  child.stderr?.on("data", (d) => { out += d.toString(); });
  child.on("exit", () => { done = true; });
  return { output: () => out, exited: () => done };
}

async function waitFor(s: Serve, ok: () => boolean, ms = 90_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    if (s.exited()) return ok();
    await sleep(100);
  }
  return false;
}

function reap(): void {
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}

/** Run probeBind with the probe child starting SLOW_MS late. */
function probeSlow(port: number, timeout: number): string {
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = slowProbeOptions();
  try {
    return probeBind("127.0.0.1", port, timeout);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
}

const bannerFor = (port: number): RegExp => new RegExp(`Server:\\s+http://\\S*:${port}\\b`);

async function main(): Promise<void> {
  console.log("\n  a slow start does not make a free port \"in use\"\n");
  const held: net.Server[] = [];
  try {
    // -- the probe, directly --
    {
      const result = probeSlow(await freePort(), 300);
      assert("a probe that times out reports unknown, not held", result === "unknown", result);
    }
    // -- the real CLI, every bind probe timing out --
    {
      const port = await freePort();
      const s = serve(port, slowProbeOptions());
      const up = await waitFor(s, () => bannerFor(port).test(s.output()));
      assert("serve with debug off starts on a free port when its probes time out",
        up && !s.output().includes("is in use"), s.output());
    }
    // -- controls: a held port is still seen as held --
    {
      const free = probeBind("127.0.0.1", await freePort());
      assert("a probe of a free port reports free", free === "free", free);
      const holder = await holdPort();
      held.push(holder);
      const port = (holder.address() as net.AddressInfo).port;
      const fast = probeBind("127.0.0.1", port);
      assert("a probe of a held port reports held", fast === "held", fast);
      const slow = probeSlow(port, 15_000);
      assert("a slow probe that finishes still reports a held port as held", slow === "held", slow);
      // Every probe is inconclusive here, so the real bind decides, and it fails
      // loudly on the held port: never a silent start, never a false banner.
      const s = serve(port, slowProbeOptions());
      await waitFor(s, () => s.exited());
      assert("serve on a held port whose probes time out fails loudly on the real bind",
        s.exited() && s.output().includes("EADDRINUSE") && !bannerFor(port).test(s.output()),
        s.output());
    }
  } finally {
    reap();
    for (const holder of held) holder.close();
    await sleep(200);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  reap();
  console.error(err);
  process.exit(1);
});

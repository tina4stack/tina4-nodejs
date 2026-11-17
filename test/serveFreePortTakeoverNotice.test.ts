/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * `tina4nodejs serve` must only say a port is in use when something holds it.
 *
 * takeOverPort() refused outside dev mode, and when takeover was opted out,
 * before it looked for a holder. So with debug off (or --no-kill) every start
 * printed "Port N is in use ..." on a port nothing held, and a production
 * operator was told a free port was taken. Parity with tina4-php#362.
 *
 * No mocks: real sockets, and the real CLI in a child process on its own port.
 * The held-port cases are the controls: the notice must still appear when the
 * port really is taken.
 *
 * Run with: npx tsx test/serveFreePortTakeoverNotice.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  takeOverPort,
  TAKEOVER_NOTHING,
  TAKEOVER_REFUSED_PROD,
} from "../packages/core/src/portTakeover.ts";
import { freePort } from "./freePort.ts";

const repoRoot = join(import.meta.dirname, "..");
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
const cliEntry = join(repoRoot, "packages/cli/src/bin.ts");
const SECRET = "serve-free-port-secret-0123456789abcdef";

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

/** A live listener on 127.0.0.1, so a later bind there fails. */
function holdPort(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const holder = net.createServer();
    holder.on("error", reject);
    holder.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve(holder));
  });
}

interface Serve {
  child: ChildProcess;
  output: () => string;
  exited: () => boolean;
}

const children: ChildProcess[] = [];
const dirs: string[] = [];

function serve(port: number, extraEnv: Record<string, string>, flags: string[] = []): Serve {
  const dir = mkdtempSync(join(tmpdir(), "tina4-serve-free-port-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("TINA4_") && v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    TINA4_OVERRIDE_CLIENT: "true",
    TINA4_NO_BROWSER: "true",
    TINA4_SECRET: SECRET,
    TINA4_HOST: "127.0.0.1",
  }, extraEnv);
  const child = spawn(process.execPath,
    ["--import", tsxLoader, cliEntry, "serve", ...flags, "--port", String(port), "--no-browser", "--no-reload"],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  children.push(child);
  let out = "";
  let done = false;
  child.stdout?.on("data", (d) => { out += d.toString(); });
  child.stderr?.on("data", (d) => { out += d.toString(); });
  child.on("exit", () => { done = true; });
  return { child, output: () => out, exited: () => done };
}

async function waitFor(s: Serve, ok: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return true;
    if (s.exited()) return ok();
    await sleep(100);
  }
  return false;
}

/** Boot serve on a free port, wait for its own Server banner, return its output. */
async function outputOnceServing(extraEnv: Record<string, string>, flags: string[] = []): Promise<string> {
  const port = await freePort();
  const s = serve(port, extraEnv, flags);
  const ownServer = new RegExp(`Server:\\s+http://\\S*:${port}\\b`);
  const up = await waitFor(s, () => ownServer.test(s.output()));
  if (!up) throw new Error(`serve never came up on free port ${port}:\n${s.output()}`);
  return s.output();
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

async function main(): Promise<void> {
  console.log("\n  serve says nothing about a free port\n");
  const held: net.Server[] = [];
  try {
    // ── the shared helper, directly ──
    {
      const result = takeOverPort(await freePort(), false, false, undefined, undefined, "127.0.0.1");
      assert("a free port is not refused outside dev mode",
        result.status === TAKEOVER_NOTHING && result.message === "", JSON.stringify(result));
    }
    {
      const result = takeOverPort(await freePort(), true, true, undefined, undefined, "127.0.0.1");
      assert("a free port is not refused when opted out",
        result.status === TAKEOVER_NOTHING && result.message === "", JSON.stringify(result));
    }
    {
      const holder = await holdPort();
      held.push(holder);
      const port = (holder.address() as net.AddressInfo).port;
      const result = takeOverPort(port, false, false, undefined, undefined, "127.0.0.1");
      assert("a held port is still refused outside dev mode",
        result.status === TAKEOVER_REFUSED_PROD && result.message.includes(`Port ${port} is in use`),
        JSON.stringify(result));
    }

    // ── the real CLI ──
    {
      const output = await outputOnceServing({ TINA4_DEBUG: "false" });
      assert("serve with debug off says nothing about a free port", !output.includes("is in use"), output);
    }
    {
      const output = await outputOnceServing({ TINA4_DEBUG: "true" }, ["--no-kill"]);
      assert("serve with --no-kill says nothing about a free port", !output.includes("is in use"), output);
    }
    {
      const holder = await holdPort();
      held.push(holder);
      const port = (holder.address() as net.AddressInfo).port;
      const s = serve(port, { TINA4_DEBUG: "false" });
      const notice = `Port ${port} is in use; takeover is disabled outside dev mode`;
      await waitFor(s, () => s.output().includes(notice));
      assert("serve with debug off still refuses a held port", s.output().includes(notice), s.output());
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

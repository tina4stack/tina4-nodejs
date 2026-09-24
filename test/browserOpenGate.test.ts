/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * The server may open a browser only for a developer at a desk.
 *
 * startServer() opened the default browser unless TINA4_NO_BROWSER was set:
 * also on a production boot (TINA4_DEBUG off) and under CI. The browser now
 * opens only when ALL of these hold: development mode is on, TINA4_NO_BROWSER
 * is not truthy, and no CI variable is set.
 *
 * NO MOCKS. Each case boots a real Tina4 server in a child process whose PATH
 * starts with a directory holding real `open` / `xdg-open` shell scripts that
 * append their argument to a marker file. The server launches the platform's
 * opener exactly as it would on a developer's machine; the test observes that
 * process launch, and no real browser is touched by the positive control.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, fstatSync, readSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

const REPO = resolve(import.meta.dirname, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");
// Written out, not imported, so the test does not trust the code it checks.
const CI_VARIABLES = ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TF_BUILD", "TEAMCITY_VERSION"];
const OPEN_WAIT_MS = 5000; // the server opens 2s after it listens

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const started: Array<{ child: ChildProcess; root: string }> = [];

afterEach(() => {
  for (const { child, root } of started.splice(0)) {
    try {
      if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/**
 * What the opener wrote, or null when it never ran. One read, no separate
 * existence check: checking and then reading is a race (the opener may still
 * be writing between the two), which is what CodeQL's js/file-system-race
 * flagged here.
 */
function readMarker(marker: string): string | null {
  try {
    return readFileSync(marker, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Boot a real server over a clean environment plus `env`; return what the opener wrote (null if it never ran). */
async function bootAndWatch(env: Record<string, string>, launch: "startServer" | "startServer-noBrowser" | "cli-no-browser" = "startServer"): Promise<string | null> {
  const root = mkdtempSync(join(tmpdir(), "tina4-browser-gate-"));
  const marker = join(root, "opened.txt");
  mkdirSync(join(root, "bin"));
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(root, "bin", opener), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${marker}'\n`);
    chmodSync(join(root, "bin", opener), 0o755);
  }
  const routes = join(root, "src", "routes", "hello");
  mkdirSync(routes, { recursive: true });
  writeFileSync(join(routes, "get.ts"), `export default async function (_req: any, res: any) { return res.json({ ok: true }); }\n`);
  const port = await freePort();
  writeFileSync(join(root, "package.json"), '{"name":"browsergate","type":"module","private":true}\n');
  const routesDir = join(root, "src", "routes");
  writeFileSync(
    join(root, "app.ts"),
    launch === "cli-no-browser"
      ? // What `tina4nodejs serve --no-browser` runs (bin.ts parses the flag into this call).
        `import { serveProject } from '${REPO}/packages/cli/src/commands/serve.ts';\n` +
          `await serveProject({ port: ${port}, noBrowser: true });\n`
      : `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
          `await startServer({ port: ${port}, routesDir: '${routesDir}'${launch === "startServer-noBrowser" ? ", noBrowser: true" : ""} } as never);\n`,
  );

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["TINA4_NO_BROWSER", "TINA4_DEBUG", ...CI_VARIABLES]) delete childEnv[name];
  const logPath = join(root, "server.log");
  const fd = openSync(logPath, "w+");
  const child = spawn(TSX, ["app.ts"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...childEnv,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TINA4_OVERRIDE_CLIENT: "true",
      TINA4_NO_AI_PORT: "true",
      TINA4_PORT: String(port),
      ...env,
    },
  });
  started.push({ child, root });

  const deadline = Date.now() + 60_000;
  let up = false;
  while (!up && Date.now() < deadline) {
    try {
      up = (await fetch(`http://127.0.0.1:${port}/hello`)).status === 200;
    } catch {
      await sleep(250);
    }
  }
  let diagnostics = "";
  try {
    if (!up) {
      const size = fstatSync(fd).size;
      const tail = Buffer.alloc(Math.min(size, 2000));
      const bytes = readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
      diagnostics = tail.subarray(0, bytes).toString("utf8");
    }
  } finally {
    closeSync(fd);
  }
  expect(up, `server never came up:\n${diagnostics}`).toBe(true);
  const until = Date.now() + OPEN_WAIT_MS;
  let opened = readMarker(marker);
  while (opened === null && Date.now() < until) {
    await sleep(100);
    opened = readMarker(marker);
  }
  return opened;
}

describe("the browser opens only for a developer", () => {
  it("a developer boot opens the browser at the server", async () => {
    // The positive control: without it every case below would pass on a
    // server that never opens anything.
    const opened = await bootAndWatch({ TINA4_DEBUG: "true" });
    expect(opened, "a development boot with nothing suppressing it must open the browser").not.toBeNull();
    expect(opened).toMatch(/^http:\/\/\S+:\d+\n$/);
  }, 90_000);

  it("a CI variable set to false or 0 does not count as CI", async () => {
    // ADR-0070: a variable counts only when present and not "false" or "0".
    const opened = await bootAndWatch({ TINA4_DEBUG: "true", CI: "false", GITHUB_ACTIONS: "0" });
    expect(opened, "CI=false / GITHUB_ACTIONS=0 must not suppress the browser").not.toBeNull();
  }, 90_000);

  const suppressed: Array<[string, Record<string, string>]> = [
    ["TINA4_NO_BROWSER=true", { TINA4_DEBUG: "true", TINA4_NO_BROWSER: "true" }],
    ["production (TINA4_DEBUG=false)", { TINA4_DEBUG: "false" }],
    ["CI=true", { TINA4_DEBUG: "true", CI: "true" }],
    ["GITHUB_ACTIONS=true", { TINA4_DEBUG: "true", GITHUB_ACTIONS: "true" }],
    ["TEAMCITY_VERSION is set", { TINA4_DEBUG: "true", TEAMCITY_VERSION: "2024.1" }],
  ];
  it("the browser stays closed with the programmatic noBrowser option", async () => {
    const opened = await bootAndWatch({ TINA4_DEBUG: "true" }, "startServer-noBrowser");
    expect(opened, "startServer({ noBrowser: true }) opened the browser").toBeNull();
  }, 90_000);

  it("the browser stays closed with tina4nodejs serve --no-browser", async () => {
    // The CLI parsed --no-browser and serve.ts dropped it (ADR-0070 rule 3).
    const opened = await bootAndWatch({ TINA4_DEBUG: "true" }, "cli-no-browser");
    expect(opened, "serve --no-browser opened the browser").toBeNull();
  }, 90_000);

  for (const [label, env] of suppressed) {
    it(`the browser stays closed when ${label}`, async () => {
      const opened = await bootAndWatch(env);
      expect(opened, `the browser was opened although ${label}`).toBeNull();
    }, 90_000);
  }
});

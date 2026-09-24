/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Regression lock-in for tina4-python#143 and #144 across the family (ADR-0072).
 *
 * #144: a Content-Type set with response.header() is THE Content-Type. Node never
 * sent two (setHeader is case-insensitive), but response(data) overwrote the
 * developer's value with a detected one for a string or object body:
 * header("Content-Type", "text/csv") + response("a,b") went out as text/plain.
 *
 * #143: a setting in .env applies. request.ts read TINA4_MAX_UPLOAD_SIZE into a
 * module constant when it was imported, before startServer() loads .env, so a
 * limit set only in .env was ignored (a 5,000-byte POST against 1,000 got 200).
 *
 * No mocks: one REAL child server booted by startServer() from a project whose
 * .env carries the settings (the outer environment is scrubbed of them), and
 * every case is a real HTTP request over a real loopback socket.
 *
 * Run with: npx tsx test/dotenvSettingsAndContentType.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_MAX_UPLOAD_SIZE, maxUploadSize } from "../packages/core/src/request.ts";

const REPO = resolve(import.meta.dirname, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");
const UPLOAD_LIMIT = 1000;
const DOTENV_HEALTH_PATH = "/healthz-from-dotenv";

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolvePort(port));
    });
  });
}

const ROUTES: Record<string, string> = {
  "upload/post.ts":
    "export const noAuth = true;\n" +
    "export default async function (_req: any, res: any) { return res('OK', 200); }\n",
  "content-type/header-with-bytes/get.ts":
    "export default async function (_req: any, res: any) {\n" +
    "  res.header('Content-Type', 'image/png');\n" +
    "  return res(Buffer.from('89504e470d0a1a0a', 'hex'));\n}\n",
  "content-type/lowercase-header/get.ts":
    "export default async function (_req: any, res: any) {\n" +
    "  res.header('content-type', 'image/png');\n" +
    "  return res(Buffer.from('89504e470d0a1a0a', 'hex'));\n}\n",
  "content-type/header-with-string/get.ts":
    "export default async function (_req: any, res: any) {\n" +
    "  res.header('Content-Type', 'text/csv');\n" +
    "  return res('a,b');\n}\n",
  "content-type/argument-after-header/get.ts":
    "export default async function (_req: any, res: any) {\n" +
    "  res.header('Content-Type', 'image/png');\n" +
    "  return res(Buffer.from('89504e470d0a1a0a', 'hex'), 200, 'image/gif');\n}\n",
  "content-type/detected/get.ts":
    "export default async function (_req: any, res: any) { return res('plain words'); }\n",
};

let child: ChildProcess | null = null;
let root = "";

async function bootFromDotenv(port: number): Promise<void> {
  root = mkdtempSync(join(tmpdir(), "tina4-dotenv-settings-"));
  const routes = join(root, "src", "routes");
  for (const [file, source] of Object.entries(ROUTES)) {
    const path = join(routes, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  writeFileSync(join(root, "package.json"), '{"name":"dotenv-settings","type":"module","private":true}\n');
  writeFileSync(
    join(root, ".env"),
    `TINA4_MAX_UPLOAD_SIZE=${UPLOAD_LIMIT}\nTINA4_HEALTH_PATH=${DOTENV_HEALTH_PATH}\nTINA4_DEBUG=false\n`,
  );
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
      `await startServer({ port: ${port}, host: '127.0.0.1', routesDir: '${routes}' } as never);\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TINA4_OVERRIDE_CLIENT: "true", TINA4_NO_BROWSER: "true", TINA4_NO_AI_PORT: "true",
  };
  // The settings under test must come from .env alone.
  for (const name of ["TINA4_MAX_UPLOAD_SIZE", "TINA4_HEALTH_PATH", "TINA4_ENV_FILE", "TINA4_DEBUG", "TINA4_PORT", "PORT"]) {
    delete env[name];
  }
  child = spawn(TSX, ["app.ts"], { cwd: root, detached: true, stdio: ["ignore", "ignore", "ignore"], env });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/content-type/detected`);
      if (res.status) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`server never came up on ${port}`);
}

function reap(): void {
  if (child?.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  child = null;
  if (root) rmSync(root, { recursive: true, force: true });
}

/** One real request; returns the status and EVERY Content-Type header line. */
function call(port: number, method: string, path: string, body?: Buffer): Promise<{ status: number; contentTypes: string[] }> {
  return new Promise((resolveCall, rejectCall) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: body ? { "content-type": "application/octet-stream", "content-length": body.length } : {} },
      (res) => {
        res.resume();
        res.on("end", () => {
          const contentTypes: string[] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            if (res.rawHeaders[i].toLowerCase() === "content-type") contentTypes.push(res.rawHeaders[i + 1]);
          }
          resolveCall({ status: res.statusCode ?? 0, contentTypes });
        });
      },
    );
    req.on("error", rejectCall);
    req.end(body);
  });
}

const same = (actual: string[], expected: string[]): boolean => JSON.stringify(actual) === JSON.stringify(expected);

console.log("=== .env settings and header Content-Type (ADR-0072) ===");
{
  // The limit is resolved from the environment on every call.
  const previous = process.env.TINA4_MAX_UPLOAD_SIZE;
  process.env.TINA4_MAX_UPLOAD_SIZE = "2048";
  const first = maxUploadSize();
  process.env.TINA4_MAX_UPLOAD_SIZE = "4096";
  assert("max upload size follows the environment", first === 2048 && maxUploadSize() === 4096);
  const fallbacks = ["ten megabytes", "-5", "0"].map((bad) => {
    process.env.TINA4_MAX_UPLOAD_SIZE = bad;
    return maxUploadSize();
  });
  // parseInt("ten megabytes") used to be NaN, and a NaN cap refused nothing.
  assert("a bad max upload size falls back to the default",
    fallbacks.every((value) => value === DEFAULT_MAX_UPLOAD_SIZE), JSON.stringify(fallbacks));
  if (previous === undefined) delete process.env.TINA4_MAX_UPLOAD_SIZE;
  else process.env.TINA4_MAX_UPLOAD_SIZE = previous;
}
try {
  const port = await freePort();
  await bootFromDotenv(port);

  console.log("--- #144 a Content-Type set with header() is THE Content-Type ---");
  let r = await call(port, "GET", "/content-type/header-with-bytes");
  assert("header content type replaces the detected type", r.status === 200 && same(r.contentTypes, ["image/png"]), JSON.stringify(r));
  r = await call(port, "GET", "/content-type/lowercase-header");
  assert("a lowercase content type header is the same header", r.status === 200 && same(r.contentTypes, ["image/png"]), JSON.stringify(r));
  r = await call(port, "GET", "/content-type/header-with-string");
  assert("header content type survives a string body", r.status === 200 && same(r.contentTypes, ["text/csv"]), JSON.stringify(r));
  r = await call(port, "GET", "/content-type/argument-after-header");
  assert("an explicit content type argument wins over the header", r.status === 200 && same(r.contentTypes, ["image/gif"]), JSON.stringify(r));
  r = await call(port, "GET", "/content-type/detected");
  assert("without a header the detected type is used",
    r.status === 200 && r.contentTypes.length === 1 && r.contentTypes[0].toLowerCase().startsWith("text/plain"), JSON.stringify(r));

  console.log("--- #143 a setting in .env applies ---");
  r = await call(port, "POST", "/upload", Buffer.alloc(UPLOAD_LIMIT * 5, 0x78));
  assert("max upload size from dotenv is enforced", r.status === 413, JSON.stringify(r));
  r = await call(port, "POST", "/upload", Buffer.alloc(UPLOAD_LIMIT / 2, 0x78));
  assert("a body under the dotenv limit is accepted", r.status === 200, JSON.stringify(r));
  r = await call(port, "GET", DOTENV_HEALTH_PATH);
  assert("health path from dotenv is served", r.status === 200, JSON.stringify(r));
} finally {
  reap();
}

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);

/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * CORS denial diagnostics are BOUNDED: one warning per reason per process, and
 * no per-origin ledger (ADR-0048).
 *
 * THE DEFECT: the warn-once ledger was keyed by the request's Origin
 * (`denied:<origin>`, and briefly `unconfigured:<origin>`). The Origin header is
 * attacker-chosen, so every new value added a Set entry that was never freed
 * and another warning line - an unbounded ledger and an unbounded log. ADR-0048
 * decided: no per-origin ledger and no per-origin warning.
 *
 * THE CONTRACT: every CORS warning is keyed by REASON only (unconfigured,
 * denied, wildcard-credentials). Fifty distinct cross-origin Origins produce
 * exactly ONE warning for their reason, and the ledger holds the reason, never
 * an origin. The one message may name the origin that first triggered it.
 *
 * NO MOCKS: each policy runs a REAL startServer() in a child process; the test
 * sends real HTTP requests, reads the child's REAL stdout, and reads the
 * ledger's contents back from a route running inside that same server.
 *
 * Same case names in all four frameworks:
 *   - fifty_origins_without_a_policy_log_one_warning
 *   - fifty_denied_origins_log_one_warning
 *   - cors_warn_state_is_bounded_by_reason
 *
 * Run with: npx tsx test/corsWarningBounded.test.ts
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

const ORIGINS = 50;
const REPO = resolve(import.meta.dirname, "..");
const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-cors-bounded-"));
mkdirSync(join(TEST_DIR, "src/routes/api/save"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/warnstate"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/api/save/post.ts"), `
export const noAuth = true;
export default async function (req: any, res: any) {
  return res.json({ saved: true });
}
`);
// Reads the ledger of the SAME module instance the server's CORS policy uses.
writeFileSync(join(TEST_DIR, "src/routes/warnstate/get.ts"), `
import * as mw from ${JSON.stringify(join(REPO, "packages/core/src/middleware.ts"))};
export default async function (req: any, res: any) {
  const read = (mw as any).corsWarningReasons;
  return res.json({ reasons: typeof read === "function" ? read() : null });
}
`);
writeFileSync(join(TEST_DIR, "server.ts"), `
import { startServer } from ${JSON.stringify(join(REPO, "packages/core/src/index.ts"))};
await startServer({ port: Number(process.env.PORT), basePath: ${JSON.stringify(TEST_DIR)} });
console.log("TEST-SERVER-READY");
`);

interface Server { port: number; child: ChildProcess; output: () => string }

async function boot(env: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const childEnv: Record<string, string | undefined> = {
    ...process.env, ...env, PORT: String(port), TINA4_DEBUG: "false", TINA4_RATE_LIMIT: "100000",
    TINA4_OVERRIDE_CLIENT: "true", TINA4_NO_AI_PORT: "true",
  };
  if (!("TINA4_CORS_ORIGINS" in env)) delete childEnv.TINA4_CORS_ORIGINS;
  const child = spawn(process.execPath, ["--import", "tsx", join(TEST_DIR, "server.ts")], {
    cwd: REPO, env: childEnv as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (c) => { out += c; });
  child.stderr!.on("data", (c) => { out += c; });
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 60000);
    const check = setInterval(() => {
      if (out.includes("TEST-SERVER-READY")) { clearInterval(check); clearTimeout(timer); ready(); }
    }, 50);
    child.on("exit", (code) => { clearInterval(check); clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
  return { port, child, output: () => out };
}

function request(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((done, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

async function scenario(label: string, caseName: string, env: Record<string, string>, reason: string): Promise<void> {
  console.log(`\n--- ${label} ---`);
  const s = await boot(env);
  try {
    const mark = s.output().length;
    const statuses: number[] = [];
    for (let i = 0; i < ORIGINS; i++) {
      const r = await request(s.port, "POST", "/api/save",
        { "Content-Type": "application/json", Origin: `https://site-${i}.attacker.example` });
      statuses.push(r.status);
    }
    await new Promise((r) => setTimeout(r, 200));
    const lines = s.output().slice(mark).split("\n").filter((l) => l.includes("CORS"));
    assert(`${caseName} (${ORIGINS} requests served)`, statuses.every((st) => st === 200), JSON.stringify(statuses));
    assert(caseName, lines.length === 1 && lines[0].split(/\s+/).some((token) => token === "https://site-0.attacker.example"),
      `${lines.length} CORS lines; first: ${lines[0]?.slice(0, 160)}`);

    const state = await request(s.port, "GET", "/warnstate", {});
    let reasons: unknown = null;
    try { reasons = JSON.parse(state.body).reasons; } catch { /* not JSON */ }
    const list = Array.isArray(reasons) ? reasons as string[] : [];
    assert(`cors_warn_state_is_bounded_by_reason (${label})`,
      Array.isArray(reasons) && list.length === 1 && list[0] === reason && !list.some((k) => k.includes("://")),
      `ledger=${JSON.stringify(reasons)?.slice(0, 200)} (${list.length} entries)`);
  } finally {
    s.child.kill("SIGKILL");
  }
}

console.log("=== CORS warnings are bounded by reason (ADR-0048) ===");
await scenario("no policy", "fifty_origins_without_a_policy_log_one_warning", {}, "unconfigured");
await scenario("allow-list excluding them", "fifty_denied_origins_log_one_warning",
  { TINA4_CORS_ORIGINS: "https://partner.example.com" }, "denied");

try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

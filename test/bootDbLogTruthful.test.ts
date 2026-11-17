/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * The boot log must tell the truth about the database (review of tina4-ruby#172).
 *
 * THE DEFECTS: a boot whose TINA4_DATABASE_URL pointed at a server that refused
 * the connection logged
 *   - "ORM not available (install @tina4/orm to enable): Error: connect
 *     ECONNREFUSED ..." - the ORM was installed; the database was down; and
 *   - "Startup migrations skipped (no database configured): No database
 *     adapter configured" - a database WAS configured; it could not connect.
 *
 * THE CONTRACT: a connect failure names the database (without credentials)
 * and the error; "no database configured" is said only when
 * TINA4_DATABASE_URL is unset; a reachable database still migrates with no
 * warning at all.
 *
 * NO MOCKS: each case boots a REAL startServer() in a child process against a
 * real target - a closed local port, a sqlite path under a regular file, a
 * reachable sqlite file - and reads the child's real stdout/stderr.
 *
 * Run with: npx tsx test/bootDbLogTruthful.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

const REPO = resolve(import.meta.dirname, "..");
const SERVER_URL = pathToFileURL(join(REPO, "packages/core/src/index.ts")).href;
const UNREACHABLE = "postgres://tina4user:s3cret@127.0.0.1:1/tina4_nodb";
const UNREACHABLE_SAFE = "postgres://127.0.0.1:1/tina4_nodb";
const roots: string[] = [];

/** A throwaway project: src/orm (so the ORM boots) and one pending migration. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "tina4-boot-db-log-"));
  roots.push(root);
  mkdirSync(join(root, "src/orm"), { recursive: true });
  mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "migrations/000001_items.sql"), "CREATE TABLE items (id INTEGER PRIMARY KEY);");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  // chdir before startServer: the default sqlite path and .env are cwd-relative,
  // and the child itself starts in REPO so `--import tsx` resolves.
  writeFileSync(join(root, "server.ts"), `
import { startServer } from ${JSON.stringify(SERVER_URL)};
process.chdir(${JSON.stringify(root)});
await startServer({ port: Number(process.env.PORT), basePath: ${JSON.stringify(root)} });
console.log("TEST-SERVER-READY");
`);
  return root;
}

/** Boot a real server in `root`; return everything it printed up to ready. */
async function bootLog(root: string, databaseUrl: string | null): Promise<string> {
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env, PORT: String(port), TINA4_DEBUG: "false", TINA4_LOG_LEVEL: "DEBUG",
    TINA4_NO_BROWSER: "true", TINA4_NO_AI_PORT: "true", TINA4_OVERRIDE_CLIENT: "true",
  };
  delete env.TINA4_AUTO_MIGRATE;
  delete env.TINA4_DB_POOL;
  if (Buffer.byteLength(env.TINA4_SECRET ?? "", "utf8") < 32) {
    env.TINA4_SECRET = "tina4-nodejs-test-suite-secret-0123456789abcdef";
  }
  if (databaseUrl === null) delete env.TINA4_DATABASE_URL;
  else env.TINA4_DATABASE_URL = databaseUrl;

  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", join(root, "server.ts")], {
    cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (c) => { out += c; });
  child.stderr!.on("data", (c) => { out += c; });
  try {
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 60000);
      const check = setInterval(() => {
        if (out.includes("TEST-SERVER-READY")) { clearInterval(check); clearTimeout(timer); ready(); }
      }, 50);
      child.on("exit", (code) => { clearInterval(check); clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
    });
  } finally {
    child.kill("SIGKILL");
  }
  return out;
}

const lineWith = (out: string, needle: string): string =>
  out.split("\n").find((l) => l.includes(needle)) ?? "";

console.log("=== Boot log tells the truth about the database ===");

// --- 1. URL set, server refuses the connection ------------------------------
console.log("\n--- unreachable configured database ---");
{
  const out = await bootLog(project(), UNREACHABLE);
  const connectLine = lineWith(out, "Database could not be reached");
  const skipLine = lineWith(out, "Startup migrations skipped");
  assert("connect_failure_is_not_reported_as_missing_orm", !out.includes("ORM not available"),
    lineWith(out, "ORM not available").slice(0, 200));
  assert("connect_failure_names_database_and_error",
    connectLine.includes(`(${UNREACHABLE_SAFE})`) && connectLine.includes("ECONNREFUSED"), connectLine.slice(0, 200));
  assert("configured_database_is_not_reported_as_unconfigured",
    skipLine.includes(`database configured but could not connect to ${UNREACHABLE_SAFE}`)
      && !skipLine.includes("no database configured"), skipLine.slice(0, 250));
  assert("boot_log_carries_no_credentials", !out.includes("s3cret") && !out.includes("tina4user"));
}

// --- 2. URL unset, the framework-default sqlite cannot open ------------------
console.log("\n--- no TINA4_DATABASE_URL ---");
{
  const root = project();
  writeFileSync(join(root, "data"), "a regular file where the default sqlite dir should be");
  const out = await bootLog(root, null);
  const skipLine = lineWith(out, "Startup migrations skipped");
  assert("unset_url_still_says_no_database_configured",
    skipLine.includes("Startup migrations skipped (no database configured)"), skipLine.slice(0, 250));
  assert("unset_url_failure_is_not_reported_as_missing_orm", !out.includes("ORM not available"),
    lineWith(out, "ORM not available").slice(0, 200));
}

// --- 3. Positive: a reachable sqlite file -----------------------------------
console.log("\n--- reachable database ---");
{
  const root = project();
  const out = await bootLog(root, `sqlite:///${join(root, "app.db").replace(/\\/g, "/")}`);
  assert("reachable_database_migrates", out.includes("Applied 1 pending migration(s) on startup"), out.slice(-400));
  assert("reachable_database_logs_no_failure",
    !out.includes("Database could not be reached") && !out.includes("Startup migrations skipped")
      && !out.includes("ORM not available"));
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

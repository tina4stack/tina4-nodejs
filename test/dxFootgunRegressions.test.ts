/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Regressions for the LLM DX footguns fixed at parity with the Python master:
 *   #289 — a handler that RETURNS a dict/array/string (instead of calling
 *          res.json) is coerced into a response, not dropped as an empty 200.
 *   #270 — a generated route test stays green when the handler is filled in.
 *   #297 — `generate migration create_*_view` scaffolds a VIEW, not a table.
 *   #288 — an empty, unedited scaffold migration is kept pending, not applied.
 *
 * No mocks: #289 drives a REAL server over a real socket; #288 runs the REAL
 * Migration runner on real SQLite; #297/#270 inspect / run real generated files.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../packages/core/src/index.ts";
import { initDatabase, migrate } from "../packages/orm/src/index.ts";
import { freePort } from "./freePort.ts";

process.env.TINA4_CORS_ORIGINS = "*";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, "../packages/cli/bin/tina4nodejs");

console.log("=== DX footgun regressions (Node) ===\n");

// ── #289: a bare return is coerced into a response ───────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "tina4-dx289-"));
  const routesDir = join(root, "src", "routes");
  function route(urlPath: string, handlerBody: string) {
    const dir = join(routesDir, ...urlPath.split("/").filter(Boolean));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "get.ts"), `export default async function (_req: any, res: any) { ${handlerBody} }\n`);
  }
  route("/stats", "return { open: 3 };");            // bare dict — no res() call
  route("/name", 'return "plain words";');            // bare string
  route("/explicit", 'return res.json({ ok: true });'); // already-sent, must not double

  const PORT = await freePort();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const req = async (p: string) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { redirect: "manual" });
    return { status: r.status, ct: r.headers.get("content-type") ?? "", body: await r.text() };
  };
  try {
    server = await startServer({ port: PORT, routesDir } as never);

    const stats = await req("/stats");
    assert("returned dict becomes a JSON body (not an empty 200)",
      stats.status === 200 && stats.ct.includes("application/json") && JSON.parse(stats.body).open === 3,
      `${stats.status} ${stats.ct} ${stats.body.slice(0, 60)}`);

    const name = await req("/name");
    assert("returned string becomes a text/html body",
      name.status === 200 && name.body.includes("plain words") && name.body.length > 0,
      `${name.status} ${name.body.slice(0, 60)}`);

    const explicit = await req("/explicit");
    assert("explicit res.json is sent once, not double",
      explicit.status === 200 && JSON.parse(explicit.body).ok === true,
      `${explicit.status} ${explicit.body.slice(0, 60)}`);
  } finally {
    if (server) await (server as { close?: () => Promise<void> }).close?.();
  }
}

// ── #297: a *_view migration scaffolds a VIEW, not a runnable table ──────
{
  const root = mkdtempSync(join(tmpdir(), "tina4-dx297-"));
  execFileSync("sh", [BIN, "generate", "migration", "create_open_tickets_view"], { cwd: root, stdio: "ignore" });
  const up = readdirSync(join(root, "migrations")).find((f) => f.endsWith("_create_open_tickets_view.sql") && !f.endsWith(".down.sql"))!;
  const sql = readFileSync(join(root, "migrations", up), "utf-8");
  assert("view migration has no runnable CREATE TABLE", !sql.includes("CREATE TABLE"), sql.slice(0, 80));
  assert("view migration mentions CREATE VIEW (as comment)", sql.includes("CREATE VIEW"));
  assert("CREATE VIEW guidance is commented", sql.split("\n").filter((l) => l.includes("CREATE VIEW")).every((l) => l.trimStart().startsWith("--")));
  const viewTests = (() => { try { return readdirSync(join(root, "tests")); } catch { return []; } })();
  assert("no misleading view migration test co-emitted", !viewTests.some((f) => f.includes("open_tickets_view")));
}

// ── #270: generated route test stays green as stub AND when filled ───────
{
  const root = mkdtempSync(join(tmpdir(), "tina4-dx270-"));
  execFileSync("sh", [BIN, "generate", "route", "complaints"], { cwd: root, stdio: "ignore" });
  const testSrc = readFileSync(join(root, "tests", "complaints.test.ts"), "utf-8");
  assert("generated route test has no self-defeating live-stub assertion",
    !testSrc.includes('assertThrows("list handler is a live stub'));
  assert("generated route test asserts the handler is callable (tolerant wiring)",
    testSrc.includes("list handler is callable"));
}

// ── #288: an empty scaffold migration is kept pending; real DDL applies ──
{
  const root = mkdtempSync(join(tmpdir(), "tina4-dx288-"));
  const migDir = join(root, "migrations");
  mkdirSync(migDir, { recursive: true });
  writeFileSync(join(migDir, "000001_add_note.sql"), "-- Migration: add_note\n-- tina4:edit  write the UP migration SQL\n");
  const db = await initDatabase({ url: `sqlite:///${join(root, "app.db")}` });
  await (db as { execute: (s: string) => Promise<unknown> }).execute("CREATE TABLE widget (id INTEGER PRIMARY KEY)");

  const r1 = await migrate(db as never, { migrationsDir: migDir });
  assert("comment-only scaffold is kept pending (not applied)", !r1.applied.some((f) => f.includes("add_note")));

  writeFileSync(join(migDir, "000001_add_note.sql"), "ALTER TABLE widget ADD COLUMN note TEXT;\n");
  const r2 = await migrate(db as never, { migrationsDir: migDir });
  assert("filled migration applies", r2.applied.some((f) => f.includes("add_note")));
  const cols = await (db as { getColumns: (t: string) => Promise<Array<{ name: string }>> }).getColumns("widget");
  assert("the real column was added", cols.some((c) => c.name === "note"));

  // A scaffolded CREATE TABLE is real DDL and must still apply (no over-skip).
  const migDir2 = join(root, "m2");
  mkdirSync(migDir2, { recursive: true });
  writeFileSync(join(migDir2, "000001_create_gizmo.sql"),
    "-- UP\nCREATE TABLE IF NOT EXISTS gizmo (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  created_at TIMESTAMP\n  -- tina4:edit  add columns\n);\n");
  const db2 = await initDatabase({ url: `sqlite:///${join(root, "app2.db")}` });
  await migrate(db2 as never, { migrationsDir: migDir2 });
  assert("scaffolded CREATE TABLE still applies (table persists)",
    await (db2 as { tableExists: (t: string) => Promise<boolean> }).tableExists("gizmo"));
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

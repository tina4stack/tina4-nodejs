/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Regression for tina4-nodejs#277: startup auto-migration is serialized across
 * processes, so a data migration applies exactly once under concurrency.
 *
 * No mocks. This spawns several REAL OS processes (not threads — the bug is
 * cross-process) that open the SAME SQLite database and run the migration runner
 * at the same moment. SQL cannot sleep, so a recursive-CTE burn widens the window
 * in which two unsynchronized runs would both decide the migration is pending and
 * both insert. The assertion is the observable outcome: the row exists exactly
 * once and the tracker holds one row for the migration.
 *
 * Without the run-wide lock in migrate() every overlapping process inserts its
 * own copy; with it, the winner migrates while the rest block (on an atomic
 * mkdir lock dir for the SQLite fallback), then re-read the applied set and find
 * nothing pending.
 *
 * SQLite is the engine exercised here because every test host has node:sqlite.
 * The PostgreSQL/MySQL/MSSQL advisory-lock paths and the Firebird file-lock path
 * are covered by the lab's real-service concurrency run.
 *
 * Run with: npx tsx test/migrationConcurrency277.test.ts
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const WORKERS = 8;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ORM_INDEX = join(HERE, "..", "packages", "orm", "src", "index.ts");
const TSX_BIN = join(HERE, "..", "node_modules", ".bin", "tsx");

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function runWorker(worker: string, dbPath: string, migDir: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, [worker, dbPath, migDir], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function main(): Promise<void> {
  console.log("\nMigration concurrency (#277)\n");

  const dir = mkdtempSync(join(tmpdir(), "tina4-277-"));
  const migDir = join(dir, "migrations");
  mkdirSync(migDir, { recursive: true });

  writeFileSync(
    join(migDir, "000001_create_widgets.sql"),
    "CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);\n",
  );

  // SQL can't sleep, so a recursive-CTE burn (~0.5s) widens the critical section
  // so an unsynchronized run inserts WORKERS copies of 'first'.
  writeFileSync(
    join(migDir, "000002_seed_first.sql"),
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) " +
      "SELECT max(x) FROM c;\n" +
      "INSERT INTO widgets (name) VALUES ('first');\n",
  );

  const dbPath = join(dir, "app.db");

  // Pre-create the SQLite file in WAL mode. Several processes each running
  // `PRAGMA journal_mode = WAL` against a brand-new file race in the ADAPTER's
  // connect (a separate concern from migrations, and absent on the PostgreSQL
  // the issue reported), so seed WAL once up front to isolate this test to the
  // migration-lock behaviour under test.
  const seed = new DatabaseSync(dbPath);
  seed.exec("PRAGMA journal_mode = WAL");
  seed.close();

  const worker = join(dir, "worker.mts");
  writeFileSync(
    worker,
    `import { initDatabase, migrate } from ${JSON.stringify(ORM_INDEX)};\n` +
      `const [dbPath, migDir] = process.argv.slice(2);\n` +
      `await initDatabase({ type: "sqlite", path: dbPath });\n` +
      `try { await migrate(undefined, { migrationsDir: migDir }); }\n` +
      `catch (e) { console.error("worker error:", e); process.exit(1); }\n` +
      `process.exit(0);\n`,
  );

  // Launch all workers as close to simultaneously as possible.
  const codes = await Promise.all(
    Array.from({ length: WORKERS }, () => runWorker(worker, dbPath, migDir)),
  );

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let firstRows = -1;
  let trackerRows = -1;
  try {
    firstRows = (db.prepare("SELECT count(*) AS n FROM widgets WHERE name = 'first'").get() as { n: number }).n;
    trackerRows = (
      db
        .prepare("SELECT count(*) AS n FROM tina4_migration WHERE migration_name = '000002_seed_first'")
        .get() as { n: number }
    ).n;
  } finally {
    db.close();
  }

  assert(
    "data migration applies exactly once under concurrency",
    firstRows === 1,
    `expected 1 row named 'first', got ${firstRows} (worker exit codes: ${codes.join(",")})`,
  );
  assert(
    "tracker holds exactly one row for the migration",
    trackerRows === 1,
    `expected 1 tracker row, got ${trackerRows}`,
  );

  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();

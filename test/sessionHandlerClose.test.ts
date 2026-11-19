/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * DatabaseSessionHandler.close() releases the SQLite connection it opened.
 *
 * The handler opens its own node:sqlite connection on first use and used to
 * have no way to let go of it, so the session database stayed open until the
 * process exited. On Windows an open file cannot be deleted or replaced, so a
 * test, a deploy step or a backup could not touch it.
 *
 * The observable proof that the connection is really closed, on every OS: the
 * handler runs SQLite in WAL mode, and SQLite removes the `-wal` and `-shm` side
 * files when the LAST connection to the database closes. They exist after a
 * write and are gone after close(). Real file, real driver, no doubles.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSessionHandler } from "../packages/core/src/sessionHandlers/databaseHandler.ts";

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

console.log("=== DatabaseSessionHandler.close() ===\n");

const dir = mkdtempSync(join(tmpdir(), "tina4-sessclose-"));
const dbPath = join(dir, "sessions.db");
const handler = new DatabaseSessionHandler({ dbPath });
const data = { _created: Date.now() / 1000, _accessed: Date.now() / 1000, _data: { user: "ada" } } as any;

handler.write("sess-1", data, 3600);
assert("a write opens the database in WAL mode (-wal side file exists)",
  existsSync(`${dbPath}-wal`));

handler.close();
assert("close() releases the connection (SQLite removes -wal on the last close)",
  !existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`),
  `wal=${existsSync(`${dbPath}-wal`)} shm=${existsSync(`${dbPath}-shm`)}`);

let secondCloseThrew = false;
try {
  handler.close();
} catch {
  secondCloseThrew = true;
}
assert("close() is idempotent", !secondCloseThrew);

const back = handler.read("sess-1");
assert("the next read reopens the connection and finds the session",
  (back as any)?._data?.user === "ada", JSON.stringify(back));

handler.close();
let removed = true;
try {
  rmSync(dir, { recursive: true, force: false });
} catch {
  removed = false;
}
assert("after close() the session database can be deleted (Windows refuses an open file)",
  removed && !existsSync(dir));

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

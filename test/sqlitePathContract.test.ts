/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * SQLite path-resolution CONTRACT (ADR-0086), the five cases the four frameworks
 * must agree on. Real resolver, real files, real mkdir — no mocks.
 * Run with: npx tsx test/sqlitePathContract.test.ts
 *
 * Fixture: tina4-documentation/plan/v3/fixtures/sqlite_path_contract.json
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSqlitePath } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== SQLite Path-Resolution Contract (ADR-0086) ===\n");
const origCwd = process.cwd();

// 1. memory passthrough
assert("memory passthrough", resolveSqlitePath(":memory:") === ":memory:");

// 2. unix absolute passthrough no mkdir
{
  const base = mkdtempSync(join(tmpdir(), "tina4-pathcontract-"));
  const absDb = join(base, "missing", "app.db"); // parent does NOT exist
  const resolved = resolveSqlitePath(absDb);
  assert("unix absolute passthrough no mkdir (returns path)", resolved === absDb, `got "${resolved}"`);
  assert("unix absolute passthrough no mkdir (no dir created)", !existsSync(join(base, "missing")));
  rmSync(base, { recursive: true, force: true });
}

// 3. drive letter absolute passthrough no mkdir
assert(
  "drive letter absolute passthrough no mkdir (forward slash)",
  resolveSqlitePath("C:/Users/app.db") === "C:/Users/app.db",
  `got "${resolveSqlitePath("C:/Users/app.db")}"`,
);
assert(
  "drive letter absolute passthrough no mkdir (back slash)",
  resolveSqlitePath("C:\\Users\\app.db") === "C:\\Users\\app.db",
);

// 4. relative under cwd creates parent mode 0775
{
  const work = mkdtempSync(join(tmpdir(), "tina4-pathcontract-rel-"));
  process.chdir(work);
  const oldUmask = process.umask(0); // so the requested 0775 lands unmasked
  let resolved = "";
  try {
    resolved = resolveSqlitePath("sub/dir/app.db");
  } finally {
    process.umask(oldUmask);
    process.chdir(origCwd);
  }
  const parent = join(work, "sub", "dir");
  // On macOS the tmpdir has a /private symlink prefix; compare by suffix + real existence.
  assert("relative under cwd creates parent mode 0775 (resolved under cwd)", resolved.endsWith(join("sub", "dir", "app.db")), `got "${resolved}"`);
  assert("relative under cwd creates parent mode 0775 (dir exists)", existsSync(parent));
  if (process.platform === "win32") {
    // Windows has no POSIX permission bits: Node reports a directory as 0666 or
    // 0777 whatever mode it was created with, so there is no 0775 to observe.
    console.log("  SKIP relative under cwd creates parent mode 0775 (mode bits) - "
      + "POSIX-only: Windows directories carry no permission bits");
  } else {
    assert(
      "relative under cwd creates parent mode 0775 (mode bits)",
      existsSync(parent) && (statSync(parent).mode & 0o777) === 0o775,
      `got ${existsSync(parent) ? (statSync(parent).mode & 0o777).toString(8) : "no dir"}`,
    );
  }
  rmSync(work, { recursive: true, force: true });
}

// 5. relative escaping cwd is refused no mkdir
{
  const root = mkdtempSync(join(tmpdir(), "tina4-pathcontract-esc-"));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  process.chdir(work);
  const outside = join(root, "escaped");
  let threw = false;
  try {
    resolveSqlitePath("../escaped/app.db");
  } catch {
    threw = true;
  } finally {
    process.chdir(origCwd);
  }
  assert("relative escaping cwd is refused no mkdir (throws)", threw);
  assert("relative escaping cwd is refused no mkdir (no dir created)", !existsSync(outside));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Guard: the test runner must start with TINA4_NO_BROWSER=true.
 *
 * test/run-all.ts sets it before spawning any test file, so every server a
 * test spawns inherits it and no browser tab opens on the machine running the
 * suite. If that default is removed, this fails.
 * Run with: npx tsx test/run-all.ts   (standalone it needs TINA4_NO_BROWSER=true)
 */
import { spawnSync } from "node:child_process";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

assert(
  "the runner starts with TINA4_NO_BROWSER=true",
  process.env.TINA4_NO_BROWSER === "true",
  `found ${JSON.stringify(process.env.TINA4_NO_BROWSER)}`,
);

const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.TINA4_NO_BROWSER))"], {
  encoding: "utf8",
});
assert("a spawned child inherits TINA4_NO_BROWSER=true", child.stdout === "true", `child saw ${JSON.stringify(child.stdout)}`);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Regressions for two TestClient DX footguns (#296, #300).
 *
 * No mocks: a real .env file on disk, the real loadEnv the server uses, and a
 * real TestResponse built from real header values.
 *
 * Mirrors: tina4-python tests/test_test_client_env_and_headers.py,
 *          tina4-php tests/TestClientEnvAndHeadersTest.php,
 *          tina4-ruby spec/test_client_env_and_headers_spec.rb
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClient, TestResponse } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } catch (e) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${(e as Error).message}`);
    fail++;
  }
}

// ───────────────────────── #296 — TestClient loads .env ─────────────────────

test("#296 TestClient loads .env from the project root without starting a server", () => {
  const secret = "a".repeat(64);
  const dir = mkdtempSync(join(tmpdir(), "tina4-tc-"));
  writeFileSync(join(dir, ".env"), `TINA4_SECRET=${secret}\n`);
  const prevCwd = process.cwd();
  const prevSecret = process.env.TINA4_SECRET;
  const prevEnvFile = process.env.TINA4_ENV_FILE;
  try {
    delete process.env.TINA4_SECRET;
    delete process.env.TINA4_ENV_FILE;
    process.chdir(dir);
    assert.equal(process.env.TINA4_SECRET, undefined, "precondition: secret must start unset");

    new TestClient(); // construction loads .env the way startServer does

    assert.equal(process.env.TINA4_SECRET, secret, "TestClient did not load .env (#296)");
  } finally {
    process.chdir(prevCwd);
    if (prevSecret === undefined) delete process.env.TINA4_SECRET; else process.env.TINA4_SECRET = prevSecret;
    if (prevEnvFile === undefined) delete process.env.TINA4_ENV_FILE; else process.env.TINA4_ENV_FILE = prevEnvFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#296 .env load is first-wins — a real env var is not clobbered", () => {
  const real = "r".repeat(64);
  const dir = mkdtempSync(join(tmpdir(), "tina4-tc-"));
  writeFileSync(join(dir, ".env"), `TINA4_SECRET=${"d".repeat(64)}\n`); // a DIFFERENT value
  const prevCwd = process.cwd();
  const prevSecret = process.env.TINA4_SECRET;
  const prevEnvFile = process.env.TINA4_ENV_FILE;
  try {
    process.env.TINA4_SECRET = real;
    delete process.env.TINA4_ENV_FILE;
    process.chdir(dir);

    new TestClient();

    assert.equal(process.env.TINA4_SECRET, real, "TestClient clobbered a real env var (#296 first-wins)");
  } finally {
    process.chdir(prevCwd);
    if (prevSecret === undefined) delete process.env.TINA4_SECRET; else process.env.TINA4_SECRET = prevSecret;
    if (prevEnvFile === undefined) delete process.env.TINA4_ENV_FILE; else process.env.TINA4_ENV_FILE = prevEnvFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────── #300 — case-insensitive response headers ───────────────

test("#300 headers lookup is case-insensitive", () => {
  const r = new TestResponse(303, { location: ["/complaints"] }, "");

  assert.equal(r.headers["Location"], "/complaints"); // canonical case — was undefined
  assert.equal(r.headers["location"], "/complaints"); // lower case
  assert.equal("Location" in r.headers, true);
  assert.deepEqual(r.getHeaderList("Location"), ["/complaints"]);
  // the stored shape is unchanged: keys stay lower case
  assert.deepEqual(Object.keys(r.headers), ["location"]);
});

test("#300 an absent header is a miss, not a false hit", () => {
  const r = new TestResponse(200, { "content-type": ["text/html"] }, "");

  assert.equal(r.headers["X-Absent"], undefined);
  assert.equal("X-Absent" in r.headers, false);
  assert.deepEqual(r.getHeaderList("X-Absent"), []);
  // real members are untouched by the proxy
  assert.equal(typeof r.headers.hasOwnProperty, "function");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Only the dev dashboard's own routes skip the auth gate.
 *
 * The dispatcher used to tell the gate a request was a dev-admin one whenever
 * its path started with the characters "/__dev", so a write route of the
 * application's own named /__developer/..., /__devices or /__dev/... ran with no
 * token, with debug on or off. DevAdmin now registers its routes noAuth and the
 * path no longer matters.
 *
 * No mocks: a real Router, the real DevAdmin.register(), requests through the
 * real dispatch via TestClient.
 * Run with: npx tsx test/devAdminAuthScope.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TINA4_SECRET = "dev-admin-auth-scope-secret-0123456789";
delete process.env.TINA4_API_KEY;
process.chdir(mkdtempSync(join(tmpdir(), "tina4-devauth-")));

const { Router, TestClient, DevAdmin } = await import("../packages/core/src/index.ts");

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

// A request that never settles must fail by name, not end the run silently.
const hung = setTimeout(() => {
  console.log("  \x1b[31mFAIL\x1b[0m a request never settled (30s)");
  process.exit(1);
}, 30_000);

const APPLICATION_PATHS = ["/__developer/secret", "/__devices", "/__dev/mine"];
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

console.log("=== Dev dashboard auth scope ===\n");

for (const debug of ["false", "true"]) {
  process.env.TINA4_DEBUG = debug;
  const router = new Router();
  if (debug === "true") DevAdmin.register(router);
  for (const path of APPLICATION_PATHS) {
    router.post(path, async (_req: any, res: any) => res.json({ ran: true }));
  }
  const client = new TestClient(router);
  for (const path of APPLICATION_PATHS) {
    const response = await client.post(path);
    assert(`debug=${debug}: an application write route at ${path} needs a token`,
      response.status === 401 && !response.text().includes('"ran"'), `got ${response.status} ${response.text()}`);
  }
}

process.env.TINA4_DEBUG = "true";
process.env.TINA4_MCP = "true";
const dashboard = new Router();
DevAdmin.register(dashboard);
const writes = dashboard.getRoutes().filter((route) => WRITE_METHODS.has(route.method) && route.pattern.startsWith("/__dev"));
const gated = writes.filter((route) => route.secure === true && route.noAuth !== true).map((route) => `${route.method} ${route.pattern}`);
assert("DevAdmin registered its write routes", writes.length > 20, `only ${writes.length}`);
assert("every dashboard write route skips the auth gate", gated.length === 0, `gated: ${gated.join(", ")}`);
assert("the dashboard's MCP endpoint is among them", writes.some((route) => route.pattern === "/__dev/mcp"));

const cleared = await new TestClient(dashboard).post("/__dev/api/messages/clear", { json: {} });
assert("a dashboard write route answers without a token", cleared.status === 200, `got ${cleared.status}`);

clearTimeout(hung);
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

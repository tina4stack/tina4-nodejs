/**
 * Tests for Server cross-framework parity: handle(), start(), stop().
 *
 * The framework refuses to boot without the tina4 Rust CLI unless
 * TINA4_OVERRIDE_CLIENT is set. Tests bypass that guard so start() can run.
 */
process.env.TINA4_OVERRIDE_CLIENT = "true";
import assert from "node:assert";
import { handle, start, stop, startServer } from "../packages/core/src/server.js";

async function testStartAndStop() {
  // start() should return a server handle
  const srv = await start({ port: 17148 });
  assert.ok(srv, "start() should return a server handle");
  assert.ok(typeof srv.close === "function", "handle should have close()");
  assert.ok(typeof srv.port === "number", "handle should have port");

  // stop() should close the server
  stop();
  console.log("  + start() and stop() work correctly");
}

async function testHandleExists() {
  assert.ok(typeof handle === "function", "handle should be exported as a function");
  console.log("  + handle() is exported");
}

async function testStopWithoutStart() {
  // stop() when no server is running should not throw
  stop();
  console.log("  + stop() without start() does not throw");
}

async function main() {
  console.log("Server Parity Tests");

  let passed = 0;
  let failed = 0;
  const tests = [testHandleExists, testStopWithoutStart, testStartAndStop];
  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (err) {
      console.error(`  \x1b[31m✗\x1b[0m ${t.name} threw: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

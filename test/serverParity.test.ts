/**
 * Tests for Server cross-framework parity: handle(), start(), stop().
 */
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

  await testHandleExists();
  await testStopWithoutStart();
  await testStartAndStop();

  console.log("All server parity tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

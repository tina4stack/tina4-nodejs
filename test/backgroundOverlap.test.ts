/**
 * Parity regression for tina4-python#94: background() must never overlap a task
 * with itself.
 *
 * Node's twin of the reported Python bug (found by cross-check, not reported):
 * `setInterval` fires on a fixed schedule and does NOT await an async callback,
 * so a run slower than the interval had a second copy start alongside it. That is
 * silent double-execution of a slow sweep - in the reporter's Python app the
 * equivalent double-sent every queued customer email.
 *
 * Real timers, real async callbacks, no mocks - the callback IS the unit under
 * test, not a stand-in for a collaborator.
 *
 * Run with: npx tsx test/backgroundOverlap.test.ts
 */
import assert from "node:assert";
import { background, stopAllBackgroundTasks, backgroundTaskCount } from "../packages/core/src/background.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${(e as Error).message}`);
    failed++;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("backgroundOverlap (python#94 parity, real timers)");

await test("a slow async task never runs concurrently with itself", async () => {
  let inFlight = 0;
  let peak = 0;
  let runs = 0;

  // 250ms of work on a 20ms interval: setInterval would stack ~12 copies.
  const handle = background(async () => {
    inFlight++; runs++;
    peak = Math.max(peak, inFlight);
    await sleep(250);
    inFlight--;
  }, 0.02);

  await sleep(1200);
  handle.stop();

  assert.ok(runs >= 2, `the task must have ticked more than once (got ${runs})`);
  assert.strictEqual(peak, 1, `background() must never overlap a task with itself (peak was ${peak})`);
});

await test("a fast task still runs every interval", async () => {
  let runs = 0;
  const handle = background(async () => { runs++; }, 0.02);
  await sleep(300);
  handle.stop();
  assert.ok(runs >= 3, `a fast task must keep ticking (got ${runs})`);
});

await test("a throwing callback does not kill the loop", async () => {
  let runs = 0;
  const handle = background(async () => { runs++; throw new Error("intentional"); }, 0.02);
  await sleep(300);
  handle.stop();
  assert.ok(runs >= 2, `the loop must survive a callback error (got ${runs})`);
});

await test("stop() during an in-flight run does not re-arm", async () => {
  let runs = 0;
  const handle = background(async () => { runs++; await sleep(200); }, 0.02);
  await sleep(60);          // let one run start
  handle.stop();            // stop WHILE it is in flight
  const atStop = runs;
  await sleep(400);         // long enough for a re-arm to fire if it were going to
  assert.strictEqual(runs, atStop, "a task stopped mid-run must not schedule another");
  assert.strictEqual(backgroundTaskCount(), 0, "stop() must deregister the task");
});

await test("stopAllBackgroundTasks() also stops an in-flight task", async () => {
  let runs = 0;
  background(async () => { runs++; await sleep(200); }, 0.02);
  await sleep(60);
  stopAllBackgroundTasks();
  const atStop = runs;
  await sleep(400);
  assert.strictEqual(runs, atStop, "stopAll must not leave an in-flight task re-arming");
  assert.strictEqual(backgroundTaskCount(), 0);
});

stopAllBackgroundTasks();
console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

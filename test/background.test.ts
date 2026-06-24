/**
 * Unit tests for the background() periodic-task helper.
 * Run with: npx tsx test/background.test.ts
 */
import {
  background,
  stopAllBackgroundTasks,
  backgroundTaskCount,
} from "../packages/core/src/background.ts";

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("=== background() Tests ===\n");

// --- Core behaviour (was: typeof export probes) ---
console.log("--- Core Behaviour ---");

// Reset before any test
stopAllBackgroundTasks();

// background() actually schedules and fires a real periodic callback, and the
// returned handle's stop() halts it. (Was: "background is a function".)
{
  let fired = 0;
  const handle = background(() => { fired++; }, 0.05); // 50ms
  await sleep(180);
  handle.stop();
  const afterStop = fired;
  assert("background() schedules a real recurring callback", afterStop >= 2, `(fired=${afterStop})`);
  // returned handle.stop must really exist and have halted the timer
  await sleep(120);
  assert("handle.stop() halts the recurring callback", fired === afterStop, `(now=${fired}, afterStop=${afterStop})`);
}

// backgroundTaskCount() returns the real live registry size: 0 when empty,
// climbing by one per registration. (Was: "backgroundTaskCount is a function".)
{
  assert("backgroundTaskCount() reports 0 when registry empty", backgroundTaskCount() === 0);
  const a = background(() => {}, 0.5);
  assert("backgroundTaskCount() reports 1 after one register", backgroundTaskCount() === 1);
  const b = background(() => {}, 0.5);
  assert("backgroundTaskCount() reports 2 after two registers", backgroundTaskCount() === 2);
  a.stop();
  b.stop();
  assert("backgroundTaskCount() back to 0 after both stop", backgroundTaskCount() === 0);
}

// stopAllBackgroundTasks() really clears the whole registry, not just one task.
// (Was: "stopAllBackgroundTasks is a function".)
{
  background(() => {}, 0.5);
  background(() => {}, 0.5);
  assert("two tasks registered before clear-all", backgroundTaskCount() === 2);
  stopAllBackgroundTasks();
  assert("stopAllBackgroundTasks() clears every registered task", backgroundTaskCount() === 0);
}

// --- Periodic invocation ---
console.log("\n--- Periodic Invocation ---");
{
  let count = 0;
  const handle = background(() => { count++; }, 0.05); // 50ms
  assert("background() returns object with stop()", typeof handle.stop === "function");
  assert("task count is 1 after register", backgroundTaskCount() === 1);

  await sleep(180);
  handle.stop();
  const observed = count;
  assert("callback fired multiple times", observed >= 2, `(observed=${observed})`);
  assert("stop() removes the task", backgroundTaskCount() === 0);

  // Confirm stop() actually stops further invocations
  const before = observed;
  await sleep(120);
  assert("no further invocations after stop()", count === before, `(after=${count}, before=${before})`);
}

// --- Async callback ---
console.log("\n--- Async Callback ---");
{
  let count = 0;
  const h = background(async () => {
    await sleep(5);
    count++;
  }, 0.04);
  await sleep(150);
  h.stop();
  assert("async callback runs at least once", count >= 1, `(count=${count})`);
}

// --- Default interval ---
console.log("\n--- Default Interval ---");
{
  // Default should be 1 second — we just confirm it accepts no second arg without throwing.
  const h = background(() => {});
  assert("registers without explicit interval", backgroundTaskCount() === 1);
  h.stop();
  assert("removed after stop()", backgroundTaskCount() === 0);
}

// --- Validation ---
console.log("\n--- Validation ---");
{
  let threw = false;
  try { background(null as any, 1); } catch { threw = true; }
  assert("rejects non-function callback", threw);
}
{
  let threw = false;
  try { background(() => {}, 0); } catch { threw = true; }
  assert("rejects zero interval", threw);
}
{
  let threw = false;
  try { background(() => {}, -1); } catch { threw = true; }
  assert("rejects negative interval", threw);
}
{
  let threw = false;
  try { background(() => {}, NaN); } catch { threw = true; }
  assert("rejects NaN interval", threw);
}

// --- stopAllBackgroundTasks clears everything ---
console.log("\n--- stopAllBackgroundTasks ---");
{
  background(() => {}, 0.5);
  background(() => {}, 0.5);
  background(() => {}, 0.5);
  assert("three tasks registered", backgroundTaskCount() === 3);
  stopAllBackgroundTasks();
  assert("all cleared by stopAllBackgroundTasks", backgroundTaskCount() === 0);
}

// --- Errors in callback do not blow up the timer ---
console.log("\n--- Error Resilience ---");
{
  let goodCalls = 0;
  const bad = background(() => { throw new Error("boom"); }, 0.04);
  const good = background(() => { goodCalls++; }, 0.04);
  await sleep(150);
  bad.stop();
  good.stop();
  assert("good task still ran despite throwing sibling", goodCalls >= 1, `(goodCalls=${goodCalls})`);
}

// --- Async rejection swallowed ---
console.log("\n--- Async Rejection ---");
{
  let after = 0;
  const h = background(async () => { throw new Error("rejected"); }, 0.04);
  await sleep(120);
  h.stop();
  // Schedule a follow-up tick to ensure the runtime still works
  const h2 = background(() => { after++; }, 0.04);
  await sleep(120);
  h2.stop();
  assert("subsequent task still runs after async rejection", after >= 1, `(after=${after})`);
}

// Reset for clean exit
stopAllBackgroundTasks();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Shared contract suite for feature 47 — background tasks.
 *
 * Fixture: tina4-documentation/plan/v3/fixtures/backgroundtasks_contract.json
 * Decisions: BG-DEC-01 (run under the production runtime, not just the dev loop)
 * + BG-DEC-02 (ONE surface: a stop-handle + a count).
 *
 * NO MOCKS. Every case exercises the REAL runtime with a REAL side effect: the
 * real event-loop timer (Node's background runtime) appends to a REAL temp file
 * on the real filesystem, and the real handle's stop() is called. Node's timer
 * runs in the same single event loop that serves HTTP, so a task is never a
 * silent no-op — the event loop IS the production runtime.
 *
 * Run with: npx tsx test/backgroundContract.test.ts
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  background,
  backgroundTaskCount,
  stopAllBackgroundTasks,
} from "../packages/core/src/background.ts";

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ticksIn(file: string): number {
  return existsSync(file) ? readFileSync(file).length : 0;
}

async function waitForTicks(file: string, target: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ticksIn(file) >= target) break;
    await sleep(20);
  }
  return ticksIn(file);
}

console.log("=== Background Tasks Contract (feature 47) ===\n");

const dir = mkdtempSync(join(tmpdir(), "tina4_bgtask_"));

try {
  // --- runs under the production runtime -----------------------------------
  stopAllBackgroundTasks();
  {
    const counter = join(dir, "prod.txt");
    const handle = background(() => appendFileSync(counter, "x"), 0.05);
    const ticks = await waitForTicks(counter, 2);
    handle.stop();
    assert(
      "a scheduled task runs under the production runtime",
      ticks >= 2,
      `(ticks=${ticks})`,
    );
  }

  // The event-loop timer fires with NO server booted -> never a silent no-op.
  stopAllBackgroundTasks();
  {
    const counter = join(dir, "guard.txt");
    const handle = background(() => appendFileSync(counter, "x"), 0.05);
    const liveImmediately = backgroundTaskCount() === 1;
    const ticks = await waitForTicks(counter, 1);
    handle.stop();
    assert(
      "a non persistent runtime is guarded not a silent drop",
      liveImmediately && ticks >= 1,
      `(live=${liveImmediately}, ticks=${ticks})`,
    );
  }

  // --- count surface -------------------------------------------------------
  stopAllBackgroundTasks();
  {
    assert("count reflects pending and running tasks (starts 0)", backgroundTaskCount() === 0);
    const first = background(() => {}, 5);
    const oneAfterFirst = backgroundTaskCount() === 1;
    const second = background(() => {}, 5);
    const twoAfterSecond = backgroundTaskCount() === 2;
    first.stop();
    second.stop();
    assert(
      "count reflects pending and running tasks",
      oneAfterFirst && twoAfterSecond,
      `(after1=${oneAfterFirst}, after2=${twoAfterSecond})`,
    );
  }

  stopAllBackgroundTasks();
  {
    const handle = background(() => {}, 5);
    const one = backgroundTaskCount() === 1;
    handle.stop();
    assert(
      "count returns to zero when a task is stopped",
      one && backgroundTaskCount() === 0,
    );
  }

  // --- stop handle ---------------------------------------------------------
  stopAllBackgroundTasks();
  {
    const counter = join(dir, "stop.txt");
    const handle = background(() => appendFileSync(counter, "x"), 0.05);
    const before = await waitForTicks(counter, 2);
    const removed = handle.stop(); // cancels a live, running task, returns true
    await sleep(200);
    const after = ticksIn(counter);
    assert(
      "the stop handle cancels a running task",
      before >= 2 && removed === true && after === before,
      `(before=${before}, removed=${removed}, after=${after})`,
    );
  }

  stopAllBackgroundTasks();
  {
    const handle = background(() => {}, 5);
    const firstStop = handle.stop();
    const secondStop = handle.stop();
    const thirdStop = handle.stop();
    assert(
      "a second stop is a safe no op",
      firstStop === true && secondStop === false && thirdStop === false && backgroundTaskCount() === 0,
      `(first=${firstStop}, second=${secondStop}, third=${thirdStop})`,
    );
  }
} finally {
  stopAllBackgroundTasks();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

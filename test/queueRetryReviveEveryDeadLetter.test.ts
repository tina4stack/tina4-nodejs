/**
 * Regression: Queue.retry() with no args must revive EVERY dead letter.
 *
 * PY-12-04 (3.13.105) ported to Node as a lock-in. Python's fix materialised
 * the retry_job() calls before reducing so `any(...)` could not short-circuit
 * after the first truthy result. Node uses a `for...of` loop that already
 * iterates every dead letter -- but the invariant is worth pinning so a
 * future refactor to `.some(j => backend.retry(...))` (which WOULD
 * short-circuit) cannot regress silently.
 *
 * The invariant: with N dead letters, retry() moves ALL N to pending.
 * Named positive AND negative cases; proven a real gate by mutation
 * (replace the loop with .some() -- both tests fail).
 *
 * NOT a mock: a real file-backed queue on disk, real dead-letter files,
 * real pop/fail lifecycle.
 *
 * Run with: npx tsx test/queueRetryReviveEveryDeadLetter.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "../packages/core/src/index.ts";

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

function makeThreeDeadLetters(base: string): Queue {
  process.env.TINA4_QUEUE_PATH = base;
  const q = new Queue({ topic: "revive_all", path: base, maxRetries: 1 });
  for (let i = 0; i < 3; i++) {
    q.push({ task: `doomed-${i}` });
  }
  // Dead-letter each -- attempts=1 == maxRetries=1 -> dead.
  for (let i = 0; i < 3; i++) {
    const job = q.pop();
    if (!job) throw new Error("prime failed: pop returned null");
    job.fail("boom");
  }
  const dead = q.deadLetters();
  if (dead.length !== 3) {
    throw new Error(`prime failed: expected 3 dead letters, got ${dead.length}`);
  }
  return q;
}

console.log("=== Queue.retry() revives every dead letter ===\n");

const sandbox = mkdtempSync(join(tmpdir(), "tina4-retry-all-"));

// ── Positive: no-arg retry revives all three ────────────────────────
{
  const q = makeThreeDeadLetters(join(sandbox, "positive"));
  const ok = q.retry();
  assert(
    "retry() returns true when at least one DL revived",
    ok === true,
    `returned ${ok}`,
  );
  const pending = q.size("pending");
  assert(
    "retry() moves ALL three dead letters to pending",
    pending === 3,
    `got size(pending)=${pending}; a short-circuit .some() would leave 2 behind`,
  );
}

// ── Negative: dead-letter store is empty after retry() ──────────────
{
  const q = makeThreeDeadLetters(join(sandbox, "negative"));
  q.retry();
  const remaining = q.deadLetters();
  assert(
    "no dead letter remains after retry() revives all three",
    remaining.length === 0,
    `dead_letters().length=${remaining.length} -- stale entries re-appear ` +
      `on the next call and a consumer processes each twice`,
  );
}

try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
delete process.env.TINA4_QUEUE_PATH;

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Regression: job.retry() on a dead-lettered job must remove the
 * dead-letter file, not leave a duplicate on disk.
 *
 * PY-12-05 (3.13.105) ported to Node. Before the fix,
 * LiteBackend.retryJob(queue, job, ...) (the path job.retry() routes to
 * via Queue._retryJob) requeued to the pending directory but never
 * unlinked the file in _failed_dir(). So a manual dead-letter recovery
 * loop -- `for (const j of q.deadLetters()) j.retry();` -- left the
 * dead-letter store carrying every "revived" job. The next deadLetters()
 * call returned them again and a consumer acting on both lists processed
 * each job twice.
 *
 * Contrast: Queue.retry(jobId) routes through LiteBackend.retry(queue,
 * jobId, ...) (a different method) which DID unlink correctly. Two
 * spellings of the same intent that diverged -- the fix aligns them.
 *
 * NOT a mock: a real file-backed queue on disk.
 *
 * Run with: npx tsx test/queueJobRetryRemovesDeadLetter.test.ts
 */
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
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

function makeTwoDeadLetters(base: string): Queue {
  process.env.TINA4_QUEUE_PATH = base;
  const q = new Queue({ topic: "job_retry_clean", path: base, maxRetries: 1 });
  for (let i = 0; i < 2; i++) {
    q.push({ task: `doomed-${i}` });
  }
  for (let i = 0; i < 2; i++) {
    const job = q.pop();
    if (!job) throw new Error("prime failed: pop returned null");
    job.fail("boom");
  }
  const dead = q.deadLetters();
  if (dead.length !== 2) {
    throw new Error(`prime failed: expected 2 dead letters, got ${dead.length}`);
  }
  return q;
}

console.log("=== job.retry() removes the dead-letter file ===\n");

const sandbox = mkdtempSync(join(tmpdir(), "tina4-job-retry-clean-"));

// ── Positive: dead-letter store is empty after per-job retry loop ────
{
  const base = join(sandbox, "positive");
  const q = makeTwoDeadLetters(base);
  for (const j of q.deadLetters()) {
    j.retry();
  }
  const remaining = q.deadLetters();
  assert(
    "dead-letter store empty after loop of j.retry()",
    remaining.length === 0,
    `deadLetters().length=${remaining.length} -- a leftover file re-appears ` +
      `on the next dead_letters() call and the job runs twice`,
  );
  // Second observation from the failed/ directory itself -- deadLetters()
  // filters by attempts>=maxRetries, so a stale file with attempts+=1 might
  // slip past the filter yet still exist on disk (parity with Python that
  // checks the directory count too).
  const failedDir = join(base, "job_retry_clean", "failed");
  const filesLeft = readdirSync(failedDir).filter((f) => f.endsWith(".queue-data")).length;
  assert(
    "failed/ directory has no leftover .queue-data files",
    filesLeft === 0,
    `${filesLeft} file(s) remain in ${failedDir}`,
  );
}

// ── Negative: revived jobs still end up in pending ───────────────────
{
  const base = join(sandbox, "negative");
  const q = makeTwoDeadLetters(base);
  for (const j of q.deadLetters()) {
    j.retry();
  }
  const pending = q.size("pending");
  assert(
    "both revived jobs land in pending",
    pending === 2,
    `size(pending)=${pending}; the unlink must not accidentally drop the requeue`,
  );
}

try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
delete process.env.TINA4_QUEUE_PATH;

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);

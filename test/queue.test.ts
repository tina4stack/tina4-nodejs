/**
 * Unit tests for the Queue module (Phase 5).
 * Run with: npx tsx test/queue.test.ts
 */
import { Queue } from "../packages/core/src/index.ts";
import type { QueueJob } from "../packages/core/src/index.ts";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as net from "node:net";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

// Skip a real-service test when the provisioned service/driver is unavailable.
// The reason names the service + "not reachable"/"not installed" so the #252
// service gate (test/_serviceGate.ts) can treat an unavailable provisioned
// service as a hard FAILURE under TINA4_REQUIRE_SERVICES.
function skip(name: string, reason: string) {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} (${reason})`);
  skipped++;
}

const TEST_PATH = join("/tmp", "tina4-queue-test-" + Date.now());

function cleanup() {
  try {
    rmSync(TEST_PATH, { recursive: true, force: true });
  } catch {}
}

// Clean up before tests
cleanup();

console.log("=== Queue Tests ===\n");

// --- Push and Pop ---
console.log("--- Push and Pop ---");

const qEmails = new Queue({ topic: "emails", path: TEST_PATH });

const jobId1 = qEmails.push({ to: "alice@test.com", subject: "Hello" });
assert("push returns a job ID (string)", typeof jobId1 === "string" && jobId1.length > 0);

const jobId2 = qEmails.push({ to: "bob@test.com", subject: "Hi" });
assert("push returns unique IDs", jobId1 !== jobId2);

const job1 = qEmails.pop();
assert("pop returns a job", job1 !== null);
assert("popped job has correct payload", job1 !== null && (job1.payload as any).to === "alice@test.com");
assert("popped job has correct status", job1 !== null && job1.status === "reserved");
assert("popped job has id", job1 !== null && typeof job1.id === "string");
assert("popped job has createdAt", job1 !== null && typeof job1.createdAt === "string");

const job2 = qEmails.pop();
assert("second pop returns second job", job2 !== null && (job2.payload as any).to === "bob@test.com");

const job3 = qEmails.pop();
assert("pop on empty queue returns null", job3 === null);

// --- Size ---
console.log("\n--- Size ---");

const qTasks = new Queue({ topic: "tasks", path: TEST_PATH });
qTasks.push({ action: "a" });
qTasks.push({ action: "b" });
qTasks.push({ action: "c" });

assert("size returns 3 after 3 pushes", qTasks.size() === 3);

qTasks.pop();
assert("size returns 2 after 1 pop", qTasks.size() === 2);

// --- Clear ---
console.log("\n--- Clear ---");

qTasks.clear();
assert("size is 0 after clear", qTasks.size() === 0);

const afterClear = qTasks.pop();
assert("pop returns null after clear", afterClear === null);

// --- Failed Jobs (still-retrying) ---
console.log("\n--- Failed Jobs ---");

// Under the auto-retry lifecycle, a failed-but-retryable job (0 < attempts <
// maxRetries) stays in the PENDING queue and is surfaced by failed(). With
// maxRetries=3, one fail() leaves attempts=1 → still retrying.
const qWork = new Queue({ topic: "work", path: TEST_PATH, maxRetries: 3 });
qWork.push({ item: 1 });
qWork.push({ item: 2 });

// Fail each job exactly once (attempts=1 < 3 → re-enqueued, not dead-lettered).
const w1 = qWork.pop();
w1?.fail("intentional failure");
const w2 = qWork.pop();
w2?.fail("intentional failure");

const failedJobs = qWork.failed();
assert("failed returns still-retrying jobs", failedJobs.length === 2);
assert("failed job has error message", failedJobs[0].error === "intentional failure");
assert("failed-but-retrying job has attempts === 1", failedJobs[0].attempts === 1);
assert("failed-but-retrying job is not dead-lettered", qWork.deadLetters().length === 0);

// --- Retry (instance-scoped dead letter retry) ---
console.log("\n--- Retry ---");

// Simulate jobs becoming dead letters by pushing and failing them maxRetries times
const qDead = new Queue({ topic: "dead-work", path: TEST_PATH, maxRetries: 1 });
qDead.push({ item: "dead-a" });
qDead.push({ item: "dead-b" });

// Process once to fail them — with maxRetries=1, one failure makes them dead letters
qDead.process((job: QueueJob) => {
  throw new Error("intentional failure");
}, { maxRetries: 1 });

const deadBeforeRetry = qDead.deadLetters();
assert("dead letters exist before retry", deadBeforeRetry.length === 2);

const retried = qDead.retry();
assert("retry() returns true when dead letters exist", retried === true);

const retriedJob = qDead.pop();
assert("retried job can be popped", retriedJob !== null);

const noRetry = qDead.retry();
assert("retry() returns false when no dead letters", noRetry === false);

// --- Ordering (FIFO) ---
console.log("\n--- FIFO Ordering ---");

const qOrdered = new Queue({ topic: "ordered", path: TEST_PATH });
qOrdered.push({ seq: 1 });
qOrdered.push({ seq: 2 });
qOrdered.push({ seq: 3 });

const o1 = qOrdered.pop();
const o2 = qOrdered.pop();
const o3 = qOrdered.pop();
assert("FIFO: first push is first pop", o1 !== null && (o1.payload as any).seq === 1);
assert("FIFO: second push is second pop", o2 !== null && (o2.payload as any).seq === 2);
assert("FIFO: third push is third pop", o3 !== null && (o3.payload as any).seq === 3);

// --- Priority Ordering ---
console.log("\n--- Priority Ordering ---");

{
  // (a) Higher-priority job pops before an OLDER lower-priority job.
  const qp = new Queue({ topic: "prio", path: TEST_PATH });
  qp.push({ t: "old_low" }, 0, 1);   // pushed first, priority 1
  qp.push({ t: "mid" }, 0, 5);       // priority 5
  qp.push({ t: "new_high" }, 0, 10); // pushed last, priority 10

  const p1 = qp.pop();
  const p2 = qp.pop();
  const p3 = qp.pop();
  assert("priority: highest pops first despite being newest", p1 !== null && (p1.payload as any).t === "new_high");
  assert("priority: mid pops second", p2 !== null && (p2.payload as any).t === "mid");
  assert("priority: oldest-lowest pops last", p3 !== null && (p3.payload as any).t === "old_low");
}

{
  // Ties broken oldest-first by createdAt (same priority → insertion order).
  const qt = new Queue({ topic: "prio_tie", path: TEST_PATH });
  qt.push({ n: 1 }, 0, 5);
  qt.push({ n: 2 }, 0, 5);
  qt.push({ n: 3 }, 0, 5);
  const t1 = qt.pop(), t2 = qt.pop(), t3 = qt.pop();
  assert("priority tie broken oldest-first",
    (t1?.payload as any).n === 1 && (t2?.payload as any).n === 2 && (t3?.payload as any).n === 3);
}

{
  // popBatch is priority-ordered too.
  const qb = new Queue({ topic: "prio_batch", path: TEST_PATH });
  qb.push({ t: "low" }, 0, 0);
  qb.push({ t: "high" }, 0, 10);
  qb.push({ t: "mid" }, 0, 5);
  const jobs = qb.popBatch(3);
  assert("popBatch orders by priority DESC",
    jobs.map(j => (j.payload as any).t).join(",") === "high,mid,low");
}

{
  // A delayed high-priority job must NOT jump ahead while still delayed;
  // an available lower-priority job pops first.
  const qd = new Queue({ topic: "prio_delay", path: TEST_PATH });
  qd.push({ t: "delayed_high" }, 3600, 100); // delayed 1h, priority 100
  qd.push({ t: "available_low" }, 0, 0);
  const job = qd.pop();
  assert("delayed high-priority job is skipped while delayed", job !== null && (job.payload as any).t === "available_low");
  assert("delayed job not yet available", qd.pop() === null);
}

// --- Auto Retry → Dead Letter (no manual retryFailed) ---
console.log("\n--- Auto Retry to Dead Letter ---");

{
  // (b) A job that fails on EVERY attempt is retried exactly maxRetries times
  // via a for-await consume() loop with job.fail() — then lands in deadLetters().
  // No manual retryFailed() call.
  const qr = new Queue({ topic: "auto_dl", path: TEST_PATH, maxRetries: 3 });
  qr.push({ task: "always_fails" });

  let executions = 0;
  // pollInterval=0 → single-pass drain that also re-drains re-enqueued jobs,
  // so the whole retry sequence runs in one for-await loop.
  for await (const j of qr.consume("auto_dl", undefined, 0)) {
    executions++;
    (j as QueueJob).fail(`boom ${executions}`);
  }

  assert("persistent failure executed exactly maxRetries (3) times", executions === 3);
  assert("nothing left pending after dead-lettering", qr.size("pending") === 0);
  const dead = qr.deadLetters();
  assert("failing job ends in deadLetters", dead.length === 1);
  assert("dead job carries attempts === maxRetries", dead[0].attempts === 3);
  assert("dead job carries last error", dead[0].error === "boom 3");
  assert("dead job payload preserved", (dead[0].payload as any).task === "always_fails");
}

{
  // (c) Success on the 2nd attempt is NOT dead-lettered.
  const qf = new Queue({ topic: "flaky", path: TEST_PATH, maxRetries: 3 });
  qf.push({ task: "flaky" });

  let executions = 0;
  for await (const j of qf.consume("flaky", undefined, 0)) {
    executions++;
    if (executions === 1) {
      (j as QueueJob).fail("transient error"); // re-enqueued
    } else {
      (j as QueueJob).complete();               // succeeds on 2nd attempt
      break;
    }
  }

  assert("flaky job executed twice", executions === 2);
  assert("flaky job not left pending", qf.size("pending") === 0);
  assert("flaky job not dead-lettered", qf.deadLetters().length === 0);
}

{
  // (d) attempts increments EXACTLY ONCE per fail() (double-increment fix).
  const qi = new Queue({ topic: "increment", path: TEST_PATH, maxRetries: 10 });
  qi.push({ task: "count" });

  const j1 = qi.pop();
  assert("fresh job starts at attempts === 0", j1 !== null && j1.attempts === 0);
  j1?.fail("first");
  const j2 = qi.pop();
  assert("after one fail attempts === 1 (single increment)", j2 !== null && j2.attempts === 1);
  j2?.fail("second");
  const j3 = qi.pop();
  assert("after two fails attempts === 2 (single increment each)", j3 !== null && j3.attempts === 2);
  assert("re-enqueued job carries prior error", j3 !== null && j3.error === "second");
  qi.clear();
}

{
  // maxRetries=2: fails twice then dead-lettered, attempts increments once each.
  const qm = new Queue({ topic: "two_retries", path: TEST_PATH, maxRetries: 2 });
  qm.push({ task: "doomed" });

  const m1 = qm.pop();
  m1?.fail("attempt 1");                 // attempts=1 < 2 → re-enqueued
  assert("maxRetries=2: still pending after 1st fail", qm.size("pending") === 1);
  assert("maxRetries=2: not dead after 1st fail", qm.deadLetters().length === 0);

  const m2 = qm.pop();
  assert("maxRetries=2: 2nd pop carries attempts === 1", m2 !== null && m2.attempts === 1);
  m2?.fail("attempt 2");                 // attempts=2 >= 2 → dead-lettered
  assert("maxRetries=2: nothing pending after 2nd fail", qm.size("pending") === 0);
  const deadM = qm.deadLetters();
  assert("maxRetries=2: dead-lettered after 2nd fail", deadM.length === 1 && deadM[0].attempts === 2);
}

{
  // reject() is an alias for fail() — same retry→dead-letter path.
  const qj = new Queue({ topic: "reject_alias", path: TEST_PATH, maxRetries: 1 });
  qj.push({ task: "bad" });
  const rj = qj.pop();
  rj?.reject("invalid");                 // attempts=1 >= 1 → dead-lettered
  const deadJ = qj.deadLetters();
  assert("reject() dead-letters like fail()", deadJ.length === 1 && deadJ[0].error === "invalid");
}

{
  // retryBackoff delays the automatic re-enqueue: an immediate pop sees nothing.
  const qbk = new Queue({ topic: "backoff", path: TEST_PATH, maxRetries: 3, retryBackoff: 3600 });
  qbk.push({ task: "slow_retry" });
  const bj = qbk.pop();
  bj?.fail("needs backoff");
  // Re-enqueued (still pending) but delayed → not yet poppable.
  assert("retryBackoff: job re-enqueued to pending", qbk.size("pending") === 1);
  assert("retryBackoff: job not immediately poppable", qbk.pop() === null);
}

{
  // job.retry() always re-queues (manual override) and increments attempts once.
  const qov = new Queue({ topic: "manual_retry", path: TEST_PATH, maxRetries: 1 });
  qov.push({ task: "again" });
  const ov = qov.pop();
  ov?.retry();
  assert("job.retry() re-queues to pending", qov.size("pending") === 1);
  const ov2 = qov.pop();
  assert("job.retry() increments attempts once", ov2 !== null && ov2.attempts === 1);
}

// --- Delayed Jobs ---
console.log("\n--- Delayed Jobs ---");

const qDelayed = new Queue({ topic: "delayed", path: TEST_PATH });
qDelayed.push({ action: "later" }, 3600); // 1 hour delay

const delayedJob = qDelayed.pop();
assert("delayed job is not popped before delay expires", delayedJob === null);
assert("delayed queue still has size 1", qDelayed.size() === 1);

// --- Separate Queues ---
console.log("\n--- Separate Queues ---");

const qAlpha = new Queue({ topic: "alpha", path: TEST_PATH });
const qBeta = new Queue({ topic: "beta", path: TEST_PATH });
qAlpha.push({ type: "a" });
qBeta.push({ type: "b" });

assert("separate queues have independent size", qAlpha.size() === 1 && qBeta.size() === 1);

const alphaJob = qAlpha.pop();
assert("pop from alpha returns alpha job", alphaJob !== null && (alphaJob.payload as any).type === "a");
assert("beta queue unaffected by alpha pop", qBeta.size() === 1);

// Clean up
cleanup();

// --- Topic-based API (unified constructor) ---
console.log("\n--- Topic-based API ---");

const TEST_PATH_TOPIC = join("/tmp", "tina4-queue-topic-test-" + Date.now());
function cleanupTopic() {
  try { rmSync(TEST_PATH_TOPIC, { recursive: true, force: true }); } catch {}
}
cleanupTopic();

{
  const qt = new Queue({ topic: "tasks", path: TEST_PATH_TOPIC });

  // Push using topic-based API (payload only, no queue name)
  const tid1 = qt.push({ action: "send_email" });
  assert("topic push returns job ID", typeof tid1 === "string" && tid1.length > 0);

  const tid2 = qt.push({ action: "process" });
  assert("topic push returns unique IDs", tid1 !== tid2);

  assert("topic size returns 2", qt.size() === 2);

  const tjob1 = qt.pop();
  assert("topic pop returns a job", tjob1 !== null);
  assert("topic popped job has correct payload", tjob1 !== null && (tjob1.payload as any).action === "send_email");

  const tjob2 = qt.pop();
  assert("topic second pop returns second job", tjob2 !== null && (tjob2.payload as any).action === "process");

  const tjob3 = qt.pop();
  assert("topic pop on empty returns null", tjob3 === null);
}

// --- Topic with size and clear ---
console.log("\n--- Topic Size and Clear ---");

{
  const qt2 = new Queue({ topic: "emails", path: TEST_PATH_TOPIC });
  qt2.push({ to: "alice" });
  qt2.push({ to: "bob" });
  qt2.push({ to: "charlie" });

  assert("topic size returns 3", qt2.size() === 3);

  qt2.clear();
  assert("topic size is 0 after clear", qt2.size() === 0);
}

// --- Topic with process ---
console.log("\n--- Topic Process ---");

{
  const qt3 = new Queue({ topic: "processable", path: TEST_PATH_TOPIC, maxRetries: 3 });
  qt3.push({ n: 1 });
  qt3.push({ n: 2 });

  const processed: number[] = [];
  qt3.process((job: QueueJob) => {
    processed.push((job.payload as any).n);
  });

  assert("topic process handles all jobs", processed.length === 2);
  assert("topic process order is FIFO", processed[0] === 1 && processed[1] === 2);
}

// --- Topic deadLetters and retryFailed ---
console.log("\n--- Topic Dead Letters ---");

{
  const qt4 = new Queue({ topic: "deadtest", path: TEST_PATH_TOPIC, maxRetries: 1 });
  qt4.push({ x: 1 });

  qt4.process((job: QueueJob) => {
    throw new Error("fatal");
  });

  const dead = qt4.deadLetters();
  assert("topic deadLetters returns dead jobs", dead.length === 1);
  assert("topic dead job has status 'dead'", dead[0].status === "dead");
}

{
  // retryFailed() revives dead-letters under a RAISED limit. With maxRetries=1
  // a single fail() dead-letters the job (attempts=1 >= 1); at the original
  // limit nothing is revived, but a raised limit re-queues it to pending.
  const qt5 = new Queue({ topic: "retrytest", path: TEST_PATH_TOPIC, maxRetries: 1 });
  qt5.push({ x: 1 });

  const r5 = qt5.pop();
  r5?.fail("fail");                       // attempts=1 >= 1 → dead-lettered
  assert("topic dead letter before retryFailed", qt5.deadLetters().length === 1);

  assert("topic retryFailed at original limit revives nothing", qt5.retryFailed() === 0);

  const retried = qt5.retryFailed(5);     // raised limit → revive
  assert("topic retryFailed under raised limit returns 1", retried === 1);
  assert("topic size after retryFailed is 1", qt5.size() === 1);
}

// --- Topic purge ---
console.log("\n--- Topic Purge ---");

{
  const qt6 = new Queue({ topic: "purgetest", path: TEST_PATH_TOPIC, maxRetries: 3 });
  qt6.push({ x: 1 });

  qt6.process((job: QueueJob) => {
    throw new Error("fail");
  });

  const purged = qt6.purge("failed");
  assert("topic purge returns 1", purged === 1);
}

// --- getTopic ---
console.log("\n--- getTopic ---");

{
  const qt7 = new Queue({ topic: "my_topic", path: TEST_PATH_TOPIC });
  assert("getTopic returns constructor topic", qt7.getTopic() === "my_topic");
}

// --- Env default ---
console.log("\n--- Env Default ---");

{
  // When TINA4_QUEUE_BACKEND is not set, defaults to 'file'
  delete process.env.TINA4_QUEUE_BACKEND;
  const qt8 = new Queue({ topic: "env_default", path: TEST_PATH_TOPIC });
  qt8.push({ test: true });
  assert("env default uses file backend", qt8.size() === 1);
}

// --- Topic constructor ---
console.log("\n--- Topic Constructor ---");

{
  const ql = new Queue({ topic: "legacy_queue", path: TEST_PATH_TOPIC });
  ql.push({ legacy: true });
  assert("topic push works", ql.size() === 1);
  const lj = ql.pop();
  assert("topic pop works", lj !== null && (lj.payload as any).legacy === true);
}

cleanupTopic();

// --- Payload Types ---
console.log("\n--- Payload Types ---");

const TEST_PATH_TYPES = join("/tmp", "tina4-queue-types-test-" + Date.now());
function cleanupTypes() {
  try { rmSync(TEST_PATH_TYPES, { recursive: true, force: true }); } catch {}
}
cleanupTypes();

{
  const qt = new Queue({ topic: "types", path: TEST_PATH_TYPES });

  // String payload
  qt.push("hello world");
  const strJob = qt.pop();
  assert("string payload preserved", strJob !== null && strJob.payload === "hello world");

  // Number payload
  qt.push(42);
  const numJob = qt.pop();
  assert("number payload preserved", numJob !== null && numJob.payload === 42);

  // Boolean payload
  qt.push(true);
  const boolJob = qt.pop();
  assert("boolean payload preserved", boolJob !== null && boolJob.payload === true);

  // Null payload
  qt.push(null);
  const nullJob = qt.pop();
  assert("null payload preserved", nullJob !== null && nullJob.payload === null);

  // Array payload
  qt.push([1, 2, 3]);
  const arrJob = qt.pop();
  assert("array payload preserved", arrJob !== null && Array.isArray(arrJob.payload) && (arrJob.payload as number[]).length === 3);

  // Nested object payload
  qt.push({ a: { b: { c: "deep" } } });
  const deepJob = qt.pop();
  assert("nested object payload preserved", deepJob !== null && (deepJob.payload as any).a.b.c === "deep");
}

cleanupTypes();

// --- Process with success ---
console.log("\n--- Process Success ---");

const TEST_PATH_PROC = join("/tmp", "tina4-queue-proc-test-" + Date.now());
function cleanupProc() {
  try { rmSync(TEST_PATH_PROC, { recursive: true, force: true }); } catch {}
}
cleanupProc();

{
  const qt = new Queue({ topic: "success_proc", path: TEST_PATH_PROC });
  qt.push({ n: 1 });
  qt.push({ n: 2 });
  qt.push({ n: 3 });

  const results: number[] = [];
  qt.process((job: QueueJob) => {
    results.push((job.payload as any).n);
  });

  assert("process handles all 3 jobs", results.length === 3);
  assert("process in FIFO order", results[0] === 1 && results[1] === 2 && results[2] === 3);
  assert("queue empty after processing", qt.size() === 0);
}

cleanupProc();

// --- Multiple topics isolation ---
console.log("\n--- Multiple Topics Isolation ---");

const TEST_PATH_MULTI = join("/tmp", "tina4-queue-multi-test-" + Date.now());
function cleanupMulti() {
  try { rmSync(TEST_PATH_MULTI, { recursive: true, force: true }); } catch {}
}
cleanupMulti();

{
  const q1 = new Queue({ topic: "topic_a", path: TEST_PATH_MULTI });
  const q2 = new Queue({ topic: "topic_b", path: TEST_PATH_MULTI });

  q1.push({ from: "a" });
  q1.push({ from: "a" });
  q2.push({ from: "b" });

  assert("topic_a has 2 jobs", q1.size() === 2);
  assert("topic_b has 1 job", q2.size() === 1);

  q1.clear();
  assert("clearing topic_a doesn't affect topic_b", q2.size() === 1);
}

cleanupMulti();

// --- Job lifecycle methods ---
console.log("\n--- Job Lifecycle Methods ---");

const TEST_PATH_LC = join("/tmp", "tina4-queue-lc-test-" + Date.now());
function cleanupLC() {
  try { rmSync(TEST_PATH_LC, { recursive: true, force: true }); } catch {}
}
cleanupLC();

{
  // complete() drives the lifecycle effect, not just exposes a method: the job
  // moves to 'completed', leaves pending, and is not re-popped.
  const qc = new Queue({ topic: "lifecycle", path: TEST_PATH_LC });
  qc.push({ task: "test" });

  const job = qc.pop();
  assert("popped job has topic field", job?.topic === "lifecycle");
  assert("pop holds the job as a reservation", qc.size("reserved") === 1);
  if (job) {
    job.complete();
    assert("complete sets status to completed", job.status === "completed");
  }
  // The file backend acks complete() by clearing the reservation (a tombstone,
  // not a counted "completed" bucket): the observable effect is the reservation
  // is gone, nothing is pending, and the job is never re-popped.
  assert("complete() clears the reservation", qc.size("reserved") === 0);
  assert("complete() leaves nothing pending", qc.size("pending") === 0);
  assert("completed job is not re-popped", qc.pop() === null);

  // fail() on a maxRetries>0 queue re-enqueues to pending with attempts++ —
  // exercising fail(), not asserting it exists.
  const qf = new Queue({ topic: "lifecycle_fail", path: TEST_PATH_LC, maxRetries: 3 });
  qf.push({ task: "retryable" });
  qf.pop()?.fail("boom");
  assert("fail() re-enqueues a retryable job to pending", qf.size("pending") === 1);
  const refailed = qf.pop();
  assert("fail() re-enqueued job carries attempts === 1", refailed !== null && refailed.attempts === 1);

  // reject() on a maxRetries:1 queue dead-letters with the given error —
  // exercising reject(), not asserting it exists.
  const qr = new Queue({ topic: "lifecycle_reject", path: TEST_PATH_LC, maxRetries: 1 });
  qr.push({ task: "bad" });
  qr.pop()?.reject("invalid");
  const rejectedDead = qr.deadLetters();
  assert("reject() dead-letters the job", rejectedDead.length === 1);
  assert("reject() preserves the error on the dead letter", rejectedDead.length === 1 && rejectedDead[0].error === "invalid");

  // retry() always re-queues to pending and increments attempts once —
  // exercising retry(), not asserting it exists.
  const qrt = new Queue({ topic: "lifecycle_retry", path: TEST_PATH_LC, maxRetries: 1 });
  qrt.push({ task: "again" });
  qrt.pop()?.retry();
  assert("retry() re-queues the job to pending", qrt.size("pending") === 1);
  const retried = qrt.pop();
  assert("retry() re-queued job carries attempts === 1", retried !== null && retried.attempts === 1);
}

cleanupLC();

// --- getMaxRetries ---
console.log("\n--- getMaxRetries ---");

{
  const qt = new Queue({ topic: "retries_test", path: TEST_PATH_LC, maxRetries: 5 });
  assert("getMaxRetries returns configured value", qt.getMaxRetries() === 5);
}

{
  const qt = new Queue({ topic: "retries_default", path: TEST_PATH_LC });
  assert("getMaxRetries returns default", qt.getMaxRetries() >= 0);
}

// --- popBatch ---
console.log("\n--- popBatch ---");

const TEST_PATH_BATCH = join("/tmp", "tina4-queue-batch-test-" + Date.now());
function cleanupBatch() {
  try { rmSync(TEST_PATH_BATCH, { recursive: true, force: true }); } catch {}
}
cleanupBatch();

{
  // returns up to count jobs as an array
  const q = new Queue({ topic: "batch_test", path: TEST_PATH_BATCH });
  q.push({ n: 1 });
  q.push({ n: 2 });
  q.push({ n: 3 });
  const jobs = q.popBatch(2);
  assert("popBatch returns an array", Array.isArray(jobs));
  assert("popBatch returns up to count jobs", jobs.length === 2);
  q.clear();
}

{
  // returns partial batch when fewer jobs available
  const q = new Queue({ topic: "batch_partial", path: TEST_PATH_BATCH });
  q.push({ n: 1 });
  const jobs = q.popBatch(10);
  assert("popBatch returns partial batch when fewer available", jobs.length === 1);
  q.clear();
}

{
  // returns empty array when queue is empty
  const q = new Queue({ topic: "batch_empty", path: TEST_PATH_BATCH });
  const jobs = q.popBatch(5);
  assert("popBatch returns empty array when queue empty", Array.isArray(jobs) && jobs.length === 0);
}

// --- consume with batchSize ---
console.log("\n--- consume with batchSize ---");

{
  const q = new Queue({ topic: "batch_consume", path: TEST_PATH_BATCH });
  q.clear();
  for (let i = 0; i < 5; i++) q.push({ n: i });

  const batches: QueueJob[][] = [];
  for await (const jobs of q.consume({ batchSize: 2, pollInterval: 0, iterations: 3 })) {
    batches.push(jobs as QueueJob[]);
    for (const job of jobs as QueueJob[]) job.complete();
  }
  const total = batches.reduce((s, b) => s + b.length, 0);
  assert("consume batchSize yields all 5 jobs total", total === 5);
  assert("consume batchSize yields arrays", batches.every(b => Array.isArray(b)));
  q.clear();
}

// --- process with batchSize ---
console.log("\n--- process with batchSize ---");

{
  const q = new Queue({ topic: "batch_process", path: TEST_PATH_BATCH });
  q.clear();
  for (let i = 0; i < 6; i++) q.push({ n: i });
  const received: number[] = [];
  q.process((jobs: QueueJob | QueueJob[]) => {
    const arr = Array.isArray(jobs) ? jobs : [jobs];
    for (const job of arr) {
      received.push((job.payload as any).n);
      job.complete();
    }
  }, { batchSize: 3 });
  assert("process batchSize passes all 6 jobs to handler", received.length === 6);
  q.clear();
}

cleanupBatch();

// --- Queue Isolation Contract ---
// Locks in: a job pushed to one topic never leaks into another (same path),
// and a queue on a FRESH storage path starts empty. Uses its own per-test
// temp dirs so it can't be contaminated by the shared TEST_PATH above.
console.log("\n--- Queue Isolation Contract ---");
{
  const isoPath = join("/tmp", "tina4-queue-iso-" + Date.now());
  try { rmSync(isoPath, { recursive: true, force: true }); } catch {}

  const topicA = new Queue({ topic: "topic_a", path: isoPath });
  const topicB = new Queue({ topic: "topic_b", path: isoPath });

  topicA.push({ to: "a" });
  topicA.push({ to: "a2" });

  // topic_b shares the base path but must see none of topic_a's jobs.
  assert("isolation: topic_b sees zero of topic_a's jobs", topicB.size() === 0);
  assert("isolation: topic_b pop is null", topicB.pop() === null);
  assert("isolation: topic_a retains its 2 jobs", topicA.size() === 2);

  // Draining topic_a leaves topic_b intact.
  topicB.push({ to: "b" });
  topicA.pop();
  topicA.pop();
  assert("isolation: draining topic_a leaves topic_b's job", topicB.size() === 1);

  try { rmSync(isoPath, { recursive: true, force: true }); } catch {}

  // A queue on a DIFFERENT base path starts empty.
  const pathOne = join("/tmp", "tina4-queue-iso-one-" + Date.now());
  const pathTwo = join("/tmp", "tina4-queue-iso-two-" + Date.now());
  try { rmSync(pathOne, { recursive: true, force: true }); } catch {}
  try { rmSync(pathTwo, { recursive: true, force: true }); } catch {}

  const first = new Queue({ topic: "jobs", path: pathOne });
  first.push({ n: 1 });
  first.push({ n: 2 });
  assert("isolation: first path has 2 jobs", first.size() === 2);

  const second = new Queue({ topic: "jobs", path: pathTwo });
  assert("isolation: fresh path starts empty (size 0)", second.size() === 0);
  assert("isolation: fresh path pop is null", second.pop() === null);

  try { rmSync(pathOne, { recursive: true, force: true }); } catch {}
  try { rmSync(pathTwo, { recursive: true, force: true }); } catch {}
}

// --- Visibility timeout / reservation reclaim (file backend) ---
//
// Regression lock for the production bug where a consumer that dies before
// job.complete() left the message stuck forever — never re-delivered, never
// retried, never dead-lettered. A popped job is now reserved for
// visibilityTimeout seconds; if it is not acked in time the next pop()
// reclaims it (incrementing attempts) or dead-letters it past maxRetries.
// Deterministic: tiny visibilityTimeout + a short real sleep.
console.log("\n--- Visibility Timeout / Reservation Reclaim ---");

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

await (async () => {
  // (a) reserve-then-abandon is reclaimed after the timeout, attempts == 1
  {
    const p = join("/tmp", "tina4-vt-reclaim-" + Date.now());
    try { rmSync(p, { recursive: true, force: true }); } catch {}
    const q = new Queue({ topic: "vt", path: p, visibilityTimeout: 0.05 });
    q.push({ job: "import" });
    const job = q.pop();                            // consumer A reserves it
    assert("vt: reserve returns a job", job !== null);
    assert("vt: reserved job has attempts 0", job !== null && job.attempts === 0);
    assert("vt: claimed out of pending", q.size("pending") === 0);
    assert("vt: held as a reservation", q.size("reserved") === 1);

    // Consumer A "dies" — never acks. After the window expires the next pop()
    // reclaims the abandoned reservation.
    await sleep(120);
    const reclaimed = q.pop();
    assert("vt: abandoned reservation reclaimed after timeout", reclaimed !== null);
    assert("vt: reclaimed payload preserved", reclaimed !== null && (reclaimed.payload as any).job === "import");
    assert("vt: reclaim counted as one attempt", reclaimed !== null && reclaimed.attempts === 1);
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }

  // (b) NOT reclaimed before the timeout (second consumer gets nothing)
  {
    const p = join("/tmp", "tina4-vt-notyet-" + Date.now());
    try { rmSync(p, { recursive: true, force: true }); } catch {}
    const q = new Queue({ topic: "vt", path: p, visibilityTimeout: 30 });
    q.push({ job: "import" });
    assert("vt: pop reserves the job", q.pop() !== null);
    assert("vt: reservation still valid -> second pop is null", q.pop() === null);
    assert("vt: still one reservation", q.size("reserved") === 1);
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }

  // (c) reclaim past maxRetries dead-letters instead of re-delivering
  {
    const p = join("/tmp", "tina4-vt-deadletter-" + Date.now());
    try { rmSync(p, { recursive: true, force: true }); } catch {}
    const q = new Queue({ topic: "vt", path: p, maxRetries: 1, visibilityTimeout: 0.05 });
    q.push({ job: "import" });
    assert("vt: reserve (attempts 0)", q.pop() !== null);
    await sleep(120);
    // Reclaim bumps attempts to 1 (>= maxRetries) -> dead-letter, not re-served.
    assert("vt: past-max-retries reclaim does NOT re-deliver", q.pop() === null);
    assert("vt: no reservation left after dead-letter", q.size("reserved") === 0);
    const dead = q.deadLetters();
    assert("vt: dead-lettered exactly one job", dead.length === 1);
    assert("vt: dead-letter payload preserved", dead.length === 1 && (dead[0].payload as any).job === "import");
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }

  // (d) complete() clears the reservation (no phantom reclaim)
  {
    const p = join("/tmp", "tina4-vt-complete-" + Date.now());
    try { rmSync(p, { recursive: true, force: true }); } catch {}
    const q = new Queue({ topic: "vt", path: p, visibilityTimeout: 0.05 });
    q.push({ job: "import" });
    // Consume by single-pass drain so the job carries lifecycle methods bound
    // to the queue (createJob wraps the pop result).
    let acked = false;
    for await (const j of q.consume("vt", undefined, 0)) {
      (j as QueueJob).complete();                    // acked — reservation cleared
      acked = true;
      break;
    }
    assert("vt: complete() ran", acked);
    assert("vt: complete() clears the reservation", q.size("reserved") === 0);
    await sleep(120);
    assert("vt: nothing to reclaim after complete()", q.pop() === null);
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }

  // (d2) fail() clears the reservation and requeues with attempts incremented
  {
    const p = join("/tmp", "tina4-vt-fail-" + Date.now());
    try { rmSync(p, { recursive: true, force: true }); } catch {}
    const q = new Queue({ topic: "vt", path: p, maxRetries: 3, visibilityTimeout: 0.05 });
    q.push({ job: "import" });
    let failed = false;
    for await (const j of q.consume("vt", undefined, 0)) {
      (j as QueueJob).fail("boom");                  // acked with failure -> requeued
      failed = true;
      break;
    }
    assert("vt: fail() ran", failed);
    assert("vt: fail() clears the reservation", q.size("reserved") === 0);
    const retried = q.pop();
    assert("vt: failed job requeued with attempts 1", retried !== null && retried.attempts === 1);
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }

  // (e) default 300 + TINA4_QUEUE_VISIBILITY_TIMEOUT env override
  {
    const prev = process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT;
    delete process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT;
    const def = new Queue({ topic: "vt", path: join("/tmp", "tina4-vt-def-" + Date.now()) });
    assert("vt: default visibility timeout is 300", def.getVisibilityTimeout() === 300);

    process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT = "42";
    const fromEnv = new Queue({ topic: "vt", path: join("/tmp", "tina4-vt-env-" + Date.now()) });
    assert("vt: env override sets visibility timeout to 42", fromEnv.getVisibilityTimeout() === 42);

    const ctorWins = new Queue({ topic: "vt", path: join("/tmp", "tina4-vt-ctor-" + Date.now()), visibilityTimeout: 7 });
    assert("vt: constructor arg wins over env", ctorWins.getVisibilityTimeout() === 7);

    if (prev === undefined) delete process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT;
    else process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT = prev;
  }

  // (f) visibilityTimeout=0 disables reclaim (reservation stays)
  {
    const p = join("/tmp", "tina4-vt-disabled-" + Date.now());
    try { rmSync(p, { recursive: true, force: true }); } catch {}
    const q = new Queue({ topic: "vt", path: p, visibilityTimeout: 0 });
    q.push({ job: "import" });
    assert("vt(0): pop reserves the job", q.pop() !== null);
    await sleep(60);
    // Reclaim is disabled — the reservation stays put (opt-out / old behaviour).
    assert("vt(0): disabled reclaim -> next pop is null", q.pop() === null);
    assert("vt(0): reservation stays", q.size("reserved") === 1);
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
})();

// --- Visibility timeout / lifecycle (MongoDB backend — LIVE mongo, NO mocks) ---
//
// These were script-string-introspection tests (no live Mongo) — exactly the
// shape that let the Mongo queue re-deliver every completed job for two
// releases. They are now REAL behavioural tests against a live MongoDB
// (localhost:27017), mirroring mongoQueueDeadLetterLive.test.ts: a throwaway,
// framework-namespaced database that is DROPPED on teardown so app data is
// never touched. We push/pop/complete/fail real documents and read the live
// collection back to assert the reservation effect — not the source text.
//
// Gated on a reachable Mongo + the `mongodb` driver. The skip reason contains
// "mongo" + "not reachable"/"not installed" so the #252 service gate treats an
// unavailable Mongo as a hard FAILURE under TINA4_REQUIRE_SERVICES.
const MONGO_URI = process.env.TINA4_MONGO_URI ?? "mongodb://localhost:27017";
const MONGO_DB = "tina4_test_queue_vt_node";    // throwaway, framework-namespaced
const MONGO_COLLECTION = "tina4_test_queue_vt_jobs";

/** Async TCP reachability probe (native node:net, no child process). */
function mongoReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    const t = setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 1500);
    if (t.unref) t.unref();
  });
}

function parseMongoHostPort(uri: string): { host: string; port: number } {
  const m = uri.match(/mongodb:\/\/(?:[^@/]*@)?([^:/]+)(?::(\d+))?/);
  return { host: m?.[1] ?? "localhost", port: m?.[2] ? parseInt(m[2], 10) : 27017 };
}

const mongoSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

console.log("\n--- Visibility Timeout / lifecycle (MongoDB LIVE) ---");
await (async () => {
  // ── Gate: driver present? ──────────────────────────────────────────────
  let mongodb: typeof import("mongodb");
  try {
    mongodb = await import("mongodb");
  } catch {
    skip("mongo: visibility timeout / lifecycle (live)", "mongodb driver not installed");
    return;
  }

  // ── Gate: server reachable? ────────────────────────────────────────────
  const { host, port } = parseMongoHostPort(MONGO_URI);
  if (!(await mongoReachable(host, port))) {
    skip("mongo: visibility timeout / lifecycle (live)", "mongo not reachable on " + host + ":" + port);
    return;
  }

  const { MongoBackend } = await import("../packages/core/src/queueBackends/mongoBackend.ts");
  const { MongoClient } = mongodb;

  // Point the Mongo backend at the throwaway, namespaced database.
  const prevMongoUri = process.env.TINA4_MONGO_URI;
  const prevMongoDb = process.env.TINA4_MONGO_DB;
  const prevMongoColl = process.env.TINA4_MONGO_COLLECTION;
  process.env.TINA4_MONGO_URI = MONGO_URI;
  process.env.TINA4_MONGO_DB = MONGO_DB;
  process.env.TINA4_MONGO_COLLECTION = MONGO_COLLECTION;

  const client = new MongoClient(MONGO_URI, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const coll = client.db(MONGO_DB).collection(MONGO_COLLECTION);
  const reset = async (t: string) => {
    await coll.deleteMany({ queue: t });
    await coll.deleteMany({ queue: t + ".dead_letter" });
  };

  try {
    // Config still resolves the same way (constructor/env). Keep the cheap
    // resolution asserts but BACK THEM with live behaviour below.
    const backend = new MongoBackend({ uri: MONGO_URI, database: MONGO_DB, collection: MONGO_COLLECTION, visibilityTimeout: 300, maxRetries: 3 });
    assert("mongo: visibility timeout resolved to 300", backend.getVisibilityTimeout() === 300);
    assert("mongo: getConfig exposes visibilityTimeout", (backend.getConfig() as any).visibilityTimeout === 300);

    // (5) Resolved timeout drives a REAL reclaim: push, reserve, sleep past the
    // (tiny) window, pop again — the abandoned reservation is reclaimed with
    // attempts === 1 (mirrors the file-backend block (a), but on live Mongo).
    {
      const T = "vt_reclaim";
      await reset(T);
      const b = new MongoBackend({ uri: MONGO_URI, database: MONGO_DB, collection: MONGO_COLLECTION, visibilityTimeout: 1, maxRetries: 5 });
      b.push(T, { job: "import" });
      const first = b.pop(T);
      assert("mongo: reserve returns a job (attempts 0)", first !== null && first.attempts === 0);
      await mongoSleep(1300);
      const reclaimed = b.pop(T);
      assert("mongo: abandoned reservation reclaimed after timeout", reclaimed !== null);
      assert("mongo: reclaimed payload preserved", reclaimed !== null && (reclaimed.payload as any).job === "import");
      assert("mongo: reclaim counted as one attempt (attempts === 1)", reclaimed !== null && reclaimed.attempts === 1);
      await reset(T);
    }

    // (6,7) pop advances availableAt to now + visibilityTimeout*1000 and stamps
    // reservedAt — read the stored document back, not the script text.
    {
      const T = "vt_reserve_stamp";
      await reset(T);
      const b = new MongoBackend({ uri: MONGO_URI, database: MONGO_DB, collection: MONGO_COLLECTION, visibilityTimeout: 300, maxRetries: 3 });
      b.push(T, { x: 1 });
      const before = Date.now();
      b.pop(T);
      const doc = await coll.findOne({ queue: T });
      assert("mongo: pop reserves the live document", !!doc && doc.status === "reserved");
      const availMs = doc ? new Date((doc as any).availableAt).getTime() : 0;
      assert("mongo: pop advances availableAt to ~now + visibilityTimeout*1000",
        availMs >= before + 300 * 1000 - 5000 && availMs <= Date.now() + 300 * 1000 + 5000,
        `availableAt delta=${availMs - before}`);
      const reservedMs = doc ? new Date((doc as any).reservedAt).getTime() : 0;
      assert("mongo: pop stamps reservedAt within a few seconds of now",
        Math.abs(reservedMs - Date.now()) < 5000, `reservedAt delta=${reservedMs - Date.now()}`);
      await reset(T);
    }

    // (8) pop sort honours priority DESC then createdAt ASC. MongoBackend.push
    // doesn't carry priority, so seed three real docs with priorities 1/5/10
    // (out of insertion order) and assert pop returns 10, 5, 1.
    {
      const T = "vt_priority";
      await reset(T);
      const b = new MongoBackend({ uri: MONGO_URI, database: MONGO_DB, collection: MONGO_COLLECTION, visibilityTimeout: 300, maxRetries: 3 });
      const t0 = new Date(Date.now()).toISOString();
      await coll.insertMany([
        { id: "p1", queue: T, status: "pending", createdAt: t0, attempts: 0, priority: 1, payload: { v: 1 } },
        { id: "p10", queue: T, status: "pending", createdAt: t0, attempts: 0, priority: 10, payload: { v: 10 } },
        { id: "p5", queue: T, status: "pending", createdAt: t0, attempts: 0, priority: 5, payload: { v: 5 } },
      ]);
      const order = [b.pop(T), b.pop(T), b.pop(T)].map((j) => (j ? (j.payload as any).v : null));
      assert("mongo: pop sort honours priority DESC (10,5,1)", order.join(",") === "10,5,1", `order=${order.join(",")}`);

      // Ties break oldest-first by createdAt.
      const T2 = "vt_priority_tie";
      await reset(T2);
      await coll.insertMany([
        { id: "a", queue: T2, status: "pending", createdAt: "2020-01-01T00:00:00.000Z", attempts: 0, priority: 5, payload: { n: 1 } },
        { id: "b", queue: T2, status: "pending", createdAt: "2020-01-02T00:00:00.000Z", attempts: 0, priority: 5, payload: { n: 2 } },
        { id: "c", queue: T2, status: "pending", createdAt: "2020-01-03T00:00:00.000Z", attempts: 0, priority: 5, payload: { n: 3 } },
      ]);
      const tieOrder = [b.pop(T2), b.pop(T2), b.pop(T2)].map((j) => (j ? (j.payload as any).n : null));
      assert("mongo: equal-priority ties break oldest-first (1,2,3)", tieOrder.join(",") === "1,2,3", `order=${tieOrder.join(",")}`);
      await reset(T);
      await reset(T2);
    }

    // (9,10) reclaim matches expired reserved docs, flips them to in-flight and
    // increments attempts on the LIVE document.
    {
      const T = "vt_reclaim_inc";
      await reset(T);
      const b = new MongoBackend({ uri: MONGO_URI, database: MONGO_DB, collection: MONGO_COLLECTION, visibilityTimeout: 1, maxRetries: 5 });
      b.push(T, { job: "x" });
      b.pop(T);                                  // reserve, attempts 0
      await mongoSleep(1300);                    // expire the reservation
      const reclaimed = b.pop(T);                // reclaim returns it
      assert("mongo: expired reservation reclaimed (returned again)", reclaimed !== null);
      assert("mongo: reclaimed job carries incremented attempts (=== 1)", reclaimed !== null && reclaimed.attempts === 1);
      const live = await coll.findOne({ queue: T });
      assert("mongo: live doc top-level attempts incremented to 1", !!live && (live as any).attempts === 1, `attempts=${(live as any)?.attempts}`);
      await reset(T);
    }

    // (11) reclaim past maxRetries dead-letters instead of re-delivering.
    {
      const T = "vt_reclaim_dl";
      await reset(T);
      const b = new MongoBackend({ uri: MONGO_URI, database: MONGO_DB, collection: MONGO_COLLECTION, visibilityTimeout: 1, maxRetries: 1 });
      b.push(T, { job: "import" });
      b.pop(T);                                  // reserve, attempts 0
      await mongoSleep(1300);
      const re = b.pop(T);                        // reclaim bumps to 1 >= 1 -> dead-letter
      assert("mongo: past-max-retries reclaim does NOT re-deliver (pop === null)", re === null);
      const dead = b.deadLetters(T);
      assert("mongo: reclaim dead-letters exactly one job", dead.length === 1);
      assert("mongo: dead-letter payload preserved", dead.length === 1 && (dead[0].payload as any).job === "import");
      await reset(T);
    }

    // (12) reclaim guarded by visibilityTimeout > 0: with vt=0 the reservation
    // stays put (the guard disables reclaim — proven by behaviour).
    {
      const T = "vt_zero";
      await reset(T);
      const b = new MongoBackend({ uri: MONGO_URI, database: MONGO_DB, collection: MONGO_COLLECTION, visibilityTimeout: 0, maxRetries: 5 });
      assert("mongo(0): visibility timeout resolved to 0", b.getVisibilityTimeout() === 0);
      b.push(T, { x: 1 });
      assert("mongo(0): pop reserves the job", b.pop(T) !== null);
      await mongoSleep(300);
      assert("mongo(0): disabled reclaim -> next pop is null", b.pop(T) === null);
      const doc = await coll.findOne({ queue: T });
      assert("mongo(0): reservation stays reserved (no reclaim)", !!doc && doc.status === "reserved");
      await reset(T);
    }

    // (13) env override sets the timeout AND drives the reclaim window: with
    // TINA4_QUEUE_VISIBILITY_TIMEOUT=1 the reclaim fires after ~1.2s.
    {
      const prev = process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT;
      process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT = "1";
      const T = "vt_env";
      await reset(T);
      const b = new MongoBackend({ uri: MONGO_URI, database: MONGO_DB, collection: MONGO_COLLECTION, maxRetries: 5 });
      assert("mongo: env override sets visibility timeout to 1", b.getVisibilityTimeout() === 1);
      b.push(T, { x: 1 });
      b.pop(T);                                  // reserve
      await mongoSleep(1200);
      const reclaimed = b.pop(T);
      assert("mongo: env-driven reclaim fires after the env window", reclaimed !== null && reclaimed.attempts === 1);
      await reset(T);
      if (prev === undefined) delete process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT;
      else process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT = prev;
    }
  } finally {
    // Drop the throwaway, namespaced database — never touch app data.
    try { await client.db(MONGO_DB).dropDatabase(); } catch { /* best effort */ }
    await client.close();
    if (prevMongoUri === undefined) delete process.env.TINA4_MONGO_URI; else process.env.TINA4_MONGO_URI = prevMongoUri;
    if (prevMongoDb === undefined) delete process.env.TINA4_MONGO_DB; else process.env.TINA4_MONGO_DB = prevMongoDb;
    if (prevMongoColl === undefined) delete process.env.TINA4_MONGO_COLLECTION; else process.env.TINA4_MONGO_COLLECTION = prevMongoColl;
  }
})();

// --- RabbitMQ + Kafka accept and ignore visibilityTimeout ---
console.log("\n--- RabbitMQ + Kafka ignore visibilityTimeout ---");
{
  const { RabbitMQBackend } = await import("../packages/core/src/queueBackends/rabbitmqBackend.ts");
  const { KafkaBackend } = await import("../packages/core/src/queueBackends/kafkaBackend.ts");
  // Both accept the param (no throw) and their resolved config does not surface
  // it — the broker owns redelivery.
  const rabbit = new RabbitMQBackend({ visibilityTimeout: 99 });
  assert("rabbitmq: accepts visibilityTimeout without surfacing it",
    !("visibilityTimeout" in rabbit.getConfig()));
  const kafka = new KafkaBackend({ visibilityTimeout: 99 });
  assert("kafka: accepts visibilityTimeout without surfacing it",
    !("visibilityTimeout" in kafka.getConfig()));
}

// --- Topic-targeting: consume()/process()/produce() honour the topic arg ---
//
// Regression lock for the production bug where consume(topic)/process(topic)
// IGNORED the topic argument and drained the construction-time topic instead.
// produce(topic) already retargeted correctly — the asymmetry was the tell. A
// job produced onto "alerts" must be consumable via consume("alerts") even when
// the Queue was constructed with a different default topic. Engine-agnostic:
// runs on the file backend so it needs no live broker. Mirrors the Python
// master regression test (commit 04f9f05).
console.log("\n--- Topic Targeting (consume/process/produce honour topic) ---");

const TEST_PATH_TGT = join("/tmp", "tina4-queue-target-test-" + Date.now());
function cleanupTgt() {
  try { rmSync(TEST_PATH_TGT, { recursive: true, force: true }); } catch {}
}
cleanupTgt();

await (async () => {
  // (a) produce("alerts") then consume("alerts") on a queue built with topic
  // "default" — the job lands on "alerts" and consume("alerts") drains it. With
  // the bug, consume drained "default" (empty) and yielded nothing.
  {
    const q = new Queue({ topic: "default", path: TEST_PATH_TGT });
    q.produce("alerts", { msg: "fire" });
    // produce() restores the prior topic afterwards, so size() (which reads the
    // current topic) reports the DEFAULT topic — which must be empty, proving the
    // job landed on "alerts" not "default".
    assert("target: produce(topic) does not push onto the construction-time topic",
      q.size() === 0);

    const drained: any[] = [];
    for await (const j of q.consume("alerts", undefined, 0)) {
      drained.push((j as QueueJob).payload);
      (j as QueueJob).complete();
    }
    assert("target: consume(topic) drains the produced topic (Bug A)",
      drained.length === 1 && (drained[0] as any).msg === "fire");
  }

  // (b) consume(topic) must NOT drain the construction-time topic. A job on the
  // default topic is left untouched when consuming a different topic.
  {
    const q = new Queue({ topic: "default", path: TEST_PATH_TGT });
    q.push({ msg: "on_default" });          // lands on "default"
    q.produce("other", { msg: "on_other" }); // lands on "other"

    const fromOther: any[] = [];
    for await (const j of q.consume("other", undefined, 0)) {
      fromOther.push((j as QueueJob).payload);
      (j as QueueJob).complete();
    }
    assert("target: consume(other) yields only 'other' jobs",
      fromOther.length === 1 && (fromOther[0] as any).msg === "on_other");

    // The default-topic job is still pending and consumable via consume("default").
    const fromDefault: any[] = [];
    const qd = new Queue({ topic: "default", path: TEST_PATH_TGT });
    for await (const j of qd.consume("default", undefined, 0)) {
      fromDefault.push((j as QueueJob).payload);
      (j as QueueJob).complete();
    }
    assert("target: consume(other) left the default-topic job intact",
      fromDefault.length === 1 && (fromDefault[0] as any).msg === "on_default");
  }

  // (b2) The OPTIONS-OBJECT form of consume must also honour opts.topic — it
  // previously ignored it (q = this.topic) and silently drained the
  // construction-time topic. Engine-agnostic regression (file backend).
  {
    const q = new Queue({ topic: "default", path: TEST_PATH_TGT });
    q.produce("alerts", { msg: "a1" });
    q.produce("alerts", { msg: "a2" });
    const fromAlerts: any[] = [];
    for await (const j of q.consume({ topic: "alerts", pollInterval: 0 })) {
      fromAlerts.push((j as QueueJob).payload);
      (j as QueueJob).complete();
    }
    assert("target: consume({topic}) options-form drains the requested topic",
      fromAlerts.length === 2 && (fromAlerts[0] as any).msg === "a1");
  }

  // (c) process({ topic }) honours the topic override (Python parity:
  // process(handler, topic=...)). Jobs on the override topic are handled; the
  // construction-time topic is left alone.
  {
    const q = new Queue({ topic: "default", path: TEST_PATH_TGT });
    q.push({ where: "default" });           // default topic
    q.produce("work", { where: "work" });   // override topic

    const handled: string[] = [];
    q.process((job: QueueJob | QueueJob[]) => {
      const arr = Array.isArray(job) ? job : [job];
      for (const j of arr) {
        handled.push((j.payload as any).where);
        j.complete();
      }
    }, { topic: "work" });

    assert("target: process({topic}) drains the override topic (Bug A)",
      handled.length === 1 && handled[0] === "work");

    // The default-topic job must remain pending (process drained "work" only).
    const q2 = new Queue({ topic: "default", path: TEST_PATH_TGT });
    assert("target: process({topic:work}) left the default-topic job pending",
      q2.size() === 1);
  }

  // (d) complete()/fail() after consume(topic) act on the RIGHT topic. After a
  // failure on a retargeted topic the retry lands back on that same topic (the
  // ack routes by the job's own .topic), and nothing leaks into 'default'.
  // Uses its OWN path so the leak assertion can't be contaminated by earlier
  // sub-blocks that deliberately leave default-topic jobs pending.
  {
    const dPath = join("/tmp", "tina4-queue-target-d-" + Date.now());
    try { rmSync(dPath, { recursive: true, force: true }); } catch {}
    const q = new Queue({ topic: "default", path: dPath, maxRetries: 3 });
    q.produce("retryable", { task: "x" });

    let runs = 0;
    for await (const j of q.consume("retryable", undefined, 0)) {
      runs++;
      if (runs === 1) {
        (j as QueueJob).fail("transient");   // re-enqueued onto "retryable"
      } else {
        (j as QueueJob).complete();
        break;
      }
    }
    assert("target: fail() on a retargeted topic re-enqueues on the same topic", runs === 2);

    const qDefault = new Queue({ topic: "default", path: dPath });
    assert("target: retargeted fail()/retry never leaked into the default topic",
      qDefault.size() === 0);
    try { rmSync(dPath, { recursive: true, force: true }); } catch {}
  }

  cleanupTgt();
})();

// --- MongoDB queue lifecycle routing + flat-attempts schema (LIVE mongo) ---
//
// Previously these grepped the TEXT of the generated operation scripts (never
// executed) — script-introspection, not behaviour, the exact shape that let the
// Mongo queue re-deliver every completed job for two releases. They now run
// against a LIVE MongoDB: push/pop/complete/fail real documents and read the
// stored docs back to prove the flat (top-level `attempts`) schema, the topic
// routing, complete/fail effects, and lifecycle methods. Same throwaway,
// framework-namespaced DB pattern (dropped on teardown).
console.log("\n--- MongoDB queue lifecycle routing + flat attempts (LIVE) ---");
await (async () => {
  // ── Gate: driver present? ──
  let mongodb: typeof import("mongodb");
  try {
    mongodb = await import("mongodb");
  } catch {
    skip("mongo: lifecycle routing + flat attempts (live)", "mongodb driver not installed");
    return;
  }
  // ── Gate: server reachable? ──
  const { host, port } = parseMongoHostPort(MONGO_URI);
  if (!(await mongoReachable(host, port))) {
    skip("mongo: lifecycle routing + flat attempts (live)", "mongo not reachable on " + host + ":" + port);
    return;
  }

  const { MongoBackend } = await import("../packages/core/src/queueBackends/mongoBackend.ts");
  const { MongoClient } = mongodb;
  const LDB = "tina4_test_queue_lc_node";        // throwaway, framework-namespaced
  const LCOLL = "tina4_test_queue_lc_jobs";
  const client = new MongoClient(MONGO_URI, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const coll = client.db(LDB).collection(LCOLL);
  const reset = async (t: string) => {
    await coll.deleteMany({ queue: t });
    await coll.deleteMany({ queue: t + ".dead_letter" });
  };
  const mk = (cfg?: Record<string, unknown>) =>
    new MongoBackend({ uri: MONGO_URI, database: LDB, collection: LCOLL, visibilityTimeout: 300, maxRetries: 3, ...(cfg ?? {}) });

  try {
    // (18) Push inserts the job document with FLAT top-level fields: `attempts`
    // is a top-level field (not nested under `data`) and `queue` === queueName.
    {
      const T = "lc_push";
      await reset(T);
      const b = mk();
      b.push(T, { x: 1 });
      const doc = await coll.findOne({ queue: T });
      assert("mongo: push stores attempts as a TOP-LEVEL field (flat schema)",
        !!doc && typeof (doc as any).attempts === "number" && (doc as any).attempts === 0);
      assert("mongo: push does NOT nest fields under a `data` envelope",
        !!doc && (doc as any).data === undefined);
      assert("mongo: push stores queue === queueName", !!doc && (doc as any).queue === T);
      assert("mongo: push stores payload at the top level", !!doc && ((doc as any).payload as any).x === 1);
      await reset(T);
    }

    // (17) pop carries the framework topic on the returned job so a later
    // complete()/fail() routes back to the right topic's docs.
    {
      const T = "alerts";
      await reset(T);
      const b = mk();
      b.push(T, { msg: "fire" });
      const job = b.pop(T);
      assert("mongo: pop carries the framework topic on the returned job",
        job !== null && (job as any).topic === "alerts");
      await reset(T);
    }

    // (20,19) pop returns the LIVE document: reserve+expire+reclaim bumps the
    // live top-level attempts, then pop surfaces attempts === 1 (no nested
    // snapshot masks the live value).
    {
      const T = "lc_live_attempts";
      await reset(T);
      const b = mk({ visibilityTimeout: 1, maxRetries: 5 });
      b.push(T, { x: 1 });
      b.pop(T);                                  // reserve, attempts 0
      await mongoSleep(1300);                    // expire
      const reclaimed = b.pop(T);                // reclaim bumps live attempts
      assert("mongo: reclaimed pop surfaces the LIVE incremented attempts (=== 1)",
        reclaimed !== null && reclaimed.attempts === 1);
      const live = await coll.findOne({ queue: T });
      assert("mongo: live doc top-level attempts === 1 (no stale nested snapshot)",
        !!live && (live as any).attempts === 1);
      assert("mongo: live doc has no nested data.attempts snapshot",
        !!live && ((live as any).data === undefined || (live as any).data?.attempts === undefined));
      await reset(T);
    }

    // (14,15) complete() acks the reservation on the LIVE store: status becomes
    // 'completed', completedAt is set, and it is not re-delivered after the
    // visibility window.
    {
      const T = "lc_complete";
      await reset(T);
      const b = mk({ visibilityTimeout: 1 });
      b.push(T, { x: 1 });
      const job = b.pop(T);
      b.complete(T, job!.id);
      const doc = await coll.findOne({ queue: T, id: job!.id });
      assert("mongo: complete marks the live doc completed", !!doc && doc.status === "completed");
      assert("mongo: complete stamps completedAt", !!doc && typeof (doc as any).completedAt === "string");
      await mongoSleep(1300);                    // past the visibility window
      assert("mongo: completed job is NOT re-delivered after the window", b.pop(T) === null);
      await reset(T);
    }

    // (14,16) fail() requeues below the limit (live doc back to pending,
    // attempts incremented) and dead-letters at the limit.
    {
      // maxRetries=3 -> first fail requeues to pending with attempts incremented.
      const T = "lc_fail_requeue";
      await reset(T);
      const b3 = mk({ maxRetries: 3 });
      b3.push(T, { x: 1 });
      const j = b3.pop(T);
      b3.fail(T, j!.id, "transient", 3, 0);
      const live = await coll.findOne({ queue: T, id: j!.id });
      assert("mongo: fail below the limit requeues the live doc to pending", !!live && live.status === "pending");
      assert("mongo: fail below the limit increments the live attempts", !!live && (live as any).attempts === 1);
      await reset(T);

      // maxRetries=1 -> fail dead-letters (queryable in the dead_letter store).
      const T2 = "lc_fail_dead";
      await reset(T2);
      const b1 = mk({ maxRetries: 1 });
      b1.push(T2, { x: 1 });
      const j2 = b1.pop(T2);
      b1.fail(T2, j2!.id, "fatal", 1, 0);
      const deadDoc = await coll.findOne({ queue: T2 + ".dead_letter", id: j2!.id });
      assert("mongo: fail at the limit dead-letters the job (queryable, status dead)",
        !!deadDoc && deadDoc.status === "dead");
      assert("mongo: dead-lettered job preserves the failure reason", !!deadDoc && (deadDoc as any).error === "fatal");
      const dead = b1.deadLetters(T2);
      assert("mongo: deadLetters() returns the dead-lettered job", dead.length === 1);
      await reset(T2);
    }

    // (14) retry() always re-queues the live doc to pending with attempts
    // incremented (manual override, independent of the retry limit).
    {
      const T = "lc_retry";
      await reset(T);
      const b = mk({ maxRetries: 1 });
      const id = b.push(T, { x: 1 });
      b.pop(T);                                  // reserve
      b.retry(T, id);                            // manual re-queue
      const doc = await coll.findOne({ queue: T, id });
      assert("mongo: retry() re-queues the live doc to pending", !!doc && doc.status === "pending");
      assert("mongo: retry() increments the live attempts", !!doc && (doc as any).attempts === 1);
      await reset(T);
    }

    // (14) retryFailed() revives a real dead-letter doc back to the main topic.
    {
      const T = "lc_retry_failed";
      await reset(T);
      await coll.insertOne({
        id: "lc-failed-1", queue: T + ".dead_letter", status: "failed", attempts: 1,
        payload: { x: 1 }, error: "boom", availableAt: "1970-01-01T00:00:00.000Z",
      });
      const b = mk({ maxRetries: 2 });
      const revived = b.retryFailed(T, 3);
      assert("mongo: retryFailed revives exactly one seeded dead-letter doc", revived === 1);
      const doc = await coll.findOne({ id: "lc-failed-1" });
      assert("mongo: retryFailed flips the doc back to pending on the main topic",
        !!doc && doc.status === "pending" && (doc as any).queue === T);
      await reset(T);
    }

    // (14) purge() removes live docs by status.
    {
      const T = "lc_purge";
      await reset(T);
      const b = mk();
      b.push(T, { x: 1 });
      b.push(T, { x: 2 });
      const removed = b.purge(T, "pending");
      assert("mongo: purge removes the live pending docs", removed === 2);
      assert("mongo: purge leaves nothing for that status", await coll.countDocuments({ queue: T, status: "pending" }) === 0);
      await reset(T);
    }
  } finally {
    try { await client.db(LDB).dropDatabase(); } catch { /* best effort */ }
    await client.close();
  }
})();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

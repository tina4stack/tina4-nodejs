/**
 * Unit tests for the Queue module (Phase 5).
 * Run with: npx tsx test/queue.test.ts
 */
import { Queue } from "../packages/core/src/index.ts";
import type { QueueJob } from "../packages/core/src/index.ts";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

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

// --- Failed Jobs ---
console.log("\n--- Failed Jobs ---");

const qWork = new Queue({ topic: "work", path: TEST_PATH });
qWork.push({ item: 1 });
qWork.push({ item: 2 });

// Process with a handler that fails
qWork.process((job: QueueJob) => {
  throw new Error("intentional failure");
}, { maxRetries: 3 });

const failedJobs = qWork.failed();
assert("failed returns failed jobs", failedJobs.length === 2);
assert("failed job has error message", failedJobs[0].error === "intentional failure");
assert("failed job has status 'failed'", failedJobs[0].status === "failed");

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
  const qt5 = new Queue({ topic: "retrytest", path: TEST_PATH_TOPIC, maxRetries: 3 });
  qt5.push({ x: 1 });

  qt5.process((job: QueueJob) => {
    throw new Error("fail");
  });

  const retried = qt5.retryFailed();
  assert("topic retryFailed returns 1", retried === 1);
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
  const qt = new Queue({ topic: "lifecycle", path: TEST_PATH_LC });
  qt.push({ task: "test" });

  const job = qt.pop();
  assert("popped job has complete method", typeof job?.complete === "function");
  assert("popped job has fail method", typeof job?.fail === "function");
  assert("popped job has reject method", typeof job?.reject === "function");
  assert("popped job has retry method", typeof job?.retry === "function");
  assert("popped job has topic field", job?.topic === "lifecycle");

  if (job) {
    job.complete();
    assert("complete sets status to completed", job.status === "completed");
  }
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

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

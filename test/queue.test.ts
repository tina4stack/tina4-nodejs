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

const q = new Queue("file", { path: TEST_PATH });

const jobId1 = q.push("emails", { to: "alice@test.com", subject: "Hello" });
assert("push returns a job ID (string)", typeof jobId1 === "string" && jobId1.length > 0);

const jobId2 = q.push("emails", { to: "bob@test.com", subject: "Hi" });
assert("push returns unique IDs", jobId1 !== jobId2);

const job1 = q.pop("emails");
assert("pop returns a job", job1 !== null);
assert("popped job has correct payload", job1 !== null && (job1.payload as any).to === "alice@test.com");
assert("popped job has correct status", job1 !== null && job1.status === "reserved");
assert("popped job has id", job1 !== null && typeof job1.id === "string");
assert("popped job has createdAt", job1 !== null && typeof job1.createdAt === "string");

const job2 = q.pop("emails");
assert("second pop returns second job", job2 !== null && (job2.payload as any).to === "bob@test.com");

const job3 = q.pop("emails");
assert("pop on empty queue returns null", job3 === null);

// --- Size ---
console.log("\n--- Size ---");

const q2 = new Queue("file", { path: TEST_PATH });
q2.push("tasks", { action: "a" });
q2.push("tasks", { action: "b" });
q2.push("tasks", { action: "c" });

assert("size returns 3 after 3 pushes", q2.size("tasks") === 3);

q2.pop("tasks");
assert("size returns 2 after 1 pop", q2.size("tasks") === 2);

// --- Clear ---
console.log("\n--- Clear ---");

q2.clear("tasks");
assert("size is 0 after clear", q2.size("tasks") === 0);

const afterClear = q2.pop("tasks");
assert("pop returns null after clear", afterClear === null);

// --- Failed Jobs ---
console.log("\n--- Failed Jobs ---");

const q3 = new Queue("file", { path: TEST_PATH });
q3.push("work", { item: 1 });
q3.push("work", { item: 2 });

// Process with a handler that fails
q3.process("work", (job: QueueJob) => {
  throw new Error("intentional failure");
}, { maxRetries: 3 });

const failedJobs = q3.failed("work");
assert("failed returns failed jobs", failedJobs.length === 2);
assert("failed job has error message", failedJobs[0].error === "intentional failure");
assert("failed job has status 'failed'", failedJobs[0].status === "failed");

// --- Retry ---
console.log("\n--- Retry ---");

const failedId = failedJobs[0].id;
const retried = q3.retry(failedId);
assert("retry returns true for existing failed job", retried === true);

const retriedJob = q3.pop("work");
assert("retried job can be popped", retriedJob !== null);
assert("retried job has correct id", retriedJob !== null && retriedJob.id === failedId);

const noRetry = q3.retry("nonexistent-id");
assert("retry returns false for nonexistent job", noRetry === false);

// --- Ordering (FIFO) ---
console.log("\n--- FIFO Ordering ---");

const q4 = new Queue("file", { path: TEST_PATH });
q4.push("ordered", { seq: 1 });
q4.push("ordered", { seq: 2 });
q4.push("ordered", { seq: 3 });

const o1 = q4.pop("ordered");
const o2 = q4.pop("ordered");
const o3 = q4.pop("ordered");
assert("FIFO: first push is first pop", o1 !== null && (o1.payload as any).seq === 1);
assert("FIFO: second push is second pop", o2 !== null && (o2.payload as any).seq === 2);
assert("FIFO: third push is third pop", o3 !== null && (o3.payload as any).seq === 3);

// --- Delayed Jobs ---
console.log("\n--- Delayed Jobs ---");

const q5 = new Queue("file", { path: TEST_PATH });
q5.push("delayed", { action: "later" }, 3600); // 1 hour delay

const delayedJob = q5.pop("delayed");
assert("delayed job is not popped before delay expires", delayedJob === null);
assert("delayed queue still has size 1", q5.size("delayed") === 1);

// --- Separate Queues ---
console.log("\n--- Separate Queues ---");

const q6 = new Queue("file", { path: TEST_PATH });
q6.push("alpha", { type: "a" });
q6.push("beta", { type: "b" });

assert("separate queues have independent size", q6.size("alpha") === 1 && q6.size("beta") === 1);

const alphaJob = q6.pop("alpha");
assert("pop from alpha returns alpha job", alphaJob !== null && (alphaJob.payload as any).type === "a");
assert("beta queue unaffected by alpha pop", q6.size("beta") === 1);

// Clean up
cleanup();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

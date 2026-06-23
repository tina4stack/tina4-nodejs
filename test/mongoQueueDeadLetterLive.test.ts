/**
 * Dead-letter + retryFailed end-to-end through the Queue facade against a
 * LIVE MongoDB (NO mocks). Mirror of the Python master
 * (tina4-python/tests/test_queue_backends.py :: TestMongoQueueDeadLetterLive).
 *
 * Why this exists: the Mongo queue once re-delivered every completed job for two
 * releases because its queue tests were mock / script-introspection based and
 * never ran against a real Mongo. The kwarg/method contract is locked mock-free
 * by mongoQueue.test.ts (constructor + method-existence, no fake collaborator);
 * THIS test proves the actual behaviour against a real broker. It runs through
 * the public Queue facade (backend: "mongodb", maxRetries: 2) so the same path
 * an app uses is exercised end-to-end.
 *
 * Real MongoDB only — there is NO test double of a Mongo collection or client.
 * It uses a THROWAWAY, framework-namespaced database (tina4_test_queue_node) and
 * DROPS it on teardown, so it never touches application data.
 *
 * Gated on a reachable Mongo (localhost:27017) + the `mongodb` driver. The skip
 * reason contains "mongo" + "not reachable"/"not installed" so the #252 service
 * gate (test/_serviceGate.ts) treats an unavailable Mongo as a hard FAILURE
 * under TINA4_REQUIRE_SERVICES.
 *
 * Run with:
 *   TINA4_MONGO_URI=mongodb://localhost:27017 npx tsx test/mongoQueueDeadLetterLive.test.ts
 */
import { Queue, createJob } from "../packages/core/src/index.ts";
import type { QueueJob, JobData } from "../packages/core/src/index.ts";
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

function skip(name: string, reason: string) {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} (${reason})`);
  skipped++;
}

/** Async TCP reachability probe (native node:net, no child process). */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    const t = setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 1500);
    if (t.unref) t.unref();
  });
}

function parseHostPort(uri: string): { host: string; port: number } {
  const m = uri.match(/mongodb:\/\/(?:[^@/]*@)?([^:/]+)(?::(\d+))?/);
  return { host: m?.[1] ?? "localhost", port: m?.[2] ? parseInt(m[2], 10) : 27017 };
}

console.log("=== MongoDB Queue Dead-Letter / retryFailed (LIVE) ===\n");

const MONGO_URI = process.env.TINA4_MONGO_URI ?? "mongodb://localhost:27017";
const DB_NAME = "tina4_test_queue_node";        // throwaway, framework-namespaced
const COLLECTION = "tina4_test_queue_jobs";
const TOPIC = "tina4_test_dead_letter";

async function main() {
  // ── Gate: driver present? ──────────────────────────────────────────────
  let mongodb: typeof import("mongodb");
  try {
    mongodb = await import("mongodb");
  } catch {
    skip("mongo queue dead-letter (live)", "mongodb driver not installed");
    skip("mongo queue retryFailed (live)", "mongodb driver not installed");
    return summarize();
  }

  // ── Gate: server reachable? ────────────────────────────────────────────
  const { host, port } = parseHostPort(MONGO_URI);
  if (!(await reachable(host, port))) {
    skip("mongo queue dead-letter (live)", "mongo not reachable on " + host + ":" + port);
    skip("mongo queue retryFailed (live)", "mongo not reachable on " + host + ":" + port);
    return summarize();
  }

  // Point the Mongo queue backend at the throwaway, namespaced database.
  process.env.TINA4_MONGO_URI = MONGO_URI;
  process.env.TINA4_MONGO_DB = DB_NAME;
  process.env.TINA4_MONGO_COLLECTION = COLLECTION;
  delete process.env.TINA4_QUEUE_URL;
  delete process.env.TINA4_QUEUE_BACKEND;

  const { MongoClient } = mongodb;
  const client = new MongoClient(MONGO_URI, {
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
  });

  try {
    await client.connect();
    const coll = client.db(DB_NAME).collection(COLLECTION);

    // ── Test 1: fail past maxRetries lands the job in deadLetters() ───────
    // Real Mongo, no mocks. maxRetries: 2 → the 2nd fail dead-letters it.
    console.log("--- fail past maxRetries -> deadLetters() ---");
    {
      // Pristine slate, even if a prior run left state behind.
      await coll.deleteMany({ queue: TOPIC });
      await coll.deleteMany({ queue: TOPIC + ".dead_letter" });

      const queue = new Queue({ topic: TOPIC, backend: "mongodb", maxRetries: 2 });
      queue.push({ to: "a@example.com" });

      for (let i = 0; i < 5; i++) {            // bounded; converges in 2 cycles
        const raw = queue.pop();
        if (raw === null) break;
        // The external backend's pop() returns a plain doc; wrap it with the
        // Queue-bound lifecycle (exactly as consume() does) so job.fail() routes
        // through _failJob -> the MongoBackend.fail() on the active store.
        const job: QueueJob = createJob(raw as unknown as JobData, queue);
        job.fail("smtp 550");
        if (queue.deadLetters().length > 0) break;
      }

      const dead = queue.deadLetters();
      assert("job lands in dead letters after maxRetries failures", dead.length === 1,
        `dead=${JSON.stringify(dead)}`);
      assert("failure reason survives to the DLQ", dead.length === 1 && (dead[0] as any).error === "smtp 550",
        `error=${dead.length === 1 ? (dead[0] as any).error : "<none>"}`);
      assert("original job no longer pending", queue.size("pending") === 0,
        `pending=${queue.size("pending")}`);

      await coll.deleteMany({ queue: TOPIC });
      await coll.deleteMany({ queue: TOPIC + ".dead_letter" });
    }

    // ── Test 2: retryFailed() requeues a seeded real failed doc ───────────
    // The auto-retry fail() path never leaves a job idle in the dead-letter
    // store under the retry limit, so seed ONE real failed document directly
    // into the live collection (real data, NOT a mock) to exercise the real
    // retryFailed update path. Node's retryFailed revives <topic>.dead_letter
    // docs (attempts < limit) back to the main topic as pending.
    console.log("\n--- retryFailed() requeues a seeded failed doc ---");
    {
      await coll.deleteMany({ queue: TOPIC });
      await coll.deleteMany({ queue: TOPIC + ".dead_letter" });

      await coll.insertOne({
        id: "tina4-test-failed-1",
        queue: TOPIC + ".dead_letter",
        status: "failed",
        attempts: 1,
        payload: { x: 1 },
        error: "boom",
        availableAt: "1970-01-01T00:00:00.000Z",
      });

      const queue = new Queue({ topic: TOPIC, backend: "mongodb", maxRetries: 2 });
      const n = queue.retryFailed(3);
      assert("retryFailed revives exactly one seeded doc", n === 1, `n=${n}`);

      const doc = await coll.findOne({ id: "tina4-test-failed-1" });
      assert("seeded doc flipped back to pending", !!doc && doc.status === "pending",
        `status=${doc?.status}`);
      assert("seeded doc requeued onto the main topic", !!doc && doc.queue === TOPIC,
        `queue=${doc?.queue}`);
      assert("error cleared on requeue", !!doc && (doc.error === null || doc.error === undefined),
        `error=${JSON.stringify(doc?.error)}`);

      await coll.deleteMany({ queue: TOPIC });
      await coll.deleteMany({ queue: TOPIC + ".dead_letter" });
    }
  } finally {
    // Drop the throwaway, namespaced database — never touch app data.
    try { await client.db(DB_NAME).dropDatabase(); } catch { /* best effort */ }
    await client.close();
  }

  return summarize();
}

function summarize() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

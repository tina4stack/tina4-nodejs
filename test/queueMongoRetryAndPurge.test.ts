/**
 * Regression: MongoDB Queue.retry(id) revives a dead letter, and
 * Queue.purge(status) returns a real deleted count for every status.
 *
 * MongoDB retry / purge (3.13.105) ported to Node. Two definite bugs in
 * the Node MongoDB backend before this release:
 *
 *   * ``retry`` searched ``{ queue: queueName, id: info.id }`` -- three
 *     reasons that could never match a dead letter:
 *       1. dead-letter docs are inserted under
 *          ``queue: queueName + ".dead_letter"``, not ``queueName``.
 *       2. They carry ``status: "dead"``; the original doc under
 *          ``queueName`` was already updated to ``completed`` after ack.
 *       3. The backend method returned ``void``, and Queue.retry(id)
 *          returned ``true`` unconditionally regardless of what happened.
 *     So a caller iterating ``deadLetters()`` and calling ``retry(j.id)``
 *     got no revival and no error -- the DL store stayed put, and any
 *     unknown id was reported as revived too.
 *
 *   * ``purge(status)`` filtered by ``{ queue: queueName, ... }`` for
 *     every status. For "dead"/"failed"/"dead_letter" this never matched
 *     the DL namespace (those docs live under ``queueName + ".dead_letter"``)
 *     so a purge of the dead-letter store deleted nothing and reported 0.
 *
 * Named positive AND negative cases below; each proven a real gate by
 * mutation of the fix.
 *
 * NOT a mock: real live MongoDB. Skipped when unreachable; the lab
 * provisions Mongo on 127.0.0.1:27017. Under TINA4_REQUIRE_SERVICES the
 * skip becomes a hard failure.
 *
 * Run with: npx tsx test/queueMongoRetryAndPurge.test.ts
 */
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
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

const HOST = process.env.TINA4_TEST_MONGO_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TINA4_TEST_MONGO_PORT ?? "27017");

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function newTopic(): Promise<Queue> {
  const topic = `mongo_retry_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const q = new Queue({ topic, backend: "mongodb", maxRetries: 1 });
  return q;
}

function deadLetterOne(q: Queue): string {
  const prior = q.deadLetters().length;
  const jobId = q.push({ task: "doomed" });
  const job = q.pop();
  if (!job) throw new Error("prime failed: pop returned null");
  job.fail("boom"); // attempts=1 == maxRetries=1 -> dead
  const now = q.deadLetters().length;
  if (now !== prior + 1) {
    throw new Error(`prime failed: dead grew by ${now - prior}, expected +1`);
  }
  return jobId;
}

async function run(): Promise<void> {
  if (!(await reachable(HOST, PORT))) {
    const why = `MongoDB is not reachable at ${HOST}:${PORT}`;
    if (process.env.TINA4_REQUIRE_SERVICES) {
      console.error(`UNEXPECTED ERROR: TINA4_REQUIRE_SERVICES is set but ${why}`);
      process.exit(1);
    }
    console.log(`  \x1b[33mSKIP\x1b[0m ${why} (not reachable)`);
    process.exit(0);
  }

  process.env.TINA4_MONGO_URI = `mongodb://${HOST}:${PORT}`;
  process.env.TINA4_QUEUE_BACKEND = "mongodb";

  console.log("=== MongoDB Queue.retry(id) revives dead letters ===\n");

  // ── Positive: retry(id) on a real dead letter revives it ────────────
  {
    const q = await newTopic();
    const jobId = deadLetterOne(q);
    const ok = q.retry(jobId);
    assert(
      "retry(id) returns true when a real DL was revived",
      ok === true,
      `returned ${ok} -- pre-3.13.105 Queue.retry(id) returned true for every ` +
        `mongo call, whether the DL existed or not`,
    );
    const remaining = q.deadLetters().length;
    assert(
      "DL store empty after successful revival",
      remaining === 0,
      `deadLetters().length=${remaining}`,
    );
    const pending = q.size("pending");
    assert(
      "revived job appears in pending",
      pending === 1,
      `size(pending)=${pending}`,
    );
    // Housekeeping
    q.purge("pending");
    q.purge("dead");
    q.close();
  }

  // ── Negative: retry(id) on an unknown id returns false ──────────────
  {
    const q = await newTopic();
    const ok = q.retry("does-not-exist-" + randomUUID());
    assert(
      "retry(id) returns false when no DL matches",
      ok === false,
      `returned ${ok}`,
    );
    assert(
      "no ghost pending doc created by an unknown-id retry",
      q.size("pending") === 0,
      `size(pending)=${q.size("pending")}`,
    );
    assert(
      "no ghost dead-letter created by an unknown-id retry",
      q.deadLetters().length === 0,
      `deadLetters().length=${q.deadLetters().length}`,
    );
    q.purge("pending");
    q.purge("dead");
    q.close();
  }

  console.log("\n=== MongoDB Queue.purge(status) returns real count ===\n");

  // ── Positive: purge("pending") returns the deleted count ────────────
  {
    const q = await newTopic();
    q.push({ n: 1 });
    q.push({ n: 2 });
    q.push({ n: 3 });
    const primed = q.size("pending");
    assert("prime: 3 pending", primed === 3, `size(pending)=${primed}`);

    const removed = q.purge("pending");
    assert(
      "purge('pending') returns the deleted count",
      removed === 3,
      `removed=${removed} -- pre-3.13.105 returned 0/undefined`,
    );
    assert(
      "pending is empty after purge",
      q.size("pending") === 0,
      `size(pending)=${q.size("pending")}`,
    );
    q.purge("dead");
    q.close();
  }

  // ── Negative: purge("pending") does NOT touch dead letters ──────────
  {
    const q = await newTopic();
    deadLetterOne(q); // 1 dead letter
    q.push({ n: "keep-pending" }); // 1 fresh pending
    assert("prime: 1 pending", q.size("pending") === 1);
    assert("prime: 1 dead", q.deadLetters().length === 1);

    q.purge("pending");

    assert(
      "purge('pending') removed the pending doc",
      q.size("pending") === 0,
      `size(pending)=${q.size("pending")}`,
    );
    assert(
      "purge('pending') must NOT touch dead letters",
      q.deadLetters().length === 1,
      `deadLetters().length=${q.deadLetters().length} -- purge must be status-scoped`,
    );
    q.purge("dead");
    q.close();
  }

  // ── Positive: purge('dead') removes dead letters and returns count ──
  {
    const q = await newTopic();
    deadLetterOne(q);
    deadLetterOne(q);
    assert("prime: 2 dead", q.deadLetters().length === 2);

    const removed = q.purge("dead");
    assert(
      "purge('dead') returns the DL count",
      removed === 2,
      `removed=${removed} -- must route to the DL namespace`,
    );
    assert(
      "DL store empty after purge('dead')",
      q.deadLetters().length === 0,
      `deadLetters().length=${q.deadLetters().length}`,
    );
    q.close();
  }

  console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("UNCAUGHT", err);
  process.exit(1);
});

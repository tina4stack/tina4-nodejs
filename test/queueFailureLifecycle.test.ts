/**
 * queue_contract.json :: the-failure-lifecycle-is-real-everywhere
 *
 * MEASURED 2026-08-04, and this invariant was OWED with no suite at all -
 * which is why every defect it covers shipped.
 *
 * The rule: a job's failure reaches the backend on EVERY provider, and a job
 * past maxRetries becomes observable through deadLetters() on EVERY provider.
 * A dead-letter handler written against the file backend must find the same
 * jobs after deploying onto Mongo.
 *
 * What was measured in NODE before the fix:
 *
 *   pop()/popById() returned the external backend's job UNWRAPPED - plain data
 *   with no lifecycle methods - so `queue.pop().fail("boom")` threw
 *   "TypeError: j.fail is not a function" on mongodb while working perfectly on
 *   file. Identical application code, different outcome, and the failure is at
 *   the JOB level so no amount of Queue-surface testing catches it. consume()
 *   already wrapped correctly, which is exactly why the bug hid.
 *
 *   mongodb failed() queried status="failed", which nothing ever writes: the
 *   fail branch re-queues a still-retryable job as "pending" and dead-letters
 *   an exhausted one as "dead". So it returned [] forever, and an empty list is
 *   indistinguishable from "nothing has failed" (ADR-0022 decision 7).
 *
 * NODE'S BROKER CASES DIFFER BY DESIGN. Per ADR-0022 decision 8 this framework
 * REFUSES rabbitmq and kafka outright at construction - a deliberate holding
 * position, chosen over documenting an at-most-once footgun, pending a
 * persistent connection. So "the failure must reach the configured backend"
 * is proved here against mongodb (the external backend Node does offer), and
 * "a backend that cannot enumerate retryable failures refuses by name" is
 * satisfied at construction rather than per-operation. The refusal still names
 * the backend, which is what invariant 6 requires.
 *
 * NO MOCKS. Every assertion drives a live MongoDB over TCP. If it is
 * unreachable the file skips, unless TINA4_REQUIRE_SERVICES is set - then a
 * missing service is a FAILURE, because a suite that silently skips its only
 * real verification is not verification.
 *
 * The case names here are shared VERBATIM with the Python, PHP and Ruby
 * suites, because scripts/audit-contract-fixtures.py resolves ONE fixture case
 * against EVERY framework's file.
 */
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolved from THIS file, never hardcoded - an absolute developer-machine path
// passes locally and dies with ERR_MODULE_NOT_FOUND on every other host.
const CORE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "core", "src", "index.ts"),
).href;

const HOST = process.env.TINA4_TEST_MONGO_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TINA4_TEST_MONGO_PORT ?? "27017");
const MAX_RETRIES = 2;

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

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

async function run() {
  if (!(await reachable(HOST, PORT))) {
    const why = `MongoDB is not reachable at ${HOST}:${PORT}`;
    if (process.env.TINA4_REQUIRE_SERVICES) {
      console.error(`UNEXPECTED ERROR: TINA4_REQUIRE_SERVICES is set but ${why}`);
      process.exit(1);
    }
    console.log(`  SKIP ${why}`);
    process.exit(0);
  }

  process.env.TINA4_MONGO_URI = `mongodb://${HOST}:${PORT}`;
  process.env.TINA4_QUEUE_PATH = mkdtempSync(join(tmpdir(), "faillc"));

  const core: any = await import(CORE);

  // A FRESH queue per call, deliberately. Reusing one instance across a loop is
  // how the surface-invariant test once passed with its fix reverted: an
  // earlier call had already connected, so the defect could not reproduce.
  const makeQueue = (backend: string) =>
    new core.Queue({
      topic: `faillc_${Math.floor(Math.random() * 2 ** 32).toString(16)}`,
      backend,
      maxRetries: MAX_RETRIES,
    });

  const drainFail = async (queue: any, times: number, prefix = "boom") => {
    for (let attempt = 1; attempt <= times; attempt++) {
      const job = queue.pop();
      if (!job) break;
      job.fail(`${prefix}-${attempt}`);
      await sleep(0.3);
    }
  };

  // Both backends implement the full lifecycle, so both must answer
  // identically. That equality IS the invariant - testing one proves nothing
  // about the swap.
  for (const backend of ["file", "mongodb"]) {
    console.log(`\n=== ${backend} ===`);

    // ── a failed job under max retries is retried rather than dead lettered ──
    {
      const queue = makeQueue(backend);
      queue.push({ m: "transient" });
      await sleep(0.4);
      const job = queue.pop();
      job?.fail("boom-1");
      await sleep(0.4);
      // THE defect class this invariant was owed for: a failed() that can never
      // match returns [] forever, and asserting only "not dead-lettered" would
      // still pass with that bug. The job must be positively REPORTABLE.
      assert(
        `a failed job under max retries is retried rather than dead lettered [${backend}]`,
        job != null &&
          queue.deadLetters().length === 0 &&
          queue.failed().length === 1 &&
          queue.pop() != null,
        `dead=${queue.deadLetters().length} failed=${queue.failed().length}`,
      );
    }

    // ── a job past max retries becomes a dead letter ────────────────────────
    {
      const queue = makeQueue(backend);
      queue.push({ m: "poison" });
      await sleep(0.4);
      await drainFail(queue, MAX_RETRIES);
      await sleep(0.4);
      assert(
        `a job past max retries becomes a dead letter [${backend}]`,
        queue.deadLetters().length === 1 && queue.pop() == null,
        `dead=${queue.deadLetters().length}`,
      );
    }

    // ── a dead letter carries the attempt count and the failure reason ──────
    {
      const queue = makeQueue(backend);
      queue.push({ m: "poison" });
      await sleep(0.4);
      await drainFail(queue, MAX_RETRIES);
      await sleep(0.4);
      const dead = queue.deadLetters();
      // A dead-letter handler exists to answer "what died, why, and after how
      // many tries". One that cannot answer that is a row in a table.
      assert(
        `a dead letter carries the attempt count and the failure reason [${backend}]`,
        dead.length === 1 &&
          dead[0].attempts === MAX_RETRIES &&
          dead[0].error === `boom-${MAX_RETRIES}`,
        `attempts=${dead[0]?.attempts} error=${JSON.stringify(dead[0]?.error)}`,
      );
    }

    // ── a completed job never appears in dead letters ───────────────────────
    {
      const queue = makeQueue(backend);
      queue.push({ m: "healthy" });
      await sleep(0.4);
      const job = queue.pop();
      job?.complete();
      await sleep(0.4);
      // CONTROL: without this, "return every job ever seen" passes the rest.
      assert(
        `a completed job never appears in dead letters [${backend}]`,
        job != null && queue.deadLetters().length === 0 && queue.failed().length === 0,
        `dead=${queue.deadLetters().length} failed=${queue.failed().length}`,
      );
    }

    // ── reading dead letters does not consume them ──────────────────────────
    {
      const queue = makeQueue(backend);
      queue.push({ m: "poison" });
      await sleep(0.4);
      await drainFail(queue, MAX_RETRIES);
      await sleep(0.4);
      // deadLetters() is what a dashboard or health check calls on a timer. A
      // read that mutated would destroy - or endlessly multiply - the backlog
      // it reports on.
      const counts = [
        queue.deadLetters().length,
        queue.deadLetters().length,
        queue.deadLetters().length,
      ];
      assert(
        `reading dead letters does not consume them [${backend}]`,
        counts.every((c) => c === 1),
        `counts=${JSON.stringify(counts)}`,
      );
    }
  }

  // ── failing a job reaches the configured backend and not just local memory ─
  //
  // Node's brokers are refused at construction, so mongodb IS the external
  // backend here - and it is exactly where the defect lived: pop() returned
  // plain data, so job.fail() was a TypeError off the local file store.
  console.log("\n=== reaches the configured backend ===");
  {
    const queue = makeQueue("mongodb");
    queue.push({ m: "poison" });
    await sleep(0.4);
    const job = queue.pop();
    let threw: string | null = null;
    try {
      job.fail("boom-1");
    } catch (e: any) {
      threw = String(e?.message ?? e);
    }
    await sleep(0.4);
    const redelivered = queue.pop();
    assert(
      "failing a job reaches the configured backend and not just local memory",
      threw === null && redelivered != null && redelivered.attempts === 1,
      `threw=${JSON.stringify(threw)} attempts=${redelivered?.attempts}`,
    );
  }

  // ── a backend that cannot enumerate retryable failures refuses by name ────
  //
  // Node's half of invariant 6. Per ADR-0022 decision 8 the brokers are
  // refused OUTRIGHT at construction, so there is no code path on which a
  // caller reaches failed() and receives a misleading empty list.
  console.log("\n=== refusal ===");
  {
    const refused: string[] = [];
    for (const backend of ["rabbitmq", "kafka"]) {
      try {
        const q = new core.Queue({ topic: "faillc_refusal", backend, maxRetries: MAX_RETRIES });
        q.failed();
      } catch (e: any) {
        if (String(e?.message ?? e).toLowerCase().includes(backend)) refused.push(backend);
      }
    }
    assert(
      "a backend that cannot enumerate retryable failures refuses by name",
      refused.length === 2,
      `only refused (naming themselves): ${JSON.stringify(refused)}`,
    );
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("UNEXPECTED ERROR:", e);
  process.exit(1);
});

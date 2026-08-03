/**
 * queue_contract.json :: priority-and-availability-are-honoured
 *
 * MEASURED 2026-08-03: push(payload, delay, priority) was honoured ONLY on the
 * file backend. An urgent job queued behind a backlog waited for all of it in
 * production, while development on the file backend prioritised correctly.
 *
 * Node's Mongo pop sort has always been { priority: -1, createdAt: 1 } - the
 * ordering was right all along. Priority simply never ARRIVED: the QueueBackend
 * interface declared push(queue, payload, delay?) with no priority parameter at
 * all, and Queue.push passed priority only to liteBackend. So the sort ordered
 * on a field no document carried.
 *
 * The fix splits by what each backend can actually do:
 *   file      already correct - highest priority first, ties oldest-first.
 *   mongodb   implemented - priority now reaches the backend and is stored.
 *   rabbitmq  refused outright at construction (ADR-0022).
 *   kafka     refused outright at construction (ADR-0022).
 *
 * Per queue invariant 6, a backend that genuinely cannot perform an operation
 * refuses naming itself. It may never silently no-op. Node satisfies that half
 * by refusing those backends entirely, so a prioritised push to a broker that
 * cannot prioritise is unreachable by construction.
 *
 * The AVAILABILITY half of this invariant is proved by the
 * delay-is-honoured-on-every-backend cases and is not duplicated here.
 *
 * NO MOCKS. Every assertion drives a live MongoDB over TCP. If it is
 * unreachable the file skips, unless TINA4_REQUIRE_SERVICES is set - then a
 * missing service is a FAILURE.
 *
 * The three case names here are shared VERBATIM with the Python, PHP and Ruby
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

const payloadOf = (job: any) => {
  const p = job?.payload ?? job;
  return p?.m;
};

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
  process.env.TINA4_QUEUE_PATH = mkdtempSync(join(tmpdir(), "qprio"));

  const core: any = await import(CORE);
  const mongoQueue = () =>
    new core.Queue({
      topic: `prio_${Math.floor(Math.random() * 2 ** 32).toString(16)}`,
      backend: "mongodb",
    });

  // ── a higher priority job is delivered before an older lower priority one ──
  //
  // The measured defect. LOW is pushed FIRST, so FIFO order and priority order
  // disagree - the only arrangement that can tell them apart.
  console.log("\n--- a higher priority job is delivered before an older lower priority one ---");
  {
    const queue = mongoQueue();
    queue.push({ m: "low" }, 0, 0);
    await sleep(0.5);                  // distinct createdAt, so FIFO is unambiguous
    queue.push({ m: "high" }, 0, 9);
    await sleep(1);

    const first = queue.pop();
    assert("a higher priority job is delivered before an older lower priority one",
      first != null && payloadOf(first) === "high",
      `delivered ${JSON.stringify(payloadOf(first))} first`);
  }

  // ── equal priority jobs are delivered oldest first ─────────────────────────
  //
  // NEGATIVE: pins the TIE-BREAK. Without it, "always deliver the newest job"
  // passes the case above while breaking FIFO for everything else. It also
  // proves both jobs come back at all, so this doubles as the control.
  console.log("\n--- equal priority jobs are delivered oldest first ---");
  {
    const queue = mongoQueue();
    queue.push({ m: "first" }, 0, 5);
    await sleep(0.5);
    queue.push({ m: "second" }, 0, 5);
    await sleep(1);

    const first = queue.pop();
    const second = queue.pop();
    assert("equal priority jobs are delivered oldest first",
      first != null && second != null &&
        payloadOf(first) === "first" && payloadOf(second) === "second",
      `got ${JSON.stringify([payloadOf(first), payloadOf(second)])}`);
  }

  // ── a backend that cannot prioritise refuses instead of dropping it ────────
  console.log("\n--- a backend that cannot prioritise refuses instead of dropping the priority ---");
  {
    const refused: string[] = [];
    for (const backend of ["rabbitmq", "kafka"]) {
      try {
        const queue = new core.Queue({ topic: "prio_refusal", backend });
        queue.push({ m: "high" }, 0, 9);
      } catch {
        refused.push(backend);
      }
    }
    assert("a backend that cannot prioritise refuses instead of dropping the priority",
      refused.length === 2,
      `only refused: ${JSON.stringify(refused)} - an accepted broker would drop the priority`);
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

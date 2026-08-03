/**
 * queue_contract.json :: delay-is-honoured-on-every-backend
 *
 * MEASURED 2026-08-03: push(payload, delay) was silently DROPPED on every
 * non-file backend, in ALL FOUR frameworks. A scheduled job fired immediately
 * in production and on time in development - the worst shape of divergence,
 * because the environment you test in is the one that behaves correctly.
 *
 * Node's Mongo bug was its own shape. push() DID write a delayUntil, but the
 * pop filter put five conditions in ONE $or, which made them alternatives
 * rather than requirements:
 *
 *     $or: [ {availableAt: null}, {availableAt: {$exists: false}},
 *            {availableAt: {$lte: now}}, {delayUntil: null},
 *            {delayUntil: {$lte: now}} ]
 *
 * A freshly pushed delayed job has no availableAt, so it matched
 * { availableAt: { $exists: false } } and was handed straight to a consumer.
 * Availability is really TWO independent gates - the reservation gate and the
 * delay gate - and both must pass, so they are now $and-ed.
 *
 * Per queue invariant 6, a backend that genuinely cannot perform an operation
 * raises naming the backend AND the operation. It may never silently no-op.
 * Node satisfies that half differently from Python/PHP/Ruby: per ADR-0022 it
 * refuses the rabbitmq and kafka backends OUTRIGHT at construction, so a
 * delayed push to a broker that cannot delay is unreachable by construction.
 *
 * NO MOCKS. Every assertion drives a live MongoDB over TCP. If it is
 * unreachable the file skips, unless TINA4_REQUIRE_SERVICES is set - then a
 * missing service is a FAILURE, because a suite that silently skips its only
 * real verification is not verification.
 *
 * The four case names here are shared VERBATIM with the Python, PHP and Ruby
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

// Long enough that a dropped delay is unambiguous, short enough to keep the
// suite quick. A dropped delay shows up instantly, so this is no race.
const DELAY = 3;

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
  process.env.TINA4_QUEUE_PATH = mkdtempSync(join(tmpdir(), "qdelay"));

  const core: any = await import(CORE);
  const mongoQueue = () =>
    new core.Queue({
      topic: `delay_${Math.floor(Math.random() * 2 ** 32).toString(16)}`,
      backend: "mongodb",
    });

  // ── an undelayed job is visible immediately ────────────────────────────────
  //
  // NEGATIVE: without this pair, "never return anything" passes both delay
  // cases below. It also proves the queue itself works, so a failure there is
  // really about the delay and not about a broken backend.
  console.log("\n--- an undelayed job is visible immediately ---");
  {
    const queue = mongoQueue();
    queue.push({ m: "undelayed" }, 0, 0);
    await sleep(1);
    assert("an undelayed job is visible immediately", queue.pop() != null,
      "an undelayed job must be available at once");
  }

  // ── a delayed job is not visible before its delay elapses ──────────────────
  //
  // The measured defect: this job used to come straight back.
  console.log("\n--- a delayed job is not visible before its delay elapses ---");
  {
    const queue = mongoQueue();
    queue.push({ m: "delayed" }, DELAY, 0);
    await sleep(1);
    assert("a delayed job is not visible before its delay elapses", queue.pop() == null,
      "a delayed job must not be claimable before its delay");
  }

  // ── a delayed job becomes visible once its delay elapses ───────────────────
  //
  // NEGATIVE of the negative: "hide it forever" would satisfy the case above
  // while losing the job outright. The delay must expire.
  console.log("\n--- a delayed job becomes visible once its delay elapses ---");
  {
    const queue = mongoQueue();
    queue.push({ m: "delayed" }, DELAY, 0);
    await sleep(DELAY + 2);
    assert("a delayed job becomes visible once its delay elapses", queue.pop() != null,
      "a delayed job must be claimable after its delay");
  }

  // ── a backend that cannot delay refuses instead of dropping the delay ──────
  //
  // Node's half of invariant 6: rabbitmq and kafka have no per-message delay,
  // and Node refuses those backends outright (ADR-0022), so there is no code
  // path on which a delay reaches them and is discarded.
  console.log("\n--- a backend that cannot delay refuses instead of dropping the delay ---");
  {
    const refused: string[] = [];
    for (const backend of ["rabbitmq", "kafka"]) {
      try {
        const queue = new core.Queue({ topic: "delay_refusal", backend });
        queue.push({ m: "delayed" }, DELAY, 0);
      } catch {
        refused.push(backend);
      }
    }
    assert("a backend that cannot delay refuses instead of dropping the delay",
      refused.length === 2,
      `only refused: ${JSON.stringify(refused)} - an accepted broker would drop the delay`);
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

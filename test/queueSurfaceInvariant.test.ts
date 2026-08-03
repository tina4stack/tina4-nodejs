/**
 * queue_contract.json :: every-method-exists-on-every-backend
 *
 * RULE: every public Queue method RESOLVES and runs on every configured
 * backend. No method may be a fatal error or an undefined function on any
 * backend the framework OFFERS.
 *
 * This is not the same rule as invariant 6. Invariant 6 says an operation a
 * backend cannot perform must throw naming itself. Invariant 1 says the method
 * must EXIST to do the throwing. A named refusal satisfies both; a
 * "x is not a function" satisfies neither.
 *
 * ── Node and the two brokers ──────────────────────────────────────────────
 *
 * Node's rabbitmq and kafka backends THROW AT CONSTRUCTION. The fixture
 * originally recorded that as a violation of this invariant. It is NOT.
 * ADR-0022 decision 8 settles it deliberately:
 *
 *   "A backend that cannot keep decision 1 is REFUSED, not documented. Node's
 *    RabbitMQ and Kafka backends now THROW on construction, naming the cause
 *    and pointing here. Documenting them as at-most-once was considered and
 *    rejected. A data-loss footgun with a paper trail is still a data-loss
 *    footgun."
 *
 * The ADR marks this a HOLDING POSITION, not the settled design - the fix is a
 * persistent connection on the backend instance, as Python/PHP/Ruby have. So
 * "the method resolves on every backend the framework OFFERS" is the honest
 * reading, and a backend Node deliberately does not offer must refuse BY NAME
 * at construction rather than half-working. This file asserts exactly that.
 *
 * NO MOCKS. Every assertion drives a live MongoDB over TCP. If it is
 * unreachable the file skips, unless TINA4_REQUIRE_SERVICES is set.
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

// Every public Queue method that needs no live job to exercise.
const METHODS: Record<string, (q: any) => unknown> = {
  size: (q) => q.size(),
  popBatch: (q) => q.popBatch(1),
  popById: (q) => q.popById("nope"),
  failed: (q) => q.failed(),
  deadLetters: (q) => q.deadLetters(),
  retry: (q) => q.retry(),
  retryFailed: (q) => q.retryFailed(),
  purge: (q) => q.purge("completed"),
  clear: (q) => q.clear(),
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
  process.env.TINA4_QUEUE_PATH = mkdtempSync(join(tmpdir(), "qsurf"));

  const core: any = await import(CORE);
  const queue = (backend: string) =>
    new core.Queue({
      topic: `surf_${Math.floor(Math.random() * 2 ** 32).toString(16)}`,
      backend,
    });

  // ── every public queue method resolves on every backend ────────────────────
  //
  // A method must never be ABSENT. "is not a function" means the call site
  // cannot even reach a refusal - the upgrade path is severed rather than
  // degraded, which is the exact scenario ADR-0024 exists to prevent.
  console.log("\n--- every public queue method resolves on every backend ---");
  {
    const unresolved: string[] = [];
    // Each method is exercised TWICE. FRESH catches a method that never
    // initialises what it uses; SHARED catches state a previous call left
    // behind. The two modes found different real bugs in the sibling
    // frameworks, so both are kept here.
    for (const backend of ["file", "mongodb"]) {
      for (const mode of ["fresh", "shared"]) {
      const sharedQ = mode === "shared" ? queue(backend) : null;
      for (const [name, call] of Object.entries(METHODS)) {
        const q = sharedQ ?? queue(backend);
        try {
          call(q);
        } catch (e: any) {
          const m = String(e?.message ?? e);
          // Only an absent method violates THIS invariant. A named refusal or
          // any runtime failure means the method resolved.
          if (/is not a function|undefined is not/i.test(m)) {
            unresolved.push(`${backend}.${name} (${mode}) - ${m}`);
          }
        }
      }
      }
    }
    assert("every public queue method resolves on every backend",
      unresolved.length === 0, `methods that do not resolve: ${JSON.stringify(unresolved)}`);
  }

  // ── a backend that cannot answer a question refuses by name ────────────────
  //
  // Node's half of the rule: a backend it does not offer refuses BY NAME at
  // construction (ADR-0022 decision 8), naming the backend so the operator can
  // act, rather than constructing a half-working queue that loses jobs.
  console.log("\n--- a backend that cannot answer a question refuses by name instead of lying ---");
  {
    const named: string[] = [];
    for (const backend of ["rabbitmq", "kafka"]) {
      try {
        queue(backend);
      } catch (e: any) {
        if (String(e?.message ?? e).includes(backend)) named.push(backend);
      }
    }
    assert("a backend that cannot answer a question refuses by name instead of lying",
      named.length === 2,
      `only these refused by name: ${JSON.stringify(named)}`);
  }

  // ── a supported method returns a real answer rather than a refusal ─────────
  //
  // NEGATIVE: without this, "make every method throw a named refusal" would
  // satisfy both cases above while breaking the whole queue.
  console.log("\n--- a supported method returns a real answer rather than a refusal ---");
  {
    const problems: string[] = [];
    for (const backend of ["file", "mongodb"]) {
      const q = queue(backend);
      if (typeof q.size() !== "number") problems.push(`${backend}.size`);
      if (!Array.isArray(q.failed())) problems.push(`${backend}.failed`);
      if (!Array.isArray(q.deadLetters())) problems.push(`${backend}.deadLetters`);
    }
    assert("a supported method returns a real answer rather than a refusal",
      problems.length === 0, `did not answer: ${JSON.stringify(problems)}`);
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

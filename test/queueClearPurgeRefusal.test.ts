/**
 * clear()/purge() on a broker backend class refuse by name (ADR-0022, invariant 6).
 *
 * MEASURED 2026-08-07: the exported RabbitMQBackend.clear() DRAINED the live
 * broker queue (execSync("purge", queue) -> Queue.Purge), destroying every
 * pending job, and KafkaBackend.clear() was a silent no-op. Neither backend had
 * a purge() at all. The Queue FACADE already refuses backend "rabbitmq"/"kafka"
 * at construction (ADR-0022 decision 8), but RabbitMQBackend and KafkaBackend
 * stay EXPORTED so the persistent-connection rewrite has something to build on -
 * so a developer importing the class directly could still silently no-op or
 * drain a live queue.
 *
 * ADR-0022: "a broker that cannot address messages by status refuses the
 * operation by name." clear() and purge(status) are status-addressed. This
 * brings the Node backend classes in line with PHP, Python and Ruby, where the
 * backend itself refuses by name: both clear() and purge() now THROW naming the
 * backend AND the operation.
 *
 * NO MOCKS and NO BROKER. Both backend constructors are connection-free (they
 * resolve config from env/args only; Node runs each real operation in a child
 * process), and clear()/purge() throw BEFORE any child process is spawned - so
 * constructing the real class and calling the real method is a complete, local,
 * red-first test. The file backend is the negative control: it CAN address by
 * status, so its clear()/purge() must still answer for real.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolved from THIS file, never hardcoded - an absolute developer-machine path
// passes locally and dies with ERR_MODULE_NOT_FOUND on every other host.
const CORE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "core", "src", "index.ts"),
).href;

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

function refusalOf(fn: () => unknown): { threw: boolean; message: string } {
  try {
    fn();
    return { threw: false, message: "" };
  } catch (e: any) {
    return { threw: true, message: String(e?.message ?? e) };
  }
}

async function run() {
  const core: any = await import(CORE);

  // ── POSITIVE: broker backend classes refuse clear()/purge() by name ─────────
  // Constructors are connection-free, so this needs no live broker.
  console.log("\n--- a broker backend class refuses clear()/purge() by name ---");
  const brokers: Array<[string, any]> = [
    ["kafka", core.KafkaBackend],
    ["rabbitmq", core.RabbitMQBackend],
  ];
  for (const [name, Backend] of brokers) {
    const backend = new Backend();

    const clr = refusalOf(() => backend.clear("topic"));
    assert(
      `${name} backend clear() refuses by name instead of no-op/drain`,
      clr.threw &&
        clr.message.toLowerCase().includes(name) &&
        clr.message.toLowerCase().includes("clear"),
      clr.threw ? clr.message.slice(0, 90) : "it did NOT throw",
    );

    const prg = refusalOf(() => backend.purge("topic", "completed"));
    assert(
      `${name} backend purge() refuses by name instead of no-op/drain`,
      prg.threw &&
        prg.message.toLowerCase().includes(name) &&
        prg.message.toLowerCase().includes("purge"),
      prg.threw ? prg.message.slice(0, 90) : "it did NOT throw",
    );
  }

  // ── NEGATIVE control: the file backend CAN address by status, so it answers ──
  // Without this, making every clear()/purge() throw would pass the cases above
  // while breaking the whole queue. The file backend returns a real number and
  // never throws a refusal.
  console.log("\n--- the file backend still clears/purges for real (negative control) ---");
  delete process.env.TINA4_QUEUE_BACKEND;
  process.env.TINA4_QUEUE_PATH = mkdtempSync(join(tmpdir(), "qcp"));

  const clearResult = refusalOf(() =>
    new core.Queue({ topic: "neg_clear", backend: "file" }).clear(),
  );
  assert(
    "file backend clear() answers for real (a number, no refusal)",
    !clearResult.threw &&
      typeof new core.Queue({ topic: "neg_clear2", backend: "file" }).clear() === "number",
    clearResult.threw ? clearResult.message.slice(0, 90) : "",
  );

  const purgeResult = refusalOf(() =>
    new core.Queue({ topic: "neg_purge", backend: "file" }).purge("completed"),
  );
  assert(
    "file backend purge() answers for real (a number, no refusal)",
    !purgeResult.threw &&
      typeof new core.Queue({ topic: "neg_purge2", backend: "file" }).purge("completed") === "number",
    purgeResult.threw ? purgeResult.message.slice(0, 90) : "",
  );

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("UNEXPECTED ERROR:", e);
  process.exit(1);
});

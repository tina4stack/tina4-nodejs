/**
 * Real tests for the top-level `queue` CLI command (Phase 3, Node mirror).
 * Run with: npx tsx test/cliQueue.test.ts
 *
 * No mocks — every test drives the ACTUAL queue handlers against a REAL
 * file-backed @tina4/core Queue in a temp directory: push real jobs, run
 * work / stats / retry / clear, and assert the real on-disk counts and side
 * effects. `work` is exercised as a bounded single-pass drain (--once) running
 * a REAL consumer module (real per-job handler, real processing, real ack/fail)
 * — no mock and no leaked worker. Dispatch guards run the REAL bin.ts entrypoint
 * as a subprocess (they process.exit, so they cannot run in-process).
 *
 * Mirrors tina4-python/tests/test_cli_queue.py.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queueCommand, resolveQueueHandler } from "../packages/cli/src/commands/queue.ts";
import { Queue } from "../packages/core/src/queue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, "../packages/cli/src/bin.ts");

// Isolated, file-backed queue rooted under a temp dir. Absolute TINA4_QUEUE_PATH
// so cwd is irrelevant; loadEnv() is first-wins so it never clobbers these.
const baseTmp = mkdtempSync(join(tmpdir(), "tina4-cliqueue-"));
process.env.TINA4_QUEUE_BACKEND = "file";
process.env.TINA4_QUEUE_PATH = join(baseTmp, "queue");
process.chdir(baseTmp); // clean cwd → loadEnv() finds no project .env

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name} ${detail}`);
    fail++;
  }
}

/** Capture console.log emitted while an async fn runs. */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let buf = "";
  console.log = (...a: unknown[]) => { buf += a.map(String).join(" ") + "\n"; };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return buf;
}

/** Write a REAL consumer module exposing topic + a per-job handle (side effect on disk). */
function writeConsumer(servicesDir: string, topic: string, resultsFile: string): void {
  mkdirSync(servicesDir, { recursive: true });
  const src =
    `import { appendFileSync } from "node:fs";\n` +
    `const RESULTS = ${JSON.stringify(resultsFile)};\n` +
    `export function handle(payload) {\n` +
    `  if (payload && payload.boom) throw new Error("boom");\n` +
    `  appendFileSync(RESULTS, String(payload.n) + "\\n");\n` +
    `}\n` +
    `export function consume() {}\n` +
    `export default { name: ${JSON.stringify(topic + "-consumer")}, ` +
    `topic: ${JSON.stringify(topic)}, handler: consume, handle, daemon: true };\n`;
  writeFileSync(join(servicesDir, `${topic}_consumer.ts`), src, "utf-8");
}

console.log("=== CLI `queue` Command Tests (real file-backed Queue) ===\n");

// ── stats ────────────────────────────────────────────────────────────
console.log("--- queue stats ---");
{
  const q = new Queue({ topic: "emails" });
  q.push({ n: 1 }); q.push({ n: 2 }); q.push({ n: 3 });
  const out = await captureLog(() => queueCommand(["stats", "emails"]));
  assert("stats reports real pending count", out.includes("pending    3"), out);
}
{
  new Queue({ topic: "emails_json" }).push({ n: 1 });
  const out = await captureLog(() => queueCommand(["stats", "emails_json", "--json"]));
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(out); } catch { /* stays null */ }
  assert("stats --json is machine-readable + exact",
    parsed !== null &&
    parsed.topic === "emails_json" && parsed.pending === 1 && parsed.reserved === 0 &&
    parsed.failed === 0 && parsed.dead === 0 && parsed.completed === 0,
    out);
}
{
  // A job that exhausts its single retry is dead-lettered for real.
  const q = new Queue({ topic: "emails_dead", maxRetries: 1 });
  q.push({ n: 1 });
  q.pop()!.fail("boom"); // attempts 1 >= maxRetries 1 → dead-letter
  const out = await captureLog(() => queueCommand(["stats", "emails_dead", "--json"]));
  const parsed = JSON.parse(out) as { dead: number };
  assert("stats counts dead-letter jobs", parsed.dead === 1, out);
}
{
  new Queue({ topic: "default" }).push({ n: 1 });
  const out = await captureLog(() => queueCommand(["stats"]));
  assert("stats defaults to the 'default' topic",
    out.includes("Queue 'default'") && out.includes("pending    1"), out);
}

// ── retry ──────────────────────────────────────────────────────────────
console.log("\n--- queue retry ---");
{
  const q = new Queue({ topic: "jobs", maxRetries: 1 });
  q.push({ n: 1 });
  q.pop()!.fail("boom"); // → dead-letter
  assert("retry: precondition dead == 1", q.size("dead") === 1);

  const out = await captureLog(() => queueCommand(["retry", "jobs"]));
  assert("retry re-queues the dead-letter job", out.includes("Re-queued 1 job(s)"), out);
  // Real files moved out of the dead-letter store back to pending.
  assert("retry: job back in pending", new Queue({ topic: "jobs" }).size("pending") === 1);
  assert("retry: dead store now empty", new Queue({ topic: "jobs" }).size("dead") === 0);
}
{
  const out = await captureLog(() => queueCommand(["retry", "jobs_empty"]));
  assert("retry with nothing to retry is zero", out.includes("Re-queued 0 job(s)"), out);
}

// ── clear ──────────────────────────────────────────────────────────────
console.log("\n--- queue clear ---");
{
  const q = new Queue({ topic: "tasks" });
  q.push({ n: 1 }); q.push({ n: 2 });
  assert("clear: precondition pending == 2", q.size("pending") === 2);

  const out = await captureLog(() => queueCommand(["clear", "pending", "tasks"]));
  assert("clear pending purges real jobs", out.includes("Cleared 2 'pending' job(s)"), out);
  assert("clear: pending now empty", new Queue({ topic: "tasks" }).size("pending") === 0);
}
{
  new Queue({ topic: "tasks_intact" }).push({ n: 1 });
  const out = await captureLog(() => queueCommand(["clear"])); // status=completed, topic=default
  assert("clear defaults to completed + default topic", out.includes("Cleared 0 'completed' job(s)"), out);
  // A completed-clear on the default topic leaves another topic intact.
  assert("clear: other topic intact", new Queue({ topic: "tasks_intact" }).size("pending") === 1);
}
{
  const q = new Queue({ topic: "tasks_dead", maxRetries: 1 });
  q.push({ n: 1 });
  q.pop()!.fail("boom"); // → dead-letter
  assert("clear-dead: precondition dead == 1", q.size("dead") === 1);
  const out = await captureLog(() => queueCommand(["clear", "dead", "tasks_dead"]));
  assert("clear dead-letter purges", out.includes("Cleared 1 'dead' job(s)"), out);
  assert("clear-dead: dead store empty", new Queue({ topic: "tasks_dead" }).size("dead") === 0);
}

// ── work (bounded --once drain, REAL consumer) ─────────────────────────
console.log("\n--- queue work --once (real consumer, real side effect) ---");
{
  const services = join(baseTmp, "svc_greet");
  const results = join(baseTmp, "results_greet.txt");
  writeConsumer(services, "greetings", results);

  const q = new Queue({ topic: "greetings" });
  q.push({ n: 1 }); q.push({ n: 2 }); q.push({ n: 3 });

  const out = await captureLog(() =>
    queueCommand(["work", "greetings", "--once", "--services", services]));

  assert("work --once processed 3 jobs", out.includes("Processed 3 job(s), 0 failed"), out);
  // The REAL handler ran for every job (real side effect on disk).
  const written = readFileSync(results, "utf-8").split(/\s+/).filter(Boolean).sort();
  assert("work --once: real handler ran for every job",
    JSON.stringify(written) === JSON.stringify(["1", "2", "3"]), written.join(","));
  assert("work --once: pending drained", new Queue({ topic: "greetings" }).size("pending") === 0);
}
{
  const services = join(baseTmp, "svc_poison");
  const results = join(baseTmp, "results_poison.txt");
  writeConsumer(services, "poison", results);

  const q = new Queue({ topic: "poison" });
  q.push({ n: 1 });       // good
  q.push({ boom: true });  // poison — handler throws

  const out = await captureLog(() =>
    queueCommand(["work", "poison", "--once", "--services", services]));

  // Good job processed; poison job burned its retries → dead-letter (bounded).
  const written = readFileSync(results, "utf-8").split(/\s+/).filter(Boolean);
  assert("work --once: good job processed, poison did not write",
    JSON.stringify(written) === JSON.stringify(["1"]), written.join(","));
  assert("work --once: poison job dead-lettered for real",
    new Queue({ topic: "poison" }).size("dead") === 1);
  assert("work --once: reports Processed 1", out.includes("Processed 1 job(s)"), out);
}
{
  new Queue({ topic: "orphans" }).push({ n: 1 });
  const out = await captureLog(() =>
    queueCommand(["work", "orphans", "--once", "--services", join(baseTmp, "nope")]));
  assert("work: no-handler warns loud", out.includes("No consumer handler found"), out);
  assert("work: no-handler still drains (consume + ack)", out.includes("Processed 1 job(s)"), out);
  assert("work: orphan topic drained", new Queue({ topic: "orphans" }).size("pending") === 0);
}

// ── resolveQueueHandler ────────────────────────────────────────────────
console.log("\n--- resolveQueueHandler ---");
{
  const missing = await resolveQueueHandler(join(baseTmp, "does_not_exist"), "x");
  assert("resolveQueueHandler: null when dir missing", missing === null);

  const services = join(baseTmp, "svc_resolve");
  writeConsumer(services, "greetings", join(baseTmp, "r.txt"));
  const found = await resolveQueueHandler(services, "greetings");
  assert("resolveQueueHandler: finds handler by topic", typeof found === "function");
  const wrong = await resolveQueueHandler(services, "other");
  assert("resolveQueueHandler: null for a non-matching topic", wrong === null);
}

// ── dispatch guards (REAL subprocess — they process.exit) ──────────────
console.log("\n--- queue dispatch guards (real bin.ts subprocess) ---");
function runQueue(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", binPath, "queue", ...args], {
      cwd: baseTmp, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000,
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}
{
  const { code, out } = runQueue([]);
  assert("no subcommand exits non-zero", code === 1, `exit ${code}`);
  assert("no subcommand prints usage", out.includes("work") && out.includes("Usage"), out);
}
{
  const { code, out } = runQueue(["frobnicate"]);
  assert("unknown subcommand exits non-zero", code === 1, `exit ${code}`);
  assert("unknown subcommand names itself", out.includes("Unknown queue subcommand"), out);
}

// ── Summary ─────────────────────────────────────────────────────────
try { rmSync(baseTmp, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

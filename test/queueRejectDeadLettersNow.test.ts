/**
 * Tina4 — Queue job.reject() dead-letters IMMEDIATELY, no retry (ADR-0023).
 *
 * Bug 4 (book review). createJob().reject() was a literal alias for fail()
 * (`reject(reason) { job.fail(reason); }`). ADR-0023 (Accepted) redefines
 * reject: it is the "this message is poison, do NOT retry it" path — the job
 * goes straight to the dead-letter store on this call, without burning the
 * retry budget. AMQP basic.reject(requeue=false) semantics.
 *
 * Pins BOTH sides on the same maxRetries=3 file-backed queue:
 *   reject -> dead-lettered NOW (1 delivery), never re-queued
 *   fail   -> re-queued, still pending, NOT dead-lettered (control)
 *
 * NO MOCKS, NO BROKER: real file backend on a temp dir.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CORE = pathToFileURL(
  join(import.meta.dirname, "..", "packages", "core", "src", "index.ts"),
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

async function run() {
  const core: any = await import(CORE);
  const newQueue = () => {
    const dir = mkdtempSync(join(tmpdir(), "tina4_reject_"));
    return new core.Queue({ topic: `reject_${Math.random().toString(16).slice(2, 10)}`, backend: "file", maxRetries: 3, path: dir });
  };

  console.log("\n--- reject() dead-letters immediately (ADR-0023) ---");
  {
    const q = newQueue();
    q.push({ task: "poison" });
    const job = q.pop();
    job.reject("payload will never parse");
    assert("reject() dead-letters on this call, not after maxRetries", q.deadLetters().length === 1);
    assert("size('dead') counts the rejected job", q.size("dead") === 1);
    assert("a rejected job is NOT re-queued (pending=0)", q.size("pending") === 0);
    assert("dead letter carries the reason", q.deadLetters()[0]?.error === "payload will never parse");
  }

  console.log("\n--- control: fail() with retries left re-queues, does NOT dead-letter ---");
  {
    const q = newQueue();
    q.push({ task: "transient" });
    q.pop().fail("temporary blip");
    assert("fail() under maxRetries does NOT dead-letter", q.size("dead") === 0);
    assert("fail() under maxRetries re-queues as pending", q.size("pending") === 1);
  }

  console.log("\n--- a rejected job is never redelivered to pop() ---");
  {
    const q = newQueue();
    q.push({ task: "poison" });
    q.pop().reject("nope");
    assert("pop() returns null after reject", q.pop() === null);
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

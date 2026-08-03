/**
 * queue_contract.json :: an-unsupported-operation-raises-naming-itself
 *
 * A typo in TINA4_QUEUE_BACKEND must not produce a running app writing every job
 * to local disk.
 *
 * MEASURED 2026-08-03: Node and PHP accepted ANY string as a backend name and
 * silently fell through to the local file store. Python and Ruby already raised,
 * naming the valid set - so this was a two-of-four divergence on a rule the
 * SESSION backend had already adopted for exactly the same reason.
 *
 * The failure mode is the one that costs most: nothing errors, the app looks
 * healthy, and every job goes to a container filesystem that nothing consumes
 * and that vanishes on the next deploy.
 *
 * The case names here are shared verbatim with the Python, Ruby and PHP suites,
 * because scripts/audit-contract-fixtures.py resolves ONE fixture case against
 * EVERY framework's file.
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

async function run() {
  const core: any = await import(CORE);
  delete process.env.TINA4_QUEUE_BACKEND;
  process.env.TINA4_QUEUE_PATH = mkdtempSync(join(tmpdir(), "qbv"));

  const construct = (backend: string): { ok: boolean; message: string } => {
    try {
      new core.Queue({ topic: "validation", backend });
      return { ok: true, message: "" };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  };

  // ── an unknown queue backend raises instead of silently using file ─────────
  console.log("\n--- an unknown queue backend raises instead of silently using file ---");
  const bogus = construct("totally-bogus-backend");
  assert("an unknown queue backend raises instead of silently using file",
    !bogus.ok, "it was accepted, so the job would go to local disk");

  // The message must name the offending value AND the valid set, so the operator
  // can fix it without reading the source.
  assert("the unknown backend error names the value and the valid set",
    bogus.message.includes("totally-bogus-backend") &&
      ["file", "rabbitmq", "kafka", "mongodb"].every((v) => bogus.message.includes(v)),
    bogus.message);

  // ── a queue backend name is normalised before it is resolved ───────────────
  //
  // " file " is the same backend as "file". Without this, a stray space in a
  // .env turns a valid configuration into the raise above - trading a silent bug
  // for a loud one rather than fixing it.
  console.log("\n--- a queue backend name is normalised before it is resolved ---");
  const normalised = [" file ", "FILE", "File", " lite", "DEFAULT"];
  const rejected = normalised.filter((s) => !construct(s).ok);
  assert("a queue backend name is normalised before it is resolved",
    rejected.length === 0, `rejected: ${JSON.stringify(rejected)}`);

  // NEGATIVE: the guard must not swallow a genuinely valid external name.
  // Without this pair, "make everything throw" would pass the test above.
  process.env.TINA4_QUEUE_MONGO_URL = "mongodb://127.0.0.1:27017";
  const externals = ["mongodb", "mongo", "MongoDB"];
  const wronglyRejected = externals.filter((s) => !construct(s).ok);
  assert("the guard still accepts every documented backend name",
    wronglyRejected.length === 0, `rejected: ${JSON.stringify(wronglyRejected)}`);

  // NEGATIVE: a backend Node deliberately refuses (ADR-0022) must keep its OWN
  // message, not be swallowed by the generic unknown-backend text.
  for (const broker of ["rabbitmq", "kafka"]) {
    const r = construct(broker);
    assert(`a deliberately refused broker (${broker}) keeps its own message`,
      !r.ok && !r.message.includes("Unknown queue backend"), r.message.slice(0, 80));
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

/**
 * queue_contract.json :: operations-reach-the-configured-backend
 *
 * RULE: every operation acts on the CONFIGURED backend. No method may silently
 * read or write the local file store when another backend is selected.
 *
 * MEASURED 2026-08-03 on mongodb, before the fix: Node's popBatch() and
 * popById() called this.liteBackend unconditionally, so they read the LOCAL
 * FILE STORE and never saw a mongodb job at all. A consumer draining a
 * mongodb-backed queue in batches got nothing, forever, with no error.
 *
 * This is the worst failure class: the call appears to succeed and operates on
 * the wrong data, so nothing surfaces it.
 *
 * NO MOCKS. Live MongoDB over TCP; skips unless TINA4_REQUIRE_SERVICES is set.
 *
 * The three case names here are shared VERBATIM with the Python, PHP and Ruby
 * suites.
 */
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "core", "src", "index.ts"),
).href;

const HOST = process.env.TINA4_TEST_MONGO_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TINA4_TEST_MONGO_PORT ?? "27017");

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); }
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
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
  process.env.TINA4_QUEUE_PATH = mkdtempSync(join(tmpdir(), "qreach"));

  const core: any = await import(CORE);
  const mongoQueue = () => new core.Queue({
    topic: `reach_${Math.floor(Math.random() * 2 ** 32).toString(16)}`, backend: "mongodb" });

  // If clear() hits the file store, the mongodb jobs survive and size stays 2.
  console.log("\n--- clear acts on the configured backend not the local file store ---");
  {
    const q = mongoQueue();
    q.push({ m: "a" }, 0, 0); q.push({ m: "b" }, 0, 0);
    const seeded = q.size();
    q.clear();
    assert("clear acts on the configured backend not the local file store",
      seeded === 2 && q.size() === 0, `seeded ${seeded}, size after clear ${q.size()}`);
  }

  // popBatch is the recorded Node defect: it read local disk on every backend.
  console.log("\n--- pop by id claims the job from the configured backend ---");
  {
    const q = mongoQueue();
    const id = q.push({ m: "byid" }, 0, 0);
    const claimed = q.popById(id);

    const q2 = mongoQueue();
    q2.push({ m: "batch" }, 0, 0);
    const batch = q2.popBatch(1);

    assert("pop by id claims the job from the configured backend",
      claimed != null && Array.isArray(batch) && batch.length === 1,
      `popById ${claimed == null ? "got nothing" : "ok"}, popBatch got ${batch?.length ?? 0}`);
  }

  // Node refuses the brokers outright (ADR-0022), so no operation can ever be
  // answered from local disk while a broker is "configured".
  console.log("\n--- an operation the backend cannot perform refuses instead of silently using the file store ---");
  {
    const refused: string[] = [];
    for (const backend of ["rabbitmq", "kafka"]) {
      try {
        const q = new core.Queue({ topic: "reach_refusal", backend });
        q.popById("whatever");
      } catch (e: any) {
        if (String(e?.message ?? e).includes(backend)) refused.push(backend);
      }
    }
    assert("an operation the backend cannot perform refuses instead of silently using the file store",
      refused.length === 2, `only refused: ${JSON.stringify(refused)}`);
  }

  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error("UNEXPECTED ERROR:", e); process.exit(1); });

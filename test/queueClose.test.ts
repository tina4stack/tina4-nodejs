/**
 * Queue.close() - the connection an app opens must be one it can hand back.
 *
 * MEASURED 2026-08-04: close() was ABSENT on the top-level Queue class in ALL
 * FOUR frameworks. The backends below it were in four different states -
 *
 *   nodejs  nowhere on ANY backend class. Node was the worst of the four: not
 *           only was there no Queue.close(), there was nothing to delegate to.
 *   php     close() on the QueueBackend INTERFACE and all four backends,
 *           surfaced on nothing.
 *   ruby    close on rabbitmq/mongo/kafka, missing on lite, so every
 *           `respond_to?(:close)` guard silently skipped the DEFAULT backend.
 *   python  nowhere at all on the queue adapters.
 *
 * - so an application holding a broker- or Mongo-backed queue had NO WAY to
 * release the connection. That is the leak ADR-0025 corollary 4
 * (client-lifecycle-is-bounded) fixed in DocStore, where 20 getCollection()
 * calls left 40 server connections open and the count grew without bound.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE IN NODE - stated plainly, because a test
 * that overclaims is worse than no test:
 *
 *   CAN   - that close() exists on Queue and on every backend Queue can reach,
 *           that Queue delegates to the resolved backend, that a second call is
 *           safe, and that closing does not disturb a REAL Mongo topic or a
 *           REAL on-disk topic.
 *   CANNOT - that a live client handle is dropped, because in NODE there is no
 *           live client handle to drop. Per ADR-0022 the Mongo backend runs
 *           every operation in its own child process (which closes its own
 *           client in a `finally` before exiting) and rabbitmq/kafka are
 *           refused outright at construction. tina4-python, tina4-php and
 *           tina4-ruby hold a real long-lived client and their sibling suites
 *           assert the handle is actually released; here that assertion would
 *           be theatre. When the persistent-connection rewrite lands, the
 *           handle assertion belongs here too.
 *
 * NO MOCKS. Every assertion drives a live MongoDB over TCP or the real on-disk
 * store. There is no double, stub or spy anywhere in this file. If MongoDB is
 * unreachable the file skips, unless TINA4_REQUIRE_SERVICES is set - then a
 * missing service is a FAILURE, because a suite that silently skips its only
 * real verification is not verification.
 *
 * The three case names are shared VERBATIM with the Python, PHP and Ruby
 * suites, so one fixture case in scripts/audit-contract-fixtures.py resolves
 * against EVERY framework's file.
 */
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

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

/**
 * The backend the queue is ACTUALLY using (external when configured, else the
 * file store) - read off the real object, never assumed. The fields are private
 * to TypeScript only; at runtime they are ordinary properties.
 */
function resolvedBackend(queue: any): any {
  return queue.externalBackend ?? queue.liteBackend;
}

async function run() {
  if (!(await reachable(HOST, PORT))) {
    const why = `MongoDB is not reachable at ${HOST}:${PORT}`;
    if (process.env.TINA4_REQUIRE_SERVICES) {
      console.error(`TINA4_REQUIRE_SERVICES is set but ${why}`);
      process.exit(1);
    }
    console.log(`SKIP: ${why}`);
    process.exit(0);
  }

  process.env.TINA4_MONGO_URI = `mongodb://${HOST}:${PORT}`;
  process.env.TINA4_QUEUE_MONGO_URI = process.env.TINA4_MONGO_URI;
  // TINA4_QUEUE_BACKEND would override the explicit backend argument.
  delete process.env.TINA4_QUEUE_BACKEND;
  const queuePath = mkdtempSync(join(tmpdir(), "tina4-qclose-"));
  process.env.TINA4_QUEUE_PATH = queuePath;

  const core: any = await import(CORE);

  // A FRESH queue per call, deliberately: reusing one instance across backends
  // is how state left by an earlier call makes a later assertion pass for the
  // wrong reason.
  const made: any[] = [];
  const makeQueue = (backend: string) => {
    const queue = new core.Queue({
      topic: `qclose_${randomUUID().slice(0, 12)}`,
      backend,
      maxRetries: 2,
      path: queuePath,
    });
    made.push(queue);
    return queue;
  };

  // ── closing a queue releases the backend connection ───────────────────────
  //
  // POSITIVE: Queue.close() reaches the resolved backend, on both backends Node
  // can reach. The push is not decoration - it drives a REAL round trip to
  // Mongo, so the close under test follows genuine traffic, and the read after
  // it proves close() released the client without disturbing the live topic.
  console.log("\n=== closing a queue releases the backend connection ===");
  {
    let reached = 0;
    let intact = 0;
    const raised: string[] = [];
    for (const backend of ["file", "mongodb"]) {
      const queue = makeQueue(backend);
      queue.push({ m: "connect" });

      const resolved = resolvedBackend(queue);
      if (typeof resolved?.close === "function") reached++;

      // Caught, not left to escape: a missing close() must be reported as THIS
      // case failing, not as an unhandled error that aborts the file before the
      // other two cases ever run.
      try {
        queue.close();
      } catch (e: any) {
        raised.push(`${backend}: ${e?.message ?? e}`);
        continue;
      }

      // The job is still in the REAL store the queue was configured to use.
      // A close() that tore down the topic, or that was wired to the local file
      // store while the queue was on Mongo, fails right here.
      if (queue.size("pending") === 1) intact++;
    }
    assert(
      "closing a queue releases the backend connection",
      reached === 2 && intact === 2 && raised.length === 0,
      `backends exposing close(): ${reached}/2, topics intact after close: ${intact}/2, `
        + `close() threw: ${JSON.stringify(raised)}`,
    );
  }

  // ── closing a queue twice is safe ─────────────────────────────────────────
  //
  // NEGATIVE: shutdown paths run twice in real apps (an explicit close plus a
  // finally). A close that throws on the second call turns a clean shutdown
  // into a crash, and a `finally { queue.close(); }` into a masked original
  // error.
  console.log("\n=== closing a queue twice is safe ===");
  {
    const raised: string[] = [];
    for (const backend of ["file", "mongodb"]) {
      const queue = makeQueue(backend);
      queue.push({ m: "connect" });
      try {
        queue.close();
        queue.close();
      } catch (e: any) {
        raised.push(`${backend}: ${e?.message ?? e}`);
      }
    }
    assert(
      "closing a queue twice is safe",
      raised.length === 0,
      `closing twice threw: ${JSON.stringify(raised)}`,
    );
  }

  // ── closing a file backed queue is not an error ───────────────────────────
  //
  // NEGATIVE: the file backend is what every app gets before it configures
  // anything. If close() were only defined on the external backend, adding a
  // shutdown path would break the default with "backend.close is not a
  // function" - so this pins that the no-op is real, and that it does not
  // disturb the queue's contents on disk.
  console.log("\n=== closing a file backed queue is not an error ===");
  {
    const queue = makeQueue("file");
    queue.push({ m: "on disk" });
    const before = queue.size("pending");

    let threw = "";
    try {
      queue.close();
    } catch (e: any) {
      threw = String(e?.message ?? e);
    }

    assert(
      "closing a file backed queue is not an error",
      threw === "" && before === 1 && queue.size("pending") === before,
      `threw=${JSON.stringify(threw)} before=${before} after=${queue.size("pending")}`,
    );

    // The job must still be POPPABLE, not merely counted - a close that left
    // the store in a state nothing could read would still pass a size check.
    const job = queue.pop();
    assert(
      "a file backed queue still yields its job after close",
      job !== null,
      "pop() returned null after close on the file backend",
    );
    job?.complete();
  }

  // Reap what we spawn: close every queue this file built, twice-safe by
  // construction, so nothing is left holding a resource on the way out.
  for (const queue of made) {
    try {
      queue.close();
    } catch {
      /* teardown must never mask a real failure */
    }
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

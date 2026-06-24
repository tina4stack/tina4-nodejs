/**
 * Behavioural tests for the MongoBackend queue class.
 * Run with: npx tsx test/mongoQueue.test.ts
 *
 * Two layers, NO mocks:
 *   1. Pure config resolution — `getConfig()` is the real resolved-config getter
 *      (uri/database/collection precedence, env defaults, embedded auth). These
 *      assert the OBSERVABLE resolved config, not method existence.
 *   2. Live behaviour against a REAL MongoDB (localhost:27017) — push/pop/size/
 *      clear exercise the actual store and assert real side effects. There is NO
 *      test double of a Mongo client/collection. Gated on a reachable Mongo +
 *      the `mongodb` driver; the skip reason contains "mongo" + "not reachable"/
 *      "not installed" so the #252 service gate treats an unavailable Mongo as a
 *      hard FAILURE under TINA4_REQUIRE_SERVICES.
 *   3. Graceful-degrade contract — pointed at an UNREACHABLE host:port, size()
 *      returns 0 and pop() returns null deterministically (the execSync child
 *      process can't connect; the backend degrades rather than throwing). No
 *      try/catch escape that would also pass on throw.
 *
 * The live layer uses a THROWAWAY, framework-namespaced database
 * (tina4_test_queue_node) and DROPS it on teardown, so it never touches app data.
 */
import { MongoBackend } from "../packages/core/src/index.ts";
import * as net from "node:net";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string) {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} (${reason})`);
  skipped++;
}

/** Async TCP reachability probe (native node:net, no child process). */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    const t = setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 1500);
    if (t.unref) t.unref();
  });
}

console.log("=== MongoDB Queue Backend Tests ===\n");

async function main() {
  // ── Layer 1: resolved-config getter (pure, no dependency) ──────────────
  // getConfig() is the real config resolver. We assert the observable resolved
  // values, NOT that methods exist.

  console.log("--- MongoBackend with explicit config ---");

  const mongo = new MongoBackend({
    host: "127.0.0.1",
    port: 27017,
    database: "test_queue",
    collection: "jobs",
  });

  {
    // (1) [construction] Construct with explicit config, then assert the REAL
    // resolved config via getConfig(): database + collection are taken verbatim
    // and the host/port build the mongodb:// URI.
    const cfg = mongo.getConfig();
    assert(
      "MongoBackend resolves explicit config (database/collection/uri)",
      cfg.database === "test_queue" &&
        cfg.collection === "jobs" &&
        cfg.uri.includes("127.0.0.1:27017") &&
        cfg.uri.startsWith("mongodb://"),
      `cfg=${JSON.stringify(cfg)}`,
    );
  }

  // (6) [construction] Defaults: with no config and no env, getConfig() yields
  // database "tina4", collection "tina4_queue", and a URI built from
  // TINA4_MONGO_HOST/PORT (default mongodb://localhost:27017).
  console.log("\n--- MongoBackend with defaults ---");
  {
    const savedHost = process.env.TINA4_MONGO_HOST;
    const savedPort = process.env.TINA4_MONGO_PORT;
    const savedDb = process.env.TINA4_MONGO_DB;
    const savedColl = process.env.TINA4_MONGO_COLLECTION;
    const savedUri = process.env.TINA4_MONGO_URI;
    const savedQueueUrl = process.env.TINA4_QUEUE_URL;
    delete process.env.TINA4_MONGO_HOST;
    delete process.env.TINA4_MONGO_PORT;
    delete process.env.TINA4_MONGO_DB;
    delete process.env.TINA4_MONGO_COLLECTION;
    delete process.env.TINA4_MONGO_URI;
    delete process.env.TINA4_QUEUE_URL;

    const cfg = new MongoBackend().getConfig();
    assert(
      "MongoBackend default config resolves env/defaults (tina4 / tina4_queue / localhost:27017)",
      cfg.database === "tina4" &&
        cfg.collection === "tina4_queue" &&
        cfg.uri === "mongodb://localhost:27017",
      `cfg=${JSON.stringify(cfg)}`,
    );

    // Restore env so later layers behave deterministically.
    if (savedHost !== undefined) process.env.TINA4_MONGO_HOST = savedHost;
    if (savedPort !== undefined) process.env.TINA4_MONGO_PORT = savedPort;
    if (savedDb !== undefined) process.env.TINA4_MONGO_DB = savedDb;
    if (savedColl !== undefined) process.env.TINA4_MONGO_COLLECTION = savedColl;
    if (savedUri !== undefined) process.env.TINA4_MONGO_URI = savedUri;
    if (savedQueueUrl !== undefined) process.env.TINA4_QUEUE_URL = savedQueueUrl;
  }

  // (11) [construction] Explicit config.uri wins over the host/port build path
  // — it is parsed/stored verbatim into the resolved config.
  console.log("\n--- MongoBackend with URI ---");
  {
    const cfg = new MongoBackend({ uri: "mongodb://myhost:27018/mydb" }).getConfig();
    assert(
      "MongoBackend config.uri is stored verbatim (wins over host/port build)",
      cfg.uri === "mongodb://myhost:27018/mydb",
      `uri=${cfg.uri}`,
    );
  }

  // (13) [construction] Auth credentials are URL-encoded and embedded into the
  // resolved URI — `admin:secret@` precedes host:port. Exercises the
  // encodeURIComponent credential-encoding path.
  console.log("\n--- MongoBackend with auth ---");
  {
    const cfg = new MongoBackend({
      host: "127.0.0.1",
      port: 27017,
      username: "admin",
      password: "secret",
      database: "prod_queue",
      collection: "queue_jobs",
    }).getConfig();
    assert(
      "MongoBackend embeds auth credentials in the resolved URI (admin:secret@)",
      cfg.uri.includes("admin:secret@") &&
        cfg.uri.includes("127.0.0.1:27017") &&
        cfg.database === "prod_queue",
      `uri=${cfg.uri}`,
    );
  }

  // ── Layer 3: graceful-degrade contract (real child process, no live server) ─
  // Point the backend at an UNREACHABLE host:port. The execSync child can't
  // connect, so the backend degrades deterministically: size() -> 0, pop() ->
  // null. No try/catch escape (that would also pass on throw — proving nothing).
  console.log("\n--- Graceful degrade against an unreachable server ---");
  {
    // Disable the visibility-timeout reclaim so pop() doesn't first spawn a
    // reclaim child; we want the single failing pop op to be the observed path.
    const down = new MongoBackend({
      host: "127.0.0.1",
      port: 1,            // nothing listens on port 1 (ECONNREFUSED)
      database: "unreachable_db",
      collection: "unreachable_jobs",
      visibilityTimeout: 0,
    });

    // (15) [degrade] size() returns exactly 0 when the server is unreachable.
    const sizeResult = down.size("degrade-topic");
    assert(
      "MongoBackend.size degrades to 0 against an unreachable server",
      sizeResult === 0,
      `size=${sizeResult}`,
    );

    // (16) [degrade] pop() returns exactly null when the server is unreachable.
    const popResult = down.pop("degrade-topic");
    assert(
      "MongoBackend.pop degrades to null against an unreachable server",
      popResult === null,
      `pop=${JSON.stringify(popResult)}`,
    );

    // (17) [degrade] clear() is a no-op against an unreachable server: the
    // observable pending count is still 0 afterward (degrades, never corrupts).
    down.clear("degrade-topic");
    const afterClear = down.size("degrade-topic");
    assert(
      "MongoBackend.clear degrades to a no-op (size still 0) against an unreachable server",
      afterClear === 0,
      `size=${afterClear}`,
    );
  }

  // ── Layer 2: live behaviour against a REAL MongoDB (NO mocks) ──────────
  console.log("\n--- Live behaviour against a real MongoDB ---");

  const LIVE_DB = "tina4_test_queue_node";        // throwaway, namespaced
  const LIVE_COLL = "tina4_test_mongoqueue_jobs";
  const MONGO_URI = process.env.TINA4_MONGO_URI ?? "mongodb://localhost:27017";
  const m = MONGO_URI.match(/mongodb:\/\/(?:[^@/]*@)?([^:/]+)(?::(\d+))?/);
  const liveHost = m?.[1] ?? "localhost";
  const livePort = m?.[2] ? parseInt(m[2], 10) : 27017;

  // Gate: driver present?
  let driverPresent = true;
  try {
    await import("mongodb");
  } catch {
    driverPresent = false;
  }

  if (!driverPresent) {
    skip("MongoBackend.push then size reflects the pushed job (live)", "mongodb driver not installed");
    skip("MongoBackend.pop returns the pushed payload (live)", "mongodb driver not installed");
    skip("MongoBackend.size returns the real pending count (live)", "mongodb driver not installed");
    skip("MongoBackend.clear empties the topic (live)", "mongodb driver not installed");
    skip("MongoBackend full lifecycle push/pop/size/clear (live)", "mongodb driver not installed");
  } else if (!(await reachable(liveHost, livePort))) {
    const why = "mongo not reachable on " + liveHost + ":" + livePort;
    skip("MongoBackend.push then size reflects the pushed job (live)", why);
    skip("MongoBackend.pop returns the pushed payload (live)", why);
    skip("MongoBackend.size returns the real pending count (live)", why);
    skip("MongoBackend.clear empties the topic (live)", why);
    skip("MongoBackend full lifecycle push/pop/size/clear (live)", why);
  } else {
    const mongodb = await import("mongodb");
    const { MongoClient } = mongodb;
    const client = new MongoClient(MONGO_URI, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });

    try {
      await client.connect();
      const coll = client.db(LIVE_DB).collection(LIVE_COLL);

      // Backend pointed at the throwaway namespaced DB/collection. Disable the
      // reclaim so pop() is a single deterministic dequeue.
      const live = new MongoBackend({
        uri: MONGO_URI,
        database: LIVE_DB,
        collection: LIVE_COLL,
        visibilityTimeout: 0,
      });

      // (2) [behaviour] push a job then size(topic) === 1.
      {
        const topic = "tina4_test_push_size";
        await coll.deleteMany({ queue: topic });
        const id = live.push(topic, { to: "a@example.com", body: "hi" });
        assert(
          "MongoBackend.push then size reflects the pushed job (live)",
          typeof id === "string" && id.length > 0 && live.size(topic) === 1,
          `id=${id} size=${live.size(topic)}`,
        );
        await coll.deleteMany({ queue: topic });
      }

      // (3) [behaviour] push then pop returns the pushed payload.
      {
        const topic = "tina4_test_pop_payload";
        await coll.deleteMany({ queue: topic });
        live.push(topic, { order: 42, sku: "abc" });
        const job = live.pop(topic);
        assert(
          "MongoBackend.pop returns the pushed payload (live)",
          !!job &&
            (job as any).payload &&
            (job as any).payload.order === 42 &&
            (job as any).payload.sku === "abc",
          `job=${JSON.stringify(job)}`,
        );
        await coll.deleteMany({ queue: topic });
      }

      // (4) [behaviour] size returns the real pending count.
      {
        const topic = "tina4_test_size_count";
        await coll.deleteMany({ queue: topic });
        assert(
          "MongoBackend.size returns the real pending count (live)",
          live.size(topic) === 0,
          `before=${live.size(topic)}`,
        );
        live.push(topic, { n: 1 });
        live.push(topic, { n: 2 });
        live.push(topic, { n: 3 });
        assert(
          "MongoBackend.size returns the real pending count (live) — 3 after 3 pushes",
          live.size(topic) === 3,
          `after=${live.size(topic)}`,
        );
        await coll.deleteMany({ queue: topic });
      }

      // (5) [behaviour] push 3, clear, then size(topic) === 0.
      {
        const topic = "tina4_test_clear";
        await coll.deleteMany({ queue: topic });
        live.push(topic, { n: 1 });
        live.push(topic, { n: 2 });
        live.push(topic, { n: 3 });
        const before = live.size(topic);
        live.clear(topic);
        const after = live.size(topic);
        assert(
          "MongoBackend.clear empties the topic (live)",
          before === 3 && after === 0,
          `before=${before} after=${after}`,
        );
        await coll.deleteMany({ queue: topic });
      }

      // (7-10, 12, 14) [behaviour] Full push/pop/size/clear lifecycle end-to-end
      // against the live store — replaces the duplicate method-existence checks
      // (default-instance push/pop/size/clear, URI-instance push, and the
      // QueueBackend interface-parity `every(typeof === "function")` check) with
      // ONE behavioural exercise of all four methods together.
      {
        const topic = "tina4_test_lifecycle";
        await coll.deleteMany({ queue: topic });

        const empty0 = live.size(topic);                  // 0
        live.push(topic, { step: 1 });
        live.push(topic, { step: 2 });
        const afterPush = live.size(topic);               // 2
        const first = live.pop(topic);                    // dequeues one
        const afterPop = live.size(topic);                // 1
        live.clear(topic);
        const afterClear = live.size(topic);              // 0

        assert(
          "MongoBackend full lifecycle push/pop/size/clear (live)",
          empty0 === 0 &&
            afterPush === 2 &&
            !!first &&
            (first as any).payload &&
            ((first as any).payload.step === 1 || (first as any).payload.step === 2) &&
            afterPop === 1 &&
            afterClear === 0,
          `empty0=${empty0} afterPush=${afterPush} first=${JSON.stringify(first)} afterPop=${afterPop} afterClear=${afterClear}`,
        );

        await coll.deleteMany({ queue: topic });
      }
    } finally {
      // Drop the throwaway, namespaced database — never touch app data.
      try { await client.db(LIVE_DB).dropDatabase(); } catch { /* best effort */ }
      await client.close();
    }
  }

  summarize();
}

function summarize() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

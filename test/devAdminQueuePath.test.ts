/**
 * Regression: the dev-admin queue panel's JOB LIST and its STATS must describe
 * the SAME set of jobs.
 *
 * Run with: npx tsx test/devAdminQueuePath.test.ts
 *
 * MEASURED 2026-08-05 on the lab host (Ubuntu, Node 24, TINA4_QUEUE_PATH set):
 *
 *   GET /__dev/api/queue  ->  jobs.length = 100,  stats sum = 12
 *
 * 100 was the count of `.queue-data` files in <cwd>/data/queue/default (stale
 * local runtime junk); 12 was the count in $TINA4_QUEUE_PATH/default (the store
 * the app actually writes to). GET /__dev/api/queue?topic=emails against a
 * fresh project returned jobs=[] while stats.pending saw the job — the same
 * defect from the other side.
 *
 * Three defects, all "the list reads a different set from the counts":
 *   1. The list scanned a HARDCODED cwd/data/queue/<topic>; Queue.size() reads
 *      queueBasePath() (TINA4_QUEUE_PATH, else data/queue).
 *   2. Reserved jobs were counted by stats.reserved and never listed; a
 *      failed-but-retryable job (which lives in the PENDING dir with status
 *      "pending") was listed TWICE — once by the dir scan, once by
 *      queue.failed(), which re-reads those same files.
 *   3. Dead letters were listed via queue.deadLetters(), which filters on the
 *      dev admin's OWN maxRetries (3) — a job dead-lettered by an app
 *      configured maxRetries=1 was counted by stats.failed and never listed.
 *
 * NO MOCKS. A real Tina4 server on a real port, a real file-backed Queue, real
 * job files on disk, real HTTP. The one hand-written file is a DECOY job at the
 * legacy cwd/data/queue path — a real stale artefact of exactly the kind that
 * produced the 100, there to prove the endpoint no longer reads it.
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { freePort } from "./freePort.ts";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
    failed++;
  }
}

const PORT = await freePort();
const scaffold = join(tmpdir(), `tina4-devadmin-queuepath-${Date.now()}-${process.pid}`);
const originalCwd = process.cwd();

// The REAL store, deliberately NOT <cwd>/data/queue — that difference is the
// whole discriminator. A test that leaves them equal passes with the bug in.
const queueStore = join(scaffold, "queue-store");
const legacyStore = join(scaffold, "data", "queue");

function httpGetJson(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(body); } catch { /* leave null */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("request timeout")); });
  });
}

const statusSum = (s: any): number =>
  Number(s?.pending ?? 0) + Number(s?.completed ?? 0) + Number(s?.failed ?? 0) + Number(s?.reserved ?? 0);

async function main(): Promise<void> {
  mkdirSync(queueStore, { recursive: true });
  process.chdir(scaffold);

  process.env.TINA4_DEBUG = "true";
  process.env.TINA4_LOG_LEVEL = "ERROR";
  process.env.TINA4_SUPPRESS = "true";
  process.env.TINA4_HOST_NAME = `localhost:${PORT}`;
  process.env.TINA4_NO_AI_PORT = "true"; // one listener, one thing to reap
  // Pin every queue knob so the run is hermetic and the assertions below mean
  // one thing on a bare laptop and on the lab (which exports TINA4_QUEUE_PATH).
  process.env.TINA4_QUEUE_PATH = queueStore;
  process.env.TINA4_QUEUE_BACKEND = "file";
  process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT = "300";

  // A real stale job file at the LEGACY hardcoded location. Nothing in the app
  // writes here any more; the endpoint used to list it and count something else.
  mkdirSync(join(legacyStore, "orders"), { recursive: true });
  writeFileSync(
    join(legacyStore, "orders", "0000000000000-000001_decoy-legacy-job.queue-data"),
    JSON.stringify({
      id: "decoy-legacy-job", payload: { decoy: true }, status: "pending",
      createdAt: new Date().toISOString(), attempts: 0, delayUntil: null,
      priority: 0, topic: "orders",
    }, null, 2),
  );
  // A topic that exists ONLY under the legacy path — /queue/topics must not
  // report it, because no queue in this app can ever read or write it.
  mkdirSync(join(legacyStore, "legacy-only"), { recursive: true });

  const { startServer, Queue } = await import("../packages/core/src/index.ts");

  // Real jobs through the real Queue — these land in $TINA4_QUEUE_PATH/orders.
  const orders = new Queue({ topic: "orders" });
  const keptId = orders.push({ sku: "A-1", qty: 2 });
  const reservedId = orders.push({ sku: "B-2", qty: 1 });
  const retriedId = orders.push({ sku: "C-3", qty: 7 });

  const server = await startServer({ port: PORT, host: "127.0.0.1" });

  try {
    // 1. The list reads the REAL store (positive), and not the legacy one (negative).
    console.log("\n--- GET /queue reads the configured store, not cwd/data/queue ---");
    {
      const { status, json } = await httpGetJson("/__dev/api/queue?topic=orders");
      const jobs: any[] = Array.isArray(json?.jobs) ? json.jobs : [];
      assert("GET /queue 200", status === 200, `status=${status}`);
      assert("lists the real pushed job",
        jobs.some((j) => j.id === keptId),
        `keptId=${keptId} ids=${JSON.stringify(jobs.map((j) => j.id))}`);
      assert("real job carries its real payload",
        jobs.find((j) => j.id === keptId)?.data?.sku === "A-1",
        JSON.stringify(jobs.find((j) => j.id === keptId)));
      assert("does NOT list the stale job at the legacy cwd/data/queue path",
        !jobs.some((j) => j.id === "decoy-legacy-job"),
        JSON.stringify(jobs.map((j) => j.id)));
      assert("stats.pending counts all three real jobs",
        Number(json?.stats?.pending) === 3, JSON.stringify(json?.stats));
      assert("stats sum equals the job count",
        statusSum(json?.stats) === jobs.length,
        `sum=${statusSum(json?.stats)} jobs.length=${jobs.length}`);
    }

    // 2. A RESERVED job is listed, not just counted.
    console.log("\n--- a reserved job appears in the list ---");
    {
      const popped = orders.pop();
      assert("pop() returned a real job", popped !== null, String(popped));
      const { json } = await httpGetJson("/__dev/api/queue?topic=orders");
      const jobs: any[] = Array.isArray(json?.jobs) ? json.jobs : [];
      assert("stats.reserved sees the reservation",
        Number(json?.stats?.reserved) === 1, JSON.stringify(json?.stats));
      assert("the reserved job is LISTED, with status reserved",
        jobs.some((j) => j.id === popped?.id && j.status === "reserved"),
        JSON.stringify(jobs.map((j) => `${j.id}:${j.status}`)));
      assert("stats sum still equals the job count with a reservation",
        statusSum(json?.stats) === jobs.length,
        `sum=${statusSum(json?.stats)} jobs.length=${jobs.length}`);
      // Put it back so the next block starts from a known state.
      popped?.complete();
    }

    // 3. A failed-but-retryable job is listed EXACTLY ONCE.
    console.log("\n--- a retrying job is listed once, not twice ---");
    {
      let target = orders.pop();
      // pop() is priority-then-oldest; drain until we hold the job we want to fail.
      const parked: any[] = [];
      while (target && target.id !== retriedId) { parked.push(target); target = orders.pop(); }
      assert("popped the job we intend to fail", target?.id === retriedId, String(target?.id));
      target?.fail("boom");                       // attempts 0 -> 1, requeued (maxRetries 3)
      for (const p of parked) p.fail("");         // release the parked reservations too

      const { json } = await httpGetJson("/__dev/api/queue?topic=orders");
      const jobs: any[] = Array.isArray(json?.jobs) ? json.jobs : [];
      const occurrences = jobs.filter((j) => j.id === retriedId).length;
      assert("the retrying job appears exactly once",
        occurrences === 1,
        `occurrences=${occurrences} ids=${JSON.stringify(jobs.map((j) => `${j.id}:${j.status}`))}`);
      assert("the retrying job carries its attempt count",
        Number(jobs.find((j) => j.id === retriedId)?.attempts) === 1,
        JSON.stringify(jobs.find((j) => j.id === retriedId)));
      assert("stats sum still equals the job count with a retrying job",
        statusSum(json?.stats) === jobs.length,
        `sum=${statusSum(json?.stats)} jobs.length=${jobs.length}`);
    }

    // 4. A dead letter written by an app with maxRetries=1 is listed, even
    //    though the dev admin's own Queue defaults to maxRetries=3.
    console.log("\n--- a dead letter is listed whatever maxRetries wrote it ---");
    {
      const strict = new Queue({ topic: "strict", maxRetries: 1 });
      const doomedId = strict.push({ sku: "D-4" });
      strict.pop()?.fail("permanent");            // attempts 1 >= maxRetries 1 -> dead-letter

      const { json } = await httpGetJson("/__dev/api/queue?topic=strict");
      const jobs: any[] = Array.isArray(json?.jobs) ? json.jobs : [];
      assert("stats.failed counts the dead letter",
        Number(json?.stats?.failed) === 1, JSON.stringify(json?.stats));
      assert("the dead letter is LISTED",
        jobs.some((j) => j.id === doomedId),
        `doomedId=${doomedId} ids=${JSON.stringify(jobs.map((j) => `${j.id}:${j.status}`))}`);
      assert("stats sum equals the job count for a dead-lettered topic",
        statusSum(json?.stats) === jobs.length,
        `sum=${statusSum(json?.stats)} jobs.length=${jobs.length}`);
    }

    // 5. Status filters return exactly what their stat counts.
    console.log("\n--- status filters agree with their stats ---");
    {
      const { json } = await httpGetJson("/__dev/api/queue?topic=strict&status=failed");
      const jobs: any[] = Array.isArray(json?.jobs) ? json.jobs : [];
      assert("?status=failed returns the dead letters", jobs.length === Number(json?.stats?.failed),
        `jobs=${jobs.length} stats.failed=${json?.stats?.failed}`);
      const pendingOnly = await httpGetJson("/__dev/api/queue?topic=orders&status=pending");
      const pendingJobs: any[] = Array.isArray(pendingOnly.json?.jobs) ? pendingOnly.json.jobs : [];
      assert("?status=pending returns only pending jobs",
        pendingJobs.length > 0 && pendingJobs.every((j) => j.status === "pending"),
        JSON.stringify(pendingJobs.map((j) => j.status)));
      assert("?status=pending count matches stats.pending",
        pendingJobs.length === Number(pendingOnly.json?.stats?.pending),
        `jobs=${pendingJobs.length} stats.pending=${pendingOnly.json?.stats?.pending}`);
    }

    // 6. Negative: a topic nothing ever wrote to is empty in BOTH views.
    console.log("\n--- negative paths ---");
    {
      const { json } = await httpGetJson("/__dev/api/queue?topic=no-such-topic");
      assert("unknown topic lists no jobs", Array.isArray(json?.jobs) && json.jobs.length === 0,
        JSON.stringify(json?.jobs));
      assert("unknown topic counts nothing", statusSum(json?.stats) === 0, JSON.stringify(json?.stats));
    }

    // 7. /queue/topics reads the same store as the jobs do.
    console.log("\n--- GET /queue/topics reads the configured store ---");
    {
      const { status, json } = await httpGetJson("/__dev/api/queue/topics");
      const topics: string[] = Array.isArray(json?.topics) ? json.topics : [];
      assert("GET /queue/topics 200", status === 200, `status=${status}`);
      assert("topics lists the real topics", topics.includes("orders") && topics.includes("strict"),
        JSON.stringify(topics));
      assert("topics does NOT list a legacy-path-only directory",
        !topics.includes("legacy-only"), JSON.stringify(topics));
      assert("topics carries no error field", json?.error === undefined, JSON.stringify(json?.error));
    }

    // 8. The DEFAULT configuration — no TINA4_QUEUE_PATH at all, so the store
    //    IS <cwd>/data/queue. This is where the double-listing bites: a job
    //    that has failed once sits in the PENDING directory with status
    //    "pending", so the directory scan listed it AND queue.failed() — which
    //    re-reads those same files — listed it again. Two rows, two different
    //    statuses, one job, and a stats sum that could never match.
    console.log("\n--- default store (no TINA4_QUEUE_PATH): retrying job listed once ---");
    {
      delete process.env.TINA4_QUEUE_PATH;
      const dup = new Queue({ topic: "dup" });
      const dupId = dup.push({ sku: "E-5" });
      dup.pop()?.fail("transient");        // attempts 0 -> 1, still < maxRetries 3

      const { json } = await httpGetJson("/__dev/api/queue?topic=dup");
      const jobs: any[] = Array.isArray(json?.jobs) ? json.jobs : [];
      assert("default store: the retrying job is listed exactly once",
        jobs.filter((j) => j.id === dupId).length === 1,
        `rows=${JSON.stringify(jobs.map((j) => `${j.id}:${j.status}`))}`);
      assert("default store: stats sum equals the job count",
        statusSum(json?.stats) === jobs.length,
        `sum=${statusSum(json?.stats)} jobs.length=${jobs.length}`);
      process.env.TINA4_QUEUE_PATH = queueStore;
    }
  } finally {
    server.close();
    process.chdir(originalCwd);
    try { rmSync(scaffold, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  try { process.chdir(originalCwd); } catch { /* ignore */ }
  try { rmSync(scaffold, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\nResults: ${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});

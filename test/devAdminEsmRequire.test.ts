/**
 * Lock-in: the dev-admin endpoints that used a bare require() must actually work.
 *
 * packages/core is `"type": "module"`, so a bare `require(...)` inside it is a
 * ReferenceError. Two handlers did exactly that inside a try/catch, so instead of
 * failing loudly they permanently took the error path:
 *
 *   GET /__dev/api/graphql/schema  ->  400 {"error":"require is not defined"}
 *   GET /__dev/api/queue/topics    ->  200 {"topics":["default"],"error":"require is not defined"}
 *
 * The queue one is the nastier of the two: it returns HTTP 200 with a plausible
 * body, so the dashboard silently showed one fake topic while real topics sat on
 * disk. No test covered either endpoint, which is why it survived.
 *
 * These assertions are discriminating - each one FAILS against the pre-fix code:
 *   - topics must contain the REAL on-disk topic dirs (pre-fix: ["default"])
 *   - neither response may carry an `error` field (pre-fix: both did)
 *   - graphql/schema must be 200 (pre-fix: 400)
 *
 * No mocks: a real server on a real port, real directories on disk, real HTTP.
 *
 * Run with: npx tsx test/devAdminEsmRequire.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
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
const scaffold = join(tmpdir(), `tina4-devadmin-esm-${Date.now()}-${process.pid}`);
const originalCwd = process.cwd();

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

async function main(): Promise<void> {
  // The queue store this app is configured to use. Pinned explicitly: the
  // endpoint lists the topics of the REAL store (TINA4_QUEUE_PATH, else
  // data/queue), so a run on a host that exports TINA4_QUEUE_PATH must still
  // be looking at the directories this test created.
  const queueStore = join(scaffold, "queue-store");
  process.env.TINA4_QUEUE_PATH = queueStore;

  // Real on-disk file-queue topics. The endpoint reads these directory names,
  // so they are the discriminator: pre-fix it could never see them.
  mkdirSync(join(queueStore, "invoices"), { recursive: true });
  mkdirSync(join(queueStore, "emails"), { recursive: true });
  // A plain file (not a directory) must be filtered out by the isDirectory() check.
  mkdirSync(join(queueStore, "shipping"), { recursive: true });
  process.chdir(scaffold);

  process.env.TINA4_DEBUG = "true";
  process.env.TINA4_LOG_LEVEL = "ERROR";
  process.env.TINA4_SUPPRESS = "true";
  process.env.TINA4_HOST_NAME = `localhost:${PORT}`;

  const { startServer } = await import("../packages/core/src/index.ts");
  const server = await startServer({ port: PORT, host: "127.0.0.1" });

  try {
    console.log("--- GET /__dev/api/queue/topics (bare require -> silent 200 with fake data) ---");
    {
      const { status, json } = await httpGetJson("/__dev/api/queue/topics");
      assert("queue/topics 200", status === 200, `status=${status}`);
      assert(
        "queue/topics carries NO error field",
        json?.error === undefined,
        `error=${JSON.stringify(json?.error)}`,
      );
      const topics: string[] = Array.isArray(json?.topics) ? json.topics : [];
      assert(
        "queue/topics lists the REAL on-disk topics",
        topics.includes("invoices") && topics.includes("emails") && topics.includes("shipping"),
        JSON.stringify(topics),
      );
      assert(
        "queue/topics is NOT the ['default'] fallback",
        !(topics.length === 1 && topics[0] === "default"),
        JSON.stringify(topics),
      );
      assert(
        "queue/topics is sorted",
        JSON.stringify(topics) === JSON.stringify([...topics].sort()),
        JSON.stringify(topics),
      );
    }

    console.log("--- GET /__dev/api/graphql/schema (bare require -> 400) ---");
    {
      const { status, json } = await httpGetJson("/__dev/api/graphql/schema");
      assert("graphql/schema 200", status === 200, `status=${status}`);
      assert(
        "graphql/schema carries NO error field",
        json?.error === undefined,
        `error=${JSON.stringify(json?.error)}`,
      );
      assert(
        "graphql/schema returns an introspection object",
        json?.schema !== undefined && typeof json.schema === "object",
        JSON.stringify(json?.schema),
      );
      assert(
        "graphql/schema returns an SDL string",
        typeof json?.sdl === "string",
        `sdl=${typeof json?.sdl}`,
      );
    }
  } finally {
    await server.close?.();
    process.chdir(originalCwd);
    rmSync(scaffold, { recursive: true, force: true });
  }

  console.log("\n==================================================");
  console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
  console.log("==================================================");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.chdir(originalCwd);
  rmSync(scaffold, { recursive: true, force: true });
  process.exit(1);
});

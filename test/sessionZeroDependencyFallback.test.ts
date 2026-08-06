/**
 * SESSION CONTRACT: every backend has a zero-dependency transport.
 * Run with: npx tsx test/sessionZeroDependencyFallback.test.ts
 *
 * "Where three frameworks ship a zero-dependency transport for a backend, the
 * fourth does too. A backend must not hard-require a third-party client in one
 * framework and not the others."
 *
 * Ruby was the framework that FAILED this - its mongodb session handler did an
 * unconditional `require "mongo"` and turned a missing gem into a hard raise,
 * while Python, PHP and Node all shipped a raw wire-protocol fallback. The same
 * .env therefore worked in three frameworks and raised in the fourth, which
 * breaks the zero-dependency promise ASYMMETRICALLY - worse than breaking it
 * consistently, because nothing in the configuration says which one will fail.
 * That is fixed in Ruby; this file is the Node PARITY LOCK-IN.
 *
 * THE INSTRUMENT, which is the part worth reviewing.
 *
 * Node's session handlers import only `node:` builtins and relative paths, and
 * `mongoClient.ts` reaches for the optional `mongodb` package through
 * `require.resolve` with a raw OP_MSG fallback when it is absent. To prove the
 * fallback really is self-sufficient, the child must genuinely be unable to
 * resolve those packages - not be told it cannot.
 *
 * So the source is COPIED OUT of the repository into a temp directory that has
 * no node_modules anywhere above it, and run with `node --experimental-strip-types`
 * (Node 24 strips TypeScript natively, so not even tsx is needed). Module
 * resolution walks up from the IMPORTING FILE, so from there every bare
 * specifier genuinely fails. Nothing is shimmed, stubbed or intercepted: the
 * failure is the one Node's real resolver produces.
 *
 * Every child SELF-VERIFIES the instrument and reports an exact count FIRST -
 * how many of the optional packages resolve, which must be 0. Without that
 * check, a child that quietly inherited the repository's node_modules would make
 * every case pass while proving nothing, and this exact trap has already
 * produced three false greens on this task.
 *
 * NO MOCKS. Real Redis, real Valkey, real memcached, real MongoDB, real files.
 */
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { buildDriverlessTree, runDriverless as runInDriverlessTree, selftestLine, selftestPassed } from "./_driverlessTree.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function skipLoudly(name: string, reason: string): void {
  if (process.env.TINA4_REQUIRE_SERVICES) {
    assert(name, false, `TINA4_REQUIRE_SERVICES is set but ${reason}`);
    return;
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} - ${reason}`);
  skipped++;
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection({ host, port });
    probe.setTimeout(2500);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
    probe.once("timeout", () => { probe.destroy(); resolve(false); });
  });
}

/**
 * The optional packages the child must NOT be able to resolve, checked from the
 * file that actually reaches for them (mongoClient.ts probes `mongodb`), not
 * from the tree root — resolution walks up from the IMPORTER, so the root sees
 * a strict subset of the directories the handler consults.
 *
 * The mechanism now lives in test/_driverlessTree.ts and is shared with
 * test/databaseDrivers.test.ts, which needs the identical property for the four
 * database drivers. One instrument, reviewed once.
 */
const DRIVERLESS = {
  packages: ["mongodb", "redis", "pg"],
  resolveFrom: "packages/core/src/sessionHandlers/mongoClient.ts",
};

function runDriverless(root: string, source: string): string {
  return runInDriverlessTree(root, source, DRIVERLESS);
}

const MONGO_HOST = process.env.TINA4_SESSION_MONGO_HOST ?? "127.0.0.1";
const MONGO_PORT = Number(process.env.TINA4_SESSION_MONGO_PORT ?? 27017);

async function main(): Promise<void> {
  let root = "";
  try {
    if (!(await reachable(MONGO_HOST, MONGO_PORT))) {
      skipLoudly("every_backend_has_a_zero_dependency_transport",
        `mongodb is not reachable at ${MONGO_HOST}:${MONGO_PORT}`);
      return;
    }
    root = buildDriverlessTree(REPO);

    // -- 1. every backend has a zero-dependency transport --------------------
    console.log("\n-- 1. every backend constructs and works with NO package resolvable --\n");

    const sessionId = `zerodep-${Math.random().toString(16).slice(2, 10)}`;
    const out1 = runDriverless(root, `
import { FileSessionHandler, RedisSessionHandler } from "./packages/core/src/session.ts";
import { ValkeySessionHandler } from "./packages/core/src/sessionHandlers/valkeyHandler.ts";
import { MemcachedSessionHandler } from "./packages/core/src/sessionHandlers/memcachedHandler.ts";
import { MongoSessionHandler } from "./packages/core/src/sessionHandlers/mongoHandler.ts";
import { DatabaseSessionHandler } from "./packages/core/src/sessionHandlers/databaseHandler.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "zerodep-run-"));
const built: string[] = [];
const broken: string[] = [];
function attempt(name: string, fn: () => void) {
  try { fn(); built.push(name); }
  catch (e) { broken.push(name + ": " + String((e as Error).message).slice(0, 80)); }
}
attempt("file", () => {
  // FileSessionHandler takes a bare path string, not a config object - a wrong
  // shape here throws from node:path and reads like a backend failure.
  const h = new FileSessionHandler(work);
  h.write("${sessionId}", { seeded: true } as never, 60);
  if (JSON.stringify(h.read("${sessionId}")) !== JSON.stringify({ seeded: true })) throw new Error("no round trip");
});
attempt("database", () => {
  const h = new DatabaseSessionHandler({ dbPath: join(work, "zd.db") } as never);
  h.write("${sessionId}", { seeded: true } as never, 60);
  if (JSON.stringify(h.read("${sessionId}")) !== JSON.stringify({ seeded: true })) throw new Error("no round trip");
});
attempt("redis", () => { new RedisSessionHandler({ redisHost: "127.0.0.1", redisPort: 6379 } as never); });
attempt("valkey", () => { new ValkeySessionHandler({ host: "127.0.0.1", port: 6380 } as never); });
attempt("memcached", () => { new MemcachedSessionHandler({ host: "127.0.0.1", port: 11211 } as never); });
attempt("mongodb", () => { new MongoSessionHandler({ host: "${MONGO_HOST}", port: ${MONGO_PORT} } as never); });
console.log("BUILT " + built.join(","));
console.log("BROKEN " + broken.join(" | "));
process.exit(0);
`);
    const brokenLine = (out1.split("\n").find((l) => l.startsWith("BROKEN ")) ?? "").slice(7).trim();
    const builtLine = (out1.split("\n").find((l) => l.startsWith("BUILT ")) ?? "").slice(6).trim();
    assert(
      "every_backend_has_a_zero_dependency_transport",
      selftestPassed(out1) && brokenLine === "" && builtLine.split(",").length === 6,
      !selftestPassed(out1)
        ? `THE INSTRUMENT FAILED: ${selftestLine(out1)} - the child could `
          + "resolve a package it was supposed to be denied, so this case proves nothing"
        : `backends that could not work without a third-party client: ${brokenLine || "(none, but built=" + builtLine + ")"}`,
    );

    // -- 2. the zero-dependency transport really round trips -----------------
    console.log("\n-- 2. the raw transport really talks to MongoDB --\n");

    const mongoId = `zerodep-mongo-${Math.random().toString(16).slice(2, 10)}`;
    const out2 = runDriverless(root, `
import { MongoSessionHandler } from "./packages/core/src/sessionHandlers/mongoHandler.ts";
const writer = new MongoSessionHandler({ host: "${MONGO_HOST}", port: ${MONGO_PORT} } as never);
writer.write("${mongoId}", { seeded: true } as never, 300);
const reader = new MongoSessionHandler({ host: "${MONGO_HOST}", port: ${MONGO_PORT} } as never);
console.log("READBACK " + JSON.stringify(reader.read("${mongoId}")));
process.exit(0);
`);
    const readback = (out2.split("\n").find((l) => l.startsWith("READBACK ")) ?? "").slice(9).trim();

    // OUT OF BAND: ask MongoDB ourselves, through the parent's own client, that
    // the document the driverless child wrote is really there.
    const { MongoSessionHandler } = await import("../packages/core/src/sessionHandlers/mongoHandler.js");
    const probe = new MongoSessionHandler({ host: MONGO_HOST, port: MONGO_PORT } as never);
    const outOfBand = JSON.stringify(probe.read(mongoId));

    assert(
      "the_zero_dependency_transport_really_round_trips",
      selftestPassed(out2)
        && readback === JSON.stringify({ seeded: true })
        && outOfBand === JSON.stringify({ seeded: true }),
      !selftestPassed(out2)
        ? "THE INSTRUMENT FAILED - the child resolved a package it was supposed to be denied"
        : `child read ${readback || "(nothing)"}, independent client read ${outOfBand} - a transport `
          + "that returns empty would pass a survival-only check, which is why the out-of-band read is here",
    );
    probe.destroy(mongoId);

    // -- 3. the third party client is still used when present ----------------
    console.log("\n-- 3. the driver is still preferred when it IS installed --\n");

    // mongoClient.ts probes `require.resolve("mongodb")` and uses the driver when
    // it resolves. In THIS process the repo's node_modules is on the path, so the
    // driver branch is the live one - the inverse of the driverless children above.
    const require_ = (await import("node:module")).createRequire(import.meta.url);
    let driverInstalled = false;
    try { require_.resolve("mongodb"); driverInstalled = true; } catch { /* not installed */ }

    if (!driverInstalled) {
      skipLoudly("the_third_party_client_is_still_used_when_present",
        "the mongodb package is not installed, so the driver-preferred path cannot be exercised");
    } else {
      const driverId = `zerodep-driver-${Math.random().toString(16).slice(2, 10)}`;
      const driven = new MongoSessionHandler({ host: MONGO_HOST, port: MONGO_PORT } as never);
      driven.write(driverId, { seeded: true } as never, 300);
      const drivenRead = JSON.stringify(driven.read(driverId));
      driven.destroy(driverId);
      assert(
        "the_third_party_client_is_still_used_when_present",
        driverInstalled && drivenRead === JSON.stringify({ seeded: true }),
        `mongodb resolvable=${driverInstalled} readback=${drivenRead} - the fallback must not `
        + "replace the driver, only stand in for it",
      );
    }
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
    try {
      const { closeSyncSockets } = await import("../packages/core/src/sessionHandlers/syncSocket.js");
      closeSyncSockets();
    } catch { /* nothing to reap */ }
  }
}

await main();

console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`
  + (skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : ""),
);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

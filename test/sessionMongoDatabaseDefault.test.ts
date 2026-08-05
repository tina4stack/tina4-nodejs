/**
 * SESSION CONTRACT: with TINA4_SESSION_MONGO_DB unset, the same .env must put a
 * session in the SAME MongoDB database in all four frameworks.
 *
 * THE DEFECT, measured across the four on 2026-08-06:
 *
 *     Node:    ?? "tina4_sessions"      <- the outlier
 *     Python:  default: tina4
 *     PHP:     ?: 'tina4'
 *     Ruby:    || "tina4"
 *
 * So an operator who deploys the identical configuration to a Python service and
 * a Node service gets two session stores in two different databases, with no
 * error and nothing in a log to say so. That is the ADR-0024 failure mode
 * exactly: identical configuration, different observable outcome. Node aligns
 * to "tina4".
 *
 * NO MIGRATION IS OWED, and no fallback read is offered. A session store is
 * ephemeral by definition - every document here carries a TTL (default 3600s) -
 * so the impact self-heals within one session lifetime and the worst case is
 * that current users re-authenticate once. A fallback read would double a read
 * path forever to save one hour of logins. (Contrast the Ruby queue-store move,
 * where the rows were pending work somebody was waiting on and a one-time
 * migration was mandatory.)
 *
 * NO MOCKS. A real MongoDB, real writes, real reads. The database each write
 * landed in is established by reading it back through a handler pinned to that
 * database - not by inspecting the handler's fields, which would prove only that
 * a literal was changed.
 *
 * THE THREE CASES, and why each is load-bearing:
 *   1. the default write is READABLE from "tina4"       - the aligned behaviour.
 *   2. the default write is ABSENT from "tina4_sessions" - the defect itself.
 *                                          Case 1 alone passes if the handler
 *                                          somehow wrote to both.
 *   3. TINA4_SESSION_MONGO_DB still overrides            - THE NEGATIVE CONTROL.
 *                                          Without it, hard-coding "tina4" and
 *                                          ignoring the env var passes 1 and 2
 *                                          while breaking every deployment that
 *                                          names its database, which is most of
 *                                          the ones that care.
 */
import { connect } from "node:net";
import { MongoSessionHandler } from "../packages/core/src/sessionHandlers/mongoHandler.js";
import { closeBridges } from "../packages/core/src/sessionHandlers/syncBridge.js";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

const LIVE_HOST = process.env.TINA4_TEST_MONGO_HOST ?? "127.0.0.1";
const LIVE_PORT = parseInt(process.env.TINA4_TEST_MONGO_PORT ?? "27017", 10);

/** The default this change aligns Node TO, and the one it moves AWAY from. */
const ALIGNED_DATABASE = "tina4";
const OUTLIER_DATABASE = "tina4_sessions";

/**
 * A collection of our own. The database is what is under test, so the
 * collection is pinned explicitly - that keeps a sibling framework's suite on
 * this shared lab MongoDB out of the assertions without weakening anything.
 */
const COLLECTION = `sessions_dbdefault_${process.pid}`;

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

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A handler pinned to one database - the instrument that says where a write went. */
function pinnedTo(database: string): MongoSessionHandler {
  return new MongoSessionHandler({ host: LIVE_HOST, port: LIVE_PORT, database, collection: COLLECTION });
}

console.log("\n== session mongo database default ==\n");

if (!(await reachable(LIVE_HOST, LIVE_PORT))) {
  const message = `mongo not reachable at ${LIVE_HOST}:${LIVE_PORT}`;
  if (process.env.TINA4_REQUIRE_SERVICES) {
    assert("session_mongo_default_database_is_tina4", false, message);
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m ${message}`);
  }
} else {
  const savedDb = process.env.TINA4_SESSION_MONGO_DB;
  const savedUri = process.env.TINA4_SESSION_MONGO_URI;
  const savedUrl = process.env.TINA4_SESSION_MONGO_URL;

  const defaultKey = `dbdefault-${process.pid}-${Date.now()}`;
  const overrideKey = `dboverride-${process.pid}-${Date.now()}`;
  const overrideDatabase = `tina4_dbdefault_${process.pid}`;

  try {
    // The lab environment exports TINA4_SESSION_MONGO_DB (and a URI) for
    // per-framework isolation. Both are cleared here on purpose: an unset
    // TINA4_SESSION_MONGO_DB is the entire subject of cases 1 and 2, and a URI
    // would decide host/port for the un-pinned handler rather than the arguments
    // this test passes.
    setEnv("TINA4_SESSION_MONGO_DB", undefined);
    setEnv("TINA4_SESSION_MONGO_URI", undefined);
    setEnv("TINA4_SESSION_MONGO_URL", undefined);

    // -- 1. the DEFAULT write lands in "tina4" ------------------------------
    const byDefault = new MongoSessionHandler({ host: LIVE_HOST, port: LIVE_PORT, collection: COLLECTION });
    byDefault.write(defaultKey, { _created: 1, _accessed: 1, marker: "aligned" }, 300);

    const fromAligned = pinnedTo(ALIGNED_DATABASE).read(defaultKey);
    assert(
      "session_mongo_default_database_is_tina4",
      fromAligned !== null && (fromAligned as Record<string, unknown>).marker === "aligned",
      `wrote with TINA4_SESSION_MONGO_DB unset, then read "${ALIGNED_DATABASE}"."${COLLECTION}" `
      + `for _id=${defaultKey} and got ${JSON.stringify(fromAligned)}; the default database is `
      + "not tina4, so the same .env still splits Node's sessions from the other three",
    );

    // -- 2. and NOT in the old outlier database -----------------------------
    const fromOutlier = pinnedTo(OUTLIER_DATABASE).read(defaultKey);
    assert(
      "session_mongo_default_database_is_no_longer_tina4_sessions",
      fromOutlier === null,
      `the default write is still visible in "${OUTLIER_DATABASE}" (${JSON.stringify(fromOutlier)}), `
      + "so Node is still writing to the outlier database",
    );

    // -- 3. NEGATIVE CONTROL: the env var still decides ---------------------
    //
    // Aligning the DEFAULT must not turn the database into a constant. An
    // operator who names a database keeps it, and the aligned default must not
    // receive that write.
    setEnv("TINA4_SESSION_MONGO_DB", overrideDatabase);
    const byEnv = new MongoSessionHandler({ host: LIVE_HOST, port: LIVE_PORT, collection: COLLECTION });
    byEnv.write(overrideKey, { _created: 1, _accessed: 1, marker: "override" }, 300);
    setEnv("TINA4_SESSION_MONGO_DB", undefined);

    const fromOverride = pinnedTo(overrideDatabase).read(overrideKey);
    const leakedToDefault = pinnedTo(ALIGNED_DATABASE).read(overrideKey);
    assert(
      "session_mongo_database_env_var_still_overrides_the_default",
      fromOverride !== null
        && (fromOverride as Record<string, unknown>).marker === "override"
        && leakedToDefault === null,
      `TINA4_SESSION_MONGO_DB=${overrideDatabase} must still decide the database: read it back as `
      + `${JSON.stringify(fromOverride)} and found ${JSON.stringify(leakedToDefault)} in `
      + `"${ALIGNED_DATABASE}"; the default was hard-coded rather than defaulted`,
    );

    // Leave nothing behind on a shared server.
    pinnedTo(ALIGNED_DATABASE).destroy(defaultKey);
    pinnedTo(OUTLIER_DATABASE).destroy(defaultKey);
    pinnedTo(overrideDatabase).destroy(overrideKey);
  } finally {
    setEnv("TINA4_SESSION_MONGO_DB", savedDb);
    setEnv("TINA4_SESSION_MONGO_URI", savedUri);
    setEnv("TINA4_SESSION_MONGO_URL", savedUrl);
    closeBridges();
  }
}

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m\n`);
if (fail > 0) process.exitCode = 1;

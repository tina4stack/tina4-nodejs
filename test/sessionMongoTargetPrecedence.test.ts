/**
 * SESSION CONTRACT: explicit configuration beats the environment, and an
 * unreachable server is a transport FAILURE rather than a miss.
 *
 * THE DEFECT, measured 2026-08-05 on the lab host. MongoSessionHandler.target()
 * let a mongodb:// URI win UNCONDITIONALLY - including over an argument the
 * caller had just passed by hand. With an ordinary deployment setting exported,
 * TINA4_SESSION_MONGO_URI=mongodb://127.0.0.1:27017/tina4_node:
 *
 *     new MongoSessionHandler({ host: "127.0.0.1", port: 59999 })
 *         asked for 127.0.0.1:59999
 *         actually dialled 127.0.0.1:27017
 *
 * The handler connected to a DIFFERENT SERVER from the one it was told to use,
 * said nothing about it, and a read came back null - indistinguishable from a
 * genuine miss. An app that points a handler at one Mongo while the environment
 * names another writes its sessions to the wrong server, and the log-loud-and-
 * degrade policy never fires because from its point of view nothing failed.
 *
 * It also made TWO existing suites report a framework contract as broken: the
 * unreachable-server-must-throw cases in sessionHandlers.test and
 * sessionMongoRawProtocol.test never reached the dead port, so they measured a
 * LIVE server and got a miss. Those cases were right. This was the bug they were
 * catching, and it read as a flaky test for as long as nobody looked.
 *
 * Same class as the TINA4_QUEUE_URL precedence inversion fixed in PHP's
 * Queue::resolveMongoConfig the same day: the environment quietly beating an
 * explicit argument.
 *
 * NO MOCKS. A real MongoDB for the reachable side and a genuinely closed TCP
 * port for the unreachable side. Nothing here is simulated - the throw comes
 * from a real ECONNREFUSED off the kernel.
 *
 * THE FOUR CASES, and why each is load-bearing:
 *   1. explicit host/port beats an ENV uri  - the defect itself.
 *   2. an explicit uri still wins            - the fix must not invert the other
 *                                              way and start ignoring a uri the
 *                                              caller passed deliberately.
 *   3. an ENV uri is still used when nothing is explicit - THE NEGATIVE CONTROL.
 *                                              Without it, "never use the env
 *                                              uri" passes 1 and 2 and silently
 *                                              breaks every deployment that
 *                                              configures Mongo by environment,
 *                                              which is most of them.
 *   4. an unreachable server THROWS          - the contract the defect masked.
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
/** Nothing listens here. The refusal comes from the kernel, not from us. */
const DEAD_PORT = 59999;

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

/** Did the handler really dial this address? A refusal proves it did. */
function readThrew(handler: MongoSessionHandler): boolean {
  try {
    handler.read(`precedence-probe-${Date.now()}`);
    return false;
  } catch {
    return true;
  }
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("\n== session mongo target precedence ==\n");

if (!(await reachable(LIVE_HOST, LIVE_PORT))) {
  const message = `mongo not reachable at ${LIVE_HOST}:${LIVE_PORT}`;
  if (process.env.TINA4_REQUIRE_SERVICES) {
    assert("session_mongo_explicit_host_port_beats_an_env_uri", false, message);
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m ${message}`);
  }
} else if (await reachable(LIVE_HOST, DEAD_PORT)) {
  // The instrument must really be closed, or every case below passes vacuously.
  assert(
    "session_mongo_explicit_host_port_beats_an_env_uri",
    false,
    `THE INSTRUMENT FAILED: something is listening on ${LIVE_HOST}:${DEAD_PORT}, `
    + "so an 'unreachable' port is reachable and no case here proves anything",
  );
} else {
  const savedUri = process.env.TINA4_SESSION_MONGO_URI;
  const savedUrl = process.env.TINA4_SESSION_MONGO_URL;
  const liveUri = `mongodb://${LIVE_HOST}:${LIVE_PORT}/tina4_precedence`;

  try {
    // -- 1. explicit host/port beats an ENV uri ----------------------------
    setEnv("TINA4_SESSION_MONGO_URI", liveUri);
    setEnv("TINA4_SESSION_MONGO_URL", undefined);
    assert(
      "session_mongo_explicit_host_port_beats_an_env_uri",
      readThrew(new MongoSessionHandler({ host: LIVE_HOST, port: DEAD_PORT })),
      `asked for ${LIVE_HOST}:${DEAD_PORT} with TINA4_SESSION_MONGO_URI=${liveUri}; `
      + "the read did NOT fail, so the handler dialled the URI's server instead of "
      + "the one it was given",
    );

    // -- 2. an explicit uri still wins -------------------------------------
    setEnv("TINA4_SESSION_MONGO_URI", liveUri);
    assert(
      "session_mongo_explicit_uri_still_wins",
      readThrew(new MongoSessionHandler({ uri: `mongodb://${LIVE_HOST}:${DEAD_PORT}/x` } as never)),
      "an explicitly passed uri must still decide the address; the read did not "
      + "reach the dead port named by it",
    );

    // -- 3. NEGATIVE CONTROL: the ENV uri is still honoured ----------------
    //
    // Nothing explicit at all, so the environment IS the configuration. A miss
    // against the live server returns null WITHOUT throwing. If this throws, the
    // fix went too far and every env-configured deployment just broke.
    setEnv("TINA4_SESSION_MONGO_URI", liveUri);
    assert(
      "session_mongo_env_uri_is_used_when_nothing_is_explicit",
      !readThrew(new MongoSessionHandler()),
      "with no explicit config the ENV uri must still be used; the read failed, "
      + "which means the env path was broken rather than merely deprioritised",
    );

    // -- 4. the contract the defect masked --------------------------------
    //
    // No uri anywhere, so there is nothing left to argue about: the handler is
    // pointed at a closed port and a transport failure must SURFACE rather than
    // read as a miss. A miss and an outage must never look the same on a session
    // store - that is how an outage silently logs everybody out.
    setEnv("TINA4_SESSION_MONGO_URI", undefined);
    setEnv("TINA4_SESSION_MONGO_URL", undefined);
    assert(
      "session_mongo_unreachable_server_throws_rather_than_reading_as_a_miss",
      readThrew(new MongoSessionHandler({ host: LIVE_HOST, port: DEAD_PORT })),
      "an unreachable server read as a MISS instead of failing, so the "
      + "log-loud-and-degrade policy can never fire for MongoDB",
    );
  } finally {
    setEnv("TINA4_SESSION_MONGO_URI", savedUri);
    setEnv("TINA4_SESSION_MONGO_URL", savedUrl);
    closeBridges();
  }
}

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m\n`);
if (fail > 0) process.exitCode = 1;

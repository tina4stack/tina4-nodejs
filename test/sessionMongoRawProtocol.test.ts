/**
 * The MongoDB session backend's ZERO-DEPENDENCY raw wire-protocol path.
 *
 * mongoClient has two transports, mirroring the Python master's pymongo-first
 * design: the official `mongodb` driver when it resolves, and a raw OP_MSG
 * fallback over node:net with a minimal BSON codec.
 *
 * The fallback is the one that never gets exercised. @tina4/orm depends on the
 * driver, so on any machine that runs this suite the driver IS installed and the
 * raw path is dead code in every test — which is exactly how its previous bugs
 * survived: `$db` encoded FIRST (so the server read it as the command name and
 * answered CommandNotFound), big-endian doubles, arrays and booleans not encoded
 * at all, and a response "parsed" by regex-matching against binary BSON.
 *
 * TINA4_MONGO_FORCE_RAW selects the raw path deliberately. That is choosing a
 * REAL code path against a REAL server, not a stub — no mock is involved.
 *
 * Run with: npx tsx test/sessionMongoRawProtocol.test.ts
 */
process.env.TINA4_MONGO_FORCE_RAW = "1";

import { execFileSync } from "node:child_process";

const HOST = process.env.TINA4_TEST_MONGO_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.TINA4_TEST_MONGO_PORT ?? "27017", 10);

let pass = 0;
let fail = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function reachable(): boolean {
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `const net=require("node:net");const s=net.createConnection({host:${JSON.stringify(HOST)},port:${PORT}});
         s.on("connect",()=>{s.destroy();process.exit(0)});
         s.on("error",()=>process.exit(1));
         setTimeout(()=>process.exit(1),2000);`,
      ],
      { stdio: "ignore", timeout: 4000 },
    );
    return true;
  } catch {
    return false;
  }
}

console.log(`=== MongoDB raw OP_MSG path (live ${HOST}:${PORT}) ===\n`);

if (!reachable()) {
  if (process.env.TINA4_REQUIRE_SERVICES) {
    console.log(`  \x1b[31m-\x1b[0m TINA4_REQUIRE_SERVICES is set but MongoDB is unreachable at ${HOST}:${PORT}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m MongoDB not reachable at ${HOST}:${PORT}`);
  process.exit(0);
}

const { MongoSessionHandler } = await import("../packages/core/src/sessionHandlers/mongoHandler.js");
const { closeBridges } = await import("../packages/core/src/sessionHandlers/syncBridge.js");

const h = new MongoSessionHandler({ host: HOST, port: PORT } as never);

// Deliberately exercises every BSON type the codec encodes: string, int, double,
// boolean, array, nested document, null. A type it cannot encode produced a
// malformed command the server rejected.
const SESSION = {
  _created: 1,
  _accessed: 2,
  userId: 7,
  ratio: 1.5,
  active: true,
  missing: null,
  tags: ["a", "b", "c"],
  nested: { deep: { n: 42 }, flag: false },
} as const;

try {
  h.write("raw-lifecycle", { ...SESSION } as never, 60);
  const hit = h.read("raw-lifecycle") as Record<string, unknown> | null;

  assert("a written session reads back", hit !== null);
  assert("...string and int survive", hit?.userId === 7);
  assert("...a double survives (little-endian)", hit?.ratio === 1.5);
  assert("...a boolean survives", hit?.active === true && (hit?.nested as never as { flag: boolean })?.flag === false);
  assert("...an array survives", Array.isArray(hit?.tags) && (hit?.tags as string[]).length === 3);
  assert("...a nested document survives",
    ((hit?.nested as never as { deep: { n: number } })?.deep?.n) === 42);

  // A miss and a failure must be different outcomes.
  assert("a miss returns null, NOT an error", h.read("raw-definitely-absent") === null);

  h.destroy("raw-lifecycle");
  assert("destroy removes the session", h.read("raw-lifecycle") === null);

  // An unreachable server must THROW rather than read as a miss — otherwise an
  // outage silently logs every user out.
  const dead = new MongoSessionHandler({ host: HOST, port: 59999 } as never);
  let threw = false;
  try {
    dead.read("anything");
  } catch {
    threw = true;
  }
  assert("an unreachable server THROWS (never reads as a miss)", threw);

  // The channel must survive a failure: the next command reconnects.
  h.write("raw-after-fail", { ...SESSION } as never, 60);
  assert("the channel still works after a failed command", h.read("raw-after-fail") !== null);
  h.destroy("raw-after-fail");
} finally {
  closeBridges();
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

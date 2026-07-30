/**
 * The synchronous socket transport — against a REAL Redis/Valkey server.
 *
 * This is the transport every Redis, Valkey and Memcached session command goes
 * through, so its contract is pinned here rather than only through one backend.
 *
 * WHAT IT REPLACED. Each command used to run in a short-lived `node -e` child,
 * paying a process spawn AND a fresh TCP connection every time. Measured on this
 * machine: spawn min 38ms / p50 41ms / p99 487ms, and a bare TCP connect had a
 * ~0.5-0.9s tail of its own. That tail tripped the child's 3s deadline under
 * load, which is what made sessionHandlers.test flaky (2-3 failures in 6 runs)
 * with the signature "a value that was just written reads back null" — the SET
 * timed out for the caller while still landing on the server, so the next GET
 * legitimately saw nothing. A brand-new memcached handler inherited the same
 * failure the day it was written, confirming the TRANSPORT was the defect.
 *
 * NO MOCKS. Every assertion drives a live server over TCP.
 *
 * Run with: npx tsx test/syncSocketTransport.test.ts
 */
import { execFileSync } from "node:child_process";
import { syncCommand, syncTextCommand, closeSyncSockets } from "../packages/core/src/sessionHandlers/syncSocket.js";

const HOST = process.env.TINA4_TEST_REDIS_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.TINA4_TEST_REDIS_PORT ?? "6379", 10);
const MC_HOST = process.env.TINA4_TEST_MEMCACHED_HOST ?? "127.0.0.1";
const MC_PORT = parseInt(process.env.TINA4_TEST_MEMCACHED_PORT ?? "11211", 10);

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

function reachable(host: string, port: number): boolean {
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `const net=require("node:net");const s=net.createConnection({host:${JSON.stringify(host)},port:${port}});
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

console.log(`=== sync socket transport (live ${HOST}:${PORT}) ===\n`);

if (!reachable(HOST, PORT)) {
  if (process.env.TINA4_REQUIRE_SERVICES) {
    console.log(`  \x1b[31m-\x1b[0m TINA4_REQUIRE_SERVICES is set but Redis/Valkey is unreachable at ${HOST}:${PORT}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m Redis/Valkey not reachable at ${HOST}:${PORT}`);
  process.exit(0);
}

const T = { host: HOST, port: PORT, db: 0 };

try {
  // --- RESP basics -------------------------------------------------------
  assert("PING round-trips", syncCommand(T, ["PING"], "V") === "PONG");

  syncCommand(T, ["SET", "sync:t:a", '{"x":1}'], "V");
  assert("a written value reads back", syncCommand(T, ["GET", "sync:t:a"], "V") === '{"x":1}');

  // The miss/failure split is the whole contract: collapsing them is how a dead
  // backend silently logs every user out instead of surfacing an outage.
  assert("a genuine miss returns empty, NOT an error", syncCommand(T, ["GET", "sync:t:absent"], "V") === "");

  syncCommand(T, ["DEL", "sync:t:a"], "V");
  assert("a deleted key reads back as a miss", syncCommand(T, ["GET", "sync:t:a"], "V") === "");

  // --- the write-then-read invariant the flake violated -------------------
  // 100 consecutive write-then-read pairs. Under the old child transport a
  // spawn-latency spike made a just-written key read back null; over a single
  // persistent connection there is no such window.
  let mismatches = 0;
  for (let i = 0; i < 100; i++) {
    syncCommand(T, ["SET", `sync:t:rw${i}`, `v${i}`], "V");
    if (syncCommand(T, ["GET", `sync:t:rw${i}`], "V") !== `v${i}`) mismatches++;
  }
  for (let i = 0; i < 100; i++) syncCommand(T, ["DEL", `sync:t:rw${i}`], "V");
  assert("100 write-then-read pairs never read back stale", mismatches === 0, `${mismatches} mismatched`);

  // --- large payloads across TCP chunks ----------------------------------
  // A bulk string bigger than one TCP segment must be reassembled, not truncated.
  const big = "y".repeat(600_000);
  syncCommand(T, ["SET", "sync:t:big", big], "V");
  const readBack = syncCommand(T, ["GET", "sync:t:big"], "V");
  assert("a 600KB value survives chunked reassembly", readBack.length === big.length && readBack === big,
    `got ${readBack.length} of ${big.length}`);
  syncCommand(T, ["DEL", "sync:t:big"], "V");

  // --- failure semantics --------------------------------------------------
  // A dead socket and a healthy server saying "-ERR" are different failures and
  // must read differently in a log.
  let transportMsg = "";
  const started = Date.now();
  try {
    syncCommand({ host: "127.0.0.1", port: 59999 }, ["GET", "x"], "Valkey");
  } catch (e) {
    transportMsg = String((e as Error).message);
  }
  assert("an unreachable server THROWS (never reads as a miss)", transportMsg !== "");
  assert("...worded as a transport failure", transportMsg.includes("Valkey command failed"), transportMsg);
  // It must fail FAST. Before the connect timeout was added this sat out the
  // full 5s reply deadline just to learn the server was down.
  assert("...and fails fast rather than waiting out the reply deadline", Date.now() - started < 3000,
    `took ${Date.now() - started}ms`);

  syncCommand(T, ["SET", "sync:t:str", "hello"], "V");
  let respMsg = "";
  try {
    syncCommand(T, ["LPUSH", "sync:t:str", "x"], "V");
  } catch (e) {
    respMsg = String((e as Error).message);
  }
  assert("a RESP -ERR reply THROWS", respMsg !== "");
  assert("...worded as a server error, not a transport failure",
    respMsg.includes("Valkey error") || respMsg.includes("V error"), respMsg);
  syncCommand(T, ["DEL", "sync:t:str"], "V");

  // --- the channel survives a failure ------------------------------------
  // A transient blip must not poison the channel: the next command reconnects.
  assert("the channel still works after a failed command", syncCommand(T, ["PING"], "V") === "PONG");

  // --- text protocol (memcached) over the same transport -----------------
  if (reachable(MC_HOST, MC_PORT)) {
    const MC = { host: MC_HOST, port: MC_PORT };
    const stored = syncTextCommand(MC, "set sync:t:mc 0 60 2\r\nhi\r\n", ["STORED\r\n", "ERROR\r\n"], "Memcached");
    assert("text protocol: a set is STORED", stored.startsWith("STORED"));
    const got = syncTextCommand(MC, "get sync:t:mc\r\n", ["END\r\n"], "Memcached");
    assert("text protocol: the value reads back", got.includes("hi"));
    const miss = syncTextCommand(MC, "get sync:t:absent\r\n", ["END\r\n"], "Memcached");
    assert("text protocol: a miss is END with no VALUE", miss.startsWith("END"));
    syncTextCommand(MC, "delete sync:t:mc\r\n", ["DELETED\r\n", "NOT_FOUND\r\n"], "Memcached");
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m memcached leg — not reachable at ${MC_HOST}:${MC_PORT}`);
  }
} finally {
  // Reap what you spawn: the workers are unref'd (so they never hold a real app
  // open), but a test closes them explicitly all the same.
  closeSyncSockets();
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

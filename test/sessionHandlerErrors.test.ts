/**
 * Session-handler error reporting — the cause, not a dump of the generated script.
 *
 * Each session handler runs its backend command in a short-lived `node -e` child
 * (the handler interface is synchronous; every client is async). When the child
 * failed, the handlers threw `execFileSync`'s own error message -- which begins
 * "Command failed:" and then embeds THE ENTIRE GENERATED SCRIPT. An operator
 * debugging a Redis outage got kilobytes of JavaScript with
 * "connect ECONNREFUSED 127.0.0.1:6379" nowhere in it.
 *
 * The children already wrote the real reason to stderr and `execFileSync`
 * captures it on `err.stderr`; nothing read it. Two of the children also called
 * a bare `process.exit(1)` right after writing, which TRUNCATES that async write,
 * so their stderr arrived empty.
 *
 * NO MOCKS. Every case here points a real handler at a real socket: a genuinely
 * closed port, and a real server (in its own process) that accepts and never
 * replies. No stand-in for any collaborator, so these run everywhere rather than
 * being gated on a live Redis/Mongo.
 */
import net from "node:net";
import { spawn } from "node:child_process";
import {
  RedisNpmSessionHandler,
  ValkeySessionHandler,
} from "../packages/core/src/index.ts";
import { mongoCommandSync } from "../packages/core/src/sessionHandlers/mongoClient.ts";
import { childFailureReason } from "../packages/core/src/sessionHandlers/childError.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

/** Run fn and return the thrown error, or null if it did not throw. */
function caught(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

/** Find a port nothing is listening on, by binding and immediately releasing it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A REAL server that accepts a connection and never answers, so the child hits
 * its own timeout.
 *
 * It MUST live in its own process: the handlers block on `execFileSync`, which
 * freezes THIS process's event loop, so an in-process listener would have its
 * TCP handshake completed by the kernel and never run its `connection` callback.
 */
function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const listener = `
    const net = require("node:net");
    const server = net.createServer((sock) => { sock.on("error", () => {}); });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write("PORT=" + server.address().port + "\\n");
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", listener], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const bail = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("silent listener did not report a port"));
    }, 5000);
    child.stdout.setEncoding("utf-8");
    child.stdout.once("data", (line: string) => {
      clearTimeout(bail);
      const port = parseInt(/PORT=(\d+)/.exec(line)?.[1] ?? "0", 10);
      if (!port) {
        child.kill("SIGKILL");
        reject(new Error(`unreadable port line: ${line}`));
        return;
      }
      resolve({
        port,
        // We spawned it, so we own its death.
        close: () =>
          new Promise<void>((done) => {
            child.once("exit", () => done());
            child.kill("SIGKILL");
          }),
      });
    });
    child.once("error", reject);
  });
}

/** The signature of the old bug: the generated child script leaking into the message. */
function looksLikeAScriptDump(message: string): boolean {
  return /node -e|const net = require|const server =|createClient|MongoClient/.test(message);
}

console.log("=== Session Handler Error Reporting ===\n");

// ── 1. Redis: a refused connection names the cause ────────────────

{
  const port = await closedPort();
  const handler = new RedisNpmSessionHandler({ host: "127.0.0.1", port });
  const err = caught(() => handler.read("sid-does-not-matter"));

  assert("Redis read() on a closed port throws", err !== null, "did not throw");
  assert(
    "the Redis message names the backend",
    err !== null && err.message.startsWith("Redis command failed:"),
    err?.message ?? "",
  );
  // NEGATIVE: this is the actual bug — the whole generated script used to be here.
  assert(
    "the Redis message does NOT dump the generated script",
    err !== null && !looksLikeAScriptDump(err.message),
    `${err?.message.length ?? 0} chars: ${err?.message.slice(0, 120)}`,
  );
  assert(
    "the Redis message carries the real refusal reason",
    err !== null && /ECONNREFUSED|refused/i.test(err.message),
    err?.message ?? "",
  );
  assert(
    "the Redis message stays short enough to read in a log",
    err !== null && err.message.length < 300,
    `${err?.message.length ?? 0} chars`,
  );
}

// ── 2. Valkey: same contract through the shared RESP transport ─────

{
  const port = await closedPort();
  const handler = new ValkeySessionHandler({ host: "127.0.0.1", port });
  const err = caught(() => handler.read("sid-does-not-matter"));

  assert("Valkey read() on a closed port throws", err !== null, "did not throw");
  assert(
    "the Valkey message names the backend",
    err !== null && err.message.startsWith("Valkey command failed:"),
    err?.message ?? "",
  );
  assert(
    "the Valkey message does NOT dump the generated script",
    err !== null && !looksLikeAScriptDump(err.message),
    `${err?.message.length ?? 0} chars: ${err?.message.slice(0, 120)}`,
  );
  assert(
    "the Valkey message carries the real refusal reason",
    err !== null && /ECONNREFUSED|refused/i.test(err.message),
    err?.message ?? "",
  );
}

// ── 3. MongoDB: same contract ─────────────────────────────────────

{
  const port = await closedPort();
  const err = caught(() =>
    mongoCommandSync(
      { host: "127.0.0.1", port, database: "tina4_t", collection: "sessions" },
      "find",
      { filter: { _id: "sid" } },
    ),
  );

  assert("mongoCommandSync on a closed port throws", err !== null, "did not throw");
  assert(
    "the MongoDB message names the backend",
    err !== null && err.message.startsWith("MongoDB command failed:"),
    err?.message ?? "",
  );
  assert(
    "the MongoDB message does NOT dump the generated script",
    err !== null && !looksLikeAScriptDump(err.message),
    `${err?.message.length ?? 0} chars: ${err?.message.slice(0, 120)}`,
  );
  assert(
    "the MongoDB message stays short enough to read in a log",
    err !== null && err.message.length < 300,
    `${err?.message.length ?? 0} chars`,
  );
}

// ── 4. A server that never answers reports a timeout, not a script ─

{
  const server = await startSilentServer();
  try {
    const handler = new ValkeySessionHandler({ host: "127.0.0.1", port: server.port });
    const err = caught(() => handler.read("sid-does-not-matter"));

    assert("Valkey read() against a silent server throws", err !== null, "did not throw");
    assert(
      "a stalled connection is reported as a timeout",
      err !== null && /timed out|timeout/i.test(err.message),
      err?.message ?? "",
    );
    assert(
      "the timeout message does NOT dump the generated script",
      err !== null && !looksLikeAScriptDump(err.message),
      `${err?.message.length ?? 0} chars: ${err?.message.slice(0, 120)}`,
    );
  } finally {
    // Reap what we spawned, in the same piece of work.
    await server.close();
  }
}

// ── 5. childFailureReason: pure function over its inputs ──────────

{
  // Not a mock: these are plain input VALUES to a pure function, the way a
  // string is input to a parser. Nothing stands in for a collaborator.

  // POSITIVE: the child's stderr wins over execFileSync's message.
  assert(
    "stderr is preferred over the (script-dumping) message",
    childFailureReason({
      stderr: "connect ECONNREFUSED 127.0.0.1:6379",
      message: "Command failed: node -e <10kb of script>",
    }) === "connect ECONNREFUSED 127.0.0.1:6379",
    childFailureReason({ stderr: "connect ECONNREFUSED 127.0.0.1:6379", message: "x" }),
  );

  // NEGATIVE: a signal kill leaves stderr EMPTY, so without this branch the
  // caller would fall through to the useless generic message.
  const killed = childFailureReason({ stderr: "", signal: "SIGTERM", message: "Command failed: ..." });
  assert(
    "a killed child is reported as a timeout/kill, not 'Command failed'",
    /timed out or was killed/.test(killed),
    killed,
  );

  const exited = childFailureReason({ stderr: "", status: 1, message: "Command failed: node -e ..." });
  assert(
    "a silent non-zero exit says so instead of dumping the message",
    /exited with code 1/.test(exited),
    exited,
  );

  // NEGATIVE: the last-resort fallback must still be bounded — an unbounded
  // fallback is how the script got into the log in the first place.
  const long = childFailureReason({ message: "Command failed: " + "x".repeat(5000) });
  assert(
    "the fallback message is truncated, never unbounded",
    long.length <= 210,
    `${long.length} chars`,
  );

  // POSITIVE: multi-line stderr collapses to its first line.
  assert(
    "only the first line of stderr is used",
    childFailureReason({ stderr: "real cause\nstack frame 1\nstack frame 2" }) === "real cause",
    childFailureReason({ stderr: "real cause\nstack frame 1" }),
  );
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

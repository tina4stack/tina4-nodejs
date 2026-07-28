/**
 * Kafka error-reporting contract — a real failure must never read as an empty queue.
 *
 * The bug: the fetch path treated EVERY non-zero Kafka error code as "no
 * message", and the transport catch turned any child-process failure into "".
 * `pop()` mapped both to null, which is the documented value for an EMPTY
 * queue. So a mis-permissioned consumer (TOPIC_AUTHORIZATION_FAILED, code 29),
 * a dead broker, and a genuinely idle topic were all indistinguishable: the
 * consumer polled an "idle" queue forever and nothing was ever logged.
 *
 * Only two codes legitimately mean "nothing here yet" —
 * UNKNOWN_TOPIC_OR_PARTITION (3) and LEADER_NOT_AVAILABLE (5), which a consumer
 * that starts before its producer hits on every cold start. Everything else is
 * a real failure and must surface. This matches the Python and PHP backends,
 * including the error wording.
 *
 * NO MOCKS. The first three cases need no Kafka at all: they point the backend
 * at a real closed port and at a real TCP server that answers with a real
 * malformed frame. Nothing stands in for a collaborator — the sockets, the
 * server and the bytes are all genuine, which is also why these run everywhere
 * rather than being gated on a broker. The last case needs a live broker and is
 * gated on reachability.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KafkaBackend } from "../packages/core/src/index.ts";

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

function reachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
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
 * A REAL TCP server that answers a Kafka request with a well-framed but
 * truncated response: a 4-byte length prefix of 8 followed by 8 bytes. The
 * backend reads the frame as complete, then runs off the end of the buffer while
 * parsing — a genuine malformed-response condition, produced for real rather
 * than simulated.
 *
 * It MUST run in its own process. The backend drives its socket through
 * `execFileSync`, which BLOCKS the calling thread's event loop: a listener in
 * this process would have its TCP handshake completed by the kernel but its
 * `connection` callback would never be scheduled, so the request would go
 * unanswered and the backend would sit out its full 10s timeout. That looks
 * exactly like a transport failure and would test the wrong path — it cost a
 * debugging round to find, hence this note.
 */
function startTruncatingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const listener = `
    const net = require("node:net");
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.once("data", () => {
        const frame = Buffer.alloc(12);
        frame.writeInt32BE(8, 0);   // "8 more bytes follow" — the frame IS complete
        sock.write(frame);          // ...but there is no topic array to parse
      });
    });
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
      reject(new Error("truncating listener did not report a port"));
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
        // We spawned it, so we own its death — kill the process and wait for it.
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

console.log("=== Kafka Error-Code Contract ===\n");

// ── 1. A dead broker must not look like an empty queue ────────────

{
  const port = await closedPort();
  const backend = new KafkaBackend({ brokers: `127.0.0.1:${port}` });

  // NEGATIVE: before the fix this returned null — "queue is empty" — so a
  // consumer against a dead broker span forever in silence.
  const popErr = caught(() => backend.pop("t_dead_broker"));
  assert(
    "pop() THROWS on an unreachable broker (does not report an empty queue)",
    popErr !== null,
    "pop() returned instead of throwing",
  );
  assert(
    "the pop() error names the topic so the cause is findable",
    popErr !== null && popErr.message.includes("t_dead_broker"),
    popErr?.message ?? "",
  );

  // NEGATIVE: push() used to throw a bare "Kafka publish failed" that discarded
  // the reason the child process had already captured on stderr.
  const pushErr = caught(() => backend.push("t_dead_broker", { hello: "world" }));
  assert(
    "push() THROWS on an unreachable broker",
    pushErr !== null,
    "push() returned instead of throwing",
  );
  assert(
    "the push() error carries the transport reason, not just 'publish failed'",
    pushErr !== null && pushErr.message !== "Kafka publish failed",
    pushErr?.message ?? "",
  );
}

// ── 2. A malformed response must not look like an empty queue ──────

{
  const server = await startTruncatingServer();
  try {
    const backend = new KafkaBackend({ brokers: `127.0.0.1:${server.port}` });

    // NEGATIVE: the parse catch used to return "__EMPTY__", so a broker
    // speaking a version we cannot read was reported as an idle queue.
    const err = caught(() => backend.pop("t_truncated"));
    assert(
      "pop() THROWS when the response cannot be parsed (not an empty queue)",
      err !== null,
      "pop() returned instead of throwing",
    );
    assert(
      "the parse error says the response was unreadable",
      err !== null && /unreadable response/.test(err.message),
      err?.message ?? "",
    );
  } finally {
    // Reap what we spawned, in the same piece of work.
    await server.close();
  }
}

// ── 3. Version floors (source invariant) ──────────────────────────

{
  // The Produce/Fetch versions live inside the protocol child's script string,
  // so there is no symbol to import — read the source instead. Kafka 4.x
  // REMOVED Produce v0-v2 and Fetch v0-v3 and answers them by closing the
  // socket rather than with an error code, so a regression here would surface
  // as a mystery disconnect. Assert the floors where they are actually written.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "..", "packages", "core", "src", "queueBackends", "kafkaBackend.ts"),
    "utf-8",
  );

  const produce = /const PRODUCE_VERSION = (\d+)/.exec(src);
  const fetchV = /const FETCH_VERSION = (\d+)/.exec(src);

  assert(
    "PRODUCE_VERSION is declared in the protocol script",
    produce !== null,
    "pattern not found — did the constant move or get renamed?",
  );
  assert(
    "FETCH_VERSION is declared in the protocol script",
    fetchV !== null,
    "pattern not found — did the constant move or get renamed?",
  );
  assert(
    "PRODUCE_VERSION >= 3 (v0-v2 carry the message format Kafka 4.x removed)",
    produce !== null && Number(produce[1]) >= 3,
    produce?.[1] ?? "",
  );
  assert(
    "FETCH_VERSION >= 4 (Kafka 4.3 advertises Fetch(1): 4 to 18)",
    fetchV !== null && Number(fetchV[1]) >= 4,
    fetchV?.[1] ?? "",
  );
}

// ── 4. Live broker: an unknown topic IS an empty queue ────────────

const url = process.env.TINA4_TEST_KAFKA_URL ?? process.env.TINA4_KAFKA_BROKERS;
if (!url) {
  console.log(
    "  SKIP: set TINA4_TEST_KAFKA_URL (e.g. localhost:9092) for the live unknown-topic case — Kafka broker not set.",
  );
} else {
  const broker = url.split(",")[0].trim().replace(/^kafka:\/\//, "");
  const [lhost, lportStr] = broker.split(":");
  const lport = parseInt(lportStr ?? "9092", 10);

  if (!(await reachable(lhost, lport))) {
    console.log(`  SKIP: Kafka broker not reachable at ${lhost}:${lport}.`);
  } else {
    const backend = new KafkaBackend({ brokers: broker });
    const absent = "t_absent_" + Math.random().toString(16).slice(2, 12);

    // POSITIVE: the counterpart to case 1 — codes 3 and 5 really do mean
    // "nothing to read yet", so this must stay null and must NOT throw. Without
    // this, "surface every error" would break every cold-start consumer.
    const err = caught(() => {
      const job = backend.pop(absent);
      assert(
        "pop() on a never-created topic returns null (code 3 = nothing yet)",
        job === null,
        JSON.stringify(job),
      );
      return job;
    });
    assert(
      "pop() on a never-created topic does NOT throw",
      err === null,
      err?.message ?? "",
    );
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

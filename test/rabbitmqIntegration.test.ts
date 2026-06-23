/**
 * Live RabbitMQ integration test — exercises the REAL broker (no mocks).
 * Run with: TINA4_TEST_RABBITMQ_URL=amqp://guest:guest@localhost:5672 npx tsx test/rabbitmqIntegration.test.ts
 *
 * Locks in the AMQP 0-9-1 handshake fix: the raw RabbitMQ backend must NEGOTIATE
 * Connection.TuneOk from the broker's Connection.Tune (echo channel-max, clamp
 * frame-max) instead of hardcoding channel-max=0. A hardcoded channel-max of 0
 * means "no limit", which RabbitMQ treats as exceeding its proposed channel-max
 * (2047) and so it closes the socket right after Connection.Open. If a full
 * push -> size(1) -> pop -> size(0) cycle works on a fresh queue, the handshake
 * negotiated correctly and the publish/get content frames are well-formed.
 *
 * Gated on TINA4_TEST_RABBITMQ_URL (e.g. amqp://guest:guest@localhost:5672).
 * Skips cleanly (reported as a pass with 0 assertions) when the env var is unset
 * or the broker is unreachable — it never fakes the broker (NO mock testing: a
 * queue test must hit a real RabbitMQ).
 */
import net from "node:net";
import { RabbitMQBackend, parseAmqpUrl } from "../packages/core/src/index.ts";

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

function summarise(): never {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
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

console.log("=== RabbitMQ Live Integration Test ===\n");

const url = process.env.TINA4_TEST_RABBITMQ_URL;
if (!url) {
  console.log("  SKIP: TINA4_TEST_RABBITMQ_URL not set (e.g. amqp://guest:guest@localhost:5672) — RabbitMQ broker not available for the live integration test.");
  summarise();
}

const cfg = parseAmqpUrl(url!);
const host = cfg.host ?? "localhost";
const port = cfg.port ?? 5672;

if (!(await reachable(host, port))) {
  console.log(`  SKIP: RabbitMQ broker unreachable at ${host}:${port}.`);
  summarise();
}

const queue = "tina4_test_" + Math.random().toString(16).slice(2, 14);
console.log(`  Queue: ${queue}\n`);

const backend = new RabbitMQBackend({
  host,
  port,
  username: cfg.username ?? "guest",
  password: cfg.password ?? "guest",
  vhost: cfg.vhost ?? "/",
});

try {
  // size() drives a full real handshake (Start/StartOk/Tune/TuneOk/Open/OpenOk
  // + Channel.Open) — if the TuneOk negotiation were broken this would fail.
  const size0 = backend.size(queue);
  assert("fresh queue is empty (handshake completed)", size0 === 0, `got ${size0}`);

  const id = backend.push(queue, { task: "node-integration", value: 999 });
  assert("push() returns an id", typeof id === "string" && id.length > 0);

  const size1 = backend.size(queue);
  assert("queue holds one message after push", size1 === 1, `got ${size1}`);

  const job = backend.pop(queue);
  assert("pop() returns the enqueued job", job !== null);
  assert(
    "popped payload round-trips",
    job !== null && (job.payload as any)?.task === "node-integration" && (job.payload as any)?.value === 999,
    JSON.stringify(job)
  );

  const size2 = backend.size(queue);
  assert("queue is empty after pop (no-ack get)", size2 === 0, `got ${size2}`);
} catch (err) {
  assert("lifecycle ran without throwing", false, String(err));
} finally {
  // Best-effort cleanup so a re-run starts clean.
  try { backend.clear(queue); } catch { /* ignore */ }
}

summarise();

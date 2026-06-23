/**
 * Live Kafka integration test — exercises the REAL broker (no mocks).
 * Run with: TINA4_TEST_KAFKA_URL=localhost:9092 npx tsx test/kafkaIntegration.test.ts
 *
 * Performs a genuine push -> pop round-trip through the raw, zero-dependency
 * KafkaBackend against a live KRaft broker (apache/kafka 3.7.0+):
 *   - produce emits a Kafka v2 RecordBatch (magic 2) with a CRC-32C checksum
 *     inside a Produce v3 request (the format a modern broker accepts; the old
 *     Produce-v0 / message-format-v0 / CRC=0 batch is rejected);
 *   - fetch parses the v2 RecordBatch back out of a Fetch v4 response.
 * It pushes a UNIQUE payload to a fresh topic and asserts the consumed payload
 * deep-equals what was produced — proving the wire encode/decode round-trips,
 * not just that the broker is reachable. This is a real-service test, never a
 * fake broker (NO mock testing: a Kafka test must hit a real Kafka).
 *
 * Topic creation: a produce against a not-yet-created topic fails on a KRaft
 * broker (no leader yet), so the test creates the topic first via the broker's
 * own admin tool inside the Kafka container (TINA4_TEST_KAFKA_CONTAINER,
 * default "tina4-kafka") — the same `kafka-topics.sh --create` the repro uses.
 *
 * Gated on TINA4_TEST_KAFKA_URL (e.g. localhost:9092). Skips cleanly (reported
 * as a pass with 0 assertions) when the env var is unset or the broker is
 * unreachable. Under TINA4_REQUIRE_SERVICES the run-all gate turns a
 * "Kafka ... not reachable / not set" skip into a hard failure (CI provisions
 * the broker, so it must run).
 */
import net from "node:net";
import { execFileSync } from "node:child_process";
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

/**
 * Ensure the topic exists by invoking the broker's own kafka-topics.sh inside
 * the Kafka container. Returns true on success (topic created or already there).
 */
function ensureTopic(container: string, broker: string, topic: string): boolean {
  try {
    execFileSync(
      "docker",
      [
        "exec",
        container,
        "/opt/kafka/bin/kafka-topics.sh",
        "--bootstrap-server",
        broker,
        "--create",
        "--topic",
        topic,
        "--partitions",
        "1",
        "--replication-factor",
        "1",
        "--if-not-exists",
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }
    );
    return true;
  } catch {
    return false;
  }
}

console.log("=== Kafka Live Integration Test ===\n");

const url = process.env.TINA4_TEST_KAFKA_URL ?? process.env.TINA4_KAFKA_BROKERS;
if (!url) {
  console.log(
    "  SKIP: set TINA4_TEST_KAFKA_URL (e.g. localhost:9092) to run the live Kafka integration test — Kafka broker not set."
  );
  summarise();
}

const broker = url!.split(",")[0].trim().replace(/^kafka:\/\//, "");
const [host, portStr] = broker.split(":");
const port = parseInt(portStr ?? "9092", 10);

if (!(await reachable(host, port))) {
  console.log(`  SKIP: Kafka broker not reachable at ${host}:${port}.`);
  summarise();
}

const container = process.env.TINA4_TEST_KAFKA_CONTAINER ?? "tina4-kafka";
const topic = "t_node_it_" + Math.random().toString(16).slice(2, 12);
console.log(`  Topic: ${topic}  (container: ${container})\n`);

if (!ensureTopic(container, broker, topic)) {
  // A KRaft broker rejects a produce to a topic that has no leader yet, so a
  // round-trip is impossible without first creating the topic. Skip with a
  // service-gate-recognised reason rather than report a false failure.
  console.log(
    `  SKIP: could not create Kafka topic via the broker admin tool (container "${container}" not reachable) — Kafka topic setup not available.`
  );
  summarise();
}

const backend = new KafkaBackend({ brokers: broker });

try {
  // Unique payload so the round-trip proves OUR record came back, not a stale
  // one. pop() reads from offset 0 of a fresh single-partition topic, so the
  // first (and only) record is exactly what we just produced.
  const payload = { task: "node-kafka-it", value: 999, nonce: Math.random().toString(16).slice(2) };

  const id = backend.push(topic, payload);
  assert("push() returns an id (did NOT throw 'Kafka publish failed')", typeof id === "string" && id.length > 0, id);

  const job = backend.pop(topic);
  assert("pop() returns the enqueued job", job !== null, JSON.stringify(job));
  assert(
    "popped payload deep-equals what was produced (v2 RecordBatch round-trip)",
    job !== null && JSON.stringify((job as any).payload) === JSON.stringify(payload),
    JSON.stringify(job?.payload)
  );
  assert(
    "popped job id matches the pushed id",
    job !== null && (job as any).id === id,
    `pushed ${id} got ${job?.id}`
  );
} catch (err) {
  assert("Kafka push -> pop round-trip ran without throwing", false, String(err));
}

summarise();

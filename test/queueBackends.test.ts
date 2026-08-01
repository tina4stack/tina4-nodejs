/**
 * Behavioural tests for Queue Backend classes (RabbitMQ and Kafka).
 * Run with: npx tsx test/queueBackends.test.ts
 *
 * These exercise the REAL brokers (no mocks): a live RabbitMQ at
 * TINA4_TEST_RABBITMQ_URL / localhost:5672 and a live Kafka at
 * TINA4_TEST_KAFKA_URL / localhost:9092. Each backend is driven through a full
 * push -> pop -> size -> clear lifecycle and the popped payload is asserted to
 * round-trip — so the connection, publish, and consume paths are proven, not
 * merely that an object was constructed or a method exists.
 *
 * The broker cases skip CLEANLY (reported as 0 assertions, never a fake broker)
 * when the service is unavailable; under TINA4_REQUIRE_SERVICES the run-all
 * gate turns a "rabbit/kafka ... not reachable" skip into a hard failure, since
 * CI provisions both. Construction-default cases (getConfig) need no broker.
 */
import net from "node:net";
import { execFileSync } from "node:child_process";
import {
  RabbitMQBackend, KafkaBackend, kafkaSecurityConfig, parseAmqpUrl,
} from "../packages/core/src/index.ts";

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

/** TCP-reachability probe — same pattern as the sibling integration tests. */
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

/** Why the last ensureKafkaTopic() call failed. Empty when it succeeded. */
let lastTopicError = "";

/**
 * Create a Kafka topic via the broker's own admin tool inside the Kafka
 * container. A KRaft broker rejects a produce to a topic with no leader yet, so
 * a real round-trip is impossible without first creating the topic — the same
 * `kafka-topics.sh --create` the sibling kafkaIntegration test uses.
 */
function ensureKafkaTopic(container: string, broker: string, topic: string): boolean {
  lastTopicError = "";
  try {
    execFileSync(
      "docker",
      [
        "exec", container,
        "/opt/kafka/bin/kafka-topics.sh",
        "--bootstrap-server", broker,
        "--create", "--topic", topic,
        "--partitions", "1",
        "--replication-factor", "1",
        "--if-not-exists",
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }
    );
    return true;
  } catch (err) {
    // A bare `catch { return false }` here threw away the ONE fact that matters
    // when this branch is taken. The caller then printed a fixed reason --
    // 'container "X" not reachable' -- which is a GUESS: a missing docker CLI,
    // an exec timeout, a broker that is up but has no controller yet, and a
    // genuinely absent container all produced that identical line. Case (14)
    // below hangs exactly ONE assertion off this call, so when it flips the
    // suite total drops by one with ZERO failures -- the silent one-test drift
    // that is invisible in a "0 failed" summary. Carry the real cause so the
    // next occurrence names itself instead of having to be re-derived.
    const e = err as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string; signal?: string };
    const stderr = e.stderr ? String(e.stderr).trim().split("\n").slice(-2).join(" | ") : "";
    lastTopicError =
      e.code === "ENOENT" ? "the `docker` CLI is not on PATH"
      : e.signal ? `docker exec killed by ${e.signal} (the 30s timeout)`
      : `docker exec exited ${e.status ?? "?"}${stderr ? `: ${stderr}` : ""}`;
    return false;
  }
}

console.log("=== Queue Backends Tests ===\n");

// --- RabbitMQ Backend (live broker round-trip) ---
console.log("--- RabbitMQ Backend ---");

const rmqUrl = process.env.TINA4_TEST_RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672";
const rmqCfg = parseAmqpUrl(rmqUrl);
const rmqHost = rmqCfg.host ?? "localhost";
const rmqPort = rmqCfg.port ?? 5672;

if (!(await reachable(rmqHost, rmqPort))) {
  console.log(`  SKIP: RabbitMQ broker not reachable at ${rmqHost}:${rmqPort} (set TINA4_TEST_RABBITMQ_URL).`);
} else {
  const rabbit = new RabbitMQBackend({
    host: rmqHost,
    port: rmqPort,
    username: rmqCfg.username ?? "guest",
    password: rmqCfg.password ?? "guest",
    vhost: rmqCfg.vhost ?? "/",
  });
  const rmqQueue = "tina4_qb_" + Math.random().toString(16).slice(2, 14);

  try {
    // (1) Constructor exercised against the REAL broker: a full push/pop cycle
    // proves the AMQP connection + publish + get content frames are wired, not
    // merely that an object was built. size() drives the whole handshake.
    const sizeStart = rabbit.size(rmqQueue);
    assert("RabbitMQBackend connects + fresh queue is empty", sizeStart === 0, `got ${sizeStart}`);

    const rmqId = rabbit.push(rmqQueue, { data: "hello", value: 42 });

    // (2) push() really publishes to the broker — the message is now countable.
    assert("RabbitMQBackend.push publishes (returns id, broker holds 1)", typeof rmqId === "string" && rmqId.length > 0 && rabbit.size(rmqQueue) === 1, rmqId);

    // (3) pop() returns the published job (payload round-trip), and a second pop
    // on the now-drained queue returns null.
    const rmqJob = rabbit.pop(rmqQueue);
    assert("RabbitMQBackend.pop returns the pushed job", rmqJob !== null && (rmqJob.payload as any)?.data === "hello" && (rmqJob.payload as any)?.value === 42, JSON.stringify(rmqJob));
    assert("RabbitMQBackend.pop on drained queue returns null", rabbit.pop(rmqQueue) === null);

    // (4) size() reports the broker's real message count across enqueue/dequeue.
    rabbit.push(rmqQueue, { n: 1 });
    rabbit.push(rmqQueue, { n: 2 });
    assert("RabbitMQBackend.size reports broker count (2 after 2 pushes)", rabbit.size(rmqQueue) === 2, `got ${rabbit.size(rmqQueue)}`);
    rabbit.pop(rmqQueue);
    assert("RabbitMQBackend.size reflects a dequeue (1 after 1 pop)", rabbit.size(rmqQueue) === 1, `got ${rabbit.size(rmqQueue)}`);

    // (5) clear() purges the queue — size()===0 and pop()===null afterwards.
    rabbit.push(rmqQueue, { n: 3 });
    rabbit.clear(rmqQueue);
    assert("RabbitMQBackend.clear purges the queue (size 0)", rabbit.size(rmqQueue) === 0, `got ${rabbit.size(rmqQueue)}`);
    assert("RabbitMQBackend.clear leaves pop returning null", rabbit.pop(rmqQueue) === null);
  } catch (err) {
    assert("RabbitMQBackend lifecycle ran without throwing", false, String(err));
  } finally {
    try { rabbit.clear(rmqQueue); } catch { /* best-effort cleanup */ }
  }

  // (7) Default-config backend connects against the default host — a real
  // push+pop round-trip proves the default connection works (not merely that a
  // push method exists). Only meaningful when the default host is the live one.
  if (rmqHost === "localhost" && rmqPort === 5672 && (rmqCfg.vhost ?? "/") === "/") {
    const rabbitDefaults = new RabbitMQBackend();
    const rmqDefQueue = "tina4_qb_def_" + Math.random().toString(16).slice(2, 12);
    try {
      const defId = rabbitDefaults.push(rmqDefQueue, { data: "default-conn" });
      const defJob = rabbitDefaults.pop(rmqDefQueue);
      assert("RabbitMQBackend default connection round-trips a payload", typeof defId === "string" && defJob !== null && (defJob.payload as any)?.data === "default-conn", JSON.stringify(defJob));
    } catch (err) {
      assert("RabbitMQBackend default connection round-trip ran without throwing", false, String(err));
    } finally {
      try { rabbitDefaults.clear(rmqDefQueue); } catch { /* best-effort cleanup */ }
    }
  } else {
    console.log("  SKIP: RabbitMQ default-host round-trip — TINA4_TEST_RABBITMQ_URL points away from the default localhost:5672/.");
  }
}

// (6) Construction-only: assert the default config is actually applied
// (no broker needed). Mirrors queueQueueUrl.test.ts, folded in here.
{
  const SAVED = ["TINA4_QUEUE_URL", "TINA4_RABBITMQ_HOST", "TINA4_RABBITMQ_PORT", "TINA4_RABBITMQ_USERNAME", "TINA4_RABBITMQ_PASSWORD", "TINA4_RABBITMQ_VHOST"];
  const snap: Record<string, string | undefined> = {};
  for (const v of SAVED) { snap[v] = process.env[v]; delete process.env[v]; }
  const cfg = new RabbitMQBackend().getConfig();
  assert(
    "RabbitMQBackend without config applies defaults (host/port/username/vhost)",
    cfg.host === "localhost" && cfg.port === 5672 && cfg.username === "guest" && cfg.vhost === "/",
    JSON.stringify(cfg)
  );
  for (const v of SAVED) { if (snap[v] === undefined) delete process.env[v]; else process.env[v] = snap[v]; }
}

// --- Kafka Backend (live broker round-trip) ---
console.log("\n--- Kafka Backend ---");

const kafkaUrl = process.env.TINA4_TEST_KAFKA_URL ?? process.env.TINA4_KAFKA_BROKERS ?? "localhost:9092";
const kafkaBroker = kafkaUrl.split(",")[0].trim().replace(/^kafka:\/\//, "");
const [kHost, kPortStr] = kafkaBroker.split(":");
const kPort = parseInt(kPortStr ?? "9092", 10);
const kafkaContainer = process.env.TINA4_TEST_KAFKA_CONTAINER ?? "tina4-kafka";

if (!(await reachable(kHost, kPort))) {
  console.log(`  SKIP: Kafka broker not reachable at ${kHost}:${kPort} (set TINA4_TEST_KAFKA_URL).`);
} else {
  const kTopic = "t_qb_" + Math.random().toString(16).slice(2, 12);
  if (!ensureKafkaTopic(kafkaContainer, kafkaBroker, kTopic)) {
    console.log(`  SKIP: could not create Kafka topic "${kTopic}" via the broker admin tool in container "${kafkaContainer}" (${lastTopicError}) — Kafka topic setup not available. Set TINA4_TEST_KAFKA_CONTAINER to the real container name.`);
  } else {
    const kafka = new KafkaBackend({ brokers: kafkaBroker, groupId: "test_group" });
    try {
      // Unique payload so the round-trip proves OUR record came back. pop() reads
      // from offset 0 of a fresh single-partition topic.
      const payload = { data: "hello", value: 42, nonce: Math.random().toString(16).slice(2) };

      // (8)+(9) Constructor + push() exercised against the REAL broker: push
      // produces a record (did NOT throw "Kafka publish failed").
      const kId = kafka.push(kTopic, payload);
      assert("KafkaBackend.push produces to the broker (returns id)", typeof kId === "string" && kId.length > 0, kId);

      // (10) pop() consumes the produced record; payload deep-equals what we sent
      // and the popped job id matches the pushed id (subscribe/assignment honoured).
      const kJob = kafka.pop(kTopic);
      assert("KafkaBackend.pop returns the produced job (payload round-trip)", kJob !== null && JSON.stringify((kJob as any).payload) === JSON.stringify(payload), JSON.stringify(kJob?.payload));
      assert("KafkaBackend.pop job id matches the pushed id", kJob !== null && (kJob as any).id === kId, `pushed ${kId} got ${kJob?.id}`);

      // (11) size() is 0 by design (Kafka has no simple queue-size). Folded in
      // here as the behavioural design assert (the typeof check was redundant).
      assert("KafkaBackend.size is 0 by design (no queue-size concept)", kafka.size(kTopic) === 0, `got ${kafka.size(kTopic)}`);

      // (12)+(15) clear() is a documented no-op. Assert the no-op contract
      // behaviourally: after clear() the producer is still usable for a
      // subsequent push and size() stays 0 by design — not just "did not throw".
      kafka.clear(kTopic);
      const kId2 = kafka.push(kTopic, { data: "after-clear", nonce: Math.random().toString(16).slice(2) });
      assert("KafkaBackend.clear is a no-op: producer still usable after it", typeof kId2 === "string" && kId2.length > 0 && kafka.size(kTopic) === 0, kId2);
    } catch (err) {
      assert("KafkaBackend lifecycle ran without throwing", false, String(err));
    }

    // (14) Default-config backend produces+consumes against the default broker —
    // a real round-trip proves the default connection works (not merely that a
    // push method exists). Only when the default broker is the live one.
    if (kafkaBroker === "localhost:9092") {
      const kafkaDefaults = new KafkaBackend();
      const kDefTopic = "t_qb_def_" + Math.random().toString(16).slice(2, 12);
      if (ensureKafkaTopic(kafkaContainer, kafkaBroker, kDefTopic)) {
        try {
          const defPayload = { data: "default-conn", nonce: Math.random().toString(16).slice(2) };
          const defId = kafkaDefaults.push(kDefTopic, defPayload);
          const defJob = kafkaDefaults.pop(kDefTopic);
          assert("KafkaBackend default connection round-trips a payload", typeof defId === "string" && defJob !== null && JSON.stringify((defJob as any).payload) === JSON.stringify(defPayload), JSON.stringify(defJob?.payload));
        } catch (err) {
          assert("KafkaBackend default connection round-trip ran without throwing", false, String(err));
        }
      } else {
        // This branch drops EXACTLY ONE assertion (the round-trip above) and
        // records no failure, so a run that takes it reads as "0 failed" with a
        // grand total one lower than the run before it. Name the real cause so
        // the next one-test drift identifies itself from the log instead of
        // needing a bisect.
        console.log(`  SKIP: could not create the default-config Kafka topic "${kDefTopic}" via the broker admin tool in container "${kafkaContainer}" (${lastTopicError}) — Kafka topic setup not available. This drops one assertion from the run total.`);
      }
    } else {
      console.log("  SKIP: Kafka default-broker round-trip — TINA4_TEST_KAFKA_URL points away from the default localhost:9092.");
    }
  }
}

// (13) Construction-only: assert defaults are applied (no broker needed).
// Mirrors queueQueueUrl.test.ts, folded in here.
{
  const SAVED = ["TINA4_QUEUE_URL", "TINA4_KAFKA_BROKERS", "TINA4_KAFKA_GROUP_ID"];
  const snap: Record<string, string | undefined> = {};
  for (const v of SAVED) { snap[v] = process.env[v]; delete process.env[v]; }
  const cfg = new KafkaBackend().getConfig();
  assert(
    "KafkaBackend without config applies the default broker (localhost:9092)",
    cfg.brokers === "localhost:9092" && cfg.groupId === "tina4_consumer_group",
    JSON.stringify(cfg)
  );
  for (const v of SAVED) { if (snap[v] === undefined) delete process.env[v]; else process.env[v] = snap[v]; }
}

// --- File queue still works (existing functionality via Queue class) ---
console.log("\n--- File queue via Queue class ---");

import { Queue } from "../packages/core/src/index.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

const TEST_PATH = join("/tmp", "tina4-qb-test-" + Date.now());

try { rmSync(TEST_PATH, { recursive: true, force: true }); } catch {}

const fileQueue = new Queue({ topic: "test-queue", path: TEST_PATH });
const fqId = fileQueue.push({ data: "hello" });
assert("file queue push returns id", typeof fqId === "string" && fqId.length > 0);

const fqJob = fileQueue.pop();
assert("file queue pop returns job", fqJob !== null);
assert("file queue job has correct payload", fqJob !== null && (fqJob.payload as any).data === "hello");

const fqEmpty = fileQueue.pop();
assert("file queue pop returns null when empty", fqEmpty === null);

try { rmSync(TEST_PATH, { recursive: true, force: true }); } catch {}

// --- Kafka TLS/SASL security config (parity with Python _security_config) ---
console.log("\n--- Kafka Security Config (TLS/SASL parity) ---");

{
  const SECURITY_VARS = [
    "TINA4_KAFKA_SECURITY_PROTOCOL", "KAFKA_SECURITY_PROTOCOL",
    "TINA4_KAFKA_SSL_CA_LOCATION", "KAFKA_SSL_CA_LOCATION",
    "TINA4_KAFKA_SASL_MECHANISM", "KAFKA_SASL_MECHANISM",
    "TINA4_KAFKA_SASL_USERNAME", "KAFKA_SASL_USERNAME",
    "TINA4_KAFKA_SASL_PASSWORD", "KAFKA_SASL_PASSWORD",
  ];

  // Snapshot + clean every relevant var so the host environment can't leak in.
  const saved: Record<string, string | undefined> = {};
  for (const v of SECURITY_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }

  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // 1) NEGATIVE: no env set -> {} (librdkafka keeps its PLAINTEXT default).
  assert(
    "kafka security: no env -> empty config",
    eq(kafkaSecurityConfig(), {})
  );

  // 2) POSITIVE: bare KAFKA_* names still work.
  process.env.KAFKA_SECURITY_PROTOCOL = "SSL";
  process.env.KAFKA_SSL_CA_LOCATION = "/etc/ssl/ca.pem";
  assert(
    "kafka security: bare KAFKA_* names honoured",
    eq(kafkaSecurityConfig(), {
      "security.protocol": "SSL",
      "ssl.ca.location": "/etc/ssl/ca.pem",
    })
  );
  delete process.env.KAFKA_SECURITY_PROTOCOL;
  delete process.env.KAFKA_SSL_CA_LOCATION;

  // 3) POSITIVE: TINA4_KAFKA_* namespaced names honoured.
  process.env.TINA4_KAFKA_SECURITY_PROTOCOL = "SASL_SSL";
  assert(
    "kafka security: TINA4_KAFKA_* namespaced names honoured",
    eq(kafkaSecurityConfig(), { "security.protocol": "SASL_SSL" })
  );
  delete process.env.TINA4_KAFKA_SECURITY_PROTOCOL;

  // 4) PRECEDENCE: TINA4_KAFKA_* wins when both are set.
  process.env.KAFKA_SECURITY_PROTOCOL = "SSL";
  process.env.TINA4_KAFKA_SECURITY_PROTOCOL = "SASL_SSL";
  assert(
    "kafka security: TINA4_KAFKA_* takes precedence over bare KAFKA_*",
    kafkaSecurityConfig()["security.protocol"] === "SASL_SSL"
  );
  delete process.env.KAFKA_SECURITY_PROTOCOL;
  delete process.env.TINA4_KAFKA_SECURITY_PROTOCOL;

  // 5) POSITIVE: SASL trio maps to the rdkafka sasl.* keys.
  process.env.TINA4_KAFKA_SASL_MECHANISM = "PLAIN";
  process.env.KAFKA_SASL_USERNAME = "user";
  process.env.KAFKA_SASL_PASSWORD = "secret";
  assert(
    "kafka security: SASL mechanism/username/password mapped",
    eq(kafkaSecurityConfig(), {
      "sasl.mechanism": "PLAIN",
      "sasl.username": "user",
      "sasl.password": "secret",
    })
  );
  delete process.env.TINA4_KAFKA_SASL_MECHANISM;
  delete process.env.KAFKA_SASL_USERNAME;
  delete process.env.KAFKA_SASL_PASSWORD;

  // Bonus: the security block is applied to BOTH producer and consumer config.
  process.env.TINA4_KAFKA_SECURITY_PROTOCOL = "SASL_SSL";
  process.env.TINA4_KAFKA_SASL_USERNAME = "u2";
  const kb = new KafkaBackend();
  const pc = kb.producerConfig();
  const cc = kb.consumerConfig();
  assert(
    "kafka security: producer config carries security keys",
    pc["security.protocol"] === "SASL_SSL" && pc["sasl.username"] === "u2"
  );
  assert(
    "kafka security: consumer config carries security keys",
    cc["security.protocol"] === "SASL_SSL" && cc["sasl.username"] === "u2"
  );
  assert(
    "kafka security: consumer config has group.id, producer does not",
    cc["group.id"] !== undefined && (pc as Record<string, unknown>)["group.id"] === undefined
  );
  delete process.env.TINA4_KAFKA_SECURITY_PROTOCOL;
  delete process.env.TINA4_KAFKA_SASL_USERNAME;

  // Restore the original environment.
  for (const v of SECURITY_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

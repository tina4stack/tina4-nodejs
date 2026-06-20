/**
 * Unit tests for Queue Backend classes (RabbitMQ and Kafka).
 * Run with: npx tsx test/queueBackends.test.ts
 *
 * Tests class structure and interface only — no actual RabbitMQ/Kafka connections.
 */
import {
  RabbitMQBackend, KafkaBackend, kafkaSecurityConfig,
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

console.log("=== Queue Backends Tests ===\n");

// --- RabbitMQ Backend ---
console.log("--- RabbitMQ Backend ---");

const rabbit = new RabbitMQBackend({
  host: "localhost",
  port: 5672,
  username: "guest",
  password: "guest",
  vhost: "/",
});

assert("RabbitMQBackend constructor works", rabbit !== null);
assert("RabbitMQBackend has push method", typeof rabbit.push === "function");
assert("RabbitMQBackend has pop method", typeof rabbit.pop === "function");
assert("RabbitMQBackend has size method", typeof rabbit.size === "function");
assert("RabbitMQBackend has clear method", typeof rabbit.clear === "function");

// RabbitMQ with defaults (env vars)
const rabbitDefaults = new RabbitMQBackend();
assert("RabbitMQBackend works without config (uses defaults)", rabbitDefaults !== null);
assert("RabbitMQBackend default has push method", typeof rabbitDefaults.push === "function");

// --- Kafka Backend ---
console.log("\n--- Kafka Backend ---");

const kafka = new KafkaBackend({
  brokers: "localhost:9092",
  groupId: "test_group",
});

assert("KafkaBackend constructor works", kafka !== null);
assert("KafkaBackend has push method", typeof kafka.push === "function");
assert("KafkaBackend has pop method", typeof kafka.pop === "function");
assert("KafkaBackend has size method", typeof kafka.size === "function");
assert("KafkaBackend has clear method", typeof kafka.clear === "function");

// Kafka with defaults
const kafkaDefaults = new KafkaBackend();
assert("KafkaBackend works without config (uses defaults)", kafkaDefaults !== null);
assert("KafkaBackend default has push method", typeof kafkaDefaults.push === "function");

// --- Kafka size returns 0 (by design) ---
console.log("\n--- Kafka size (design) ---");

const kafkaSize = kafka.size("test-topic");
assert("KafkaBackend.size returns 0 (Kafka design)", kafkaSize === 0);

// --- Kafka clear is no-op (by design) ---
console.log("\n--- Kafka clear (design) ---");

// Should not throw
kafka.clear("test-topic");
assert("KafkaBackend.clear does not throw", true);

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

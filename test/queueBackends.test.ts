/**
 * Unit tests for Queue Backend classes (RabbitMQ and Kafka).
 * Run with: npx tsx test/queueBackends.test.ts
 *
 * Tests class structure and interface only — no actual RabbitMQ/Kafka connections.
 */
import {
  RabbitMQBackend, KafkaBackend,
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

const fileQueue = new Queue("file", { path: TEST_PATH });
const fqId = fileQueue.push("test-queue", { data: "hello" });
assert("file queue push returns id", typeof fqId === "string" && fqId.length > 0);

const fqJob = fileQueue.pop("test-queue");
assert("file queue pop returns job", fqJob !== null);
assert("file queue job has correct payload", fqJob !== null && (fqJob.payload as any).data === "hello");

const fqEmpty = fileQueue.pop("test-queue");
assert("file queue pop returns null when empty", fqEmpty === null);

try { rmSync(TEST_PATH, { recursive: true, force: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

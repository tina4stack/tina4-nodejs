/**
 * Unit tests for TINA4_QUEUE_URL config resolution across queue backends.
 * Run with: npx tsx test/queueQueueUrl.test.ts
 *
 * Config-resolution level only — no live RabbitMQ/Kafka/MongoDB connections.
 * Proves each backend reads connection settings from TINA4_QUEUE_URL, and that
 * a per-backend var still overrides it. Mirrors Python/PHP/Ruby parity.
 */
import {
  RabbitMQBackend, KafkaBackend, MongoBackend, parseAmqpUrl,
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

// Backend constructors read process.env at construction time. Each case clears
// the relevant vars first so cases don't leak into one another.
const QUEUE_VARS = [
  "TINA4_QUEUE_URL",
  "TINA4_RABBITMQ_HOST", "TINA4_RABBITMQ_PORT", "TINA4_RABBITMQ_USERNAME",
  "TINA4_RABBITMQ_PASSWORD", "TINA4_RABBITMQ_VHOST",
  "TINA4_KAFKA_BROKERS", "TINA4_KAFKA_GROUP_ID",
  "TINA4_MONGO_URI", "TINA4_MONGO_HOST", "TINA4_MONGO_PORT",
  "TINA4_MONGO_USERNAME", "TINA4_MONGO_PASSWORD",
];

function clearEnv() {
  for (const v of QUEUE_VARS) delete process.env[v];
}

console.log("=== Queue TINA4_QUEUE_URL Config Resolution ===\n");

// ── parseAmqpUrl helper ──────────────────────────────────────
console.log("--- parseAmqpUrl ---");

const full = parseAmqpUrl("amqp://alice:s3cret@rabbit.example.com:5673/myvhost");
assert("parseAmqpUrl host", full.host === "rabbit.example.com", JSON.stringify(full));
assert("parseAmqpUrl port", full.port === 5673, JSON.stringify(full));
assert("parseAmqpUrl username", full.username === "alice", JSON.stringify(full));
assert("parseAmqpUrl password", full.password === "s3cret", JSON.stringify(full));
assert("parseAmqpUrl vhost gets leading slash", full.vhost === "/myvhost", JSON.stringify(full));

const noCreds = parseAmqpUrl("amqp://rabbit.local:5672");
assert("parseAmqpUrl host-only", noCreds.host === "rabbit.local" && noCreds.port === 5672, JSON.stringify(noCreds));
assert("parseAmqpUrl no creds -> undefined username", noCreds.username === undefined, JSON.stringify(noCreds));

const amqps = parseAmqpUrl("amqps://host.tls:5671");
assert("parseAmqpUrl strips amqps://", amqps.host === "host.tls" && amqps.port === 5671, JSON.stringify(amqps));

// ── RabbitMQ ─────────────────────────────────────────────────
console.log("\n--- RabbitMQ ---");

clearEnv();
process.env.TINA4_QUEUE_URL = "amqp://bob:pw@mq.internal:5680/vh";
const rmqFromUrl = new RabbitMQBackend().getConfig();
assert("RabbitMQ reads host from TINA4_QUEUE_URL", rmqFromUrl.host === "mq.internal", JSON.stringify(rmqFromUrl));
assert("RabbitMQ reads port from TINA4_QUEUE_URL", rmqFromUrl.port === 5680, JSON.stringify(rmqFromUrl));
assert("RabbitMQ reads username from TINA4_QUEUE_URL", rmqFromUrl.username === "bob", JSON.stringify(rmqFromUrl));
assert("RabbitMQ reads password from TINA4_QUEUE_URL", rmqFromUrl.password === "pw", JSON.stringify(rmqFromUrl));
assert("RabbitMQ reads vhost from TINA4_QUEUE_URL", rmqFromUrl.vhost === "/vh", JSON.stringify(rmqFromUrl));

// Per-backend var overrides the URL-derived field (only host overridden here).
clearEnv();
process.env.TINA4_QUEUE_URL = "amqp://bob:pw@mq.internal:5680/vh";
process.env.TINA4_RABBITMQ_HOST = "override-host";
const rmqOverride = new RabbitMQBackend().getConfig();
assert("RabbitMQ TINA4_RABBITMQ_HOST overrides URL host", rmqOverride.host === "override-host", JSON.stringify(rmqOverride));
assert("RabbitMQ other fields still come from URL", rmqOverride.port === 5680 && rmqOverride.username === "bob", JSON.stringify(rmqOverride));

// No env at all -> existing defaults preserved (non-breaking).
clearEnv();
const rmqDefault = new RabbitMQBackend().getConfig();
assert("RabbitMQ defaults when nothing set",
  rmqDefault.host === "localhost" && rmqDefault.port === 5672 &&
  rmqDefault.username === "guest" && rmqDefault.password === "guest" && rmqDefault.vhost === "/",
  JSON.stringify(rmqDefault));

// ── Kafka ────────────────────────────────────────────────────
console.log("\n--- Kafka ---");

clearEnv();
process.env.TINA4_QUEUE_URL = "kafka://broker1:9092,broker2:9092";
const kfFromUrl = new KafkaBackend().getConfig();
assert("Kafka strips kafka:// from TINA4_QUEUE_URL", kfFromUrl.brokers === "broker1:9092,broker2:9092", JSON.stringify(kfFromUrl));

// Bare value (no scheme) is used as-is.
clearEnv();
process.env.TINA4_QUEUE_URL = "localhost:9092";
const kfBare = new KafkaBackend().getConfig();
assert("Kafka uses bare TINA4_QUEUE_URL as-is", kfBare.brokers === "localhost:9092", JSON.stringify(kfBare));

// TINA4_KAFKA_BROKERS overrides TINA4_QUEUE_URL.
clearEnv();
process.env.TINA4_QUEUE_URL = "kafka://from-url:9092";
process.env.TINA4_KAFKA_BROKERS = "from-broker-var:9092";
const kfOverride = new KafkaBackend().getConfig();
assert("Kafka TINA4_KAFKA_BROKERS overrides URL", kfOverride.brokers === "from-broker-var:9092", JSON.stringify(kfOverride));

// Default preserved.
clearEnv();
const kfDefault = new KafkaBackend().getConfig();
assert("Kafka default brokers when nothing set", kfDefault.brokers === "localhost:9092", JSON.stringify(kfDefault));

// ── MongoDB ──────────────────────────────────────────────────
console.log("\n--- MongoDB ---");

clearEnv();
process.env.TINA4_QUEUE_URL = "mongodb://muser:mpw@mongo.internal:27018";
const moFromUrl = new MongoBackend().getConfig();
assert("MongoDB reads URI from TINA4_QUEUE_URL", moFromUrl.uri === "mongodb://muser:mpw@mongo.internal:27018", JSON.stringify(moFromUrl));

// TINA4_MONGO_URI overrides TINA4_QUEUE_URL.
clearEnv();
process.env.TINA4_QUEUE_URL = "mongodb://from-queue-url:27017";
process.env.TINA4_MONGO_URI = "mongodb://from-mongo-uri:27019";
const moOverride = new MongoBackend().getConfig();
assert("MongoDB TINA4_MONGO_URI overrides TINA4_QUEUE_URL", moOverride.uri === "mongodb://from-mongo-uri:27019", JSON.stringify(moOverride));

// Field vars still build a URI when no URI is set (default path unchanged).
clearEnv();
process.env.TINA4_MONGO_HOST = "fieldhost";
process.env.TINA4_MONGO_PORT = "27020";
const moFields = new MongoBackend().getConfig();
assert("MongoDB field vars still build a URI", moFields.uri === "mongodb://fieldhost:27020", JSON.stringify(moFields));

// Default preserved.
clearEnv();
const moDefault = new MongoBackend().getConfig();
assert("MongoDB default URI when nothing set", moDefault.uri === "mongodb://localhost:27017", JSON.stringify(moDefault));

clearEnv();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

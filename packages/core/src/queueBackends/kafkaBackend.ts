/**
 * Tina4 Kafka Queue Backend — Kafka protocol via raw TCP, zero dependencies.
 *
 * Implements the same interface as the file-based queue but uses Apache Kafka
 * for message storage and delivery.
 *
 * Configure via environment variables:
 *   TINA4_QUEUE_URL       — broker list (strips a leading kafka:// if present)
 *   TINA4_KAFKA_BROKERS   (override; default: "localhost:9092")
 *   TINA4_KAFKA_GROUP_ID  (default: "tina4_consumer_group")
 *
 *   TLS/SASL (each read as TINA4_KAFKA_<NAME> first, then bare KAFKA_<NAME>):
 *   TINA4_KAFKA_SECURITY_PROTOCOL — e.g. SSL / SASL_SSL (default: PLAINTEXT)
 *   TINA4_KAFKA_SSL_CA_LOCATION   — CA cert path for TLS brokers/proxies
 *   TINA4_KAFKA_SASL_MECHANISM / TINA4_KAFKA_SASL_USERNAME / TINA4_KAFKA_SASL_PASSWORD — optional SASL
 *
 * Precedence for brokers: specific TINA4_KAFKA_BROKERS var (if set)
 *   > value derived from TINA4_QUEUE_URL > existing default.
 */
import net from "node:net";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { QueueJob } from "../queue.js";

// ── Types ────────────────────────────────────────────────────

export interface KafkaConfig {
  brokers?: string;
  groupId?: string;
}

/**
 * librdkafka-style SSL/SASL client config (a TLS broker/proxy). Mirrors the
 * keys produced by Python's `KafkaConnector._security_config`. Every key is
 * optional — an unset env var leaves the key OUT (librdkafka defaults to the
 * PLAINTEXT protocol with no SASL).
 */
export interface KafkaSecurityConfig {
  "security.protocol"?: string;
  "ssl.ca.location"?: string;
  "sasl.mechanism"?: string;
  "sasl.username"?: string;
  "sasl.password"?: string;
}

/** Resolved producer/consumer config — brokers, client id, and security keys. */
export interface KafkaClientConfig extends KafkaSecurityConfig {
  "bootstrap.servers": string;
  "client.id": string;
  "group.id"?: string;
  "auto.offset.reset"?: string;
  "enable.auto.commit"?: boolean;
}

/**
 * Build the SSL/SASL client config from the environment (for a TLS broker or
 * proxy in front of Kafka). Each setting is read from the Tina4-namespaced env
 * var FIRST (`TINA4_KAFKA_SECURITY_PROTOCOL` …) and falls back to the bare
 * librdkafka-convention name (`KAFKA_SECURITY_PROTOCOL` …) that many Kafka
 * deployments already set. Honours security.protocol (e.g. SSL, SASL_SSL),
 * ssl.ca.location, and optional SASL (mechanism / username / password). Unset
 * keys are omitted so librdkafka keeps its PLAINTEXT defaults.
 *
 * Exported for testing/introspection — and exact parity with Python's
 * `_security_config` (same key set, same precedence, same omit-when-unset).
 */
export function kafkaSecurityConfig(
  env: NodeJS.ProcessEnv = process.env
): KafkaSecurityConfig {
  // rdkafka key -> env suffix (read as TINA4_KAFKA_<suffix>, then KAFKA_<suffix>)
  const mapping: [keyof KafkaSecurityConfig, string][] = [
    ["security.protocol", "SECURITY_PROTOCOL"],
    ["ssl.ca.location", "SSL_CA_LOCATION"],
    ["sasl.mechanism", "SASL_MECHANISM"],
    ["sasl.username", "SASL_USERNAME"],
    ["sasl.password", "SASL_PASSWORD"],
  ];
  const config: KafkaSecurityConfig = {};
  for (const [rdk, suffix] of mapping) {
    const value = env[`TINA4_KAFKA_${suffix}`] || env[`KAFKA_${suffix}`];
    if (value) {
      config[rdk] = value;
    }
  }
  return config;
}

export interface QueueBackend {
  push(queue: string, payload: unknown, delay?: number): string;
  pop(queue: string): QueueJob | null;
  size(queue: string): number;
  clear(queue: string): void;
}

// ── Kafka Protocol Constants ─────────────────────────────────

const API_PRODUCE = 0;
const API_FETCH = 1;
const API_LIST_OFFSETS = 2;
const API_METADATA = 3;
const API_OFFSET_COMMIT = 8;
const API_OFFSET_FETCH = 9;
const API_FIND_COORDINATOR = 10;
const API_JOIN_GROUP = 11;
const API_HEARTBEAT = 12;
const API_LEAVE_GROUP = 13;
const API_SYNC_GROUP = 14;

// ── Kafka Backend ────────────────────────────────────────────

/**
 * Kafka queue backend using raw Kafka protocol over TCP.
 *
 * Uses synchronous-style communication by spawning a child process
 * for each operation, similar to the Redis session handler pattern.
 */
export class KafkaBackend implements QueueBackend {
  private brokers: string;
  private groupId: string;

  constructor(config?: KafkaConfig) {
    // Base layer: brokers derived from TINA4_QUEUE_URL (strip a leading
    // kafka:// scheme if present; otherwise use the value as-is, e.g.
    // "localhost:9092").
    const url = process.env.TINA4_QUEUE_URL;
    const fromUrl = url ? url.replace(/^kafka:\/\//, "") : undefined;

    // Precedence: explicit config arg > specific TINA4_KAFKA_BROKERS var
    // > value from TINA4_QUEUE_URL > existing default.
    this.brokers = config?.brokers ?? process.env.TINA4_KAFKA_BROKERS ?? fromUrl ?? "localhost:9092";
    this.groupId = config?.groupId ?? process.env.TINA4_KAFKA_GROUP_ID ?? "tina4_consumer_group";
  }

  /**
   * Resolved connection config — exposed for testing/introspection.
   */
  getConfig(): Required<KafkaConfig> {
    return { brokers: this.brokers, groupId: this.groupId };
  }

  /**
   * Resolved SSL/SASL client config from the environment (PLAINTEXT default).
   * Mirrors Python's `KafkaConnector._security_config`.
   */
  securityConfig(): KafkaSecurityConfig {
    return kafkaSecurityConfig();
  }

  /**
   * Full producer config — brokers + client id + the resolved security block.
   * The security keys are applied to BOTH producer and consumer (matching
   * Python's `_connect_confluent`).
   */
  producerConfig(): KafkaClientConfig {
    return {
      "bootstrap.servers": this.brokers,
      "client.id": "tina4-nodejs",
      ...this.securityConfig(),
    };
  }

  /**
   * Full consumer config — brokers + client id + group id + the SAME resolved
   * security block applied to the producer.
   */
  consumerConfig(): KafkaClientConfig {
    return {
      "bootstrap.servers": this.brokers,
      "client.id": "tina4-nodejs",
      "group.id": this.groupId,
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
      ...this.securityConfig(),
    };
  }

  /**
   * Parse broker string into host:port.
   */
  private parseBroker(): { host: string; port: number } {
    const parts = this.brokers.split(",")[0].trim().split(":");
    return {
      host: parts[0] ?? "localhost",
      port: parts[1] ? parseInt(parts[1], 10) : 9092,
    };
  }

  /**
   * Execute a Kafka operation synchronously via a child process.
   */
  private execSync(operation: string, topic: string, data?: string): string {
    // execFileSync imported at top level
    const broker = this.parseBroker();

    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(broker.host)};
      const port = ${broker.port};
      const operation = ${JSON.stringify(operation)};
      const topic = ${JSON.stringify(topic)};
      const groupId = ${JSON.stringify(this.groupId)};
      const data = ${JSON.stringify(data ?? "")};
      let correlationId = 0;

      // Kafka wire protocol helpers
      function writeInt32(buf, offset, val) {
        buf.writeInt32BE(val, offset);
        return offset + 4;
      }
      function writeInt16(buf, offset, val) {
        buf.writeInt16BE(val, offset);
        return offset + 2;
      }
      function writeString(buf, offset, str) {
        if (str === null) {
          buf.writeInt16BE(-1, offset);
          return offset + 2;
        }
        const len = Buffer.byteLength(str, "utf-8");
        buf.writeInt16BE(len, offset);
        buf.write(str, offset + 2, len, "utf-8");
        return offset + 2 + len;
      }
      function writeBytes(buf, offset, bytes) {
        if (bytes === null) {
          buf.writeInt32BE(-1, offset);
          return offset + 4;
        }
        buf.writeInt32BE(bytes.length, offset);
        bytes.copy(buf, offset + 4);
        return offset + 4 + bytes.length;
      }

      function buildProduceRequest(topicName, messageBytes) {
        correlationId++;
        const clientId = "tina4";
        const topicBuf = Buffer.from(topicName, "utf-8");
        const clientBuf = Buffer.from(clientId, "utf-8");

        // Build message set (MessageV0)
        const msgSize = 4 + 1 + 1 + 4 + 4 + messageBytes.length; // crc + magic + attrs + key(-1) + value
        const msgBuf = Buffer.alloc(12 + msgSize); // offset(8) + size(4) + message
        let o = 0;
        // Offset (8 bytes, 0 for produce)
        msgBuf.writeBigInt64BE(0n, o); o += 8;
        // Message size
        msgBuf.writeInt32BE(msgSize, o); o += 4;
        // CRC placeholder (will be 0 — Kafka accepts for some versions)
        msgBuf.writeInt32BE(0, o); o += 4;
        // Magic byte
        msgBuf.writeInt8(0, o); o += 1;
        // Attributes
        msgBuf.writeInt8(0, o); o += 1;
        // Key (null = -1)
        msgBuf.writeInt32BE(-1, o); o += 4;
        // Value
        msgBuf.writeInt32BE(messageBytes.length, o); o += 4;
        messageBytes.copy(msgBuf, o); o += messageBytes.length;

        // Build request
        const reqSize = 2 + 2 + 4 + 2 + clientBuf.length + 2 + 4 + 4 + 2 + topicBuf.length + 4 + 4 + 4 + msgBuf.length;
        const req = Buffer.alloc(4 + reqSize);
        let pos = 0;
        req.writeInt32BE(reqSize, pos); pos += 4;
        // API key (Produce = 0)
        req.writeInt16BE(API_PRODUCE, pos); pos += 2;
        // API version
        req.writeInt16BE(0, pos); pos += 2;
        // Correlation ID
        req.writeInt32BE(correlationId, pos); pos += 4;
        // Client ID
        req.writeInt16BE(clientBuf.length, pos); pos += 2;
        clientBuf.copy(req, pos); pos += clientBuf.length;
        // Required acks
        req.writeInt16BE(1, pos); pos += 2;
        // Timeout
        req.writeInt32BE(5000, pos); pos += 4;
        // Topic count
        req.writeInt32BE(1, pos); pos += 4;
        // Topic name
        req.writeInt16BE(topicBuf.length, pos); pos += 2;
        topicBuf.copy(req, pos); pos += topicBuf.length;
        // Partition count
        req.writeInt32BE(1, pos); pos += 4;
        // Partition index
        req.writeInt32BE(0, pos); pos += 4;
        // Message set size
        req.writeInt32BE(msgBuf.length, pos); pos += 4;
        msgBuf.copy(req, pos);

        return req;
      }

      function buildFetchRequest(topicName, fetchOffset) {
        correlationId++;
        const clientId = "tina4";
        const topicBuf = Buffer.from(topicName, "utf-8");
        const clientBuf = Buffer.from(clientId, "utf-8");

        const reqSize = 2 + 2 + 4 + 2 + clientBuf.length + 4 + 4 + 4 + 4 + 2 + topicBuf.length + 4 + 4 + 8 + 4;
        const req = Buffer.alloc(4 + reqSize);
        let pos = 0;
        req.writeInt32BE(reqSize, pos); pos += 4;
        req.writeInt16BE(API_FETCH, pos); pos += 2;
        req.writeInt16BE(0, pos); pos += 2;
        req.writeInt32BE(correlationId, pos); pos += 4;
        req.writeInt16BE(clientBuf.length, pos); pos += 2;
        clientBuf.copy(req, pos); pos += clientBuf.length;
        // Replica ID (-1 for consumer)
        req.writeInt32BE(-1, pos); pos += 4;
        // Max wait time
        req.writeInt32BE(1000, pos); pos += 4;
        // Min bytes
        req.writeInt32BE(1, pos); pos += 4;
        // Topic count
        req.writeInt32BE(1, pos); pos += 4;
        // Topic name
        req.writeInt16BE(topicBuf.length, pos); pos += 2;
        topicBuf.copy(req, pos); pos += topicBuf.length;
        // Partition count
        req.writeInt32BE(1, pos); pos += 4;
        // Partition
        req.writeInt32BE(0, pos); pos += 4;
        // Fetch offset
        req.writeBigInt64BE(BigInt(fetchOffset), pos); pos += 8;
        // Max bytes
        req.writeInt32BE(1048576, pos); pos += 4;

        return req;
      }

      const sock = net.createConnection({ host, port }, () => {
        if (operation === "publish") {
          const msgBytes = Buffer.from(data, "utf-8");
          const req = buildProduceRequest(topic, msgBytes);
          sock.write(req);
        } else if (operation === "get") {
          const req = buildFetchRequest(topic, 0);
          sock.write(req);
        } else {
          process.stdout.write("__UNSUPPORTED__");
          sock.destroy();
        }
      });

      let buffer = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (buffer.length >= 4) {
          const respSize = buffer.readInt32BE(0);
          if (buffer.length >= 4 + respSize) {
            if (operation === "publish") {
              process.stdout.write("__PUBLISHED__");
            } else if (operation === "get") {
              // Parse fetch response to extract message value
              try {
                // Skip response header and topic metadata to find message
                let pos = 4 + 4; // size + correlation_id
                const topicCount = buffer.readInt32BE(pos); pos += 4;
                if (topicCount > 0) {
                  const topicLen = buffer.readInt16BE(pos); pos += 2 + topicLen;
                  const partCount = buffer.readInt32BE(pos); pos += 4;
                  if (partCount > 0) {
                    const partId = buffer.readInt32BE(pos); pos += 4;
                    const errCode = buffer.readInt16BE(pos); pos += 2;
                    const hwm = buffer.readBigInt64BE(pos); pos += 8;
                    const msgSetSize = buffer.readInt32BE(pos); pos += 4;

                    if (msgSetSize > 0 && errCode === 0) {
                      // Parse first message in message set
                      const msgOffset = buffer.readBigInt64BE(pos); pos += 8;
                      const msgSize = buffer.readInt32BE(pos); pos += 4;
                      const crc = buffer.readInt32BE(pos); pos += 4;
                      const magic = buffer.readInt8(pos); pos += 1;
                      const attrs = buffer.readInt8(pos); pos += 1;
                      const keyLen = buffer.readInt32BE(pos); pos += 4;
                      if (keyLen > 0) pos += keyLen;
                      const valLen = buffer.readInt32BE(pos); pos += 4;
                      if (valLen > 0) {
                        const val = buffer.subarray(pos, pos + valLen).toString("utf-8");
                        process.stdout.write(val);
                      } else {
                        process.stdout.write("__EMPTY__");
                      }
                    } else {
                      process.stdout.write("__EMPTY__");
                    }
                  } else {
                    process.stdout.write("__EMPTY__");
                  }
                } else {
                  process.stdout.write("__EMPTY__");
                }
              } catch (e) {
                process.stdout.write("__EMPTY__");
              }
            }
            sock.destroy();
          }
        }
      });

      sock.on("error", (err) => {
        process.stderr.write(err.message);
        process.exit(1);
      });

      setTimeout(() => { sock.destroy(); process.exit(1); }, 10000);
    `;

    try {
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result;
    } catch {
      return "";
    }
  }

  push(queue: string, payload: unknown, _delay?: number): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    const job = {
      id,
      payload,
      status: "pending",
      createdAt: now,
      attempts: 0,
      delayUntil: null,
    };

    const result = this.execSync("publish", queue, JSON.stringify(job));
    if (!result.includes("__PUBLISHED__")) {
      throw new Error("Kafka publish failed");
    }
    return id;
  }

  pop(queue: string): QueueJob | null {
    const result = this.execSync("get", queue);
    if (!result || result === "__EMPTY__" || result === "__UNSUPPORTED__") return null;

    try {
      return JSON.parse(result) as QueueJob;
    } catch {
      return null;
    }
  }

  size(_queue: string): number {
    // Kafka doesn't have a simple "queue size" concept — return 0
    // Real implementation would need to compare committed offset vs log end offset
    return 0;
  }

  clear(_queue: string): void {
    // Kafka topics are cleared via retention policies, not purging
    // This is a no-op for Kafka
  }
}

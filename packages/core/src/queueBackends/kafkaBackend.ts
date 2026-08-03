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
  /**
   * Accepted for API parity with the file/MongoDB backends and IGNORED —
   * consumer-group offsets own redelivery, so the framework-level visibility
   * timeout does not apply here.
   */
  visibilityTimeout?: number;
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
  push(queue: string, payload: unknown, delay?: number, priority?: number): string;
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
  getConfig(): Required<Omit<KafkaConfig, "visibilityTimeout">> {
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
   *
   * The wire protocol is hand-rolled (Tina4 is zero-dependency — no npm Kafka
   * library). Produce uses Produce **v3** carrying a Kafka **v2 RecordBatch**
   * (magic byte 2) with a **CRC-32C** (Castagnoli) checksum; Fetch uses Fetch
   * **v4** and parses the v2 RecordBatch out of the response. Both formats are
   * what a modern KRaft broker (apache/kafka 3.7.0) requires — the old
   * Produce-v0 / message-format-v0 / CRC=0 batch is rejected by such brokers.
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
      const API_PRODUCE = ${API_PRODUCE};
      const API_FETCH = ${API_FETCH};
      const PRODUCE_VERSION = 3; // v3+ requires the v2 RecordBatch format
      const FETCH_VERSION = 4;   // v4 returns v2 RecordBatches + isolation_level
      let correlationId = 0;

      // ── CRC-32C (Castagnoli, polynomial 0x1EDC6F41), table-based ──────────
      // Node has no built-in CRC-32C; the v2 RecordBatch mandates it over the
      // bytes from \`attributes\` to the end of the batch. A wrong CRC makes the
      // broker drop the connection, so this must be exact.
      const CRC32C_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0x82f63b78 ^ (c >>> 1)) : (c >>> 1);
          }
          table[n] = c >>> 0;
        }
        return table;
      })();
      function crc32c(buf) {
        let crc = 0xffffffff;
        for (let i = 0; i < buf.length; i++) {
          crc = (CRC32C_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
        }
        return (crc ^ 0xffffffff) >>> 0;
      }

      // ── Kafka protocol varints (zigzag-encoded signed varints) ────────────
      function encodeZigZag(n) {
        // 32-bit zigzag: (n << 1) ^ (n >> 31)
        return ((n << 1) ^ (n >> 31)) >>> 0;
      }
      function encodeVarintUnsigned(u) {
        const bytes = [];
        let v = u >>> 0;
        while (true) {
          if ((v & ~0x7f) === 0) { bytes.push(v); break; }
          bytes.push((v & 0x7f) | 0x80);
          v >>>= 7;
        }
        return Buffer.from(bytes);
      }
      function encodeVarint(n) {
        // signed varint = zigzag then unsigned-varint
        return encodeVarintUnsigned(encodeZigZag(n));
      }
      function decodeVarint(buf, pos) {
        // returns { value, next } — signed (zigzag-decoded)
        let result = 0, shift = 0, b;
        do {
          b = buf[pos++];
          result |= (b & 0x7f) << shift;
          shift += 7;
        } while (b & 0x80);
        result = result >>> 0;
        // zigzag decode
        const value = (result >>> 1) ^ -(result & 1);
        return { value, next: pos };
      }

      // ── v2 RecordBatch builder ────────────────────────────────────────────
      function buildRecordBatch(valueBytes) {
        const now = BigInt(Date.now());

        // Build the single record body.
        // record = attributes:int8(0), timestampDelta:varint(0),
        //          offsetDelta:varint(0), keyLen:varint(-1 null),
        //          valueLen:varint(len), value, headerCount:varint(0)
        const recBody = Buffer.concat([
          Buffer.from([0]),              // attributes (int8)
          encodeVarint(0),               // timestampDelta
          encodeVarint(0),               // offsetDelta
          encodeVarint(-1),              // keyLen (-1 = null key)
          encodeVarint(valueBytes.length), // valueLen
          valueBytes,                    // value (JSON payload bytes)
          encodeVarint(0),               // headerCount
        ]);
        // record length prefix = signed varint of recBody length
        const record = Buffer.concat([encodeVarint(recBody.length), recBody]);
        const recordsCount = 1;

        // The portion the CRC covers starts at \`attributes\` and runs to end.
        // crcBody = attributes:int16(0), lastOffsetDelta:int32(count-1),
        //           firstTimestamp:int64, maxTimestamp:int64,
        //           producerId:int64(-1), producerEpoch:int16(-1),
        //           baseSequence:int32(-1), recordsCount:int32, records
        const crcBody = Buffer.alloc(2 + 4 + 8 + 8 + 8 + 2 + 4 + 4 + record.length);
        let c = 0;
        crcBody.writeInt16BE(0, c); c += 2;                 // attributes
        crcBody.writeInt32BE(recordsCount - 1, c); c += 4;  // lastOffsetDelta
        crcBody.writeBigInt64BE(now, c); c += 8;            // firstTimestamp
        crcBody.writeBigInt64BE(now, c); c += 8;            // maxTimestamp
        crcBody.writeBigInt64BE(-1n, c); c += 8;            // producerId
        crcBody.writeInt16BE(-1, c); c += 2;                // producerEpoch
        crcBody.writeInt32BE(-1, c); c += 4;                // baseSequence
        crcBody.writeInt32BE(recordsCount, c); c += 4;      // recordsCount
        record.copy(crcBody, c);

        const crc = crc32c(crcBody);

        // Header before the CRC-covered region:
        // baseOffset:int64(0), batchLength:int32, partitionLeaderEpoch:int32(-1),
        // magic:int8(2), crc:uint32. batchLength counts everything AFTER itself
        // (partitionLeaderEpoch through end of records) = 4 + 1 + 4 + crcBody.
        const batchLength = 4 + 1 + 4 + crcBody.length;
        const head = Buffer.alloc(8 + 4 + 4 + 1 + 4);
        let h = 0;
        head.writeBigInt64BE(0n, h); h += 8;        // baseOffset
        head.writeInt32BE(batchLength, h); h += 4;  // batchLength
        head.writeInt32BE(-1, h); h += 4;           // partitionLeaderEpoch
        head.writeInt8(2, h); h += 1;               // magic = 2
        head.writeUInt32BE(crc, h); h += 4;         // crc (CRC-32C)

        return Buffer.concat([head, crcBody]);
      }

      // ── Produce v3 request ─────────────────────────────────────────────────
      function buildProduceRequest(topicName, valueBytes) {
        correlationId++;
        const clientBuf = Buffer.from("tina4", "utf-8");
        const topicBuf = Buffer.from(topicName, "utf-8");
        const recordBatch = buildRecordBatch(valueBytes);

        const body = Buffer.alloc(
          2 + // transactionalId (-1 null nullable_string)
          2 + // acks
          4 + // timeoutMs
          4 + // topics array count
          2 + topicBuf.length + // topic name
          4 + // partitions array count
          4 + // partition index
          4 + recordBatch.length // recordSetBytes (int32 size) + batch
        );
        let p = 0;
        body.writeInt16BE(-1, p); p += 2;            // transactionalId = null
        body.writeInt16BE(1, p); p += 2;             // acks = 1
        body.writeInt32BE(10000, p); p += 4;         // timeoutMs
        body.writeInt32BE(1, p); p += 4;             // topics count
        body.writeInt16BE(topicBuf.length, p); p += 2;
        topicBuf.copy(body, p); p += topicBuf.length;
        body.writeInt32BE(1, p); p += 4;             // partitions count
        body.writeInt32BE(0, p); p += 4;             // partition index 0
        body.writeInt32BE(recordBatch.length, p); p += 4; // recordSetBytes size
        recordBatch.copy(body, p);

        return frameRequest(API_PRODUCE, PRODUCE_VERSION, clientBuf, body);
      }

      // ── Fetch v4 request ────────────────────────────────────────────────────
      function buildFetchRequest(topicName, fetchOffset) {
        correlationId++;
        const clientBuf = Buffer.from("tina4", "utf-8");
        const topicBuf = Buffer.from(topicName, "utf-8");

        // Fetch v4 request body (NO logStartOffset — that arrives in v5+):
        // replicaId(4), maxWaitMs(4), minBytes(4), maxBytes(4 v3+),
        // isolationLevel(1 v4+), topics[count]: name, partitions[count]:
        //   partition(4), fetchOffset(8), partitionMaxBytes(4).
        const buf = Buffer.alloc(4 + 4 + 4 + 4 + 1 + 4 + (2 + topicBuf.length) + 4 + 4 + 8 + 4);
        let p = 0;
        buf.writeInt32BE(-1, p); p += 4;             // replicaId (-1 consumer)
        buf.writeInt32BE(1000, p); p += 4;           // maxWaitMs
        buf.writeInt32BE(1, p); p += 4;              // minBytes
        buf.writeInt32BE(1048576, p); p += 4;        // maxBytes
        buf.writeInt8(0, p); p += 1;                 // isolationLevel = READ_UNCOMMITTED
        buf.writeInt32BE(1, p); p += 4;              // topics count
        buf.writeInt16BE(topicBuf.length, p); p += 2;
        topicBuf.copy(buf, p); p += topicBuf.length;
        buf.writeInt32BE(1, p); p += 4;              // partitions count
        buf.writeInt32BE(0, p); p += 4;              // partition 0
        buf.writeBigInt64BE(BigInt(fetchOffset), p); p += 8; // fetchOffset
        buf.writeInt32BE(1048576, p); p += 4;        // partitionMaxBytes

        return frameRequest(API_FETCH, FETCH_VERSION, clientBuf, buf);
      }

      // Frame a request with header v1: apiKey, apiVersion, correlationId,
      // clientId (nullable string) + body.
      function frameRequest(apiKey, apiVersion, clientBuf, body) {
        const header = Buffer.alloc(2 + 2 + 4 + 2 + clientBuf.length);
        let p = 0;
        header.writeInt16BE(apiKey, p); p += 2;
        header.writeInt16BE(apiVersion, p); p += 2;
        header.writeInt32BE(correlationId, p); p += 4;
        header.writeInt16BE(clientBuf.length, p); p += 2;
        clientBuf.copy(header, p);
        const payload = Buffer.concat([header, body]);
        const framed = Buffer.alloc(4 + payload.length);
        framed.writeInt32BE(payload.length, 0);
        payload.copy(framed, 4);
        return framed;
      }

      // ── Parse a v2 RecordBatch region, return the FIRST record value ───────
      // \`buf\` is the whole fetch response; [start, end) bounds the partition's
      // record-set bytes (may contain one or more concatenated batches).
      function firstRecordValue(buf, start, end) {
        let pos = start;
        while (pos + 12 <= end) {
          // baseOffset(8) + batchLength(4) then batchLength bytes follow.
          const batchLength = buf.readInt32BE(pos + 8);
          const batchStart = pos + 12; // first byte of partitionLeaderEpoch
          const batchEnd = batchStart + batchLength;
          if (batchLength <= 0 || batchEnd > end) break;
          // partitionLeaderEpoch(4), magic(1), crc(4), attributes(2),
          // lastOffsetDelta(4), firstTimestamp(8), maxTimestamp(8),
          // producerId(8), producerEpoch(2), baseSequence(4), recordsCount(4)
          const magic = buf.readInt8(batchStart + 4);
          if (magic !== 2) { pos = batchEnd; continue; }
          let r = batchStart + 4 + 1 + 4 + 2 + 4 + 8 + 8 + 8 + 2 + 4;
          const recordsCount = buf.readInt32BE(r); r += 4;
          for (let i = 0; i < recordsCount && r < batchEnd; i++) {
            const recLen = decodeVarint(buf, r); // record length (signed varint)
            let rp = recLen.next;
            const recordEnd = rp + recLen.value;
            rp += 1; // attributes (int8)
            const tsDelta = decodeVarint(buf, rp); rp = tsDelta.next;
            const offDelta = decodeVarint(buf, rp); rp = offDelta.next;
            const keyLen = decodeVarint(buf, rp); rp = keyLen.next;
            if (keyLen.value >= 0) rp += keyLen.value;
            const valLen = decodeVarint(buf, rp); rp = valLen.next;
            if (valLen.value >= 0) {
              return buf.subarray(rp, rp + valLen.value).toString("utf-8");
            }
            r = recordEnd;
          }
          pos = batchEnd;
        }
        return null;
      }

      let finished = false;
      function finish(out, code) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { sock.destroy(); } catch (e) { /* ignore */ }
        if (out) process.stdout.write(out);
        // Flush stdout before exiting so execFileSync captures it.
        process.stdout.write("", () => process.exit(code));
      }

      const sock = net.createConnection({ host, port }, () => {
        if (operation === "publish") {
          const req = buildProduceRequest(topic, Buffer.from(data, "utf-8"));
          sock.write(req);
        } else if (operation === "get") {
          sock.write(buildFetchRequest(topic, 0));
        } else {
          finish("__UNSUPPORTED__", 0);
        }
      });

      let buffer = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const respSize = buffer.readInt32BE(0);
        if (buffer.length < 4 + respSize) return;

        if (operation === "publish") {
          // Produce v3 response (after the 4-byte frame size): correlationId(4),
          // topics[count]: name, partitions[count]: partition(4), errorCode(2),
          //   baseOffset(8), logAppendTime(8); then throttleTimeMs(4) at the END.
          // Only the per-partition error code matters here.
          try {
            let pos = 4 + 4; // skip frame size + correlationId
            const topicCount = buffer.readInt32BE(pos); pos += 4;
            let errCode = 0;
            for (let t = 0; t < topicCount; t++) {
              const tl = buffer.readInt16BE(pos); pos += 2 + tl;
              const pc = buffer.readInt32BE(pos); pos += 4;
              for (let pi = 0; pi < pc; pi++) {
                pos += 4;                               // partition index
                errCode = buffer.readInt16BE(pos); pos += 2; // error code
                pos += 8;                               // baseOffset
                pos += 8;                               // logAppendTime (v2+)
              }
            }
            if (errCode === 0) {
              finish("__PUBLISHED__", 0);
            } else {
              // Report the CODE, not just "it failed" — the caller decides
              // whether it is retriable (3/5, the async topic-creation race)
              // or fatal (e.g. 29 TOPIC_AUTHORIZATION_FAILED).
              process.stderr.write("Produce error code " + errCode);
              finish("__PRODUCEERROR__" + errCode, 0);
            }
          } catch (e) {
            process.stderr.write("produce parse: " + e.message);
            finish("__PARSEERROR__produce: " + e.message, 0);
          }
          return;
        } else if (operation === "get") {
          // Fetch v4 response (after the 4-byte frame size): correlationId(4),
          // throttleTimeMs(4), topics[count]: name, partitions[count]:
          //   partition(4), errorCode(2), highWatermark(8), lastStableOffset(8),
          //   abortedTxns[count](producerId(8)+firstOffset(8)),
          //   recordSetBytes(int32)+batch.
          try {
            let pos = 4 + 4;                            // frame size + correlationId
            pos += 4;                                   // throttleTimeMs (v1+)
            const topicCount = buffer.readInt32BE(pos); pos += 4;
            let out = "__EMPTY__";
            let fatalCode = 0;
            for (let t = 0; t < topicCount; t++) {
              const tl = buffer.readInt16BE(pos); pos += 2 + tl;
              const pc = buffer.readInt32BE(pos); pos += 4;
              for (let pi = 0; pi < pc; pi++) {
                pos += 4;                               // partition index
                const errCode = buffer.readInt16BE(pos); pos += 2;
                pos += 8;                               // highWatermark
                pos += 8;                               // lastStableOffset (v4+)
                const abortedCount = buffer.readInt32BE(pos); pos += 4;
                if (abortedCount > 0) pos += abortedCount * 16; // (-1 => none, skip)
                const recSetSize = buffer.readInt32BE(pos); pos += 4;
                // 3 = UNKNOWN_TOPIC_OR_PARTITION, 5 = LEADER_NOT_AVAILABLE:
                // "nothing to read here yet", which a consumer that starts
                // before its producer hits on every cold start. Any OTHER code
                // (29 TOPIC_AUTHORIZATION_FAILED, 13 STALE_CONTROLLER_EPOCH, …)
                // is a real failure and must NOT be reported as an empty queue.
                if (errCode !== 0 && errCode !== 3 && errCode !== 5) {
                  fatalCode = errCode;
                }
                if (errCode === 0 && recSetSize > 0) {
                  const val = firstRecordValue(buffer, pos, pos + recSetSize);
                  if (val !== null) out = val;
                }
                pos += recSetSize > 0 ? recSetSize : 0;
              }
            }
            if (fatalCode !== 0) {
              process.stderr.write("Fetch error code " + fatalCode);
              finish("__FETCHERROR__" + fatalCode, 0);
              return;
            }
            finish(out, 0);
          } catch (e) {
            // A parse failure is NOT an empty queue either — say so.
            process.stderr.write("fetch parse: " + e.message);
            finish("__PARSEERROR__fetch: " + e.message, 0);
          }
          return;
        }
      });

      // Report the reason on STDOUT and exit 0. Writing it to stderr and
      // exiting non-zero LOST it: stderr to a pipe is an async write and
      // process.exit() truncates it, so the parent saw an empty stderr and fell
      // back to execFileSync's message -- which embeds this entire script.
      // stdout is flushed by finish()'s write callback, so it survives.
      sock.on("error", (err) => {
        finish("__TRANSPORTERROR__" + err.message, 0);
      });

      var timer = setTimeout(() => {
        finish("__TRANSPORTERROR__timed out after 10s talking to " + host + ":" + port, 0);
      }, 10000);
    `;

    try {
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result;
    } catch (err) {
      // Reached only when the child itself could not run (spawn failure, killed,
      // the outer 15s timeout). The socket-level reasons come back through
      // stdout as __TRANSPORTERROR__ instead. Swallowing this to "" made every
      // failure indistinguishable from an empty queue.
      //
      // execFileSync's own message embeds the ENTIRE generated script, so it is
      // truncated here -- a 20KB error that buries the cause is barely better
      // than no error at all.
      const e = err as { stderr?: Buffer | string; message?: string };
      const reason = String(e.stderr ?? "").trim() || e.message || "unknown error";
      const firstLine = reason.split("\n", 1)[0]!.slice(0, 200);
      return "__TRANSPORTERROR__" + firstLine;
    }
  }

  /**
   * Sleep synchronously between produce retries.
   *
   * `push()` is synchronous (the whole backend drives its socket through a child
   * process), so there is no event loop to await on. `Atomics.wait` on a
   * SharedArrayBuffer is the stdlib way to block a thread for a fixed time --
   * no dependency, no busy-wait burning CPU.
   */
  private static sleepSync(ms: number): void {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
  }

  /**
   * Turn a sentinel from the protocol child into a thrown error, or return.
   *
   * The wording matches the Python and PHP backends exactly -- the parity rule
   * covers user-visible error messages, not just behaviour.
   */
  private static assertNoError(result: string, operation: string, topic: string): void {
    const fatal = /^__(PRODUCEERROR|FETCHERROR)__(\d+)/.exec(result);
    if (fatal) {
      throw new Error(
        `Kafka rejected the ${operation} for topic ${topic}: error code ${fatal[2]}`,
      );
    }
    if (result.startsWith("__TRANSPORTERROR__")) {
      throw new Error(
        `Kafka ${operation} for topic ${topic} failed: ` +
          result.slice("__TRANSPORTERROR__".length),
      );
    }
    if (result.startsWith("__PARSEERROR__")) {
      throw new Error(
        `Kafka ${operation} for topic ${topic} returned an unreadable response: ` +
          result.slice("__PARSEERROR__".length),
      );
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

    // Topic auto-creation is ASYNCHRONOUS, so a brand-new topic answers
    // UNKNOWN_TOPIC_OR_PARTITION (3) or LEADER_NOT_AVAILABLE (5) on the first
    // attempt while the controller is still electing a leader. Retry those
    // (same 10 attempts / 200ms as the Python and PHP backends) instead of
    // failing a cold-start push; every other code throws immediately.
    const body = JSON.stringify(job);
    let result = "";
    for (let attempt = 1; attempt <= 10; attempt++) {
      result = this.execSync("publish", queue, body);
      if (result.includes("__PUBLISHED__")) {
        return id;
      }
      const retriable = /^__PRODUCEERROR__(3|5)\b/.test(result);
      if (!retriable || attempt === 10) {
        break;
      }
      KafkaBackend.sleepSync(200);
    }

    KafkaBackend.assertNoError(result, "produce", queue);
    throw new Error(`Kafka publish failed for topic ${queue}: ${result || "no response"}`);
  }

  pop(queue: string): QueueJob | null {
    const result = this.execSync("get", queue);

    // A real failure must NOT read as an empty queue: a mis-permissioned
    // consumer would otherwise poll an "idle" topic forever.
    KafkaBackend.assertNoError(result, "fetch", queue);

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

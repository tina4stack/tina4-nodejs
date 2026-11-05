/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Tina4 Kafka Queue Backend — Kafka protocol via raw TCP, zero dependencies.
 *
 * Implements the same interface as the file-based queue but uses Apache Kafka
 * for message storage and delivery.
 *
 * The queue API is synchronous, but a durable Kafka consumer needs a PERSISTENT
 * connection that holds an in-memory read cursor and commits consumer-group
 * offsets (ADR-0022 decision 8: the correct fix is "a persistent connection held
 * on the backend instance, the way Python, PHP and Ruby already do it"). Node
 * sockets are async, so the connection lives in a worker thread with its own
 * event loop; the main thread drives it synchronously via a SharedArrayBuffer +
 * Atomics.wait. The worker owns the broker socket, the group-coordinator socket,
 * the per-topic read cursor, and the in-flight map (job id -> record offset) so
 * complete()/fail()/reject()/retry() commit exactly the right record. This
 * replaces the previous stateless child-process-per-operation design, which
 * could not keep a cursor, always fetched offset 0, and never committed — so it
 * replayed the whole topic on every call and every restart.
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
import { Worker } from "node:worker_threads";
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

/**
 * Resolve the consumer's auto.offset.reset policy from the environment.
 *
 * Where a NEW consumer group (one with no committed offset) starts reading:
 * "earliest" (the default, unchanged) replays the retained backlog; "latest"
 * skips it. Read from the Tina4-namespaced env var FIRST
 * (`TINA4_KAFKA_AUTO_OFFSET_RESET`) and fall back to the bare librdkafka-
 * convention name (`KAFKA_AUTO_OFFSET_RESET`) — the same precedence the TLS/SASL
 * keys use. A blank value falls through to the default (tina4-nodejs#263).
 *
 * Mirrors Python's `KafkaConnector._offset_reset`.
 */
export function kafkaOffsetReset(env: NodeJS.ProcessEnv = process.env): string {
  return env.TINA4_KAFKA_AUTO_OFFSET_RESET || env.KAFKA_AUTO_OFFSET_RESET || "earliest";
}

export interface QueueBackend {
  push(queue: string, payload: unknown, delay?: number, priority?: number, raw?: boolean): string;
  pop(queue: string): QueueJob | null;
  size(queue: string): number;
  clear(queue: string): void;
}

/**
 * The worker source (plain JS, run via `new Worker(src, { eval: true })`). It
 * owns the sockets, the per-topic read cursor, and the in-flight map, speaks the
 * Kafka wire protocol by hand (Produce v3 + v2 RecordBatch + CRC-32C, Fetch v4,
 * FindCoordinator v1, OffsetFetch v1, OffsetCommit v2 — the lowest non-flexible
 * versions, matching the PHP/Python backends), and answers one request at a time
 * over a SharedArrayBuffer. No backticks / ${} inside so it embeds cleanly.
 */
const WORKER_SRC = `
const net = require("node:net");
const tls = require("node:tls");
const { parentPort, workerData } = require("node:worker_threads");

const brokers = workerData.brokers;
const groupId = workerData.groupId;
const security = workerData.security || {};
const offsetReset = workerData.offsetReset || "earliest";
const header = new Int32Array(workerData.sab, 0, 2); // [0]=flag, [1]=respLen
const outBytes = new Uint8Array(workerData.sab, 8);

// Lowest versions Kafka 4.x still accepts: it REMOVED Produce v0-v2 / Fetch v0-v3
// (the old message formats) and answers a removed version by closing the socket,
// not with an error code. These are named constants so the source invariant test
// (test/kafkaErrorCodes.test.ts) can assert the floors.
const PRODUCE_VERSION = 3;
const FETCH_VERSION = 4;

let correlationId = 0;
let brokerSock = null;
let coordSock = null;
const offsets = {};   // topic -> next read offset (in-memory cursor)
const inFlight = {};   // job id -> { offset, value, attempts, isEnvelope }

const COORDINATOR_ERRORS = [14, 15, 16];

function parseBroker(list) {
  const first = String(list).split(",")[0].trim();
  const i = first.lastIndexOf(":");
  if (i < 0) return { host: first || "localhost", port: 9092 };
  return { host: first.slice(0, i) || "localhost", port: parseInt(first.slice(i + 1), 10) || 9092 };
}

function connect(host, port) {
  return new Promise(function (resolve, reject) {
    const proto = String(security["security.protocol"] || "PLAINTEXT").toUpperCase();
    const useTls = proto.indexOf("SSL") >= 0;
    let sock;
    const onErr = function (e) { reject(e); };
    if (useTls) {
      const opts = { host: host, port: port, servername: host };
      if (security["ssl.ca.location"]) opts.ca = require("node:fs").readFileSync(security["ssl.ca.location"]);
      sock = tls.connect(opts, function () { sock.removeListener("error", onErr); resolve(sock); });
    } else {
      sock = net.createConnection({ host: host, port: port }, function () { sock.removeListener("error", onErr); resolve(sock); });
    }
    sock.once("error", onErr);
  });
}

// One request/response round trip on a socket: write the framed request, read a
// 4-byte length then that many bytes, resolve with the payload AFTER the length
// (so it starts at correlationId). Serialized — one in flight per socket.
function rpc(sock, reqBuf) {
  return new Promise(function (resolve, reject) {
    let buf = Buffer.alloc(0);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const size = buf.readInt32BE(0);
      if (buf.length < 4 + size) return;
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      resolve(buf.subarray(4, 4 + size));
    }
    function onErr(e) {
      sock.removeListener("data", onData);
      reject(e);
    }
    sock.on("data", onData);
    sock.once("error", onErr);
    sock.write(reqBuf);
  });
}

// ── encoders ──────────────────────────────────────────────────────────────
function kstr(s) {
  const b = Buffer.from(s, "utf-8");
  const out = Buffer.alloc(2 + b.length);
  out.writeInt16BE(b.length, 0);
  b.copy(out, 2);
  return out;
}
function frame(apiKey, apiVersion, body) {
  correlationId++;
  const client = Buffer.from("tina4-nodejs", "utf-8");
  const head = Buffer.alloc(2 + 2 + 4 + 2 + client.length);
  let p = 0;
  head.writeInt16BE(apiKey, p); p += 2;
  head.writeInt16BE(apiVersion, p); p += 2;
  head.writeInt32BE(correlationId, p); p += 4;
  head.writeInt16BE(client.length, p); p += 2;
  client.copy(head, p);
  const payload = Buffer.concat([head, body]);
  const out = Buffer.alloc(4 + payload.length);
  out.writeInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

// ── CRC-32C + varints + v2 RecordBatch (produce) ────────────────────────────
const CRC32C_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0x82f63b78 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32c(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (CRC32C_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
function zig(n) { return ((n << 1) ^ (n >> 31)) >>> 0; }
function varU(u) {
  const b = [];
  let v = u >>> 0;
  for (;;) { if ((v & ~0x7f) === 0) { b.push(v); break; } b.push((v & 0x7f) | 0x80); v >>>= 7; }
  return Buffer.from(b);
}
function varint(n) { return varU(zig(n)); }
function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do { b = buf[pos++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  result = result >>> 0;
  return { value: (result >>> 1) ^ -(result & 1), next: pos };
}
function buildRecordBatch(valueBytes) {
  const now = BigInt(Date.now());
  const recBody = Buffer.concat([
    Buffer.from([0]), varint(0), varint(0), varint(-1),
    varint(valueBytes.length), valueBytes, varint(0),
  ]);
  const record = Buffer.concat([varint(recBody.length), recBody]);
  const crcBody = Buffer.alloc(2 + 4 + 8 + 8 + 8 + 2 + 4 + 4 + record.length);
  let c = 0;
  crcBody.writeInt16BE(0, c); c += 2;
  crcBody.writeInt32BE(0, c); c += 4;
  crcBody.writeBigInt64BE(now, c); c += 8;
  crcBody.writeBigInt64BE(now, c); c += 8;
  crcBody.writeBigInt64BE(-1n, c); c += 8;
  crcBody.writeInt16BE(-1, c); c += 2;
  crcBody.writeInt32BE(-1, c); c += 4;
  crcBody.writeInt32BE(1, c); c += 4;
  record.copy(crcBody, c);
  const crc = crc32c(crcBody);
  const batchLength = 4 + 1 + 4 + crcBody.length;
  const head = Buffer.alloc(8 + 4 + 4 + 1 + 4);
  let h = 0;
  head.writeBigInt64BE(0n, h); h += 8;
  head.writeInt32BE(batchLength, h); h += 4;
  head.writeInt32BE(-1, h); h += 4;
  head.writeInt8(2, h); h += 1;
  head.writeUInt32BE(crc, h); h += 4;
  return Buffer.concat([head, crcBody]);
}

// ── produce ─────────────────────────────────────────────────────────────────
function produceRequest(topic, valueBytes) {
  const topicBuf = Buffer.from(topic, "utf-8");
  const batch = buildRecordBatch(valueBytes);
  const body = Buffer.alloc(2 + 2 + 4 + 4 + 2 + topicBuf.length + 4 + 4 + 4 + batch.length);
  let p = 0;
  body.writeInt16BE(-1, p); p += 2;        // transactionalId null
  body.writeInt16BE(1, p); p += 2;         // acks 1
  body.writeInt32BE(10000, p); p += 4;     // timeoutMs
  body.writeInt32BE(1, p); p += 4;         // topics
  body.writeInt16BE(topicBuf.length, p); p += 2;
  topicBuf.copy(body, p); p += topicBuf.length;
  body.writeInt32BE(1, p); p += 4;         // partitions
  body.writeInt32BE(0, p); p += 4;         // partition 0
  body.writeInt32BE(batch.length, p); p += 4;
  batch.copy(body, p);
  return frame(0, PRODUCE_VERSION, body);
}
function parseProduce(resp) {
  let pos = 4; // correlationId
  const topicCount = resp.readInt32BE(pos); pos += 4;
  let err = 0;
  for (let t = 0; t < topicCount; t++) {
    const tl = resp.readInt16BE(pos); pos += 2 + tl;
    const pc = resp.readInt32BE(pos); pos += 4;
    for (let pi = 0; pi < pc; pi++) {
      pos += 4; err = resp.readInt16BE(pos); pos += 2; pos += 8; pos += 8;
    }
  }
  return err;
}
async function produce(topic, valueBytes) {
  const sock = await broker();
  for (let attempt = 1; attempt <= 10; attempt++) {
    const err = parseProduce(await rpc(sock, produceRequest(topic, valueBytes)));
    if (err === 0) return;
    if ((err !== 3 && err !== 5) || attempt === 10) {
      throw new Error("Kafka rejected the produce for topic " + topic + ": error code " + err);
    }
    await sleep(200);
  }
}

// ── fetch ─────────────────────────────────────────────────────────────────
function fetchRequest(topic, offset) {
  const topicBuf = Buffer.from(topic, "utf-8");
  const buf = Buffer.alloc(4 + 4 + 4 + 4 + 1 + 4 + 2 + topicBuf.length + 4 + 4 + 8 + 4);
  let p = 0;
  buf.writeInt32BE(-1, p); p += 4;       // replicaId
  buf.writeInt32BE(1000, p); p += 4;     // maxWaitMs
  buf.writeInt32BE(1, p); p += 4;        // minBytes
  buf.writeInt32BE(1048576, p); p += 4;  // maxBytes
  buf.writeInt8(0, p); p += 1;           // isolation READ_UNCOMMITTED
  buf.writeInt32BE(1, p); p += 4;        // topics
  buf.writeInt16BE(topicBuf.length, p); p += 2;
  topicBuf.copy(buf, p); p += topicBuf.length;
  buf.writeInt32BE(1, p); p += 4;        // partitions
  buf.writeInt32BE(0, p); p += 4;        // partition 0
  buf.writeBigInt64BE(BigInt(offset), p); p += 8;
  buf.writeInt32BE(1048576, p); p += 4;
  return frame(1, FETCH_VERSION, buf);
}
// Decode the first record of the partition's record-set: its value string and
// absolute offset (baseOffset + offsetDelta). null = no usable record.
function firstRecord(buf, start, end) {
  let pos = start;
  while (pos + 12 <= end) {
    const baseOffset = buf.readBigInt64BE(pos);
    const batchLength = buf.readInt32BE(pos + 8);
    const batchStart = pos + 12;
    const batchEnd = batchStart + batchLength;
    if (batchLength <= 0 || batchEnd > end) break;
    const magic = buf.readInt8(batchStart + 4);
    if (magic !== 2) { pos = batchEnd; continue; }
    let r = batchStart + 4 + 1 + 4 + 2 + 4 + 8 + 8 + 8 + 2 + 4;
    const recordsCount = buf.readInt32BE(r); r += 4;
    for (let i = 0; i < recordsCount && r < batchEnd; i++) {
      const recLen = readVarint(buf, r);
      let rp = recLen.next;
      const recordEnd = rp + recLen.value;
      rp += 1;
      rp = readVarint(buf, rp).next;              // timestampDelta
      const offDelta = readVarint(buf, rp); rp = offDelta.next;
      const keyLen = readVarint(buf, rp); rp = keyLen.next;
      if (keyLen.value >= 0) rp += keyLen.value;
      const valLen = readVarint(buf, rp); rp = valLen.next;
      if (valLen.value >= 0) {
        return {
          value: buf.subarray(rp, rp + valLen.value).toString("utf-8"),
          offset: Number(baseOffset) + offDelta.value,
        };
      }
      r = recordEnd;
    }
    pos = batchEnd;
  }
  return null;
}
async function fetchAt(topic, offset) {
  const sock = await broker();
  const resp = await rpc(sock, fetchRequest(topic, offset));
  let pos = 4;       // correlationId
  pos += 4;          // throttleTimeMs
  const topicCount = resp.readInt32BE(pos); pos += 4;
  let rec = null;
  for (let t = 0; t < topicCount; t++) {
    const tl = resp.readInt16BE(pos); pos += 2 + tl;
    const pc = resp.readInt32BE(pos); pos += 4;
    for (let pi = 0; pi < pc; pi++) {
      pos += 4;
      const err = resp.readInt16BE(pos); pos += 2;
      pos += 8; pos += 8;
      const aborted = resp.readInt32BE(pos); pos += 4;
      if (aborted > 0) pos += aborted * 16;
      const recSize = resp.readInt32BE(pos); pos += 4;
      if (err !== 0 && err !== 3 && err !== 5) {
        throw new Error("Kafka rejected the fetch for topic " + topic + ": error code " + err);
      }
      if (err === 0 && recSize > 0) {
        const r = firstRecord(resp, pos, pos + recSize);
        if (r !== null) rec = r;
      }
      if (recSize > 0) pos += recSize;
    }
  }
  return rec;
}

// ── coordinator + offsets ───────────────────────────────────────────────────
function readNullableString(buf, pos) {
  const len = buf.readInt16BE(pos); pos += 2;
  if (len < 0) return { value: null, next: pos };
  return { value: buf.toString("utf-8", pos, pos + len), next: pos + len };
}
async function findCoordinator() {
  const sock = await broker();
  for (let attempt = 0; attempt < 30; attempt++) {
    const body = Buffer.concat([kstr(groupId), Buffer.from([0])]); // key_type 0 = group
    const resp = await rpc(sock, frame(10, 1, body));
    let pos = 4;        // correlationId
    pos += 4;           // throttle
    const err = resp.readInt16BE(pos); pos += 2;
    pos = readNullableString(resp, pos).next; // error_message
    pos += 4;           // node_id
    const hostRes = readNullableString(resp, pos); pos = hostRes.next;
    const port = resp.readInt32BE(pos);
    if (err === 0 && hostRes.value) return { host: hostRes.value, port: port };
    if (err !== 14 && err !== 15) {
      throw new Error("Kafka FindCoordinator failed for group " + groupId + ": error code " + err);
    }
    await sleep(300);
  }
  throw new Error("Kafka group coordinator for " + groupId + " did not become available");
}
async function coordinator() {
  if (coordSock) return coordSock;
  const c = await findCoordinator();
  coordSock = await connect(c.host, c.port);
  return coordSock;
}
function dropCoordinator() {
  if (coordSock) { try { coordSock.destroy(); } catch (e) { /* ignore */ } }
  coordSock = null;
}
function offsetCommitRequest(topic, offset) {
  const body = Buffer.concat([
    kstr(groupId),
    int32(-1),            // generation_id -1 (simple consumer)
    kstr(""),             // member_id ""
    int64(-1n),           // retention_time -1
    int32(1), kstr(topic), int32(1), int32(0), int64(BigInt(offset)), int16(-1),
  ]);
  return frame(8, 2, body);
}
function parseOffsetCommit(resp) {
  let pos = 4;
  const tc = resp.readInt32BE(pos); pos += 4;
  if (tc === 0) return 16;
  const tl = resp.readInt16BE(pos); pos += 2 + tl;
  const pc = resp.readInt32BE(pos); pos += 4;
  if (pc === 0) return 16;
  pos += 4;
  return resp.readInt16BE(pos);
}
async function offsetCommit(topic, offset) {
  let err = parseOffsetCommit(await rpc(await coordinator(), offsetCommitRequest(topic, offset)));
  if (COORDINATOR_ERRORS.indexOf(err) >= 0) {
    dropCoordinator();
    err = parseOffsetCommit(await rpc(await coordinator(), offsetCommitRequest(topic, offset)));
  }
  if (err !== 0) throw new Error("Kafka rejected the offset commit for " + topic + ": error code " + err);
}
function offsetFetchRequest(topic) {
  const body = Buffer.concat([kstr(groupId), int32(1), kstr(topic), int32(1), int32(0)]);
  return frame(9, 1, body);
}
function parseOffsetFetch(resp) {
  let pos = 4;
  const tc = resp.readInt32BE(pos); pos += 4;
  if (tc === 0) return { offset: -1, err: 16 };
  const tl = resp.readInt16BE(pos); pos += 2 + tl;
  const pc = resp.readInt32BE(pos); pos += 4;
  if (pc === 0) return { offset: -1, err: 16 };
  pos += 4;
  const offset = Number(resp.readBigInt64BE(pos)); pos += 8;
  pos = readNullableString(resp, pos).next;
  const err = resp.readInt16BE(pos);
  return { offset: offset, err: err };
}
async function offsetFetch(topic) {
  let r = parseOffsetFetch(await rpc(await coordinator(), offsetFetchRequest(topic)));
  if (COORDINATOR_ERRORS.indexOf(r.err) >= 0) {
    dropCoordinator();
    r = parseOffsetFetch(await rpc(await coordinator(), offsetFetchRequest(topic)));
  }
  if (r.err !== 0) throw new Error("Kafka rejected the offset fetch for " + topic + ": error code " + r.err);
  return r.offset < 0 ? 0 : r.offset;
}

function int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; }
function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; }
function int64(n) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n), 0); return b; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function broker() {
  if (brokerSock) return brokerSock;
  const b = parseBroker(brokers);
  brokerSock = await connect(b.host, b.port);
  return brokerSock;
}

// Resume from the committed offset on the FIRST read of a topic in this worker,
// then advance the in-memory cursor; the committed offset only moves on a
// commit, so it lags and a crash before commit replays (at-least-once).
async function fetchNext(topic) {
  if (!(topic in offsets)) offsets[topic] = await offsetFetch(topic);
  const rec = await fetchAt(topic, offsets[topic]);
  if (rec === null) return null;
  offsets[topic] = rec.offset + 1;
  return rec;
}

function encodeEnvelope(id, payload, attempts) {
  return JSON.stringify({ id: id, payload: payload, status: "pending", createdAt: new Date().toISOString(), attempts: attempts, delayUntil: null });
}

async function handle(req) {
  const op = req.op;
  if (op === "publish") {
    await produce(req.topic, Buffer.from(req.value, "utf-8"));
    return { ok: true };
  }
  if (op === "dequeueRaw") {
    // The value exactly as it sits on the wire (a raw record stays its bare
    // bytes — tina4-nodejs#264), with no id/offset tracking. For wire
    // inspection; the facade consumes through "pop", which normalises + tracks.
    const rec = await fetchNext(req.topic);
    if (rec === null) return { ok: true, message: null };
    let decoded;
    try { decoded = JSON.parse(rec.value); } catch (e) { decoded = rec.value; }
    return { ok: true, message: decoded };
  }
  if (op === "pop") {
    let rec;
    try {
      rec = await fetchNext(req.topic);
    } catch (e) {
      // A malformed/short response runs the parser off the end (a RangeError);
      // anything else is a transport failure. Both name the topic so the cause
      // is findable, and neither reads as an empty queue (ADR: a real failure
      // must never look idle). Wording matches the Python/PHP backends.
      const range = (e instanceof RangeError) || /out of range|bounds/i.test((e && e.message) || "");
      if (range) throw new Error("Kafka fetch for topic " + req.topic + " returned an unreadable response: " + ((e && e.message) || e));
      throw new Error("Kafka fetch for topic " + req.topic + " failed: " + ((e && e.message) || e));
    }
    if (rec === null) return { ok: true, message: null };
    const coordinate = req.topic + ":0:" + rec.offset;
    let decoded;
    try { decoded = JSON.parse(rec.value); } catch (e) { decoded = null; }
    let message;
    let isEnvelope = false;
    if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) && "payload" in decoded) {
      message = decoded;
      isEnvelope = true;
      if (!message.id) message.id = coordinate;
    } else {
      message = { id: coordinate, payload: decoded === null ? rec.value : decoded, status: "pending", attempts: 0 };
    }
    // The Job lifecycle (complete/fail/retry) routes by the record's own topic,
    // so it must be carried back (like the file/mongodb backends do).
    message.topic = req.topic;
    inFlight[String(message.id)] = { offset: rec.offset, value: rec.value, attempts: message.attempts || 0, isEnvelope: isEnvelope };
    return { ok: true, message: message };
  }
  if (op === "complete") {
    const rec = inFlight[String(req.id)];
    if (rec) { delete inFlight[String(req.id)]; await offsetCommit(req.topic, rec.offset + 1); }
    return { ok: true };
  }
  if (op === "fail") {
    const rec = inFlight[String(req.id)];
    if (rec) {
      delete inFlight[String(req.id)];
      const attempts = (rec.attempts || 0) + 1;
      const parsed = (function () { try { return JSON.parse(rec.value); } catch (e) { return rec.value; } })();
      const payload = (parsed && typeof parsed === "object" && "payload" in parsed) ? parsed.payload : parsed;
      if (attempts < req.maxRetries) {
        await produce(req.topic, Buffer.from(encodeEnvelope(req.id, payload, attempts), "utf-8"));
      } else {
        await produce(req.topic + ".dead_letter", Buffer.from(JSON.stringify({ id: req.id, payload: payload, attempts: attempts, error: req.error }), "utf-8"));
      }
      await offsetCommit(req.topic, rec.offset + 1);
    }
    return { ok: true };
  }
  if (op === "reject") {
    const rec = inFlight[String(req.id)];
    if (rec) {
      delete inFlight[String(req.id)];
      const parsed = (function () { try { return JSON.parse(rec.value); } catch (e) { return rec.value; } })();
      const payload = (parsed && typeof parsed === "object" && "payload" in parsed) ? parsed.payload : parsed;
      await produce(req.topic + ".dead_letter", Buffer.from(JSON.stringify({ id: req.id, payload: payload, attempts: req.maxRetries, error: req.reason }), "utf-8"));
      await offsetCommit(req.topic, rec.offset + 1);
    }
    return { ok: true };
  }
  if (op === "retry") {
    const rec = inFlight[String(req.id)];
    if (rec) {
      delete inFlight[String(req.id)];
      const attempts = (rec.attempts || 0) + 1;
      const parsed = (function () { try { return JSON.parse(rec.value); } catch (e) { return rec.value; } })();
      const payload = (parsed && typeof parsed === "object" && "payload" in parsed) ? parsed.payload : parsed;
      await produce(req.topic, Buffer.from(encodeEnvelope(req.id, payload, attempts), "utf-8"));
      await offsetCommit(req.topic, rec.offset + 1);
    }
    return { ok: true };
  }
  if (op === "deadLetters") {
    // Read the <topic>.dead_letter topic from the beginning; every record on it
    // is a dead letter by construction. A throwaway cursor that never commits,
    // so it does not disturb the main consume position.
    const dlq = req.topic + ".dead_letter";
    const out = [];
    let off = 0;
    for (;;) {
      const rec = await fetchAt(dlq, off);
      if (rec === null) break;
      off = rec.offset + 1;
      try { out.push(JSON.parse(rec.value)); } catch (e) { /* skip */ }
      if (out.length > 10000) break;
    }
    return { ok: true, deadLetters: out };
  }
  if (op === "close") {
    try { if (brokerSock) brokerSock.destroy(); } catch (e) { /* ignore */ }
    dropCoordinator();
    return { ok: true, closing: true };
  }
  return { ok: false, error: "unknown op " + op };
}

parentPort.on("message", async function (req) {
  let res;
  try { res = await handle(req); }
  catch (e) { res = { ok: false, error: (e && e.message) ? e.message : String(e) }; }
  const bytes = Buffer.from(JSON.stringify(res), "utf-8");
  outBytes.set(bytes.subarray(0, outBytes.length), 0);
  Atomics.store(header, 1, Math.min(bytes.length, outBytes.length));
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
});
`;

/**
 * Kafka queue backend — a persistent worker-thread connection (see the file
 * header). The public API stays synchronous; each call blocks the main thread on
 * Atomics.wait while the worker runs the async socket I/O.
 */
export class KafkaBackend implements QueueBackend {
  private brokers: string;
  private groupId: string;
  private worker: Worker | null = null;
  private sab: SharedArrayBuffer | null = null;
  private header: Int32Array | null = null;
  private outBytes: Uint8Array | null = null;
  private static readonly SAB_SIZE = 1 << 20; // 1 MiB (8-byte header + response bytes)
  private static readonly CALL_TIMEOUT_MS = 20000;

  constructor(config?: KafkaConfig) {
    const url = process.env.TINA4_QUEUE_URL;
    const fromUrl = url ? url.replace(/^kafka:\/\//, "") : undefined;
    this.brokers = config?.brokers ?? process.env.TINA4_KAFKA_BROKERS ?? fromUrl ?? "localhost:9092";
    this.groupId = config?.groupId ?? process.env.TINA4_KAFKA_GROUP_ID ?? "tina4_consumer_group";
  }

  /** Resolved connection config — exposed for testing/introspection. */
  getConfig(): Required<Omit<KafkaConfig, "visibilityTimeout">> {
    return { brokers: this.brokers, groupId: this.groupId };
  }

  securityConfig(): KafkaSecurityConfig {
    return kafkaSecurityConfig();
  }

  producerConfig(): KafkaClientConfig {
    return { "bootstrap.servers": this.brokers, "client.id": "tina4-nodejs", ...this.securityConfig() };
  }

  consumerConfig(): KafkaClientConfig {
    return {
      "bootstrap.servers": this.brokers,
      "client.id": "tina4-nodejs",
      "group.id": this.groupId,
      "auto.offset.reset": kafkaOffsetReset(),
      "enable.auto.commit": false,
      ...this.securityConfig(),
    };
  }

  /** Lazily start the persistent worker + its shared buffer. */
  private ensureWorker(): void {
    if (this.worker) return;
    this.sab = new SharedArrayBuffer(KafkaBackend.SAB_SIZE);
    this.header = new Int32Array(this.sab, 0, 2);
    this.outBytes = new Uint8Array(this.sab, 8);
    this.worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: {
        brokers: this.brokers,
        groupId: this.groupId,
        security: this.securityConfig(),
        offsetReset: kafkaOffsetReset(),
        sab: this.sab,
      },
    });
    // The worker must not keep the parent process alive by itself.
    this.worker.unref();
  }

  /** One synchronous request to the worker: post, block on Atomics.wait, read. */
  private request(req: Record<string, unknown>): Record<string, unknown> {
    this.ensureWorker();
    const header = this.header!;
    const outBytes = this.outBytes!;
    Atomics.store(header, 0, 0); // pending
    this.worker!.postMessage(req);
    const waited = Atomics.wait(header, 0, 0, KafkaBackend.CALL_TIMEOUT_MS);
    if (waited === "timed-out") {
      throw new Error(`Kafka ${String(req.op)} for topic ${String(req.topic ?? "")} timed out after ${KafkaBackend.CALL_TIMEOUT_MS}ms`);
    }
    const len = Atomics.load(header, 1);
    const json = Buffer.from(outBytes.buffer, outBytes.byteOffset, len).toString("utf-8");
    const res = JSON.parse(json) as Record<string, unknown>;
    if (res.ok === false) {
      throw new Error(String(res.error ?? "unknown Kafka worker error"));
    }
    return res;
  }

  /**
   * Serialize the record value. raw (tina4-nodejs#264) emits the payload exactly
   * as given — no {id, payload, status, attempts, ...} envelope — so a non-Tina4
   * consumer reading the topic gets the schema it expects; otherwise the Tina4
   * job envelope. pop() unwraps both shapes (payload ?? the whole record).
   */
  private static encodeJob(id: string, payload: unknown, raw: boolean): string {
    if (raw) return JSON.stringify(payload);
    return JSON.stringify({
      id,
      payload,
      status: "pending",
      createdAt: new Date().toISOString(),
      attempts: 0,
      delayUntil: null,
    });
  }

  push(queue: string, payload: unknown, _delay?: number, _priority?: number, raw: boolean = false): string {
    const id = randomUUID();
    const value = KafkaBackend.encodeJob(id, payload, raw);
    this.request({ op: "publish", topic: queue, value });
    return id;
  }

  pop(queue: string): QueueJob | null {
    const res = this.request({ op: "pop", topic: queue });
    const message = res.message as QueueJob | null;
    return message ?? null;
  }

  /**
   * Read the next record's value exactly as it sits on the wire — a Tina4
   * envelope as produced, a raw record (tina4-nodejs#264) as its bare bytes —
   * with no id/offset tracking. For a foreign consumer's view of the schema;
   * the queue facade consumes through pop(), which also normalises and tracks
   * the offset so complete()/fail() can commit it.
   */
  dequeue(queue: string): unknown {
    const res = this.request({ op: "dequeueRaw", topic: queue });
    return res.message ?? null;
  }

  /** Commit the record's offset so a completed job never replays (ADR-0022 d.4). */
  complete(queue: string, id: string): void {
    this.request({ op: "complete", topic: queue, id });
  }

  /**
   * Record a failed attempt: re-produce the job with an incremented attempts
   * count while it has retries left, else produce it to the dead-letter topic;
   * commit the original offset either way (ADR-0022 decision 2).
   */
  fail(queue: string, id: string, error: string, maxRetries: number, _retryBackoff?: number): void {
    this.request({ op: "fail", topic: queue, id, error, maxRetries });
  }

  /** Dead-letter the job now, no retry (ADR-0023 reject), then commit the offset. */
  reject(queue: string, id: string, reason: string, maxRetries: number): void {
    this.request({ op: "reject", topic: queue, id, reason, maxRetries });
  }

  /** Re-produce the job (manual retry) and commit the original offset. */
  retry(queue: string, id: string, delaySeconds?: number): boolean {
    this.request({ op: "retry", topic: queue, id, delaySeconds: delaySeconds ?? 0 });
    return true;
  }

  /** Read the dead-letter topic for this queue (every record on it is a dead letter). */
  deadLetters(queue: string, _maxRetries?: number): QueueJob[] {
    const res = this.request({ op: "deadLetters", topic: queue });
    return (res.deadLetters as QueueJob[]) ?? [];
  }

  /**
   * Refuse rather than silently answer from the local file store. Kafka keeps no
   * queryable registry of failed jobs: a failed record is re-produced to a
   * dead-letter TOPIC and the original offset committed past, and a log cannot be
   * queried by job state. Returning [] would claim nothing has failed.
   */
  failed(_queue: string, _maxRetries?: number): QueueJob[] {
    throw new Error(
      "The kafka queue backend cannot answer failed(): Kafka keeps no queryable " +
        "registry of failed or dead jobs. Consume the dead-letter topic directly " +
        "(deadLetters()), or use the file or mongodb backend.",
    );
  }

  /** Refuse for the same reason failed() does (no queryable failed registry). */
  retryFailed(_queue: string, _maxRetries?: number): number {
    throw new Error(
      "The kafka queue backend cannot perform retryFailed(): Kafka keeps no " +
        "queryable registry of failed or dead jobs. Consume the dead-letter topic " +
        "directly, or use the file or mongodb backend.",
    );
  }

  size(_queue: string): number {
    // Kafka has no queue-depth concept; computing one means an admin round-trip
    // per call. ADR-0022 decision 5 records 0 as the documented answer.
    return 0;
  }

  clear(_queue: string): void {
    throw new Error(
      "The kafka queue backend cannot perform clear(): Kafka has no notion of " +
        "job status and cannot delete records on demand. A log is read in " +
        "offset order and records leave only by retention. Use the file or " +
        "mongodb backend.",
    );
  }

  purge(_queue: string, _status?: string): number {
    throw new Error(
      "The kafka queue backend cannot perform purge(): Kafka has no notion of " +
        "job status to purge by. A log is read in offset order and records " +
        "leave only by retention. Use the file or mongodb backend.",
    );
  }

  /** Stop the worker and release the connection. Idempotent. */
  close(): void {
    if (!this.worker) return;
    try {
      this.request({ op: "close" });
    } catch {
      // best effort — we are tearing the worker down regardless
    }
    void this.worker.terminate();
    this.worker = null;
    this.sab = null;
    this.header = null;
    this.outBytes = null;
  }
}

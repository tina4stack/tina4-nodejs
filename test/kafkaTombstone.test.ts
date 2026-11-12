/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Live Kafka tombstone test — exercises the REAL broker (no mocks).
 * Run with: TINA4_TEST_KAFKA_URL=localhost:9092 npx tsx test/kafkaTombstone.test.ts
 *
 * A tombstone is a record with a NULL value (Debezium writes one after a row
 * delete; log-compacted topics use them as delete markers) — normal traffic
 * that carries no job payload. The consumer's wire decoder returned a bare null
 * for a null-value record — the SAME sentinel it returns for "nothing" — so
 * fetchNext() returned null WITHOUT advancing the read offset, and every later
 * pop() re-fetched the same tombstone offset for ever: nothing after a tombstone
 * was ever delivered, silently, with no error. The fix (parity with
 * tina4-php #357 / tina4-python #309) decodes only a batch's first record,
 * returns a tombstone as a value-null marker carrying its offset, and steps the
 * offset past it under a 1 s deadline.
 *
 * Tombstones cannot be produced through KafkaBackend.push (it always writes a
 * value), so they are produced with the broker's OWN console producer
 * (--property null.marker=TOMBSTONE), one `docker exec` run per batch — exactly
 * as tina4-php's KafkaIntegrationTest does. Gated on TINA4_TEST_KAFKA_URL; skips
 * cleanly (a pass with 0 assertions) when the broker/container is unavailable.
 * Under TINA4_REQUIRE_SERVICES the run-all gate turns a "Kafka ... not
 * reachable/not set" skip into a hard failure (CI provisions the broker).
 */
import net from "node:net";
import { execFileSync } from "node:child_process";
import { KafkaBackend } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
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

let lastTopicError = "";

function ensureTopic(container: string, broker: string, topic: string): boolean {
  lastTopicError = "";
  try {
    execFileSync(
      "docker",
      [
        "exec", container,
        "/opt/kafka/bin/kafka-topics.sh",
        "--bootstrap-server", broker,
        "--create", "--topic", topic,
        "--partitions", "1", "--replication-factor", "1", "--if-not-exists",
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }
    );
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string; signal?: string };
    const stderr = e.stderr ? String(e.stderr).trim().split("\n").slice(-2).join(" | ") : "";
    lastTopicError =
      e.code === "ENOENT" ? "the `docker` CLI is not on PATH"
      : e.signal ? `docker exec killed by ${e.signal} (the 30s timeout)`
      : `docker exec exited ${e.status ?? "?"}${stderr ? `: ${stderr}` : ""}`;
    return false;
  }
}

/**
 * Produce newline-separated `key,value` lines through the broker's console
 * producer in ONE run == ONE batch. A value equal to the null marker is written
 * as a real tombstone (null value), the record Debezium writes after a delete.
 * The client decodes only a batch's first record, so "own batch" (a separate
 * run) is what makes a tombstone the first record the consumer sees.
 */
function produceLines(container: string, broker: string, topic: string, lines: string): void {
  execFileSync(
    "docker",
    [
      "exec", "-i", container,
      "/opt/kafka/bin/kafka-console-producer.sh",
      "--bootstrap-server", broker,
      "--topic", topic,
      "--property", "parse.key=true",
      "--property", "key.separator=,",
      "--property", "null.marker=TOMBSTONE",
    ],
    { input: lines.endsWith("\n") ? lines : lines + "\n", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }
  );
}

function popN(backend: KafkaBackend, topic: string): number | null {
  const job = backend.pop(topic) as { payload?: { n?: number } } | null;
  if (job === null) return null;
  return job.payload?.n ?? null;
}

console.log("=== Kafka Tombstone Test ===\n");

const url = process.env.TINA4_TEST_KAFKA_URL ?? process.env.TINA4_KAFKA_BROKERS;
if (!url) {
  console.log(
    "  SKIP: set TINA4_TEST_KAFKA_URL (e.g. localhost:9092) to run the live Kafka tombstone test — Kafka broker not set."
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

function freshTopic(tag: string): string {
  return `t_node_tomb_${tag}_` + Math.random().toString(16).slice(2, 10);
}

// A probe produce proves the console producer + null.marker is usable in this
// container; if it is not, skip the whole file with a gate-recognised reason
// rather than report every case as a failure.
const probe = freshTopic("probe");
if (!ensureTopic(container, broker, probe)) {
  console.log(
    `  SKIP: could not create Kafka topic via the broker admin tool in container "${container}" (${lastTopicError}) — Kafka topic setup not available.`
  );
  summarise();
}
try {
  produceLines(container, broker, probe, "k,{\"probe\":1}");
} catch (err) {
  console.log(`  SKIP: the broker console producer is not usable in container "${container}" (${String(err)}) — Kafka tombstone setup not available.`);
  summarise();
}

// ── Case 1: a tombstone is stepped over and the record after it is delivered ──
// Pre-fix the fetch answered a null value with "nothing" and never moved the
// offset, so pop() re-fetched the tombstone for ever and n:2 was never seen.
try {
  const topic = freshTopic("step");
  ensureTopic(container, broker, topic);
  produceLines(container, broker, topic, "k1,{\"n\":1}");   // own batch -> offset 0
  produceLines(container, broker, topic, "k1,TOMBSTONE");    // own batch -> offset 1 (null value)
  produceLines(container, broker, topic, "k2,{\"n\":2}");    // own batch -> offset 2

  const backend = new KafkaBackend({ brokers: broker });
  const got: Array<number | null> = [];
  for (let i = 0; i < 5; i++) {
    const n = popN(backend, topic);
    if (n === null) break;
    got.push(n);
  }
  assert(
    "a tombstone is stepped over and the next record is delivered (got [1,2])",
    JSON.stringify(got) === JSON.stringify([1, 2]),
    `got ${JSON.stringify(got)} (pre-fix: [1] — the consumer stalled at the tombstone)`
  );
} catch (err) {
  assert("case 1 ran without throwing", false, String(err));
}

// ── Case 2: a tombstone that cannot be stepped over does not spin ────────────
// A tombstone batched AHEAD of a record: the broker returns the whole batch and
// the client decodes only its first record, so the tombstone comes back at an
// offset already passed. The anti-spin guard (nextOffset <= offset) must stop at
// once (null) rather than re-fetch the same offset until the deadline. The
// record after it is NOT delivered by this client — the separate first-record
// batch-decoding limit, the same as php/python.
try {
  const topic = freshTopic("spin");
  ensureTopic(container, broker, topic);
  produceLines(container, broker, topic, "k1,TOMBSTONE\nk2,{\"n\":1}"); // ONE batch: tombstone@0, record@1

  const backend = new KafkaBackend({ brokers: broker });
  const t0 = Date.now();
  const n = popN(backend, topic);
  const dt = Date.now() - t0;
  assert(
    "a non-steppable tombstone returns null (not the shadowed record)",
    n === null,
    `got ${JSON.stringify(n)}`
  );
  assert(
    "the anti-spin guard returns fast (< 500ms), not after the 1s deadline",
    dt < 500,
    `took ${dt}ms (without the nextOffset<=offset guard this spins to the ~1s deadline)`
  );
} catch (err) {
  assert("case 2 ran without throwing", false, String(err));
}

// ── Case 3: trailing tombstones end the topic within the deadline ────────────
// A real record, then only tombstones: pop() consumes the record, then the next
// pop() steps past every trailing tombstone and returns null WITHIN the deadline
// — it must not hang, and must not re-fetch the tombstones for ever.
try {
  const topic = freshTopic("tail");
  ensureTopic(container, broker, topic);
  produceLines(container, broker, topic, "k1,{\"n\":1}");  // offset 0: real
  produceLines(container, broker, topic, "k1,TOMBSTONE");   // offset 1
  produceLines(container, broker, topic, "k1,TOMBSTONE");   // offset 2
  produceLines(container, broker, topic, "k1,TOMBSTONE");   // offset 3

  const backend = new KafkaBackend({ brokers: broker });
  assert("case 3: the real record is delivered first", popN(backend, topic) === 1);
  const t0 = Date.now();
  const n = popN(backend, topic);
  const dt = Date.now() - t0;
  assert(
    "trailing tombstones yield null (the topic is exhausted past them)",
    n === null,
    `got ${JSON.stringify(n)}`
  );
  assert(
    "it returns within the deadline (< 1600ms), bounded by the maxWait cap",
    dt < 1600,
    `took ${dt}ms (without the shrinking-maxWait deadline the terminal fetch long-polls the full 5s)`
  );
} catch (err) {
  assert("case 3 ran without throwing", false, String(err));
}

summarise();

/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Live Kafka durable-offset test (no mocks) — ADR-0022 decisions 2/3/4 and the
 * tina4#274 family, driven through the Queue FACADE (backend "kafka", which is
 * no longer refused — it now holds a persistent worker connection).
 *
 * Proves the consumer commits consumer-group offsets so that:
 *   - a completed job is NEVER re-delivered after a restart (decision 4);
 *   - a job popped but NOT acknowledged IS re-delivered after a restart (the
 *     negative control — proving it is the durable COMMIT, not an in-memory
 *     cursor or an empty topic, that suppresses the replay);
 *   - an externally-produced record (raw, no Tina4 envelope, no id — the
 *     Debezium/CDC case) is consumable through the facade AND commits durably,
 *     its payload delivered byte-for-byte.
 *
 * A fresh Queue (a fresh worker + socket) per "restart" stands in for a new
 * process: the read cursor resets, but the committed offset lives on the broker,
 * so resume is real. Gated on TINA4_TEST_KAFKA_URL; skips with a reason the
 * TINA4_REQUIRE_SERVICES gate recognises ("Kafka ... not set / not reachable").
 */
import net from "node:net";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Queue } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}
function summarise(): never {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m\n`);
  process.exit(fail > 0 ? 1 : 0);
}
function reachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}
function createTopic(container: string, broker: string, topic: string): boolean {
  try {
    execFileSync("docker", ["exec", container, "/opt/kafka/bin/kafka-topics.sh",
      "--bootstrap-server", broker, "--create", "--topic", topic,
      "--partitions", "1", "--replication-factor", "1", "--if-not-exists"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
    return true;
  } catch { return false; }
}

console.log("=== Kafka Durable Offset Test ===\n");

const url = process.env.TINA4_TEST_KAFKA_URL ?? process.env.TINA4_KAFKA_BROKERS;
if (!url) {
  console.log("  SKIP: set TINA4_TEST_KAFKA_URL (e.g. localhost:9092) — Kafka broker not set.");
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
process.env.TINA4_KAFKA_BROKERS = broker;

/** A fresh queue in a given group/topic (a fresh worker + socket = a "restart"). */
function queueIn(group: string, topic: string): Queue {
  process.env.TINA4_KAFKA_GROUP_ID = group;
  return new Queue({ backend: "kafka", topic });
}
function popWait(q: Queue, tries = 40): any {
  for (let i = 0; i < tries; i++) { const j = q.pop(); if (j !== null) return j; }
  return null;
}

// ── 1. A completed job never replays across a restart (decision 4) ──
{
  const suffix = randomBytes(5).toString("hex");
  const topic = `t_durable_${suffix}`;
  const group = `g_durable_${suffix}`;
  if (!createTopic(container, broker, topic)) {
    console.log("  SKIP: could not create the test topic via docker exec.");
  } else {
    const producer = queueIn(group, topic);
    for (let i = 1; i <= 3; i++) producer.push({ n: i, nonce: randomBytes(3).toString("hex") });
    producer.close();

    const consumer = queueIn(group, topic);
    let completed = 0;
    for (let i = 0; i < 3; i++) {
      const job: any = popWait(consumer);
      if (job) { job.complete(); completed++; }
    }
    consumer.close();
    assert("all three jobs consumed + completed", completed === 3, `completed ${completed}`);

    const afterRestart = queueIn(group, topic);
    const replay = popWait(afterRestart, 6);
    afterRestart.close();
    assert("a completed job does NOT replay after a restart (offset committed)",
      replay === null, JSON.stringify(replay));
  }
}

// ── 2. An un-acknowledged job DOES replay (negative control) ──
{
  const suffix = randomBytes(5).toString("hex");
  const topic = `t_unacked_${suffix}`;
  const group = `g_unacked_${suffix}`;
  if (createTopic(container, broker, topic)) {
    const nonce = randomBytes(6).toString("hex");
    const p = queueIn(group, topic); p.push({ keep: true, nonce }); p.close();

    const first = queueIn(group, topic);
    const job: any = popWait(first);
    first.close(); // never completed — no commit
    assert("the record is consumable", job !== null && job.payload?.nonce === nonce, JSON.stringify(job));

    const second = queueIn(group, topic);
    const again: any = popWait(second);
    second.close();
    assert("an un-acknowledged record replays after a restart",
      again !== null && again.payload?.nonce === nonce, JSON.stringify(again));
  } else {
    console.log("  SKIP: could not create the unacked test topic via docker exec.");
  }
}

// ── 3. An external (raw) record is consumable AND commits durably (#274) ──
{
  const suffix = randomBytes(5).toString("hex");
  const topic = `t_external_${suffix}`;
  const group = `g_external_${suffix}`;
  if (createTopic(container, broker, topic)) {
    const external = { source: "debezium", op: "c", row: { id: 42, name: "ext" } };
    const p = queueIn(group, topic); p.push(external, 0, 0, true); p.close(); // raw=true

    const consumer = queueIn(group, topic);
    const job: any = popWait(consumer);
    assert("an external record is consumable through the facade (not a crash)", job !== null, "null");
    assert("the external payload is delivered byte-for-byte (no envelope leak)",
      job !== null && JSON.stringify(job.payload) === JSON.stringify(external), JSON.stringify(job?.payload));
    assert("an id-less external record takes its topic:partition:offset coordinate as its id",
      job !== null && String(job.id).includes(`${topic}:0:`), String(job?.id));
    if (job) job.complete();
    consumer.close();

    const afterRestart = queueIn(group, topic);
    const replay = popWait(afterRestart, 6);
    afterRestart.close();
    assert("the completed external record does not replay after a restart",
      replay === null, JSON.stringify(replay));
  } else {
    console.log("  SKIP: could not create the external test topic via docker exec.");
  }
}

summarise();

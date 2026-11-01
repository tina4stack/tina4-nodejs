/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Kafka consumer offset-reset override (tina4-nodejs#263) and the raw producer
 * refusal on non-Kafka backends (tina4-nodejs#264). Pure/offline — no broker, so
 * this runs in every job. The live raw round-trip proving a raw produce carries
 * no envelope is in kafkaIntegration.test.ts (gated on a real broker).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue, kafkaOffsetReset } from "../packages/core/src/index.ts";

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

console.log("=== Kafka offset-reset + raw producer (offline) ===\n");

// ── #263: auto.offset.reset resolution (pure, env passed explicitly) ─────────
assert("offset reset defaults to earliest", kafkaOffsetReset({}) === "earliest");
assert(
  "offset reset honours TINA4_KAFKA_AUTO_OFFSET_RESET",
  kafkaOffsetReset({ TINA4_KAFKA_AUTO_OFFSET_RESET: "latest" }) === "latest"
);
assert(
  "offset reset falls back to bare KAFKA_AUTO_OFFSET_RESET",
  kafkaOffsetReset({ KAFKA_AUTO_OFFSET_RESET: "latest" }) === "latest"
);
assert(
  "TINA4_ wins over the bare KAFKA_ name",
  kafkaOffsetReset({ TINA4_KAFKA_AUTO_OFFSET_RESET: "latest", KAFKA_AUTO_OFFSET_RESET: "earliest" }) === "latest"
);
assert(
  "a blank value falls through to the default",
  kafkaOffsetReset({ TINA4_KAFKA_AUTO_OFFSET_RESET: "" }) === "earliest"
);

// ── #264: raw is Kafka-only — the file backend refuses by name ───────────────
const dir = mkdtempSync(join(tmpdir(), "tina4-raw-"));
process.env.TINA4_QUEUE_PATH = dir;
try {
  const refuseQueue = new Queue({ topic: "tina4_raw_refusal", backend: "file" });
  let threw = "";
  try {
    refuseQueue.push({ event: "x" }, undefined, 0, true);
  } catch (err) {
    threw = String((err as Error).message);
  }
  assert("file backend refuses push(raw=true)", threw.includes("file queue backend") && threw.includes("raw=true"), threw);

  // Positive control: the default raw=false path is unchanged.
  const okQueue = new Queue({ topic: "tina4_raw_default", backend: "file" });
  const id = okQueue.push({ event: "x" });
  assert("default push still returns an id", typeof id === "string" && id.length > 0, id);
  const job = okQueue.pop();
  assert(
    "default push round-trips the payload",
    job !== null && JSON.stringify((job as any).payload) === JSON.stringify({ event: "x" }),
    JSON.stringify(job)
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

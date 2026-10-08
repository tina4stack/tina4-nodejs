/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Regression for tina4-nodejs#278: the SMTP send timeout is configurable.
 *
 * No mocks. A REAL TCP server accepts the connection and then says nothing, so
 * send() blocks waiting for the SMTP greeting. With the timeout left at its 30 s
 * default that is a 30 s hold; with a 1 s timeout the send must fail in about a
 * second. The wall-clock is the instrument: a configured 1 s timeout that is
 * honoured finishes well under the default, a hardcoded 30 s does not.
 *
 * Parity with Python (tina4-python#203), PHP (tina4-php#282) and Ruby
 * (tina4-ruby#110).
 *
 * Run with: npx tsx test/messengerTimeout278.test.ts
 */

import net from "node:net";
import { Messenger } from "../packages/core/src/index.ts";

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

/** A server that accepts TCP connections and never sends a byte. */
function silentSmtpServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const held: net.Socket[] = [];
    const server = net.createServer((socket) => {
      held.push(socket); // keep it open, never reply
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => {
          for (const s of held) s.destroy();
          server.close();
        },
      });
    });
  });
}

async function timeSend(port: number, opts: Record<string, unknown> = {}): Promise<number> {
  const messenger = new Messenger({ host: "127.0.0.1", port, encryption: "none", fromAddress: "app@localhost", ...opts });
  const start = process.hrtime.bigint();
  const result = await messenger.send("someone@localhost", "test", "hello");
  const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
  // The host never speaks SMTP, so the send always fails — what matters is HOW
  // LONG it waited.
  assert("send fails (host never speaks SMTP)", result.success === false);
  return elapsed;
}

async function main(): Promise<void> {
  console.log("\nMessenger SMTP timeout (#278)\n");

  // Default is 30 s when nothing is configured.
  assert("default timeout is 30 s", new Messenger({ host: "127.0.0.1", encryption: "none" }).timeoutMs === 30_000);

  // A non-numeric env value falls back to 30 s, never NaN/0.
  process.env.TINA4_MAIL_TIMEOUT = "not-a-number";
  assert(
    "bad TINA4_MAIL_TIMEOUT falls back to 30 s",
    new Messenger({ host: "127.0.0.1", encryption: "none" }).timeoutMs === 30_000,
  );
  delete process.env.TINA4_MAIL_TIMEOUT;

  // A constructor timeout of 1 s is honoured (ms).
  assert("constructor timeout: 1 → 1000ms", new Messenger({ host: "127.0.0.1", encryption: "none", timeout: 1 }).timeoutMs === 1000);

  const { port, close } = await silentSmtpServer();
  try {
    const byCtor = await timeSend(port, { timeout: 1 });
    assert("constructor timeout bounds the send (<8s)", byCtor < 8, `took ${byCtor.toFixed(1)}s`);

    process.env.TINA4_MAIL_TIMEOUT = "1";
    try {
      const byEnv = await timeSend(port);
      assert("TINA4_MAIL_TIMEOUT bounds the send (<8s)", byEnv < 8, `took ${byEnv.toFixed(1)}s`);
    } finally {
      delete process.env.TINA4_MAIL_TIMEOUT;
    }
  } finally {
    close();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();

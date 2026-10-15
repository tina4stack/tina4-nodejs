/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

// #229 parity: the S3 client fails loud on missing credentials, retries a
// transient failure (429 / any 5xx / a dropped connection) twice at most
// honouring Retry-After, does NOT retry a final 4xx, and keeps an endpoint's
// path prefix in front of every request. Proven against a REAL local HTTP
// server that records what the client sends and answers with chosen statuses -
// nothing in the client is replaced (no mocks). Mirrors the Python master's
// tests/test_s3_client.py.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { S3Client, S3ConfigError, S3Error } from "../packages/orm/src/realtime/s3Client.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

interface Seen { method: string; url: string; }
interface Recording {
  seen: Seen[];
  statuses: Array<number | "drop">;
  port: number;
  close: () => Promise<void>;
}

// A real server. Each request pops the next entry from `statuses`: a number is
// answered with that code (a Retry-After on 429/503), "drop" destroys the socket
// mid-request (a dropped connection). An exhausted list answers 200.
async function recordingServer(): Promise<Recording> {
  const rec: Recording = { seen: [], statuses: [], port: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    rec.seen.push({ method: req.method ?? "", url: req.url ?? "" });
    req.on("data", () => {});
    req.on("end", () => {
      const next = rec.statuses.shift();
      if (next === "drop") { req.socket.destroy(); return; }
      const status = typeof next === "number" ? next : 200;
      const headers: Record<string, string> = {};
      if (status === 429 || status === 503) headers["retry-after"] = "0";
      res.writeHead(status, headers);
      res.end(status >= 200 && status < 300 ? "ok" : "err");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rec.port = (server.address() as AddressInfo).port;
  rec.close = () => new Promise<void>((r) => server.close(() => r()));
  return rec;
}

const client = (rec: Recording, extra: Partial<{ endpoint: string }> = {}) =>
  new S3Client({
    endpoint: extra.endpoint ?? `http://127.0.0.1:${rec.port}`,
    accessKey: "AKID", secretKey: "SECRET", region: "us-east-1", timeout: 5000,
  });

async function main(): Promise<void> {
  console.log("=== S3 client: fail-loud + retries + endpoint path (#229 parity) ===\n");

  // --- missing credentials: raise S3ConfigError, send nothing ---
  {
    const rec = await recordingServer();
    const c = new S3Client({ endpoint: `http://127.0.0.1:${rec.port}`, accessKey: "", secretKey: "" });
    let threw = false;
    try { await c.putObject("b", "k", Buffer.from("x")); }
    catch (e) { threw = e instanceof S3ConfigError; }
    assert("missing credentials raise S3ConfigError and send nothing", threw && rec.seen.length === 0,
      `threw=${threw} sent=${rec.seen.length}`);

    // half a credential is refused too
    let halfA = false, halfB = false;
    try { await new S3Client({ endpoint: `http://127.0.0.1:${rec.port}`, accessKey: "", secretKey: "S" }).putObject("b", "k", Buffer.from("x")); } catch (e) { halfA = e instanceof S3ConfigError; }
    try { await new S3Client({ endpoint: `http://127.0.0.1:${rec.port}`, accessKey: "A", secretKey: "" }).putObject("b", "k", Buffer.from("x")); } catch (e) { halfB = e instanceof S3ConfigError; }
    assert("half a credential is refused too", halfA && halfB, `a=${halfA} b=${halfB}`);
    await rec.close();
  }

  // --- a transient failure is sent again ---
  for (const transient of [429, 500, 502, 503, 504, "drop"] as Array<number | "drop">) {
    const rec = await recordingServer();
    rec.statuses = [transient, 200];
    await client(rec).putObject("bucket", "key", Buffer.from("x"));
    assert(`a transient ${transient} is retried then succeeds`, rec.seen.length === 2, `attempts=${rec.seen.length}`);
    await rec.close();
  }

  // --- gives up after two retries (3 attempts) ---
  {
    const rec = await recordingServer();
    rec.statuses = [503, 503, 503, 503];
    let status = 0;
    try { await client(rec).putObject("bucket", "key", Buffer.from("x")); }
    catch (e) { if (e instanceof S3Error) status = e.status; }
    assert("gives up after two retries (503)", status === 503 && rec.seen.length === 3, `status=${status} attempts=${rec.seen.length}`);
    await rec.close();
  }

  // --- a final 4xx is not retried ---
  for (const code of [400, 403, 404]) {
    const rec = await recordingServer();
    rec.statuses = [code, 200];
    let status = 0;
    try { await client(rec).getObject("bucket", "key"); }
    catch (e) { if (e instanceof S3Error) status = e.status; }
    assert(`a final ${code} is not retried`, status === code && rec.seen.length === 1, `status=${status} attempts=${rec.seen.length}`);
    await rec.close();
  }

  // --- an endpoint behind a path keeps it in front of every request ---
  {
    const rec = await recordingServer();
    rec.statuses = [200];
    await client(rec, { endpoint: `http://127.0.0.1:${rec.port}/s3pfx` }).putObject("bucket", "obj.png", Buffer.from("x"));
    assert("an endpoint path prefix is kept in front of the request path",
      rec.seen[0]?.url === "/s3pfx/bucket/obj.png", `url=${rec.seen[0]?.url}`);
    // presigned URL carries the prefix too
    const url = client(rec, { endpoint: `http://127.0.0.1:${rec.port}/s3pfx` }).presignedGetUrl("bucket", "obj.png");
    assert("presigned URL carries the endpoint path prefix", url.includes(`:${rec.port}/s3pfx/bucket/obj.png?`), url);
    await rec.close();
  }

  console.log(`\n${"=".repeat(50)}\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m\n${"=".repeat(50)}`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();

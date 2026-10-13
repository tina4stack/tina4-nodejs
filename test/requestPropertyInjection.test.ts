/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A request-supplied name can never inject a dangerous property onto the
 * query, cookie or file bags (js/remote-property-injection).
 *
 * The parser filters __proto__ / constructor / prototype out of every
 * user-keyed bag (isUnsafeFieldName) and writes the kept keys reflectively.
 * These bags hold arbitrary user keys by design, so the property that must
 * hold is: a crafted name is DROPPED, a legitimate name lands, and no
 * prototype is polluted.
 *
 * Mutation proof (why this is a real gate, not a tautology): `constructor` is
 * a DATA property on Object.prototype, so with the isUnsafeFieldName guard
 * removed, `?constructor=evil` would create an own `constructor` key on the
 * bag and `bag.constructor === "evil"` would be true. The native-constructor
 * assertions below go red the moment that guard is dropped.
 *
 * No mocks: real IncomingMessage bodies/headers through createRequest().
 * Run with: npx tsx test/requestPropertyInjection.test.ts
 */
import { createRequest } from "../packages/core/src/index.ts";
import type { Tina4Request } from "../packages/core/src/index.ts";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const BOUNDARY = "----Tina4PropInjection";

function make(url: string, headers: Record<string, string> = {}, body?: string): Tina4Request {
  const req = new IncomingMessage(new Socket()) as Tina4Request;
  req.url = url;
  req.method = body === undefined ? "GET" : "POST";
  req.headers = { host: "localhost:3000", ...headers };
  if (body !== undefined) { req.push(Buffer.from(body)); req.push(null); }
  return createRequest(req);
}

console.log("=== Request property injection ===\n");

// A clean Object.prototype before and after every case.
const protoClean = () => (Object.prototype as any).polluted === undefined
  && (Object.prototype as any).evil === undefined;

// ── query string ────────────────────────────────────────────────────────
{
  const q = make("/?__proto__=x&constructor=evil&prototype=z&name=Ann&tags=a").query as Record<string, string>;
  assert("query: __proto__ / constructor / prototype are dropped",
    !Object.keys(q).includes("__proto__") && !Object.keys(q).includes("constructor")
    && !Object.keys(q).includes("prototype"), `got ${JSON.stringify(q)}`);
  assert("query: a crafted constructor does not become the value (guard gate)",
    (q as any).constructor !== "evil" && typeof (q as any).constructor === "function");
  assert("query: a legitimate key still lands", q.name === "Ann" && q.tags === "a");
  assert("query: no prototype polluted", protoClean());
}

// ── cookies ─────────────────────────────────────────────────────────────
{
  const c = make("/", { cookie: "__proto__=x; constructor=evil; sid=abc123" }).cookies as Record<string, string>;
  assert("cookies: __proto__ / constructor are dropped",
    !Object.keys(c).includes("__proto__") && !Object.keys(c).includes("constructor"),
    `got ${JSON.stringify(c)}`);
  assert("cookies: a crafted constructor does not become the value (guard gate)",
    (c as any).constructor !== "evil" && typeof (c as any).constructor === "function");
  assert("cookies: a legitimate cookie still lands", c.sid === "abc123");
  assert("cookies: no prototype polluted", protoClean());
}

// ── multipart file fields ─────────────────────────────────────────────────
{
  const body =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="__proto__"; filename="a.txt"\r\n`
    + `Content-Type: application/octet-stream\r\n\r\nAAAA\r\n`
    + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="constructor"; filename="b.txt"\r\n`
    + `Content-Type: application/octet-stream\r\n\r\nBBBB\r\n`
    + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="avatar"; filename="me.png"\r\n`
    + `Content-Type: application/octet-stream\r\n\r\nCCCC\r\n`
    + `--${BOUNDARY}--\r\n`;
  const request = make("/upload", { "content-type": `multipart/form-data; boundary=${BOUNDARY}` }, body);
  await request.parseBody();
  const files = request.files as Record<string, any>;
  assert("files: __proto__ / constructor file fields are dropped",
    !Object.keys(files).includes("__proto__") && !Object.keys(files).includes("constructor"),
    `got ${Object.keys(files)}`);
  assert("files: a crafted constructor field does not become a file (guard gate)",
    typeof (files as any).constructor === "function");
  assert("files: a legitimate file field still lands",
    files.avatar?.content?.toString() === "CCCC");
  assert("files: no prototype polluted", protoClean());
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

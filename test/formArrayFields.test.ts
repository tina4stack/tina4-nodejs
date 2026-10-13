/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A bracketed form field (`tags[]`, `user[name]`) arrives nested, however the
 * form was sent.
 *
 * A multi-select or checkbox group posts `tags[]` once per ticked value. Both
 * the multipart and the urlencoded parser stored each field under its raw
 * name, so `tags[]=red` then `tags[]=blue` arrived as `{"tags[]": "blue"}` -
 * the first value gone. Both now nest the way PHP and tina4-ruby do:
 * `{"tags": ["red", "blue"]}`. The query string is left flat (AutoCrud reads
 * `filter[...]` keys from it).
 *
 * No mocks: real multipart and urlencoded bodies through createRequest().parseBody().
 * Run with: npx tsx test/formArrayFields.test.ts
 */
import { createRequest } from "../packages/core/src/index.ts";
import type { Tina4Request } from "../packages/core/src/index.ts";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";

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

const BOUNDARY = "----Tina4FormArrayFields";

async function post(body: string, contentType: string, url = "/form"): Promise<Tina4Request> {
  const req = new IncomingMessage(new Socket()) as Tina4Request;
  req.url = url;
  req.method = "POST";
  req.headers = { host: "localhost:3000", "content-type": contentType };
  req.push(Buffer.from(body));
  req.push(null);
  const request = createRequest(req);
  await request.parseBody();
  return request;
}

function multipart(pairs: Array<[string, string]>, files: Array<[string, string, string]> = []) {
  let body = "";
  for (const [name, value] of pairs) {
    body += `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  for (const [name, filename, content] of files) {
    body += `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
      + `Content-Type: application/octet-stream\r\n\r\n${content}\r\n`;
  }
  return post(`${body}--${BOUNDARY}--\r\n`, `multipart/form-data; boundary=${BOUNDARY}`);
}

function urlencoded(pairs: Array<[string, string]>) {
  return post(new URLSearchParams(pairs).toString(), "application/x-www-form-urlencoded");
}

function same(name: string, actual: unknown, expected: unknown) {
  assert(name, isDeepStrictEqual(actual, expected), `got ${JSON.stringify(actual)}`);
}

console.log("=== Bracketed form fields ===\n");

const forms: Record<string, [Array<[string, string]>, unknown]> = {
  "a checkbox group": [[["tags[]", "red"], ["tags[]", "blue"]], { tags: ["red", "blue"] }],
  "one ticked box": [[["tags[]", "red"]], { tags: ["red"] }],
  "a nested field": [[["user[name]", "Ann"], ["user[roles][]", "admin"]],
    { user: { name: "Ann", roles: ["admin"] } }],
  "a list of records": [[["rows[][id]", "1"], ["rows[][id]", "2"], ["rows[][qty]", "5"]],
    { rows: [{ id: "1" }, { id: "2", qty: "5" }] }],
  "a repeated plain name": [[["p", "1"], ["p", "2"]], { p: "2" }],
  "plain fields alongside": [[["name", "x"], ["tags[]", "red"]], { name: "x", tags: ["red"] }],
};

for (const [form, [pairs, expected]] of Object.entries(forms)) {
  same(`multipart nests ${form}`, (await multipart(pairs)).body, expected);
  same(`urlencoded nests ${form}`, (await urlencoded(pairs)).body, expected);
}

for (const send of [multipart, urlencoded]) {
  same(`${send.name}: a conflicting field keeps its flat key and the rest still nest`,
    (await send([["a", "1"], ["a[b]", "2"], ["tags[]", "red"]])).body, { a: "1", "a[b]": "2", tags: ["red"] });
  const many: Array<[string, string]> = Array.from({ length: 4097 }, (_, i) => ["x[][k]", String(i)]);
  same(`${send.name}: a form past the field limit keeps flat keys`, (await send(many)).body, { "x[][k]": "4096" });
  same(`${send.name}: a list after a plain value of that name keeps flat keys`,
    (await send([["a", "1"], ["a[]", "2"]])).body, { a: "1", "a[]": "2" });
  const long = "a[k][" + "x".repeat(2000) + "]";
  same(`${send.name}: a name past the length limit keeps its flat key`,
    (await send([[long, "v"], ["t[]", "1"]])).body, { [long]: "v", t: ["1"] });
  const deep = "x" + "[k]".repeat(40);
  same(`${send.name}: nesting past the depth limit keeps flat keys`,
    (await send([[deep, "v"]])).body, { [deep]: "v" });
  const polluted = (await send([["__proto__[polluted]", "yes"], ["constructor[prototype][polluted]", "yes"], ["a[]__proto__", "x"], ["b[c]__proto__", "x"], ["ok", "1"]])).body as any;
  assert(`${send.name}: a __proto__ or constructor name pollutes no prototype`,
    ({} as any).polluted === undefined && Object.getPrototypeOf(polluted) === Object.prototype && polluted.ok === "1"
      && polluted.a === undefined && polluted.b === undefined,
    `got ${JSON.stringify(polluted)}`);
}

for (const send of [multipart, urlencoded]) {
  same(`${send.name}: a name Object already carries (toString, constructor) nests like any other`,
    (await send([["toString[]", "a"], ["constructor[name]", "b"], ["tags[]", "c"]])).body,
    { toString: ["a"], constructor: { name: "b" }, tags: ["c"] });
}

const withFile = await multipart([["tags[]", "red"], ["tags[]", "blue"]], [["photo", "a.txt", "AAAA"]]);
same("files still arrive beside nested fields", withFile.body, { tags: ["red", "blue"] });
assert("the file is still a file", (withFile.files as any).photo?.content?.toString() === "AAAA");

const query = await post("", "application/x-www-form-urlencoded", "/form?filter%5Bname%5D=Ann&tags%5B%5D=a&tags%5B%5D=b");
same("the query string stays flat", query.query, { "filter[name]": "Ann", "tags[]": "b" });

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

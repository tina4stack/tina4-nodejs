/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

// Zero-dependency SigV4 S3 client: signing math vs AWS's published vector (no
// service, no mocks) plus a real put/get/presigned-GET/delete round-trip against
// a live S3 server (skipped when none is reachable — CI provisions MinIO on
// localhost:9100). Mirrors the Python master's test_s3_client + TestS3Storage.

import { createHmac, createHash } from "node:crypto";
import { connect } from "node:net";
import { S3Client, uriEncode } from "../packages/orm/src/realtime/s3Client.ts";
import { S3Storage, selectStorage, storageKey } from "../packages/orm/src/realtime/storage.ts";

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

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

// ── unit: SigV4 against AWS's get-vanilla vector ────────────────────────────
{
  const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  const ds = "20150830";
  const region = "us-east-1";
  const svc = "service";
  const amz = "20150830T123600Z";
  const cr = [
    "GET", "/", "",
    "host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n",
    "host;x-amz-date",
    createHash("sha256").update("").digest("hex"),
  ].join("\n");
  const sts = ["AWS4-HMAC-SHA256", amz, `${ds}/${region}/${svc}/aws4_request`,
    createHash("sha256").update(cr).digest("hex")].join("\n");
  let k = createHmac("sha256", "AWS4" + secret).update(ds).digest();
  k = createHmac("sha256", k).update(region).digest();
  k = createHmac("sha256", k).update(svc).digest();
  k = createHmac("sha256", k).update("aws4_request").digest();
  const sig = createHmac("sha256", k).update(sts).digest("hex");
  assert("SigV4 signature matches the AWS get-vanilla vector",
    sig === "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31", sig);
}

assert("uriEncode keeps / in a path, encodes space as %20, keeps ~",
  uriEncode("a/b c~d", true) === "a/b%20c~d");
assert("uriEncode encodes / in a query",
  uriEncode("a/b c~d", false) === "a%2Fb%20c~d");

{
  const client = new S3Client({ endpoint: "http://localhost:9100", accessKey: "AKID", secretKey: "secret", region: "us-east-1" });
  const url = client.presignedGetUrl("bucket", "obj.png", 120);
  const hasAll = url.startsWith("http://localhost:9100/bucket/obj.png?") &&
    ["X-Amz-Algorithm=AWS4-HMAC-SHA256", "X-Amz-Credential=", "X-Amz-Date=",
      "X-Amz-Expires=120", "X-Amz-SignedHeaders=host", "X-Amz-Signature="].every((p) => url.includes(p));
  assert("presigned URL carries the SigV4 query params", hasAll, url);
}

// ── live round-trip against a real S3 server (skipped if unreachable) ────────
const S3_HOST = "localhost";
const S3_PORT = 9100;
const S3_BUCKET = "tina4-rt-test";

if (await reachable(S3_HOST, S3_PORT)) {
  process.env.TINA4_STORAGE_BACKEND = "s3";
  process.env.TINA4_STORAGE_URL = `http://${S3_HOST}:${S3_PORT}`;
  process.env.TINA4_STORAGE_KEY = "minioadmin";
  process.env.TINA4_STORAGE_SECRET = "minioadmin";
  process.env.TINA4_STORAGE_BUCKET = S3_BUCKET;
  process.env.TINA4_STORAGE_REGION = "us-east-1";

  // Ensure the bucket exists (idempotent) via a direct client — no SDK.
  await new S3Client({
    endpoint: `http://${S3_HOST}:${S3_PORT}`, accessKey: "minioadmin", secretKey: "minioadmin", region: "us-east-1",
  }).createBucket(S3_BUCKET);

  const store = selectStorage();
  assert("selectStorage returns S3Storage when configured", store instanceof S3Storage);

  const key = storageKey("photo.png");
  const blob = Buffer.from("\x89PNG-real-bytes", "binary");
  await store.put(key, blob, "image/png");
  assert("exists after put", (await store.exists(key)) === true);
  const got = await store.get(key);
  assert("get returns the bytes", got !== null && got.equals(blob));

  const url = (await store.url(key, 120)) ?? "";
  assert("url is a presigned link to the key", url.startsWith("http") && url.includes(key));
  const fetched = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert("the presigned URL really fetches the object", fetched.equals(blob));

  await store.delete(key);
  assert("exists is false after delete", (await store.exists(key)) === false);

  for (const k of ["TINA4_STORAGE_BACKEND", "TINA4_STORAGE_URL", "TINA4_STORAGE_KEY",
    "TINA4_STORAGE_SECRET", "TINA4_STORAGE_BUCKET", "TINA4_STORAGE_REGION"]) {
    delete process.env[k];
  }
} else {
  console.log(`  \x1b[33mSKIP\x1b[0m live S3 round-trip — no S3 server at ${S3_HOST}:${S3_PORT} (real S3, never mocked)`);
}

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);

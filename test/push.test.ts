/** Web Push contract tests against a real local HTTP endpoint. */
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Push, PushError, generateVapidKeys } from "../packages/core/src/index.ts";
import type { PushSubscription } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` ${detail}` : ""}`);
    fail++;
  }
}

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    assert(name, await fn());
  } catch (error) {
    assert(name, false, `(${error instanceof Error ? error.message : String(error)})`);
  }
}

function b64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hmac(key: Buffer, value: Buffer): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hkdf(prk: Buffer, info: Buffer, length: number): Buffer {
  const chunks: Buffer[] = [];
  let previous: Buffer = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(chunks).length < length; i++) {
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([i])]));
    chunks.push(previous);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function decrypt(body: Buffer, client: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyIdLength = body[20];
  const serverPublic = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);
  if (recordSize !== 4096 || keyIdLength !== 65) throw new Error("invalid aes128gcm header");
  const clientPublic = client.getPublicKey(undefined, "uncompressed");
  const shared = client.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), clientPublic, serverPublic]);
  const ikm = hkdf(hmac(auth, shared), keyInfo, 32);
  const prk = hmac(salt, ikm);
  const cek = hkdf(prk, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16);
  const nonce = hkdf(prk, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  if (plaintext[plaintext.length - 1] !== 0x02) throw new Error("missing aes128gcm delimiter");
  return plaintext.subarray(0, -1);
}

function readRequest(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

console.log("=== Web Push Tests ===\n");

const vapid = generateVapidKeys();
assert("generateVapidKeys returns a 65-byte public key", Buffer.from(vapid.publicKey, "base64url").length === 65);
assert("generateVapidKeys returns a 32-byte private key", Buffer.from(vapid.privateKey, "base64url").length === 32);

const client = createECDH("prime256v1");
client.generateKeys();
const auth = Buffer.alloc(16, 7);
const subscription: PushSubscription = {
  endpoint: "http://127.0.0.1/push/test",
  keys: { p256dh: b64url(client.getPublicKey(undefined, "uncompressed")), auth: b64url(auth) },
};

let requestHeaders: IncomingMessage["headers"] = {};
let requestBody = Buffer.alloc(0);
let server: ReturnType<typeof createServer>;

await new Promise<void>((resolve) => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    requestHeaders = req.headers;
    requestBody = await readRequest(req);
    res.statusCode = 201;
    res.end("accepted");
  });
  server.listen(0, "127.0.0.1", resolve);
});
const address = server!.address();
const port = typeof address === "object" && address ? address.port : 0;
subscription.endpoint = `http://127.0.0.1:${port}/push/test`;

await assertAsync("send posts an encrypted payload to a real endpoint", async () => {
  const result = await new Push({ ...vapid, subject: "mailto:test@tina4.com" }).send(subscription, { message: "hello" });
  return result.ok && result.status === 201 && !result.dead && result.response === "accepted";
});
assert("request uses aes128gcm", requestHeaders["content-encoding"] === "aes128gcm");
assert("request has VAPID authorization", typeof requestHeaders.authorization === "string" && requestHeaders.authorization.startsWith("vapid t="));
assert("request has a positive TTL", Number(requestHeaders.ttl) > 0);
assert("encrypted body decrypts to the original JSON", JSON.parse(decrypt(requestBody, client, auth).toString("utf8")).message === "hello");

await new Promise<void>((resolve) => server!.close(() => resolve()));

const goneServer = createServer((_req, res) => { res.statusCode = 410; res.end("expired"); });
await new Promise<void>((resolve) => goneServer.listen(0, "127.0.0.1", resolve));
const goneAddress = goneServer.address();
subscription.endpoint = `http://127.0.0.1:${typeof goneAddress === "object" && goneAddress ? goneAddress.port : 0}/gone`;
await assertAsync("410 marks a subscription as dead", async () => {
  const result = await new Push({ ...vapid, subject: "mailto:test@tina4.com" }).send(subscription, "expired");
  return !result.ok && result.status === 410 && result.dead;
});
await new Promise<void>((resolve) => goneServer.close(() => resolve()));

const notFoundServer = createServer((_req, res) => { res.statusCode = 404; res.end("missing"); });
await new Promise<void>((resolve) => notFoundServer.listen(0, "127.0.0.1", resolve));
const notFoundAddress = notFoundServer.address();
subscription.endpoint = `http://127.0.0.1:${typeof notFoundAddress === "object" && notFoundAddress ? notFoundAddress.port : 0}/missing`;
await assertAsync("404 marks a subscription as dead", async () => {
  const result = await new Push({ ...vapid, subject: "mailto:test@tina4.com" }).send(subscription, "missing");
  return !result.ok && result.status === 404 && result.dead && !result.retryable;
});
await new Promise<void>((resolve) => notFoundServer.close(() => resolve()));

const retryServer = createServer((_req, res) => { res.statusCode = 429; res.end("busy"); });
await new Promise<void>((resolve) => retryServer.listen(0, "127.0.0.1", resolve));
const retryAddress = retryServer.address();
subscription.endpoint = `http://127.0.0.1:${typeof retryAddress === "object" && retryAddress ? retryAddress.port : 0}/retry`;
await assertAsync("429 is classified as retryable", async () => {
  const result = await new Push({ ...vapid, subject: "mailto:test@tina4.com" }).send(subscription, "busy");
  return !result.ok && result.status === 429 && !result.dead && result.retryable;
});
await new Promise<void>((resolve) => retryServer.close(() => resolve()));

const serverError = createServer((_req, res) => { res.statusCode = 500; res.end("failed"); });
await new Promise<void>((resolve) => serverError.listen(0, "127.0.0.1", resolve));
const serverErrorAddress = serverError.address();
subscription.endpoint = `http://127.0.0.1:${typeof serverErrorAddress === "object" && serverErrorAddress ? serverErrorAddress.port : 0}/error`;
await assertAsync("5xx is classified as retryable", async () => {
  const result = await new Push({ ...vapid, subject: "mailto:test@tina4.com" }).send(subscription, "failed");
  return !result.ok && result.status === 500 && !result.dead && result.retryable;
});
await new Promise<void>((resolve) => serverError.close(() => resolve()));

await assertAsync("invalid subscription keys fail before delivery", async () => {
  const invalid = { ...subscription, endpoint: "http://127.0.0.1:1/push", keys: { ...subscription.keys, p256dh: "bad" } };
  try {
    await new Push({ ...vapid, subject: "mailto:test@tina4.com" }).send(invalid, "invalid");
    return false;
  } catch (error) {
    return error instanceof PushError && error.message.includes("subscription.keys.p256dh");
  }
});

const oldSubject = process.env.TINA4_VAPID_SUBJECT;
const oldPublic = process.env.TINA4_VAPID_PUBLIC;
const oldPrivate = process.env.TINA4_VAPID_PRIVATE;
delete process.env.TINA4_VAPID_SUBJECT;
delete process.env.TINA4_VAPID_PUBLIC;
delete process.env.TINA4_VAPID_PRIVATE;
try {
  let threw = false;
  try { await new Push().send(subscription, "missing configuration"); } catch (error) { threw = error instanceof PushError; }
  assert("sending without VAPID configuration fails loudly", threw);
} finally {
  if (oldSubject === undefined) delete process.env.TINA4_VAPID_SUBJECT; else process.env.TINA4_VAPID_SUBJECT = oldSubject;
  if (oldPublic === undefined) delete process.env.TINA4_VAPID_PUBLIC; else process.env.TINA4_VAPID_PUBLIC = oldPublic;
  if (oldPrivate === undefined) delete process.env.TINA4_VAPID_PRIVATE; else process.env.TINA4_VAPID_PRIVATE = oldPrivate;
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;

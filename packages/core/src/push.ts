/**
 * Provider-neutral Web Push delivery using Node's built-in crypto and fetch.
 *
 * This module implements the RFC 8291 `aes128gcm` content encoding and VAPID
 * (RFC 8292). It deliberately has no web-push package dependency: the runtime
 * already provides P-256 ECDH, ES256 signing, AES-GCM, and HTTPS fetch.
 */
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
} from "node:crypto";

const CURVE = "prime256v1";
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = RECORD_SIZE - 17;

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushOptions {
  subject?: string;
  publicKey?: string;
  privateKey?: string;
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
}

export interface PushResult {
  ok: boolean;
  status: number;
  dead: boolean;
  retryable: boolean;
  endpoint: string;
  response: string;
}

export type PushPayload = string | Uint8Array | Record<string, unknown> | unknown[] | number | boolean | null;

export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushError";
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string, name: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new PushError(`${name} must be a non-empty base64url string`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PushError(`${name} must be base64url encoded`);
  }
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function vapidPrivateKey(rawPrivate: Buffer, rawPublic: Buffer) {
  if (rawPublic.length !== 65 || rawPublic[0] !== 0x04) throw new PushError("P-256 public keys must be 65-byte uncompressed points");
  const x = encodeBase64Url(rawPublic.subarray(1, 33));
  const y = encodeBase64Url(rawPublic.subarray(33, 65));
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: encodeBase64Url(rawPrivate),
      x,
      y,
      ext: true,
    },
    format: "jwk",
  });
}

function hmac(salt: Buffer, value: Buffer): Buffer {
  return createHmac("sha256", salt).update(value).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const chunks: Buffer[] = [];
  let previous: Buffer = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(chunks).length < length; counter++) {
    if (counter > 255) throw new PushError("HKDF output is too large");
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([counter])]));
    chunks.push(previous);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function payloadBytes(payload: PushPayload): Buffer {
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  try {
    const json = JSON.stringify(payload);
    if (json === undefined) throw new PushError("Push payload is not JSON serializable");
    return Buffer.from(json, "utf8");
  } catch (error) {
    throw new PushError(`Push payload is not JSON serializable: ${String(error)}`);
  }
}

function encryptPayload(payload: Buffer, subscription: PushSubscription): Buffer {
  if (payload.length > MAX_PAYLOAD) {
    throw new PushError(`Push payload is too large; maximum is ${MAX_PAYLOAD} bytes`);
  }
  const clientPublic = decodeBase64Url(subscription.keys.p256dh, "subscription.keys.p256dh");
  const authSecret = decodeBase64Url(subscription.keys.auth, "subscription.keys.auth");
  if (clientPublic.length !== 65 || clientPublic[0] !== 0x04) {
    throw new PushError("subscription.keys.p256dh must be a 65-byte P-256 public key");
  }
  if (authSecret.length !== 16) {
    throw new PushError("subscription.keys.auth must be a 16-byte authentication secret");
  }

  const ephemeral = createECDH(CURVE);
  ephemeral.generateKeys();
  const serverPublic = ephemeral.getPublicKey(undefined, "uncompressed");
  const sharedSecret = ephemeral.computeSecret(clientPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    clientPublic,
    serverPublic,
  ]);
  const prkKey = hmac(authSecret, sharedSecret);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  // The salt is written to the message header and is the salt used for the
  // content-encryption PRK.
  const salt = randomBytes(16);
  const contentPrk = hmac(salt, ikm);
  const cek = hkdfExpand(contentPrk, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16);
  const nonce = hkdfExpand(contentPrk, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([serverPublic.length]),
    serverPublic,
    ciphertext,
  ]);
}

function vapidToken(endpoint: string, subject: string, rawPrivate: Buffer, rawPublic: Buffer): string {
  const audience = new URL(endpoint).origin;
  const header = encodeBase64Url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = encodeBase64Url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: vapidPrivateKey(rawPrivate, rawPublic), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: encodeBase64Url(ecdh.getPublicKey(undefined, "uncompressed")),
    privateKey: encodeBase64Url(ecdh.getPrivateKey()),
  };
}

/** Provider-neutral Web Push sender. A subscription is accepted as returned by PushManager. */
export class Push {
  private readonly options: PushOptions;

  constructor(options: PushOptions = {}) {
    this.options = { ...options };
    if (["0", "false", "off", "no"].includes((process.env.TINA4_WEB_PUSH ?? "").trim().toLowerCase())) throw new PushError("Web Push is disabled by TINA4_WEB_PUSH");
    const configured = [
      (options.subject ?? process.env.TINA4_VAPID_SUBJECT)?.trim(),
      (options.publicKey ?? process.env.TINA4_VAPID_PUBLIC)?.trim(),
      (options.privateKey ?? process.env.TINA4_VAPID_PRIVATE)?.trim(),
    ].some((value) => value !== undefined);
    if (configured) this.requireConfiguration();
  }

  static fromEnv(options: PushOptions = {}): Push { return new Push(options); }
  static generateKeys(): { publicKey: string; privateKey: string } { return generateVapidKeys(); }

  private requireConfiguration(): { subject: string; publicKey: string; privateKey: string } {
    const subject = (this.options.subject ?? process.env.TINA4_VAPID_SUBJECT)?.trim();
    const publicKey = (this.options.publicKey ?? process.env.TINA4_VAPID_PUBLIC)?.trim();
    const privateKey = (this.options.privateKey ?? process.env.TINA4_VAPID_PRIVATE)?.trim();
    const missing = [
      subject ? undefined : "TINA4_VAPID_SUBJECT",
      publicKey ? undefined : "TINA4_VAPID_PUBLIC",
      privateKey ? undefined : "TINA4_VAPID_PRIVATE",
    ].filter((name): name is string => name !== undefined);
    if (missing.length > 0) {
      throw new PushError(`Web Push is configured but missing: ${missing.join(", ")}`);
    }
    // The guard above establishes these values for both TypeScript and the
    // runtime; keeping this explicit avoids silently accepting partial VAPID
    // configuration.
    if (!subject || !publicKey || !privateKey) {
      throw new PushError("Web Push VAPID configuration is incomplete");
    }
    return { subject, publicKey, privateKey };
  }

  private endpointFor(subscription: PushSubscription): URL {
    if (!subscription || typeof subscription.endpoint !== "string") {
      throw new PushError("A Web Push subscription with an endpoint is required");
    }
    let endpoint: URL;
    try { endpoint = new URL(subscription.endpoint); } catch { throw new PushError("Push subscription endpoint must be a valid URL"); }
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new PushError("Push subscription endpoint must use HTTP or HTTPS");
    }
    return endpoint;
  }

  private vapidKeys(config: { publicKey: string; privateKey: string }): { rawPublic: Buffer; rawPrivate: Buffer } {
    const rawPublic = decodeBase64Url(config.publicKey, "TINA4_VAPID_PUBLIC");
    const rawPrivate = decodeBase64Url(config.privateKey, "TINA4_VAPID_PRIVATE");
    if (rawPublic.length !== 65 || rawPublic[0] !== 0x04) throw new PushError("TINA4_VAPID_PUBLIC must be a 65-byte P-256 public key");
    if (rawPrivate.length !== 32) throw new PushError("TINA4_VAPID_PRIVATE must be a 32-byte P-256 private key");
    const derived = createECDH(CURVE);
    try { derived.setPrivateKey(rawPrivate); } catch { throw new PushError("TINA4_VAPID_PRIVATE is not a valid P-256 private key"); }
    if (!derived.getPublicKey(undefined, "uncompressed").equals(rawPublic)) throw new PushError("TINA4_VAPID_PUBLIC does not match TINA4_VAPID_PRIVATE");
    return { rawPublic, rawPrivate };
  }

  private async deliver(endpoint: URL, config: { subject: string; publicKey: string; privateKey: string }, keys: { rawPublic: Buffer; rawPrivate: Buffer }, body: Buffer): Promise<PushResult> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `vapid t=${vapidToken(endpoint.toString(), config.subject, keys.rawPrivate, keys.rawPublic)}, k=${config.publicKey}`,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(this.options.ttl ?? 60),
          ...(this.options.urgency ? { Urgency: this.options.urgency } : {}),
        },
        // Node's fetch accepts Buffer at runtime, while the DOM declaration
        // used by the published type build narrows BodyInit to ArrayBuffer
        // backed views. Keep the binary payload intact and make that boundary
        // explicit rather than converting the encrypted bytes to text.
        body: body as unknown as BodyInit,
      });
    } catch (error) {
      throw new PushError(`Web Push request failed: ${String(error)}`);
    }
    const status = response.status;
    return { ok: response.ok, status, dead: status === 404 || status === 410, retryable: status === 408 || status === 429 || status >= 500, endpoint: endpoint.toString(), response: await response.text() };
  }

  async send(subscription: PushSubscription, payload: PushPayload): Promise<PushResult> {
    const endpoint = this.endpointFor(subscription);
    const config = this.requireConfiguration();
    const keys = this.vapidKeys(config);
    return this.deliver(endpoint, config, keys, encryptPayload(payloadBytes(payload), subscription));
  }
}

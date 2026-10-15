/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import { createHash, createHmac } from "node:crypto";

/**
 * Zero-dependency S3 client (AWS Signature Version 4) on the Node standard
 * library — node:crypto for signing, global fetch for transport. Covers exactly
 * what the realtime S3Storage backend needs (PUT, GET, DELETE, HEAD, a presigned
 * GET URL, and create-bucket for provisioning) so the `s3` backend no longer
 * needs @aws-sdk/client-s3 or @aws-sdk/s3-request-presigner.
 *
 * Path-style addressing (<endpoint>/<bucket>/<key>), which S3-compatible servers
 * (MinIO, Garage) require and AWS accepts; with no endpoint it targets
 * https://s3.<region>.amazonaws.com. SigV4 is HMAC-SHA256 canonical signing —
 * the same primitive Tina4's JWT already uses (node:crypto); nothing here is
 * reinvented crypto. Mirrors the Python master, proven against AWS's published
 * SigV4 test vector.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNRESERVED = /[A-Za-z0-9\-_.~]/;

// Retry policy, as for the AI client (ADR-0053): HTTP 429, any 5xx (S3's
// SlowDown is a 503) and a dropped connection are sent again, a bounded number
// of times, honouring Retry-After. Every operation here is idempotent.
const MAX_RETRIES = 2;
const BACKOFF_BASE = 0.5; // seconds; retry n waits up to base * 2**n, jittered
const BACKOFF_CAP = 20.0;

/** An S3 request returned a non-2xx status; `status` holds the HTTP code. */
export class S3Error extends Error {
  /** Seconds from a Retry-After header in its delta-seconds form, else null. */
  retryAfter: number | null = null;
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "S3Error";
  }
}

/** The client cannot sign a request: no access key or secret was given. */
export class S3ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3ConfigError";
  }
}

/** Seconds from a Retry-After header in its delta-seconds form, else null. */
function retryAfterSeconds(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * SigV4 canonical encoding: keep the RFC 3986 unreserved set literal; keep "/"
 * in a path and encode it in a query; every other byte becomes %XX (upper-case).
 */
export function uriEncode(value: string, isPath: boolean): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (UNRESERVED.test(ch) || (isPath && ch === "/")) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac("sha256", key).update(msg, "utf8").digest();
}

export class S3Client {
  private readonly scheme: string;
  private readonly host: string; // authority (host[:port]) — matches the Host header
  private readonly prefix: string; // path an endpoint carries (https://host/s3 -> "/s3"), "" if none
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly timeout: number;

  constructor(opts: {
    endpoint?: string;
    accessKey?: string;
    secretKey?: string;
    region?: string;
    timeout?: number;
  } = {}) {
    this.region = opts.region || "us-east-1";
    this.accessKey = opts.accessKey || "";
    this.secretKey = opts.secretKey || "";
    this.timeout = opts.timeout ?? 30000;
    let base = opts.endpoint || `https://s3.${this.region}.amazonaws.com`;
    while (base.endsWith("/")) base = base.slice(0, -1); // strip trailing slashes without a regex
    // Split scheme :// authority [ / path ]. The authority alone is the Host
    // header and the signed `host:`; an endpoint behind a path (https://host/s3)
    // keeps that path in front of every request path, and in what is signed.
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)(\/.*)?$/i.exec(base);
    this.scheme = m ? m[1] : "https";
    this.host = m ? m[2] : base;
    let p = m && m[3] ? m[3] : "";
    while (p.endsWith("/")) p = p.slice(0, -1);
    this.prefix = p;
  }

  // -- public API (the subset S3Storage uses) --------------------------------

  async putObject(bucket: string, key: string, data: Buffer | string, contentType = "application/octet-stream"): Promise<void> {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await this.request("PUT", this.canonicalUri(bucket, key), body, { "content-type": contentType });
  }

  async getObject(bucket: string, key: string): Promise<Buffer> {
    return (await this.request("GET", this.canonicalUri(bucket, key), Buffer.alloc(0))).body;
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.request("DELETE", this.canonicalUri(bucket, key), Buffer.alloc(0));
  }

  async headObject(bucket: string, key: string): Promise<void> {
    await this.request("HEAD", this.canonicalUri(bucket, key), Buffer.alloc(0));
  }

  /** Create the bucket (path-style `PUT /<bucket>`); an already-owned bucket (409) is success. */
  async createBucket(bucket: string): Promise<void> {
    try {
      await this.request("PUT", `${this.prefix}/${uriEncode(bucket, true)}`, Buffer.alloc(0));
    } catch (e) {
      if (!(e instanceof S3Error) || e.status !== 409) throw e;
    }
  }

  /** A URL that fetches the object directly, signed via SigV4 query params. */
  presignedGetUrl(bucket: string, key: string, expires = 3600): string {
    this.requireCredentials();
    const { amzDate, dateStamp } = this.now();
    const uri = this.canonicalUri(bucket, key);
    const scope = `${dateStamp}/${this.region}/${SERVICE}/aws4_request`;
    const query: Record<string, string> = {
      "X-Amz-Algorithm": ALGORITHM,
      "X-Amz-Credential": `${this.accessKey}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": "host",
    };
    const canonicalQs = this.canonicalQuery(query);
    const canonicalRequest = ["GET", uri, canonicalQs, `host:${this.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const signature = this.sign(canonicalRequest, amzDate, dateStamp, scope);
    return `${this.scheme}://${this.host}${uri}?${canonicalQs}&X-Amz-Signature=${signature}`;
  }

  // -- signing + transport ----------------------------------------------------

  private requireCredentials(): void {
    // Signing with an empty key only earns a 403 from the server, which says
    // nothing about the cause. Name the settings instead, before sending.
    if (!this.accessKey || !this.secretKey) {
      throw new S3ConfigError(
        "S3 credentials are not set: set TINA4_STORAGE_KEY and TINA4_STORAGE_SECRET",
      );
    }
  }

  private now(): { amzDate: string; dateStamp: string } {
    const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { amzDate: iso, dateStamp: iso.slice(0, 8) };
  }

  private canonicalUri(bucket: string, key: string): string {
    return `${this.prefix}/${uriEncode(bucket, true)}/${uriEncode(key, true)}`;
  }

  private canonicalQuery(query: Record<string, string>): string {
    return Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`)
      .join("&");
  }

  private signingKey(dateStamp: string): Buffer {
    const kDate = hmac(`AWS4${this.secretKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, SERVICE);
    return hmac(kService, "aws4_request");
  }

  private sign(canonicalRequest: string, amzDate: string, dateStamp: string, scope: string): string {
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    return createHmac("sha256", this.signingKey(dateStamp)).update(stringToSign, "utf8").digest("hex");
  }

  private async request(
    method: string,
    uri: string,
    body: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: Buffer }> {
    this.requireCredentials();
    for (let attempt = 0; ; attempt++) {
      const last = attempt === MAX_RETRIES;
      let delay: number | null = null;
      try {
        // Signed afresh each attempt: x-amz-date moves on.
        return await this.send(method, uri, body, extraHeaders);
      } catch (e) {
        if (e instanceof S3Error) {
          if (last || !(e.status === 429 || e.status >= 500)) throw e;
          delay = e.retryAfter;
        } else {
          // Connection refused or dropped, timeout: nothing was answered.
          if (last) throw e;
          delay = null;
        }
      }
      if (delay == null) delay = Math.random() * (BACKOFF_BASE * 2 ** attempt);
      await sleep(Math.min(delay, BACKOFF_CAP) * 1000);
    }
  }

  private async send(
    method: string,
    uri: string,
    body: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: Buffer }> {
    const { amzDate, dateStamp } = this.now();
    const payloadHash = sha256Hex(body);

    const signed: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedKeys = Object.keys(signed).sort();
    const canonicalHeaders = signedKeys.map((k) => `${k}:${signed[k]}\n`).join("");
    const signedHeaders = signedKeys.join(";");
    const canonicalRequest = [method, uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${this.region}/${SERVICE}/aws4_request`;
    const signature = this.sign(canonicalRequest, amzDate, dateStamp, scope);
    const authorization = `${ALGORITHM} Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers: Record<string, string> = {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };

    const url = `${this.scheme}://${this.host}${uri}`;
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (method === "PUT" || method === "POST") init.body = body;
    if (AbortSignal.timeout) init.signal = AbortSignal.timeout(this.timeout);

    const response = await fetch(url, init);
    if (response.status < 200 || response.status >= 300) {
      const err = new S3Error(response.status, `${method} ${uri}: HTTP ${response.status}`);
      err.retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
      throw err;
    }
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  }
}

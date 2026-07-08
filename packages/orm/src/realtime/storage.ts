import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { Log } from "@tina4/core";

// ESM has no global `require`; create one so the OPTIONAL aws-sdk can be loaded
// synchronously in S3Storage's constructor. A missing driver throws here and
// selectStorage() catches it, degrading to local storage.
const require = createRequire(import.meta.url);

/**
 * Pluggable file storage for the realtime "files" feature. StorageBackend is
 * the interface; LocalStorage (default, zero-dependency, filesystem) and
 * S3Storage (opt-in, S3-compatible via @aws-sdk/client-s3) are the shipped
 * implementations. Selection mirrors the cache/session/queue backend pattern:
 * TINA4_STORAGE_BACKEND (local default | s3) plus per-backend env vars, with a
 * graceful fallback to local if an s3 backend cannot be constructed - a real
 * persistent store, never a silent no-op. Parity with Python's storage.py.
 */
export interface StorageBackend {
  put(key: string, data: Buffer | string, mime?: string): void | Promise<void>;
  get(key: string): Buffer | null | Promise<Buffer | null>;
  /** A directly-fetchable URL when the backend supports one, else null. */
  url(key: string, ttl?: number): string | null | Promise<string | null>;
  delete(key: string): void | Promise<void>;
  exists(key: string): boolean | Promise<boolean>;
}

const UNSAFE = /[^A-Za-z0-9]/g;

/**
 * Generate an opaque, collision-free storage key, preserving the extension.
 * The key carries no user-controlled path segment, so it can never traverse
 * outside the storage root.
 */
export function storageKey(filename = ""): string {
  let ext = "";
  if (filename && filename.includes(".")) {
    const raw = filename.slice(filename.lastIndexOf(".") + 1);
    const clean = raw.replace(UNSAFE, "").slice(0, 12);
    if (clean) ext = `.${clean}`;
  }
  return `${randomBytes(16).toString("hex")}${ext}`;
}

/** Zero-dependency filesystem store. The default backend. */
export class LocalStorage implements StorageBackend {
  private directory: string;

  constructor(directory?: string) {
    this.directory = resolve(directory || process.env.TINA4_STORAGE_DIR || "data/rt_storage");
    mkdirSync(this.directory, { recursive: true });
  }

  // Resolve inside the root and reject any traversal attempt.
  private pathFor(key: string): string {
    const target = resolve(this.directory, key);
    if (target !== this.directory && !target.startsWith(this.directory + sep)) {
      throw new Error(`unsafe storage key: ${JSON.stringify(key)}`);
    }
    return target;
  }

  put(key: string, data: Buffer | string): void {
    writeFileSync(this.pathFor(key), data);
  }

  get(key: string): Buffer | null {
    try {
      return readFileSync(this.pathFor(key));
    } catch {
      return null;
    }
  }

  // No direct URL: the permissioned app download route serves local files.
  url(): string | null {
    return null;
  }

  delete(key: string): void {
    try {
      unlinkSync(this.pathFor(key));
    } catch {
      /* not found / unsafe — nothing to remove */
    }
  }

  exists(key: string): boolean {
    try {
      return statSync(this.pathFor(key)).isFile();
    } catch {
      return false;
    }
  }
}

/**
 * S3-compatible store (AWS S3, MinIO, ...). Opt-in; needs @aws-sdk/client-s3.
 * Presigned GET URLs let clients fetch large blobs straight from object
 * storage instead of streaming through the app.
 */
export class S3Storage implements StorageBackend {
  private client: any;
  private bucket: string;

  constructor(opts: { endpoint?: string; key?: string; secret?: string; bucket?: string; region?: string } = {}) {
    this.bucket = opts.bucket || process.env.TINA4_STORAGE_BUCKET || "";
    if (!this.bucket) throw new Error("S3Storage requires TINA4_STORAGE_BUCKET");
    // Loaded lazily; a missing driver throws here and selectStorage falls back.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { S3Client } = require("@aws-sdk/client-s3");
    const endpoint = opts.endpoint || process.env.TINA4_STORAGE_URL;
    this.client = new S3Client({
      endpoint: endpoint || undefined,
      forcePathStyle: true,
      region: opts.region || process.env.TINA4_STORAGE_REGION || "us-east-1",
      credentials: {
        accessKeyId: opts.key || process.env.TINA4_STORAGE_KEY || "",
        secretAccessKey: opts.secret || process.env.TINA4_STORAGE_SECRET || "",
      },
    });
  }

  async put(key: string, data: Buffer | string, mime = "application/octet-stream"): Promise<void> {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mime }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  async url(key: string, ttl = 3600): Promise<string | null> {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttl });
  }

  async delete(key: string): Promise<void> {
    try {
      const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      Log.error(`S3Storage delete failed for ${key}: ${(e as Error).message}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const { HeadObjectCommand } = require("@aws-sdk/client-s3");
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Resolve the storage backend from an explicit instance or the environment.
 * Falls back to LocalStorage (logging why) when an s3 backend cannot be built
 * (driver missing or config incomplete) - a real store, never a silent no-op.
 */
export function selectStorage(storage?: StorageBackend): StorageBackend {
  if (storage) return storage;
  const name = (process.env.TINA4_STORAGE_BACKEND || "local").toLowerCase();
  if (name === "s3") {
    try {
      return new S3Storage();
    } catch (e) {
      Log.warning(
        `realtime files: S3 storage unavailable (${(e as Error).message}); ` +
          "falling back to local filesystem storage.",
      );
      return new LocalStorage();
    }
  }
  return new LocalStorage();
}

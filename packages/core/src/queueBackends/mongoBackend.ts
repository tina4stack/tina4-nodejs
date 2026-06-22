/**
 * Tina4 MongoDB Queue Backend — uses `mongodb` npm package via dynamic import.
 *
 * Implements the same interface as the file-based queue but uses MongoDB
 * for message storage and delivery. Atomic pop via findOneAndUpdate.
 *
 * Configure via environment variables:
 *   TINA4_QUEUE_URL        — connection URI (mongodb://...)
 *   TINA4_MONGO_URI        (override; wins over TINA4_QUEUE_URL)
 *   TINA4_MONGO_HOST       (default: "localhost")
 *   TINA4_MONGO_PORT       (default: 27017)
 *   TINA4_MONGO_USERNAME   (optional)
 *   TINA4_MONGO_PASSWORD   (optional)
 *   TINA4_MONGO_DB         (default: "tina4")
 *   TINA4_MONGO_COLLECTION (default: "tina4_queue")
 *
 * Precedence for the connection URI: explicit config.uri
 *   > TINA4_MONGO_URI > TINA4_QUEUE_URL > a URI built from the
 *   TINA4_MONGO_HOST/PORT/USERNAME/PASSWORD field vars (existing defaults).
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { QueueJob } from "../queue.js";

// ── Types ────────────────────────────────────────────────────

export interface MongoConfig {
  host?: string;
  port?: number;
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
  collection?: string;
  /**
   * Reservation/visibility timeout (seconds). A dequeued message is held
   * reserved with availableAt = now + timeout; reclaim returns it once that
   * passes (consumer died mid-flight, before complete()/fail()). <= 0 disables
   * the reclaim. Falls back to TINA4_QUEUE_VISIBILITY_TIMEOUT, else 300.
   */
  visibilityTimeout?: number;
  /** Max attempts before the reclaim dead-letters a job instead of re-delivering. */
  maxRetries?: number;
}

export interface QueueBackend {
  push(queue: string, payload: unknown, delay?: number): string;
  pop(queue: string): QueueJob | null;
  size(queue: string): number;
  clear(queue: string): void;
}

// ── MongoDB Backend ──────────────────────────────────────────

/**
 * MongoDB queue backend using the `mongodb` npm package.
 *
 * Uses synchronous-style communication by spawning a child process
 * for each operation, similar to the RabbitMQ and Redis patterns.
 * This keeps the interface synchronous as required by the Queue class.
 */
export class MongoBackend implements QueueBackend {
  private host: string;
  private port: number;
  private uri: string;
  private username: string;
  private password: string;
  private database: string;
  private collection: string;
  private visibilityTimeout: number;
  private maxRetries: number;

  constructor(config?: MongoConfig) {
    this.host = config?.host ?? process.env.TINA4_MONGO_HOST ?? "localhost";
    this.port = config?.port
      ?? (process.env.TINA4_MONGO_PORT ? parseInt(process.env.TINA4_MONGO_PORT, 10) : 27017);
    this.username = config?.username ?? process.env.TINA4_MONGO_USERNAME ?? "";
    this.password = config?.password ?? process.env.TINA4_MONGO_PASSWORD ?? "";
    this.database = config?.database ?? process.env.TINA4_MONGO_DB ?? "tina4";
    this.collection = config?.collection ?? process.env.TINA4_MONGO_COLLECTION ?? "tina4_queue";

    // Reservation/visibility timeout (seconds): config wins, else env, else 300.
    if (config?.visibilityTimeout !== undefined) {
      this.visibilityTimeout = config.visibilityTimeout;
    } else {
      const raw = process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT;
      const parsed = raw === undefined || raw === "" ? 300 : Number(raw);
      this.visibilityTimeout = Number.isFinite(parsed) ? parsed : 300;
    }
    this.maxRetries = config?.maxRetries ?? 3;

    // Connection URI precedence: explicit config.uri > TINA4_MONGO_URI
    // > TINA4_QUEUE_URL > a URI built from the host/port/auth field vars.
    const explicitUri = config?.uri ?? process.env.TINA4_MONGO_URI ?? process.env.TINA4_QUEUE_URL;
    if (explicitUri) {
      this.uri = explicitUri;
    } else {
      const auth = this.username
        ? `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`
        : "";
      this.uri = `mongodb://${auth}${this.host}:${this.port}`;
    }
  }

  /**
   * Resolved connection config — exposed for testing/introspection.
   */
  getConfig(): { uri: string; database: string; collection: string; visibilityTimeout: number } {
    return {
      uri: this.uri,
      database: this.database,
      collection: this.collection,
      visibilityTimeout: this.visibilityTimeout,
    };
  }

  /**
   * Resolved reservation/visibility timeout (seconds). <= 0 disables the
   * reclaim. Exposed for testing/introspection.
   */
  getVisibilityTimeout(): number {
    return this.visibilityTimeout;
  }

  /**
   * Build the Node script that performs one MongoDB queue operation in a child
   * process. Exposed (not private) so tests can assert the visibility-timeout
   * behaviour without a live MongoDB — the script's pop branch advances
   * availableAt = now + visibilityTimeout and stamps reservedAt (the core fix),
   * and the reclaim branch flips an expired { status: reserved } back to
   * pending with attempts incremented (dead-lettering past maxRetries),
   * disabled when visibilityTimeout <= 0.
   */
  buildScript(operation: string, queue: string, data?: string): string {
    return `
      async function main() {
        let mongodb;
        try {
          mongodb = await import("mongodb");
        } catch {
          process.stderr.write("mongodb package not installed — run: npm install mongodb");
          process.exit(1);
        }

        const { MongoClient } = mongodb;
        const uri = ${JSON.stringify(this.uri)};
        const dbName = ${JSON.stringify(this.database)};
        const collName = ${JSON.stringify(this.collection)};
        const operation = ${JSON.stringify(operation)};
        const queueName = ${JSON.stringify(queue)};
        const data = ${JSON.stringify(data ?? "")};
        const visibilityTimeout = ${JSON.stringify(this.visibilityTimeout)};
        const maxRetries = ${JSON.stringify(this.maxRetries)};

        const client = new MongoClient(uri, {
          connectTimeoutMS: 5000,
          serverSelectionTimeoutMS: 5000,
        });

        try {
          await client.connect();
          const db = client.db(dbName);
          const col = db.collection(collName);

          // Ensure indexes on first use
          await col.createIndex({ queue: 1, status: 1, availableAt: 1 });
          await col.createIndex({ queue: 1, createdAt: 1 });

          if (operation === "push") {
            const job = JSON.parse(data);
            await col.insertOne({ ...job, queue: queueName });
            process.stdout.write("__PUSHED__");
          }
          else if (operation === "reclaim") {
            // Return reservations whose visibility window expired (at-least-once
            // delivery). A doc left { status: reserved, availableAt <= now } had
            // its consumer die before acknowledging — flip it back to pending
            // with attempts incremented, or dead-letter once attempts hit the
            // limit. Disabled when visibilityTimeout <= 0.
            let reclaimed = 0;
            if (visibilityTimeout > 0) {
              while (true) {
                const now = new Date().toISOString();
                const doc = await col.findOneAndUpdate(
                  { queue: queueName, status: "reserved", availableAt: { $lte: now } },
                  { $set: { status: "pending", availableAt: now, reservedAt: null }, $inc: { attempts: 1 } },
                  { sort: { availableAt: 1 }, returnDocument: "after" },
                );
                const updated = doc && doc.value ? doc.value : (doc && doc._id ? doc : null);
                if (!updated) break;
                reclaimed++;
                if ((updated.attempts || 0) >= maxRetries) {
                  await col.insertOne({
                    ...updated,
                    _id: undefined,
                    status: "dead",
                    queue: queueName + ".dead_letter",
                    error: "reservation timed out — consumer did not acknowledge within the visibility timeout",
                  });
                  await col.deleteOne({ _id: updated._id, queue: queueName });
                }
              }
            }
            process.stdout.write(String(reclaimed));
          }
          else if (operation === "pop") {
            const now = new Date().toISOString();
            // The claim advances availableAt = now + visibilityTimeout and
            // stamps reservedAt so reclaim can return the job if the consumer
            // dies before complete()/fail() — this is the fix for the "reserved
            // forever" bug (previously availableAt was left unchanged).
            const future = new Date(Date.now() + visibilityTimeout * 1000).toISOString();
            const result = await col.findOneAndUpdate(
              {
                queue: queueName,
                status: "pending",
                $or: [
                  { availableAt: null },
                  { availableAt: { $exists: false } },
                  { availableAt: { $lte: now } },
                  { delayUntil: null },
                  { delayUntil: { $lte: now } },
                ],
              },
              { $set: { status: "reserved", reservedAt: now, availableAt: future } },
              { sort: { priority: -1, createdAt: 1 }, returnDocument: "before" },
            );

            if (result && result.value) {
              // findOneAndUpdate returns { value: doc } in older drivers
              const doc = result.value;
              delete doc._id;
              delete doc.queue;
              process.stdout.write(JSON.stringify(doc));
            } else if (result && result._id) {
              // Some driver versions return the doc directly
              const doc = { ...result };
              delete doc._id;
              delete doc.queue;
              process.stdout.write(JSON.stringify(doc));
            } else {
              process.stdout.write("__EMPTY__");
            }
          }
          else if (operation === "size") {
            const count = await col.countDocuments({
              queue: queueName,
              status: "pending",
            });
            process.stdout.write(String(count));
          }
          else if (operation === "clear") {
            await col.deleteMany({ queue: queueName });
            process.stdout.write("__CLEARED__");
          }
        } catch (err) {
          process.stderr.write(err.message || String(err));
          process.exit(1);
        } finally {
          await client.close();
        }
      }

      main();
    `;
  }

  /**
   * Execute a MongoDB operation synchronously via a child process.
   */
  private execSync(operation: string, queue: string, data?: string): string {
    const script = this.buildScript(operation, queue, data);

    try {
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result;
    } catch {
      return "";
    }
  }

  push(queue: string, payload: unknown, delay?: number): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    const job = {
      id,
      payload,
      status: "pending",
      createdAt: now,
      attempts: 0,
      delayUntil: delay ? new Date(Date.now() + delay * 1000).toISOString() : null,
    };

    const result = this.execSync("push", queue, JSON.stringify(job));
    if (!result.includes("__PUSHED__")) {
      throw new Error("MongoDB push failed");
    }
    return id;
  }

  pop(queue: string): QueueJob | null {
    // Reclaim any reservations whose consumer died before acking, then take the
    // next available message (at-least-once delivery). Disabled at timeout <= 0.
    if (this.visibilityTimeout > 0) {
      this.execSync("reclaim", queue);
    }
    const result = this.execSync("pop", queue);
    if (!result || result === "__EMPTY__") return null;

    try {
      return JSON.parse(result) as QueueJob;
    } catch {
      return null;
    }
  }

  size(queue: string): number {
    const result = this.execSync("size", queue);
    const num = parseInt(result, 10);
    return isNaN(num) ? 0 : num;
  }

  clear(queue: string): void {
    this.execSync("clear", queue);
  }
}

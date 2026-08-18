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
  push(queue: string, payload: unknown, delay?: number, priority?: number): string;
  pop(queue: string): QueueJob | null;
  size(queue: string): number;
  clear(queue: string): void;
  /** Release whatever connection the backend holds. Must be idempotent. */
  close(): void;
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
                // TWO INDEPENDENT GATES, both of which must pass: the
                // reservation gate (availableAt) and the delay gate
                // (delayUntil). These used to share ONE $or, which made them
                // alternatives rather than requirements — a freshly pushed
                // delayed job has no availableAt, matched
                // { availableAt: { $exists: false } }, and was handed straight
                // to a consumer. That is why push(payload, delay) fired
                // immediately on Mongo and on time on the file backend.
                // The $exists arms keep documents written before either field
                // existed claimable, instead of stranding them forever.
                $and: [
                  {
                    $or: [
                      { availableAt: null },
                      { availableAt: { $exists: false } },
                      { availableAt: { $lte: now } },
                    ],
                  },
                  {
                    $or: [
                      { delayUntil: null },
                      { delayUntil: { $exists: false } },
                      { delayUntil: { $lte: now } },
                    ],
                  },
                ],
              },
              { $set: { status: "reserved", reservedAt: now, availableAt: future } },
              { sort: { priority: -1, createdAt: 1 }, returnDocument: "before" },
            );

            if (result && result.value) {
              // findOneAndUpdate returns { value: doc } in older drivers
              const doc = result.value;
              // Carry the framework topic on the job so complete()/fail()
              // route the ack/requeue back to THIS topic's docs (the Mongo
              // internal queue field is dropped from the returned shape).
              doc.topic = queueName;
              delete doc._id;
              delete doc.queue;
              process.stdout.write(JSON.stringify(doc));
            } else if (result && result._id) {
              // Some driver versions return the doc directly
              const doc = { ...result };
              // Carry the framework topic on the job so complete()/fail()
              // route the ack/requeue back to THIS topic's docs (the Mongo
              // internal queue field is dropped from the returned shape).
              doc.topic = queueName;
              delete doc._id;
              delete doc.queue;
              process.stdout.write(JSON.stringify(doc));
            } else {
              process.stdout.write("__EMPTY__");
            }
          }
          else if (operation === "popById") {
            // Claim ONE specific job by id, the same way pop() claims the head.
            // Queue.popById used to read the LOCAL FILE STORE regardless of the
            // configured backend, so it never saw a mongodb job at all.
            const now = new Date().toISOString();
            const future = new Date(Date.now() + visibilityTimeout * 1000).toISOString();
            const wanted = JSON.parse(data);
            const result = await col.findOneAndUpdate(
              { queue: queueName, status: "pending", id: wanted.id },
              { $set: { status: "reserved", reservedAt: now, availableAt: future } },
              { returnDocument: "before" },
            );
            const doc = result && result.value ? result.value : (result && result._id ? { ...result } : null);
            if (doc) {
              doc.topic = queueName;
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
          else if (operation === "complete") {
            // Ack a finished job so the reclaim never re-delivers it. data = job id.
            // (The pop reserved this doc; without this it stays reserved and is
            // re-delivered after the visibility window — the redelivery bug.)
            await col.updateOne(
              { queue: queueName, id: data },
              { $set: { status: "completed", completedAt: new Date().toISOString(), reservedAt: null } },
            );
            process.stdout.write("__OK__");
          }
          else if (operation === "fail") {
            // Requeue while retries remain (reset availableAt -> visible again),
            // else dead-letter. Atomic decision in Mongo. data = JSON
            // { id, error, maxRetries, retryBackoff }.
            const info = JSON.parse(data);
            const now = new Date().toISOString();
            const doc = await col.findOne({ queue: queueName, id: info.id });
            if (doc) {
              const attempts = (doc.attempts || 0) + 1;
              if (attempts >= info.maxRetries) {
                await col.insertOne({
                  ...doc, _id: undefined, attempts,
                  status: "dead", queue: queueName + ".dead_letter", error: info.error,
                });
                await col.deleteOne({ _id: doc._id, queue: queueName });
              } else {
                const avail = info.retryBackoff > 0
                  ? new Date(Date.now() + info.retryBackoff * 1000).toISOString()
                  : now;
                await col.updateOne(
                  { _id: doc._id, queue: queueName },
                  { $set: { status: "pending", availableAt: avail, reservedAt: null, error: info.error },
                    $inc: { attempts: 1 } },
                );
              }
            }
            process.stdout.write("__OK__");
          }
          else if (operation === "retry") {
            // Explicit manual re-queue. Serves BOTH Queue.retry(id) (revive
            // a dead-letter job) AND job.retry() (manual re-queue of a live
            // reserved/pending job) so the Mongo backend matches
            // LiteBackend's dual behaviour.
            //
            // 1) DL revival (Queue.retry(id) after fail exhausted retries).
            //    Pre-3.13.105 this branch was BROKEN: the search filter was
            //    { queue: queueName, id, status: "failed" } -- three separate
            //    reasons it could never match. dead_letter() inserts under
            //    queueName + ".dead_letter" (not queueName), carries
            //    status "dead" (not "failed"), and the original under
            //    queueName was already acked to "completed" by the time the
            //    DL was written. Now we look up in the DL namespace by id,
            //    delete the DL doc first (so an interrupted retry never
            //    leaves both a DL and a fresh pending doc), and upsert the
            //    original back to pending -- re-hydrating if the original
            //    was purged (housekeeping) so a retry always works.
            // 2) Live-doc manual re-queue (job.retry() on a job the caller
            //    just popped and wants back in pending). The live-doc path
            //    is preserved from before 3.13.105.
            //
            // Returns __OK__ when either path acted; __NOT_FOUND__ when
            // neither the DL nor the live doc existed, so Queue.retry(id)
            // can now report the pre-3.13.105 blanket-true as false for
            // unknown ids. data = JSON { id, delaySeconds }.
            const info = JSON.parse(data);
            const dlTopic = queueName + ".dead_letter";
            const now = new Date().toISOString();
            const avail = info.delaySeconds > 0
              ? new Date(Date.now() + info.delaySeconds * 1000).toISOString()
              : now;
            const dlDoc = await col.findOne({ queue: dlTopic, id: info.id });
            if (dlDoc !== null) {
              await col.deleteOne({ _id: dlDoc._id });
              const payload = dlDoc.payload ?? {};
              const priority = dlDoc.priority ?? 0;
              await col.updateOne(
                { queue: queueName, id: info.id },
                {
                  $set: {
                    status: "pending",
                    availableAt: avail,
                    reservedAt: null,
                    error: null,
                    payload,
                    priority,
                    id: info.id,
                    createdAt: dlDoc.createdAt ?? now,
                  },
                  $inc: { attempts: 1 },
                },
                { upsert: true },
              );
              process.stdout.write("__OK__");
            } else {
              const result = await col.updateOne(
                { queue: queueName, id: info.id },
                { $set: { status: "pending", availableAt: avail, reservedAt: null }, $inc: { attempts: 1 } },
              );
              process.stdout.write(result.matchedCount > 0 ? "__OK__" : "__NOT_FOUND__");
            }
          }
          else if (operation === "deadLetters") {
            const docs = await col.find({ queue: queueName + ".dead_letter" }).toArray();
            const out = docs.map((d) => { delete d._id; delete d.queue; return d; });
            process.stdout.write(JSON.stringify(out));
          }
          else if (operation === "failed") {
            // Found by the ATTEMPTS COUNTER, not by a "failed" status. The
            // fail() branch above re-queues a still-retryable job as "pending"
            // (that is what makes the next pop redeliver it) and dead-letters
            // an exhausted one as "dead" - nothing ever writes "failed", so
            // this query matched nothing and returned [] forever. An empty
            // list is indistinguishable from "nothing has failed"
            // (ADR-0022 decision 7). attempts > 0 is the real marker of a job
            // that has already died at least once.
            const docs = await col
              .find({
                queue: queueName,
                status: "pending",
                attempts: { $gt: 0, $lt: maxRetries },
              })
              .toArray();
            const out = docs.map((d) => { delete d._id; delete d.queue; return d; });
            process.stdout.write(JSON.stringify(out));
          }
          else if (operation === "retryFailed") {
            // Revive dead-lettered jobs under the (possibly raised) limit back to
            // the main queue as pending. data = the max-retries limit.
            const mr = data ? Number(data) : maxRetries;
            const now = new Date().toISOString();
            let revived = 0;
            while (true) {
              const doc = await col.findOneAndUpdate(
                { queue: queueName + ".dead_letter", attempts: { $lt: mr } },
                { $set: { status: "pending", availableAt: now, reservedAt: null, queue: queueName, error: null } },
                { returnDocument: "after" },
              );
              const updated = doc && doc.value ? doc.value : (doc && doc._id ? doc : null);
              if (!updated) break;
              revived++;
            }
            process.stdout.write(String(revived));
          }
          else if (operation === "purge") {
            // Delete docs by status (default: every doc for the topic).
            // Pre-3.13.105 this filtered by { queue: queueName, status } for
            // EVERY status -- correct for pending/reserved/completed, wrong
            // for the dead-letter states (dead/failed/dead_letter) which
            // live under queueName + ".dead_letter" and carry status "dead".
            // A purge("dead") therefore deleted nothing and returned 0.
            // data = JSON { status }.
            const info = data ? JSON.parse(data) : {};
            const isDead = info.status && ["dead", "failed", "dead_letter"].includes(info.status);
            const filter = isDead
              ? { queue: queueName + ".dead_letter" }
              : (info.status
                ? { queue: queueName, status: info.status }
                : { queue: queueName });
            const res = await col.deleteMany(filter);
            process.stdout.write(String(res.deletedCount || 0));
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

  popById(queue: string, id: string): QueueJob | null {
    const out = this.execSync("popById", queue, JSON.stringify({ id }));
    if (!out || out === "__EMPTY__") return null;
    try {
      return JSON.parse(out) as QueueJob;
    } catch {
      return null;
    }
  }

  push(queue: string, payload: unknown, delay?: number, priority?: number): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    const job = {
      id,
      payload,
      status: "pending",
      createdAt: now,
      attempts: 0,
      delayUntil: delay ? new Date(Date.now() + delay * 1000).toISOString() : null,
      // The pop sort has always been { priority: -1, createdAt: 1 }, but this
      // field was never written, so every job scored undefined and the queue
      // ran pure FIFO. Priority did not even reach here: the backend interface
      // had no such parameter and Queue.push dropped it for external backends.
      priority: priority ?? 0,
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

  /**
   * Acknowledge a completed job — drop its reservation so the reclaim never
   * re-delivers it. Without this a Mongo-popped job stayed reserved and was
   * re-delivered after the visibility window (the redelivery bug).
   */
  complete(queue: string, id: string): void {
    this.execSync("complete", queue, id);
  }

  /**
   * Record a failed attempt: requeue (reset availableAt, ++attempts) while
   * retries remain, else dead-letter. Mirrors the file/lite backend.
   */
  fail(queue: string, id: string, error: string, maxRetries: number, retryBackoff: number = 0): void {
    this.execSync("fail", queue, JSON.stringify({ id, error, maxRetries, retryBackoff }));
  }

  /**
   * Revive a specific dead-letter job by id. Returns true if the DL was found
   * and revived, false otherwise (parity with LiteBackend.retry(queue, id)
   * and Python's mongo_backend.retry_job()). Pre-3.13.105 this returned void
   * and Queue.retry(id) reported success for every call, even for unknown ids.
   */
  retry(queue: string, id: string, delaySeconds: number = 0): boolean {
    const out = this.execSync("retry", queue, JSON.stringify({ id, delaySeconds }));
    return out.includes("__OK__");
  }

  /** Jobs that exceeded max retries (the `<queue>.dead_letter` collection topic). */
  deadLetters(queue: string, maxRetries?: number): QueueJob[] {
    const out = this.execSync("deadLetters", queue, String(maxRetries ?? this.maxRetries));
    try { return JSON.parse(out) as QueueJob[]; } catch { return []; }
  }

  /** Jobs that failed but are still eligible for retry (status=failed, attempts < max). */
  failed(queue: string, maxRetries?: number): QueueJob[] {
    const out = this.execSync("failed", queue, String(maxRetries ?? this.maxRetries));
    try { return JSON.parse(out) as QueueJob[]; } catch { return []; }
  }

  /** Revive dead-lettered jobs under the (possibly raised) limit. Returns count revived. */
  retryFailed(queue: string, maxRetries?: number): number {
    const out = this.execSync("retryFailed", queue, String(maxRetries ?? this.maxRetries));
    return parseInt(out, 10) || 0;
  }

  /** Remove jobs by status (default: every doc for the topic). Returns count removed. */
  purge(queue: string, status?: string): number {
    const out = this.execSync("purge", queue, JSON.stringify({ status: status ?? "" }));
    return parseInt(out, 10) || 0;
  }

  /**
   * Release the MongoDB connection. Idempotent — a second call is a no-op.
   *
   * HONEST CAVEAT, and it is the whole reason ADR-0022 exists: THIS backend
   * holds no connection between calls to release. Every operation runs in its
   * own child process (see execSync/buildScript), and that child's `finally`
   * already does `await client.close()` before it exits — so the pool it opened
   * is gone by the time the method returns. Unlike tina4-python, tina4-php and
   * tina4-ruby, whose Mongo/broker backends hold a long-lived client that this
   * method genuinely hands back, Node has nothing to give back.
   *
   * It is implemented anyway, and required by the QueueBackend interface,
   * because the CONTRACT is what matters: `Queue.close()` must be callable on
   * every backend in every framework, and the day the persistent-connection
   * rewrite lands (ADR-0022's tracked fix) the client goes here with no change
   * at any call site. A method that is a no-op today and correct forever beats
   * a missing method the caller has to feature-detect.
   */
  close(): void {
    // Nothing held: the per-operation child process owns and closes its client.
  }
}

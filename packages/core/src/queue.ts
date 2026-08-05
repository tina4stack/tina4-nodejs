/**
 * Tina4 Queue — Unified job queue with pluggable backends, zero dependencies.
 *
 * Switching from file to MongoDB is a .env change — no code change needed.
 *
 * Supported backends:
 *   - 'file'     — JSON files on disk (default)
 *   - 'mongodb'  — MongoDB via `mongodb` npm package (also 'mongo')
 *
 * REFUSED backends (ADR-0022):
 *   - 'rabbitmq' and 'kafka' THROW on construction. Node drives both through a
 *     child process per operation, so no connection survives between pop() and
 *     complete() and acknowledgement is impossible: RabbitMQ was at-most-once
 *     (a dead consumer lost the job) and Kafka could never drain a topic. They
 *     lost work silently, so they now refuse. tina4-python, tina4-php and
 *     tina4-ruby still offer both. See unsupportedBrokerMessage() below.
 *
 * Environment variables:
 *   TINA4_QUEUE_BACKEND — 'file' or 'mongodb'
 *   TINA4_QUEUE_URL     — connection URL for mongodb
 *   TINA4_QUEUE_PATH    — file backend storage path (default: data/queue)
 *
 * Usage:
 *   import { Queue } from "@tina4/core";
 *
 *   // Auto-detect from env (default: file)
 *   const queue = new Queue({ topic: "emails" });
 *   queue.push({ to: "alice@test.com", subject: "Hello" });
 *
 *   // Explicit backend
 *   const queue = new Queue({ topic: "tasks", backend: "mongodb" });
 *
 *   // Legacy usage (still works — uses file backend)
 *   const queue = new Queue();
 *   queue.push("emails", { to: "alice@test.com" });
 */
import { MongoBackend } from "./queueBackends/mongoBackend.js";
import { LiteBackend } from "./queueBackends/liteBackend.js";
import { type QueueJob, type JobData, createJob } from "./job.js";

export { LiteBackend } from "./queueBackends/liteBackend.js";

export { type QueueJob } from "./job.js";

// ── Types ────────────────────────────────────────────────────

export interface QueueConfig {
  backend?: string;
  path?: string;
  topic?: string;
  maxRetries?: number;
  /**
   * Seconds to delay a failed job's automatic re-enqueue. 0 (the default)
   * means retry immediately — the next pop()/consume() iteration picks it up
   * straight away. Parity with Python's retry_backoff.
   */
  retryBackoff?: number;
  /**
   * Reservation/visibility timeout (seconds). A popped job is reserved for this
   * long; if the consumer dies before complete()/fail() (crash, OOM, k8s
   * eviction) the next pop() reclaims it — incrementing attempts and
   * re-enqueuing, or dead-lettering past maxRetries (at-least-once delivery).
   * Falls back to TINA4_QUEUE_VISIBILITY_TIMEOUT, else 300 (5 min). <= 0
   * disables the reclaim (a reservation then lasts until the consumer acks —
   * the old at-most-once behaviour). File + MongoDB backends, which are the
   * only backends Node offers (ADR-0022). Parity with Python's
   * visibility_timeout.
   */
  visibilityTimeout?: number;
}

/**
 * Where the file-backed queue stores its jobs — `TINA4_QUEUE_PATH`, else
 * `data/queue` (relative to the working directory).
 *
 * Exported because it is the ONE answer to "where do the queue files live",
 * and anything that reads the store directly (the dev-admin queue panel) must
 * ask here rather than re-deriving it. The dev admin hardcoded
 * `cwd/data/queue/<topic>` and so listed a DIFFERENT directory from the one
 * `Queue.size()` counted the moment `TINA4_QUEUE_PATH` was set.
 */
export function queueBasePath(): string {
  return process.env.TINA4_QUEUE_PATH ?? "data/queue";
}

/**
 * Reservation/visibility timeout in seconds, from env (default 300 = 5 min).
 * Mirrors Python's _default_visibility_timeout().
 */
function defaultVisibilityTimeout(): number {
  const raw = process.env.TINA4_QUEUE_VISIBILITY_TIMEOUT;
  if (raw === undefined || raw === "") return 300;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 300;
}

export interface ProcessOptions {
  pollInterval?: number;
  maxJobs?: number;
  maxRetries?: number;
  batchSize?: number;
  /**
   * Override the queue's topic for this drain (parity with Python's
   * process(handler, topic=...)). When set, process() retargets the queue so
   * pop() reads the requested topic instead of the construction-time one.
   */
  topic?: string;
}

export interface ConsumeOptions {
  /** Topic to consume (defaults to the constructor topic). */
  topic?: string;
  batchSize?: number;
  pollInterval?: number;
  iterations?: number;
  id?: string;
}

export interface QueueBackendInterface {
  push(queue: string, payload: unknown, delay?: number, priority?: number): string;
  pop(queue: string): QueueJob | null;
  size(queue: string): number;
  clear(queue: string): void;
  /**
   * Release whatever connection the backend holds, and be safe to call twice.
   *
   * REQUIRED, not optional, and deliberately so: it mirrors PHP's
   * Tina4\Queue\QueueBackend, where close() has always been part of the
   * interface. Optional would reintroduce exactly the bug this closes — a
   * caller feature-detecting `backend.close?.()` silently skips the backend
   * that forgot to implement it, which is how tina4-ruby's lite backend went
   * un-closed by every `respond_to?(:close)` guard in its tree.
   */
  close(): void;
  // Optional full lifecycle. Reservation-based backends (MongoDB) implement
  // these so complete()/fail() ack the ACTIVE store — without complete(), a
  // reserved Mongo job is re-delivered after the visibility window.
  //
  // Optional is a wart, not a design: a backend that omitted them silently fell
  // through to the LOCAL FILE store, so a fail() on a broker-backed queue wrote
  // JSON to disk while the broker still held the message. The only backends
  // that did that were RabbitMQ and Kafka, and ADR-0022 now refuses both, so
  // nothing in tree relies on the fallback. Make these required when the
  // persistent-connection rewrite lands.
  complete?(queue: string, id: string): void;
  fail?(queue: string, id: string, error: string, maxRetries: number, retryBackoff: number): void;
  retry?(queue: string, id: string, delaySeconds?: number): void;
  deadLetters?(queue: string, maxRetries?: number): QueueJob[];
  failed?(queue: string, maxRetries?: number): QueueJob[];
  retryFailed?(queue: string, maxRetries?: number): number;
  purge?(queue: string, status?: string): number;
}

/**
 * Why `backend: "rabbitmq"` and `backend: "kafka"` are refused in Node (ADR-0022).
 *
 * Both backends drive the wire protocol through `execFileSync`, spawning a fresh
 * child process for EVERY operation. The child connects, performs one operation,
 * destroys its socket and exits, so no connection, channel, consumer or session
 * survives between push, pop and complete.
 *
 * That makes acknowledgement impossible, not merely unimplemented. An AMQP
 * delivery tag identifies a delivery on a CHANNEL that is already closed by the
 * time pop() returns, and a Kafka consumer-group offset belongs to a SESSION
 * that never existed. So RabbitMQ ran Basic.Get with no-ack=true (at-most-once:
 * a consumer that dies after pop() loses the job outright) and Kafka fetched
 * from offset 0 every time (the topic could never drain).
 *
 * Refusing loudly follows the same call the session backend already made for
 * `redis-npm`: a silent demotion looks like it is working while the operator
 * believes otherwise, which is worse than an outage you can see. Anyone
 * "successfully" running these today is already losing jobs and does not know it.
 *
 * This is a HOLDING POSITION, not the design. The fix is a persistent
 * connection held on the backend instance, the way Python, PHP and Ruby already
 * do it. There is deliberately no opt-in escape hatch: nobody has asked for
 * fire-and-forget, and a knob for a hypothetical user is not worth its weight.
 */
function unsupportedBrokerMessage(backendName: string): string {
  const broker = backendName === "kafka" ? "Kafka" : "RabbitMQ";
  const lost = backendName === "kafka"
    ? "every pop() re-read offset 0, so the topic could never drain"
    : "pop() destroyed the message with no acknowledgement, so a consumer that died lost the job";
  return (
    `Queue backend "${backendName}" is not available in tina4-nodejs.\n\n` +
    `Reason: the ${broker} backend runs each operation in a separate child ` +
    `process, so no connection survives between pop() and complete(). ` +
    `Acknowledgement is therefore impossible, and ${lost}. It was losing work ` +
    `silently, so it now refuses instead.\n\n` +
    `Use backend "mongodb" (at-least-once, with a real reservation and ` +
    `visibility timeout) or the default "file" backend. tina4-python, ` +
    `tina4-php and tina4-ruby still offer ${broker}.\n\n` +
    `Tracking: ADR-0022 in tina4-documentation/plan/v3/DECISIONS.md, ` +
    `findings in plan/v3/features/048-queue-backends.md.`
  );
}

// ── Queue ────────────────────────────────────────────────────

export class Queue {
  private backendName: string;
  private basePath: string;
  private topic: string;
  private _maxRetries: number;
  private _retryBackoff: number;
  private _visibilityTimeout: number;
  private externalBackend: QueueBackendInterface | null = null;
  private liteBackend!: LiteBackend;

  /**
   * Unified Queue constructor.
   *
   * Accepts either:
   *   - new Queue({ topic: "tasks", backend: "mongodb" })
   *   - new Queue("mongodb", { path: "data/queue" })  // legacy
   *   - new Queue()  // file backend, default topic
   *
   * Throws on backend "rabbitmq" or "kafka" (ADR-0022).
   */
  constructor(backendOrConfig?: string | QueueConfig, config?: QueueConfig) {
    let resolvedConfig: QueueConfig = {};

    if (typeof backendOrConfig === "string") {
      // Legacy: new Queue("mongodb", { ... })
      resolvedConfig = { ...(config ?? {}), backend: backendOrConfig };
    } else if (typeof backendOrConfig === "object" && backendOrConfig !== null) {
      resolvedConfig = backendOrConfig;
    }

    // Normalised (trimmed + lowercased) so " MongoDB " resolves, matching the
    // Python master, Ruby and PHP. An unrecognised value THROWS below.
    this.backendName = String(
      resolvedConfig.backend ?? process.env.TINA4_QUEUE_BACKEND ?? "file",
    ).trim().toLowerCase();
    this.basePath = resolvedConfig.path ?? queueBasePath();
    this.topic = resolvedConfig.topic ?? "default";
    this._maxRetries = resolvedConfig.maxRetries ?? 3;
    this._retryBackoff = resolvedConfig.retryBackoff ?? 0;
    this._visibilityTimeout = resolvedConfig.visibilityTimeout ?? defaultVisibilityTimeout();
    this.liteBackend = new LiteBackend(this.basePath, this._visibilityTimeout);

    // Initialize external backends
    if (this.backendName === "rabbitmq" || this.backendName === "kafka") {
      throw new Error(unsupportedBrokerMessage(this.backendName));
    } else if (this.backendName === "mongodb" || this.backendName === "mongo") {
      this.externalBackend = new MongoBackend({ visibilityTimeout: this._visibilityTimeout });
    } else if (!["file", "default", "lite"].includes(this.backendName)) {
      // An UNRECOGNISED backend name THROWS rather than falling through to the
      // local file store.
      //
      // MEASURED 2026-08-03: a typo in TINA4_QUEUE_BACKEND produced a running
      // app writing every job to local disk while the operator believed they
      // were in MongoDB - jobs nothing consumes, on a container filesystem that
      // vanishes on the next deploy, with no error at any point. Python and Ruby
      // already raise here; this is the same rule the session backend adopted
      // for the same reason.
      throw new Error(
        `Unknown queue backend: '${this.backendName}'. ` +
          `Use 'file', 'rabbitmq', 'kafka', or 'mongodb'.`,
      );
    }
  }

  /**
   * Point this queue at ``topic`` in place.
   *
   * produce()/consume()/process() call this so a topic argument actually
   * changes which topic is read or written. Without it the argument was
   * accepted but ignored on the read path — pop() always used the
   * construction-time topic, so consume("other") silently drained the wrong
   * queue. The lite + external backends are topic-per-call (every push/pop/size
   * takes the queue name), so changing this.topic retargets all of them; the
   * job lifecycle (complete()/fail()/retry()) routes by the job's own .topic, so
   * it is unaffected. Mirrors Python's Queue._retarget().
   */
  private retarget(topic: string): void {
    this.topic = topic;
  }

  // ── Unified API (topic-aware) ────────────────────────────────

  /**
   * Add a job to the queue. Returns job ID.
   *
   * Can be called as:
   *   queue.push(payload)                — uses constructor topic
   *   queue.push(payload, delay)         — uses constructor topic with delay
   *   queue.push(payload, delay, priority) — with delay and priority
   *
   * @param priority — Higher value = higher priority. Default 0.
   */
  push(payload: unknown, delay?: number, priority: number = 0): string {
    if (this.externalBackend) {
      // priority goes to the external backend too. It used to be passed only to
      // liteBackend, so switching to mongodb silently turned a prioritised
      // queue into a FIFO one.
      return this.externalBackend.push(this.topic, payload, delay, priority);
    }
    return this.liteBackend.push(this.topic, payload, delay, priority);
  }

  /**
   * Atomically claim the next available job from this queue's topic. Returns null if empty.
   */
  pop(): QueueJob | null {
    const q = this.topic;

    if (this.externalBackend) {
      const raw = this.externalBackend.pop(q);
      // Wrap it. An external backend returns PLAIN DATA with no lifecycle
      // methods, so `queue.pop().fail("boom")` threw
      // "TypeError: j.fail is not a function" on mongodb/rabbitmq/kafka while
      // working on file — identical application code, different outcome, which
      // is exactly what ADR-0024 forbids. createJob attaches
      // complete()/fail()/reject()/retry(), and they route back through
      // _completeJob/_failJob, which already dispatch to the external backend.
      return raw ? createJob(raw as any, this) : null;
    }
    return this.liteBackend.pop(q, this);
  }

  /**
   * Pop up to count jobs at once. Returns a partial batch if fewer available.
   */
  popBatch(count: number): QueueJob[] {
    // Route to the CONFIGURED backend. This used to read the LOCAL FILE STORE
    // unconditionally, so a mongodb-backed queue always came back empty.
    // Repeated pop() is the correct batch on an external backend: each claim is
    // atomic, and a short batch simply means the queue drained.
    if (this.externalBackend) {
      const jobs: QueueJob[] = [];
      for (let i = 0; i < count; i++) {
        const job = this.pop();
        if (!job) break;
        jobs.push(job);
      }
      return jobs;
    }
    return this.liteBackend.popBatch(this.topic, this, count);
  }

  /**
   * Process jobs from a queue with a handler function.
   */
  process(
    handler: (job: QueueJob | QueueJob[]) => Promise<void> | void,
    options?: ProcessOptions,
  ): void {
    // Honour an explicit topic: retarget so pop() drains the requested topic
    // (parity with Python's process(handler, topic=...)). Without this the
    // argument was accepted but ignored on the read path.
    if (options?.topic !== undefined) {
      this.retarget(options.topic);
    }
    const queue = this.topic;
    const opts = options;

    const maxJobs = opts?.maxJobs ?? Infinity;
    const maxRetries = opts?.maxRetries ?? this._maxRetries;
    const batchSize = opts?.batchSize;
    let processed = 0;

    if (batchSize && batchSize > 1) {
      while (processed < maxJobs) {
        const remaining = maxJobs === Infinity ? batchSize : Math.min(batchSize, maxJobs - processed);
        const jobs = this.popBatch(remaining);
        if (jobs.length === 0) break;
        try {
          const result = handler(jobs);
          if (result instanceof Promise) {
            result.catch((err: Error) => {
              for (const job of jobs) this._failJob(queue, job, err.message, maxRetries);
            });
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          for (const job of jobs) this._failJob(queue, job, message, maxRetries);
        }
        processed += jobs.length;
      }
    } else {
      while (processed < maxJobs) {
        const job = this.pop();
        if (!job) break;
        try {
          const result = handler(job);
          if (result instanceof Promise) {
            result.catch((err: Error) => {
              this._failJob(queue, job, err.message, maxRetries);
            });
          }
          processed++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this._failJob(queue, job, message, maxRetries);
          processed++;
        }
      }
    }
  }

  /**
   * Count jobs filtered by status. Defaults to "pending".
   */
  size(status: string = "pending"): number {
    const q = this.topic;

    if (this.externalBackend) {
      return this.externalBackend.size(q);
    }
    return this.liteBackend.size(q, status);
  }

  /**
   * Remove all jobs from this queue's topic. Returns the number cleared.
   */
  clear(): number {
    const q = this.topic;

    if (this.externalBackend) {
      this.externalBackend.clear(q);
      return 0;
    }
    return this.liteBackend.clear(q);
  }

  /**
   * Release the backend's connection and free its resources.
   *
   * MEASURED 2026-08-04: close() was absent on the top-level Queue in ALL FOUR
   * frameworks, and in Node it was absent on every backend class too — so an
   * application had no way at all to hand a queue's client back. Same class of
   * leak as ADR-0025 corollary 4 (client-lifecycle-is-bounded).
   *
   * Safe on EVERY backend: the file backend holds no connection and closes as a
   * documented no-op, so a TINA4_QUEUE_BACKEND change never turns a working
   * shutdown path into an error. Idempotent — each backend drops its handles on
   * the first call, so a second call finds nothing to close and returns.
   *
   * HONEST CAVEAT specific to Node: neither backend it can reach holds a
   * connection between calls today. The Mongo backend runs each operation in
   * its own child process (ADR-0022), which closes its own client before it
   * exits, and rabbitmq/kafka are refused outright at construction. So this
   * releases nothing YET — it is here for the contract, and because the day the
   * persistent-connection rewrite lands the client is released here with no
   * change at any call site. Python, PHP and Ruby release a REAL client through
   * the identically-named method.
   *
   * Treat the queue as spent afterwards and build a new one to keep working.
   */
  close(): void {
    (this.externalBackend ?? this.liteBackend).close();
  }

  /**
   * Get jobs that failed at least once but are still being retried
   * (0 < attempts < maxRetries). These live in the pending queue under the
   * auto-retry lifecycle; dead-lettered jobs are returned by deadLetters().
   */
  failed(): QueueJob[] {
    if (this.externalBackend?.failed) {
      return this.externalBackend.failed(this.topic, this._maxRetries);
    }
    return this.liteBackend.failed(this.topic, this._maxRetries);
  }

  /**
   * Retry all dead letter jobs for this queue's topic.
   * Moves failed jobs that exceeded max retries back to pending.
   *
   * @param delaySeconds - Optional delay before jobs become available
   * @returns true if at least one job was re-queued, false if none found
   */
  retry(jobId?: string, delaySeconds?: number): boolean {
    if (jobId) {
      // Retry a specific job by ID
      if (this.externalBackend?.retry) {
        this.externalBackend.retry(this.topic, jobId, delaySeconds);
        return true;
      }
      return this.liteBackend.retry(this.topic, jobId, delaySeconds);
    }
    // Retry all dead-letter jobs
    const deadJobs = this.deadLetters();
    if (deadJobs.length === 0) return false;
    let retried = false;
    for (const job of deadJobs) {
      if (this.externalBackend?.retry) {
        this.externalBackend.retry(this.topic, job.id, delaySeconds);
        retried = true;
      } else if (this.liteBackend.retry(this.topic, job.id, delaySeconds)) {
        retried = true;
      }
    }
    return retried;
  }

  /**
   * Get dead letter jobs — failed jobs that exceeded max retries.
   */
  deadLetters(maxRetries?: number): QueueJob[] {
    if (this.externalBackend?.deadLetters) {
      return this.externalBackend.deadLetters(this.topic, maxRetries ?? this._maxRetries);
    }
    return this.liteBackend.deadLetters(this.topic, maxRetries ?? this._maxRetries);
  }

  /**
   * Delete messages by status (e.g. "completed", "failed", "dead").
   */
  purge(status: string, maxRetries?: number): number {
    if (this.externalBackend?.purge) {
      return this.externalBackend.purge(this.topic, status);
    }
    return this.liteBackend.purge(this.topic, status, maxRetries ?? this._maxRetries);
  }

  /**
   * Re-queue failed jobs that haven't exceeded max retries back to pending.
   */
  retryFailed(maxRetries?: number): number {
    if (this.externalBackend?.retryFailed) {
      return this.externalBackend.retryFailed(this.topic, maxRetries ?? this._maxRetries);
    }
    return this.liteBackend.retryFailed(this.topic, maxRetries ?? this._maxRetries);
  }

  /**
   * Produce a message onto a topic. Convenience wrapper around push().
   *
   * Retargets to the requested topic (restoring the prior one afterwards) so it
   * shares the same retarget path consume()/process() use — keeping produce and
   * consume symmetric on the same topic argument.
   */
  produce(topic: string, payload: unknown, priority: number = 0, delay: number = 0): string {
    const previous = this.topic;
    this.retarget(topic);
    try {
      return this.push(payload, delay, priority);
    } finally {
      this.retarget(previous);
    }
  }

  /**
   * Consume jobs from a topic using a generator (yield pattern).
   *
   * Usage:
   *   for (const job of queue.consume("emails")) {
   *       processEmail(job);
   *   }
   *
   *   // Consume a specific job by ID:
   *   for (const job of queue.consume("emails", "job-id-123")) {
   *       processEmail(job);
   *   }
   */
  /**
   * Long-running async generator that polls the queue continuously.
   * When empty, sleeps for pollInterval ms before polling again.
   * No external while-loop or sleep needed.
   *
   * @param topic Queue topic (defaults to constructor topic)
   * @param id Optional job ID — single yield, no polling
   * @param pollInterval Milliseconds to sleep when queue is empty (default 1000)
   *
   * Usage:
   *   for await (const job of queue.consume("emails")) { ... }
   *   for await (const job of queue.consume("emails", undefined, 5000)) { ... }
   */
  async *consume(topicOrOptions?: string | ConsumeOptions, id?: string, pollInterval: number = 1000, iterations: number = 0, batchSize: number = 1): AsyncGenerator<QueueJob | QueueJob[]> {
    // Support options-object form: consume({ batchSize, pollInterval, iterations, id })
    let q: string;
    let resolvedId: string | undefined;
    let resolvedPollInterval: number;
    let resolvedIterations: number;
    let resolvedBatchSize: number;

    if (topicOrOptions !== null && typeof topicOrOptions === "object") {
      const opts = topicOrOptions as ConsumeOptions;
      // Honour opts.topic (parity with the string-arg form) — previously the
      // options-object form ignored it and always drained the constructor topic.
      q = opts.topic ?? this.topic;
      resolvedId = opts.id;
      resolvedPollInterval = opts.pollInterval ?? 1000;
      resolvedIterations = opts.iterations ?? 0;
      resolvedBatchSize = opts.batchSize ?? batchSize;
    } else {
      q = (topicOrOptions as string | undefined) ?? this.topic;
      resolvedId = id;
      resolvedPollInterval = pollInterval;
      resolvedIterations = iterations;
      resolvedBatchSize = batchSize;
    }

    // Honour the topic argument: point the queue (and the backend pop()/
    // popById() route through) at it. Previously the resolved topic was
    // computed but never used — pop()/popById() read this.topic, so
    // consume("other") silently drained the construction-time topic.
    this.retarget(q);

    if (resolvedId !== undefined) {
      const raw = this.popById(resolvedId);
      if (raw) yield createJob(raw as any, this);
      return;
    }

    // pollInterval=0 → single-pass drain (returns when empty)
    // pollInterval>0 → long-running poll (sleeps when empty, never returns)
    // iterations>0   → stop after consuming N jobs (or N batches when batchSize>1)
    let consumed = 0;
    while (true) {
      if (resolvedBatchSize && resolvedBatchSize > 1) {
        const jobs = this.popBatch(resolvedBatchSize);
        if (jobs.length === 0) {
          if (resolvedPollInterval <= 0) break;
          await new Promise(resolve => setTimeout(resolve, resolvedPollInterval));
          continue;
        }
        yield jobs;
        consumed++;
        if (resolvedIterations > 0 && consumed >= resolvedIterations) break;
      } else {
        const raw = this.pop() as any;
        if (raw === null) {
          if (resolvedPollInterval <= 0) break;
          await new Promise(resolve => setTimeout(resolve, resolvedPollInterval));
          continue;
        }
        yield createJob(raw, this);
        consumed++;
        if (resolvedIterations > 0 && consumed >= resolvedIterations) break;
      }
    }
  }

  /**
   * Pop a specific job by ID from this queue's topic.
   */
  popById(id: string): QueueJob | null {
    // Same defect as popBatch: this read the local file store on every backend.
    if (this.externalBackend) {
      const claim = (this.externalBackend as any).popById;
      if (typeof claim !== "function") {
        throw new Error(
          `The ${this.backendName} queue backend cannot perform popById(): it ` +
          `cannot address a single message by id. Use the file or mongodb backend.`,
        );
      }
      // Same shape as pop() — and, like pop(), PLAIN DATA with no lifecycle
      // methods, so it must be wrapped or job.complete()/job.fail() is a
      // TypeError on every external backend.
      const raw = claim.call(this.externalBackend, this.topic, id);
      return raw ? createJob(raw as any, this) : null;
    }
    return this.liteBackend.popById(this.topic, id);
  }

  /**
   * Get the configured topic name.
   */
  getTopic(): string {
    return this.topic;
  }

  getMaxRetries(): number {
    return this._maxRetries;
  }

  getRetryBackoff(): number {
    return this._retryBackoff;
  }

  /**
   * Resolved reservation/visibility timeout (seconds). <= 0 means the reclaim
   * is disabled. File + MongoDB backends honour it; RabbitMQ/Kafka delegate to
   * the broker.
   */
  getVisibilityTimeout(): number {
    return this._visibilityTimeout;
  }

  /**
   * Record a failed attempt for a job. The backend increments `attempts`
   * exactly once and decides whether to re-enqueue (attempts < maxRetries,
   * after retryBackoff seconds) or dead-letter (attempts >= maxRetries).
   */
  _failJob(queue: string, job: QueueJob, error: string, maxRetries: number): void {
    if (this.externalBackend?.fail) {
      this.externalBackend.fail(queue, job.id, error, maxRetries, this._retryBackoff);
      return;
    }
    this.liteBackend.failJob(queue, job, error, maxRetries, this._retryBackoff);
  }

  /**
   * Re-queue a job back to the main queue directory with incremented attempts.
   */
  _retryJob(queue: string, job: QueueJob, delaySeconds?: number): void {
    if (this.externalBackend?.retry) {
      this.externalBackend.retry(queue, job.id, delaySeconds);
      return;
    }
    this.liteBackend.retryJob(queue, job, delaySeconds);
  }

  /**
   * Acknowledge a completed job — drop its reservation so the visibility reclaim
   * never re-delivers it. Routes to the active backend: a reservation-based
   * external backend (MongoDB) acks there (without this its reserved doc would
   * be re-delivered after the visibility window); RabbitMQ (no-ack on get) and
   * Kafka (offset-based) expose no complete(), so the lite path is used and is a
   * harmless no-op for them since they already acked/own redelivery.
   */
  _completeJob(queue: string, job: QueueJob): void {
    if (this.externalBackend?.complete) {
      this.externalBackend.complete(queue, job.id);
      return;
    }
    this.liteBackend.completeJob(queue, job);
  }
}

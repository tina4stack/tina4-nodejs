/**
 * Tina4 Queue — Unified job queue with pluggable backends, zero dependencies.
 *
 * Switching from file to RabbitMQ or Kafka is a .env change — no code change needed.
 *
 * Supported backends:
 *   - 'file'     — JSON files on disk (default)
 *   - 'rabbitmq' — RabbitMQ via raw TCP (AMQP 0-9-1)
 *   - 'kafka'    — Kafka via raw TCP
 *   - 'mongodb'  — MongoDB via `mongodb` npm package (also 'mongo')
 *
 * Environment variables:
 *   TINA4_QUEUE_BACKEND — 'file', 'rabbitmq', 'kafka', or 'mongodb'
 *   TINA4_QUEUE_URL     — connection URL for rabbitmq/kafka
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
 *   const queue = new Queue({ topic: "tasks", backend: "rabbitmq" });
 *
 *   // Legacy usage (still works — uses file backend)
 *   const queue = new Queue();
 *   queue.push("emails", { to: "alice@test.com" });
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface QueueConfig {
  backend?: string;
  path?: string;
  topic?: string;
  maxRetries?: number;
}

export interface QueueJob {
  id: string;
  payload: unknown;
  status: "pending" | "reserved" | "failed" | "dead" | "completed";
  createdAt: string;
  attempts: number;
  delayUntil: string | null;
  error?: string;
  /** Mark this job as completed. */
  complete(): void;
  /** Mark this job as failed with a reason. */
  fail(reason?: string): void;
  /** Reject this job with a reason. Alias for fail(). */
  reject(reason?: string): void;
}

/** Create a QueueJob with lifecycle methods bound to a Queue instance. */
function createJob(data: Omit<QueueJob, "complete" | "fail" | "reject">, queue: Queue, topic: string): QueueJob {
  const job: QueueJob = {
    ...data,
    complete() {
      job.status = "completed";
    },
    fail(reason = "") {
      job.status = "failed";
      job.error = reason;
      job.attempts = (job.attempts || 0) + 1;
      queue._failJob(topic, job, reason, queue.getMaxRetries());
    },
    reject(reason = "") {
      job.fail(reason);
    },
  };
  return job;
}

export interface ProcessOptions {
  pollInterval?: number;
  maxJobs?: number;
  maxRetries?: number;
}

export interface QueueBackendInterface {
  push(queue: string, payload: unknown, delay?: number): string;
  pop(queue: string): QueueJob | null;
  size(queue: string): number;
  clear(queue: string): void;
}

// ── Queue ────────────────────────────────────────────────────

export class Queue {
  private backendName: string;
  private basePath: string;
  private topic: string;
  private _maxRetries: number;
  private seq: number = 0;
  private externalBackend: QueueBackendInterface | null = null;

  /**
   * Unified Queue constructor.
   *
   * Accepts either:
   *   - new Queue({ topic: "tasks", backend: "rabbitmq" })
   *   - new Queue("rabbitmq", { path: "data/queue" })  // legacy
   *   - new Queue()  // file backend, default topic
   */
  constructor(backendOrConfig?: string | QueueConfig, config?: QueueConfig) {
    let resolvedConfig: QueueConfig = {};

    if (typeof backendOrConfig === "string") {
      // Legacy: new Queue("rabbitmq", { ... })
      resolvedConfig = { ...(config ?? {}), backend: backendOrConfig };
    } else if (typeof backendOrConfig === "object" && backendOrConfig !== null) {
      resolvedConfig = backendOrConfig;
    }

    this.backendName = resolvedConfig.backend
      ?? process.env.TINA4_QUEUE_BACKEND
      ?? "file";
    this.basePath = resolvedConfig.path
      ?? process.env.TINA4_QUEUE_PATH
      ?? "data/queue";
    this.topic = resolvedConfig.topic ?? "default";
    this._maxRetries = resolvedConfig.maxRetries ?? 3;

    // Initialize external backends
    if (this.backendName === "rabbitmq") {
      const { RabbitMQBackend } = require("./queueBackends/rabbitmqBackend.js");
      this.externalBackend = new RabbitMQBackend();
    } else if (this.backendName === "kafka") {
      const { KafkaBackend } = require("./queueBackends/kafkaBackend.js");
      this.externalBackend = new KafkaBackend();
    } else if (this.backendName === "mongodb" || this.backendName === "mongo") {
      const { MongoBackend } = require("./queueBackends/mongoBackend.js");
      this.externalBackend = new MongoBackend();
    }
  }

  // ── Directory helpers ────────────────────────────────────────

  private ensureDir(queue: string): string {
    const dir = join(this.basePath, queue);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private ensureFailedDir(queue: string): string {
    const dir = join(this.basePath, queue, "failed");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ── Unified API (topic-aware) ────────────────────────────────

  /**
   * Add a job to the queue. Returns job ID.
   *
   * Can be called as:
   *   queue.push(payload)                 — uses constructor topic
   *   queue.push(payload, delay)          — uses constructor topic with delay
   *   queue.push("queueName", payload)    — legacy: explicit queue name
   */
  push(queueOrPayload: string | unknown, payloadOrDelay?: unknown, delay?: number): string {
    let queue: string;
    let payload: unknown;
    let actualDelay: number | undefined;

    if (typeof queueOrPayload === "string" && payloadOrDelay !== undefined && typeof payloadOrDelay !== "number") {
      // Legacy: push("queueName", payload, delay?)
      queue = queueOrPayload;
      payload = payloadOrDelay;
      actualDelay = delay;
    } else {
      // Unified: push(payload) or push(payload, delay)
      queue = this.topic;
      payload = queueOrPayload;
      actualDelay = typeof payloadOrDelay === "number" ? payloadOrDelay : delay;
    }

    if (this.externalBackend) {
      return this.externalBackend.push(queue, payload, actualDelay);
    }
    const dir = this.ensureDir(queue);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.seq++;

    const job: QueueJob = {
      id,
      payload,
      status: "pending",
      createdAt: now,
      attempts: 0,
      delayUntil: actualDelay ? new Date(Date.now() + actualDelay * 1000).toISOString() : null,
    };

    const prefix = `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
    writeFileSync(join(dir, `${prefix}_${id}.json`), JSON.stringify(job, null, 2));
    return id;
  }

  /**
   * Atomically claim the next available job. Returns null if empty.
   *
   * Can be called as:
   *   queue.pop()            — uses constructor topic
   *   queue.pop("queueName") — legacy: explicit queue name
   */
  pop(queue?: string): QueueJob | null {
    const q = queue ?? this.topic;

    if (this.externalBackend) {
      return this.externalBackend.pop(q);
    }
    const dir = this.ensureDir(q);

    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    } catch {
      return null;
    }

    const now = new Date().toISOString();

    for (const file of files) {
      const filePath = join(dir, file);
      let job: QueueJob;
      try {
        job = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        continue;
      }

      if (job.status !== "pending") continue;
      if (job.delayUntil && job.delayUntil > now) continue;

      job.status = "reserved";
      writeFileSync(filePath, JSON.stringify(job, null, 2));

      try {
        unlinkSync(filePath);
      } catch {
        // Already consumed by another worker
      }

      return job;
    }

    return null;
  }

  /**
   * Process jobs from a queue with a handler function.
   */
  process(
    handlerOrQueue: string | ((job: QueueJob) => Promise<void> | void),
    handlerOrOptions?: ((job: QueueJob) => Promise<void> | void) | ProcessOptions,
    options?: ProcessOptions,
  ): void {
    let queue: string;
    let handler: (job: QueueJob) => Promise<void> | void;
    let opts: ProcessOptions | undefined;

    if (typeof handlerOrQueue === "string") {
      // Legacy: process("queueName", handler, options)
      queue = handlerOrQueue;
      handler = handlerOrOptions as (job: QueueJob) => Promise<void> | void;
      opts = options;
    } else {
      // Unified: process(handler, options?)
      queue = this.topic;
      handler = handlerOrQueue;
      opts = handlerOrOptions as ProcessOptions | undefined;
    }

    const maxJobs = opts?.maxJobs ?? Infinity;
    const maxRetries = opts?.maxRetries ?? this._maxRetries;
    let processed = 0;

    while (processed < maxJobs) {
      const job = this.pop(queue);
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

  /**
   * Count pending jobs in a queue.
   */
  size(queue?: string): number {
    const q = queue ?? this.topic;

    if (this.externalBackend) {
      return this.externalBackend.size(q);
    }
    const dir = this.ensureDir(q);
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".json"));
    } catch {
      return 0;
    }

    let count = 0;
    for (const file of files) {
      try {
        const job: QueueJob = JSON.parse(readFileSync(join(dir, file), "utf-8"));
        if (job.status === "pending") count++;
      } catch {
        // skip corrupt files
      }
    }
    return count;
  }

  /**
   * Remove all jobs from a queue.
   */
  clear(queue?: string): void {
    const q = queue ?? this.topic;

    if (this.externalBackend) {
      this.externalBackend.clear(q);
      return;
    }
    const dir = this.ensureDir(q);
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        unlinkSync(join(dir, file));
      }
    } catch {
      // directory might not exist
    }

    // Also clear failed jobs
    const failedDir = join(dir, "failed");
    try {
      if (existsSync(failedDir)) {
        const files = readdirSync(failedDir).filter(f => f.endsWith(".json"));
        for (const file of files) {
          unlinkSync(join(failedDir, file));
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Get all failed jobs for a queue.
   */
  failed(queue?: string): QueueJob[] {
    const q = queue ?? this.topic;
    const failedDir = this.ensureFailedDir(q);
    const results: QueueJob[] = [];

    try {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".json")).sort();
      for (const file of files) {
        try {
          const job: QueueJob = JSON.parse(readFileSync(join(failedDir, file), "utf-8"));
          results.push(job);
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // directory might not exist
    }

    return results;
  }

  /**
   * Retry a failed job by moving it back to the queue.
   */
  retry(jobId: string): boolean {
    try {
      const queues = readdirSync(this.basePath);
      for (const queue of queues) {
        const failedDir = join(this.basePath, queue, "failed");
        const filePath = join(failedDir, `${jobId}.json`);

        if (existsSync(filePath)) {
          const job: QueueJob = JSON.parse(readFileSync(filePath, "utf-8"));
          job.status = "pending";
          job.attempts = (job.attempts || 0) + 1;
          job.error = undefined;

          this.seq++;
          const prefix = `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
          const queueDir = join(this.basePath, queue);
          writeFileSync(join(queueDir, `${prefix}_${jobId}.json`), JSON.stringify(job, null, 2));
          unlinkSync(filePath);
          return true;
        }
      }
    } catch {
      // ignore
    }

    return false;
  }

  /**
   * Get dead letter jobs — failed jobs that exceeded max retries.
   */
  deadLetters(queue?: string, maxRetries?: number): QueueJob[] {
    const q = queue ?? this.topic;
    const mr = maxRetries ?? this._maxRetries;
    const failedDir = this.ensureFailedDir(q);
    const results: QueueJob[] = [];

    try {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".json")).sort();
      for (const file of files) {
        try {
          const job: QueueJob = JSON.parse(readFileSync(join(failedDir, file), "utf-8"));
          if ((job.attempts || 0) >= mr) {
            job.status = "dead";
            results.push(job);
          }
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // directory might not exist
    }

    return results;
  }

  /**
   * Delete messages by status.
   */
  purge(statusOrQueue: string, statusOrMaxRetries?: string | number, maxRetries?: number): number {
    let queue: string;
    let status: string;
    let mr: number;

    if (typeof statusOrMaxRetries === "string") {
      // Legacy: purge("queueName", "status", maxRetries?)
      queue = statusOrQueue;
      status = statusOrMaxRetries;
      mr = maxRetries ?? this._maxRetries;
    } else {
      // Unified: purge("status") or purge("status", maxRetries)
      queue = this.topic;
      status = statusOrQueue;
      mr = typeof statusOrMaxRetries === "number" ? statusOrMaxRetries : (maxRetries ?? this._maxRetries);
    }

    let count = 0;

    if (status === "dead") {
      const failedDir = this.ensureFailedDir(queue);
      try {
        const files = readdirSync(failedDir).filter(f => f.endsWith(".json"));
        for (const file of files) {
          try {
            const job: QueueJob = JSON.parse(readFileSync(join(failedDir, file), "utf-8"));
            if ((job.attempts || 0) >= mr) {
              unlinkSync(join(failedDir, file));
              count++;
            }
          } catch {
            // skip corrupt files
          }
        }
      } catch {
        // directory might not exist
      }
    } else if (status === "failed") {
      const failedDir = this.ensureFailedDir(queue);
      try {
        const files = readdirSync(failedDir).filter(f => f.endsWith(".json"));
        for (const file of files) {
          try {
            const job: QueueJob = JSON.parse(readFileSync(join(failedDir, file), "utf-8"));
            if ((job.attempts || 0) < mr) {
              unlinkSync(join(failedDir, file));
              count++;
            }
          } catch {
            // skip corrupt files
          }
        }
      } catch {
        // directory might not exist
      }
    } else {
      const dir = this.ensureDir(queue);
      try {
        const files = readdirSync(dir).filter(f => f.endsWith(".json"));
        for (const file of files) {
          try {
            const job: QueueJob = JSON.parse(readFileSync(join(dir, file), "utf-8"));
            if (job.status === status) {
              unlinkSync(join(dir, file));
              count++;
            }
          } catch {
            // skip corrupt files
          }
        }
      } catch {
        // directory might not exist
      }
    }

    return count;
  }

  /**
   * Re-queue failed jobs that haven't exceeded max retries back to pending.
   */
  retryFailed(queue?: string, maxRetries?: number): number {
    const q = queue ?? this.topic;
    const mr = maxRetries ?? this._maxRetries;
    const failedDir = this.ensureFailedDir(q);
    const queueDir = this.ensureDir(q);
    let count = 0;

    try {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        try {
          const filePath = join(failedDir, file);
          const job: QueueJob = JSON.parse(readFileSync(filePath, "utf-8"));

          if ((job.attempts || 0) >= mr) {
            continue;
          }

          job.status = "pending";
          job.error = undefined;

          this.seq++;
          const prefix = `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
          writeFileSync(join(queueDir, `${prefix}_${job.id}.json`), JSON.stringify(job, null, 2));
          unlinkSync(filePath);
          count++;
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // directory might not exist
    }

    return count;
  }

  /**
   * Produce a message onto a topic. Convenience wrapper around push().
   */
  produce(topic: string, payload: unknown, delay?: number): string {
    return this.push(topic, payload, delay);
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
  *consume(topic?: string, id?: string): Generator<QueueJob> {
    const q = topic ?? this.topic;

    if (id !== undefined) {
      const raw = this.popById(q, id);
      if (raw) yield createJob(raw as any, this, q);
      return;
    }

    let raw: any;
    while ((raw = this.pop(q)) !== null) {
      yield createJob(raw, this, q);
    }
  }

  /**
   * Pop a specific job by ID from the queue.
   */
  popById(queue: string, id: string): QueueJob | null {
    const q = queue ?? this.topic;
    const dir = this.ensureDir(q);

    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".json"));
    } catch {
      return null;
    }

    for (const file of files) {
      const filePath = join(dir, file);
      let job: QueueJob;
      try {
        job = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        continue;
      }

      if (job.status !== "pending") continue;
      if (job.id === id) {
        try { unlinkSync(filePath); } catch { /* already consumed */ }
        return job;
      }
    }

    return null;
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

  /**
   * Move a job to the failed directory.
   */
  _failJob(queue: string, job: QueueJob, error: string, maxRetries: number): void {
    const failedDir = this.ensureFailedDir(queue);
    job.status = "failed";
    job.attempts = (job.attempts || 0) + 1;
    job.error = error;

    writeFileSync(join(failedDir, `${job.id}.json`), JSON.stringify(job, null, 2));
  }
}

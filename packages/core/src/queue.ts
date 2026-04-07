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
import { RabbitMQBackend } from "./queueBackends/rabbitmqBackend.js";
import { KafkaBackend } from "./queueBackends/kafkaBackend.js";
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
  private externalBackend: QueueBackendInterface | null = null;
  private liteBackend!: LiteBackend;

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
    this.liteBackend = new LiteBackend(this.basePath);

    // Initialize external backends
    if (this.backendName === "rabbitmq") {
      this.externalBackend = new RabbitMQBackend();
    } else if (this.backendName === "kafka") {
      this.externalBackend = new KafkaBackend();
    } else if (this.backendName === "mongodb" || this.backendName === "mongo") {
      this.externalBackend = new MongoBackend();
    }
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
      return this.externalBackend.push(this.topic, payload, delay);
    }
    return this.liteBackend.push(this.topic, payload, delay, priority);
  }

  /**
   * Atomically claim the next available job from this queue's topic. Returns null if empty.
   */
  pop(): QueueJob | null {
    const q = this.topic;

    if (this.externalBackend) {
      return this.externalBackend.pop(q);
    }
    return this.liteBackend.pop(q, this);
  }

  /**
   * Process jobs from a queue with a handler function.
   */
  process(
    handler: (job: QueueJob) => Promise<void> | void,
    options?: ProcessOptions,
  ): void {
    const queue = this.topic;
    const opts = options;

    const maxJobs = opts?.maxJobs ?? Infinity;
    const maxRetries = opts?.maxRetries ?? this._maxRetries;
    let processed = 0;

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
   * Remove all jobs from this queue's topic.
   */
  clear(): void {
    const q = this.topic;

    if (this.externalBackend) {
      this.externalBackend.clear(q);
      return;
    }
    this.liteBackend.clear(q);
  }

  /**
   * Get all failed jobs for this queue's topic.
   */
  failed(): QueueJob[] {
    return this.liteBackend.failed(this.topic);
  }

  /**
   * Retry a failed job by moving it back to the queue.
   */
  retry(jobId: string, delaySeconds?: number): boolean {
    return this.liteBackend.retry(this.topic, jobId, delaySeconds);
  }

  /**
   * Get dead letter jobs — failed jobs that exceeded max retries.
   */
  deadLetters(maxRetries?: number): QueueJob[] {
    return this.liteBackend.deadLetters(this.topic, maxRetries ?? this._maxRetries);
  }

  /**
   * Delete messages by status (e.g. "completed", "failed", "dead").
   */
  purge(status: string, maxRetries?: number): number {
    return this.liteBackend.purge(this.topic, status, maxRetries ?? this._maxRetries);
  }

  /**
   * Re-queue failed jobs that haven't exceeded max retries back to pending.
   */
  retryFailed(maxRetries?: number): number {
    return this.liteBackend.retryFailed(this.topic, maxRetries ?? this._maxRetries);
  }

  /**
   * Produce a message onto a topic. Convenience wrapper around push().
   */
  produce(topic: string, payload: unknown, delay?: number, priority: number = 0): string {
    if (this.externalBackend) {
      return this.externalBackend.push(topic, payload, delay);
    }
    return this.liteBackend.push(topic, payload, delay, priority);
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
  async *consume(topic?: string, id?: string, pollInterval: number = 1000, iterations: number = 0): AsyncGenerator<QueueJob> {
    const q = topic ?? this.topic;

    if (id !== undefined) {
      const raw = this.popById(id);
      if (raw) yield createJob(raw as any, this);
      return;
    }

    // pollInterval=0 → single-pass drain (returns when empty)
    // pollInterval>0 → long-running poll (sleeps when empty, never returns)
    // iterations>0   → stop after consuming N jobs
    let consumed = 0;
    while (true) {
      const raw = this.pop(q) as any;
      if (raw === null) {
        if (pollInterval <= 0) break;
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      yield createJob(raw, this);
      consumed++;
      if (iterations > 0 && consumed >= iterations) break;
    }
  }

  /**
   * Pop a specific job by ID from this queue's topic.
   */
  popById(id: string): QueueJob | null {
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

  /**
   * Move a job to the failed directory.
   */
  _failJob(queue: string, job: QueueJob, error: string, maxRetries: number): void {
    this.liteBackend.failJob(queue, job, error, maxRetries);
  }

  /**
   * Re-queue a job back to the main queue directory with incremented attempts.
   */
  _retryJob(queue: string, job: QueueJob, delaySeconds?: number): void {
    this.liteBackend.retryJob(queue, job, delaySeconds);
  }
}

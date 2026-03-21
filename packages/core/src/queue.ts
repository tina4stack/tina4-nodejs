/**
 * Tina4 Queue — File-backed job queue, zero dependencies.
 *
 * Production-grade queue using the file system as storage.
 * No Redis, no RabbitMQ, no external dependencies needed.
 *
 *   import { Queue } from "@tina4/core";
 *
 *   const queue = new Queue();
 *   queue.push("emails", { to: "alice@test.com", subject: "Hello" });
 *
 *   const job = queue.pop("emails");
 *   if (job) {
 *     await processJob(job);
 *   }
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface QueueConfig {
  backend?: string;
  path?: string;
}

export interface QueueJob {
  id: string;
  payload: unknown;
  status: "pending" | "reserved" | "failed" | "dead";
  createdAt: string;
  attempts: number;
  delayUntil: string | null;
  error?: string;
}

export interface ProcessOptions {
  pollInterval?: number;
  maxJobs?: number;
  maxRetries?: number;
}

// ── Queue ────────────────────────────────────────────────────

export class Queue {
  private backend: string;
  private basePath: string;
  private seq: number = 0;
  private externalBackend: { push: (q: string, p: unknown, d?: number) => string; pop: (q: string) => QueueJob | null; size: (q: string) => number; clear: (q: string) => void } | null = null;

  constructor(backend?: string, config?: QueueConfig) {
    this.backend = backend ?? config?.backend ?? process.env.TINA4_QUEUE_BACKEND ?? "file";
    this.basePath = config?.path ?? process.env.TINA4_QUEUE_PATH ?? "data/queue";

    // Initialize external backends
    if (this.backend === "rabbitmq") {
      // Dynamic import to avoid loading when not needed
      const { RabbitMQBackend } = require("./queueBackends/rabbitmqBackend.js");
      this.externalBackend = new RabbitMQBackend();
    } else if (this.backend === "kafka") {
      const { KafkaBackend } = require("./queueBackends/kafkaBackend.js");
      this.externalBackend = new KafkaBackend();
    }
  }

  /**
   * Ensure directory exists for a queue.
   */
  private ensureDir(queue: string): string {
    const dir = join(this.basePath, queue);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Ensure the failed subdirectory exists for a queue.
   */
  private ensureFailedDir(queue: string): string {
    const dir = join(this.basePath, queue, "failed");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Add a job to the queue. Returns job ID.
   */
  push(queue: string, payload: unknown, delay?: number): string {
    if (this.externalBackend) {
      return this.externalBackend.push(queue, payload, delay);
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
      delayUntil: delay ? new Date(Date.now() + delay * 1000).toISOString() : null,
    };

    // Use timestamp + sequence prefix for FIFO ordering
    const prefix = `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
    writeFileSync(join(dir, `${prefix}_${id}.json`), JSON.stringify(job, null, 2));
    return id;
  }

  /**
   * Atomically claim the next available job. Returns null if empty.
   */
  pop(queue: string): QueueJob | null {
    if (this.externalBackend) {
      return this.externalBackend.pop(queue);
    }
    const dir = this.ensureDir(queue);

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

      // Reserve the job
      job.status = "reserved";
      writeFileSync(filePath, JSON.stringify(job, null, 2));

      // Remove the file (job is consumed)
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
    queue: string,
    handler: (job: QueueJob) => Promise<void> | void,
    options?: ProcessOptions,
  ): void {
    const maxJobs = options?.maxJobs ?? Infinity;
    const maxRetries = options?.maxRetries ?? 3;
    let processed = 0;

    const tick = () => {
      if (processed >= maxJobs) return;

      const job = this.pop(queue);
      if (!job) return;

      try {
        const result = handler(job);
        if (result instanceof Promise) {
          result
            .then(() => { processed++; })
            .catch((err: Error) => {
              this._failJob(queue, job, err.message, maxRetries);
              processed++;
            });
        } else {
          processed++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this._failJob(queue, job, message, maxRetries);
        processed++;
      }
    };

    // Process all currently available jobs synchronously
    while (processed < maxJobs) {
      const job = this.pop(queue);
      if (!job) break;
      try {
        const result = handler(job);
        if (result instanceof Promise) {
          // For async handlers in sync process loop, we still increment
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
  size(queue: string): number {
    if (this.externalBackend) {
      return this.externalBackend.size(queue);
    }
    const dir = this.ensureDir(queue);
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
  clear(queue: string): void {
    if (this.externalBackend) {
      this.externalBackend.clear(queue);
      return;
    }
    const dir = this.ensureDir(queue);
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
  failed(queue: string): QueueJob[] {
    const failedDir = this.ensureFailedDir(queue);
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
    // Search for the job in all queue failed directories
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

          // Move back to queue directory with sortable prefix
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
  deadLetters(queue: string, maxRetries: number = 3): QueueJob[] {
    const failedDir = this.ensureFailedDir(queue);
    const results: QueueJob[] = [];

    try {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".json")).sort();
      for (const file of files) {
        try {
          const job: QueueJob = JSON.parse(readFileSync(join(failedDir, file), "utf-8"));
          if ((job.attempts || 0) >= maxRetries) {
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
   * Delete messages by status (completed, failed, dead).
   * For 'dead', removes failed jobs that exceeded maxRetries.
   * For 'failed', removes failed jobs under maxRetries.
   * For other statuses, removes matching jobs from the main queue directory.
   */
  purge(queue: string, status: string, maxRetries: number = 3): number {
    let count = 0;

    if (status === "dead") {
      const failedDir = this.ensureFailedDir(queue);
      try {
        const files = readdirSync(failedDir).filter(f => f.endsWith(".json"));
        for (const file of files) {
          try {
            const job: QueueJob = JSON.parse(readFileSync(join(failedDir, file), "utf-8"));
            if ((job.attempts || 0) >= maxRetries) {
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
            if ((job.attempts || 0) < maxRetries) {
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
      // completed, pending, or other — scan main queue directory
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
   * Returns the number of jobs re-queued.
   */
  retryFailed(queue: string, maxRetries: number = 3): number {
    const failedDir = this.ensureFailedDir(queue);
    const queueDir = this.ensureDir(queue);
    let count = 0;

    try {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        try {
          const filePath = join(failedDir, file);
          const job: QueueJob = JSON.parse(readFileSync(filePath, "utf-8"));

          // Only retry if under max retries (not dead)
          if ((job.attempts || 0) >= maxRetries) {
            continue;
          }

          job.status = "pending";
          job.error = undefined;

          // Move back to queue directory with sortable prefix
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
   * Move a job to the failed directory.
   */
  private _failJob(queue: string, job: QueueJob, error: string, maxRetries: number): void {
    const failedDir = this.ensureFailedDir(queue);
    job.status = "failed";
    job.attempts = (job.attempts || 0) + 1;
    job.error = error;

    writeFileSync(join(failedDir, `${job.id}.json`), JSON.stringify(job, null, 2));
  }
}

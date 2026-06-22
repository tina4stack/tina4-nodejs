/**
 * Tina4 Queue Job — a single queue job with lifecycle methods.
 */

// ── Types ────────────────────────────────────────────────────

export interface JobData {
  id: string;
  payload: unknown;
  status: "pending" | "reserved" | "failed" | "dead" | "completed";
  createdAt: string;
  attempts: number;
  delayUntil: string | null;
  priority: number;
  topic: string;
  error?: string;
}

export interface JobLifecycle {
  /** Mark this job as completed. */
  complete(): void;
  /** Mark this job as failed with a reason. */
  fail(reason?: string): void;
  /** Reject this job with a reason. Alias for fail(). */
  reject(reason?: string): void;
  /** Re-queue this job with incremented attempts and optional delay. */
  retry(delaySeconds?: number): void;
  /** Return job fields as a flat array of values. */
  toArray(): unknown[];
  /** Return job as a plain object. */
  toHash(): Record<string, unknown>;
  /** Return job as a JSON string. */
  toJson(): string;
}

export type QueueJob = JobData & JobLifecycle;

// ── Job factory ──────────────────────────────────────────────

export interface JobQueueBridge {
  _failJob(topic: string, job: QueueJob, reason: string, maxRetries: number): void;
  _retryJob(topic: string, job: QueueJob, delaySeconds?: number): void;
  _completeJob(topic: string, job: QueueJob): void;
  getMaxRetries(): number;
}

/** Create a QueueJob with lifecycle methods bound to a Queue instance. */
export function createJob(data: JobData, queue: JobQueueBridge): QueueJob {
  const job: QueueJob = {
    ...data,
    complete() {
      // Terminal — the pending file was claimed on pop and a reservation record
      // written; complete() drops the reservation so a dead-consumer reclaim
      // never re-delivers an already-acked job. The job is done.
      job.status = "completed";
      queue._completeJob(job.topic, job);
    },
    fail(reason = "") {
      // Record a failed attempt. `attempts` is incremented exactly once, inside
      // the backend's failJob() — NOT here — so a persistently-failing job runs
      // exactly maxRetries times before it is dead-lettered. The backend decides
      // whether to re-enqueue (attempts < maxRetries) or dead-letter
      // (attempts >= maxRetries).
      job.status = "failed";
      job.error = reason;
      queue._failJob(job.topic, job, reason, queue.getMaxRetries());
    },
    reject(reason = "") {
      job.fail(reason);
    },
    retry(delaySeconds?: number) {
      queue._retryJob(job.topic, job, delaySeconds);
    },
    toArray() {
      return [job.id, job.topic, job.payload, job.priority, job.attempts];
    },
    toHash() {
      return {
        id: job.id,
        topic: job.topic,
        payload: job.payload,
        priority: job.priority,
        attempts: job.attempts,
        status: job.status,
        createdAt: job.createdAt,
        delayUntil: job.delayUntil,
        error: job.error,
      };
    },
    toJson() {
      return JSON.stringify(job.toHash());
    },
  };
  return job;
}

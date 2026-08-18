/**
 * LiteBackend — file-based queue backend for Tina4 Queue.
 * Stores jobs as JSON files on disk. Zero dependencies.
 *
 * Dequeue policy (parity with Python master): the highest-priority AVAILABLE
 * job is returned first; ties are broken oldest-first by createdAt. The file
 * *name* is no longer the ordering key — the stored `priority` and `createdAt`
 * fields are. Delayed jobs (delayUntil in the future) are skipped until due.
 *
 * Failure lifecycle (parity with Python master): job.fail() records one failed
 * attempt — `attempts` is incremented exactly once, here in failJob(). If the
 * job still has retries left (attempts < maxRetries) it is automatically
 * re-enqueued to the pending queue (immediately, or after retryBackoff seconds
 * if configured) so the next pop()/consume() picks it up again. Once it has
 * been attempted maxRetries times (attempts >= maxRetries) it is moved to the
 * dead-letter (failed/) directory, where deadLetters() returns it.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type QueueJob } from "../job.js";
import { createJob, type JobQueueBridge } from "../job.js";

export class LiteBackend {
  private basePath: string;
  private seq: number = 0;
  /**
   * Reservation/visibility timeout (seconds). A popped job is held in reserved/
   * with availableAt = now + visibilityTimeout. If the consumer dies before
   * complete()/fail() (crash, OOM, k8s eviction) the next pop() reclaims it once
   * the window expires — incrementing attempts and re-enqueuing, or
   * dead-lettering past maxRetries. <= 0 disables the reclaim (a reservation
   * then lasts until the consumer acks — the old at-most-once behaviour).
   */
  private visibilityTimeout: number;

  constructor(basePath: string = "data/queue", visibilityTimeout: number = 300) {
    this.basePath = basePath;
    this.visibilityTimeout = visibilityTimeout;
  }

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

  private ensureReservedDir(queue: string): string {
    const dir = join(this.basePath, queue, "reserved");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private reservedPath(queue: string, jobId: string): string {
    return join(this.ensureReservedDir(queue), `${jobId}.queue-data`);
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private futureIso(seconds: number): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  private nextPrefix(): string {
    this.seq++;
    return `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
  }

  /**
   * No-op: the file backend holds no connection to release.
   *
   * It exists so `Queue.close()` can call ONE method on every backend instead
   * of testing for it, and so switching TINA4_QUEUE_BACKEND to "file" never
   * turns a working close() into "backend.close is not a function". Idempotent
   * by construction — there is nothing to drop.
   */
  close(): void {
    // Nothing held: every operation opens, reads/writes and closes its own file
    // descriptor synchronously, so no handle survives a call.
  }

  push(queue: string, payload: unknown, delay?: number, priority?: number): string {
    const dir = this.ensureDir(queue);
    const id = randomUUID();
    const now = new Date().toISOString();

    const job = {
      id,
      payload,
      status: "pending" as const,
      createdAt: now,
      attempts: 0,
      delayUntil: delay ? new Date(Date.now() + delay * 1000).toISOString() : null,
      priority: priority ?? 0,
      topic: queue,
      error: undefined as string | undefined,
    };

    const prefix = this.nextPrefix();
    writeFileSync(join(dir, `${prefix}_${id}.queue-data`), JSON.stringify(job, null, 2));
    return id;
  }

  /**
   * Return [filename, jobData] for every pending, non-delayed job, ordered by
   * the dequeue policy: highest priority first, ties broken oldest-first by
   * createdAt. createdAt is an ISO-8601 string, so lexicographic comparison ==
   * chronological order.
   */
  private availableCandidates(queue: string, now: string): Array<[string, any]> {
    const dir = this.ensureDir(queue);

    let filenames: string[];
    try {
      filenames = readdirSync(dir).filter(f => f.endsWith(".queue-data"));
    } catch {
      return [];
    }

    const candidates: Array<[string, any]> = [];
    for (const filename of filenames) {
      const filePath = join(dir, filename);
      let job: any;
      try {
        job = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        continue;
      }
      if (job.status !== "pending") continue;
      if (job.delayUntil && job.delayUntil > now) continue; // still delayed
      candidates.push([filename, job]);
    }

    // priority DESC, then createdAt ASC (oldest first).
    candidates.sort((a, b) => {
      const pa = Number(a[1].priority ?? 0) || 0;
      const pb = Number(b[1].priority ?? 0) || 0;
      if (pb !== pa) return pb - pa;
      const ca = (a[1].createdAt ?? "") as string;
      const cb = (b[1].createdAt ?? "") as string;
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });

    return candidates;
  }

  /**
   * Persist a reservation record so a dead consumer's job is reclaimable.
   *
   * Stores reservedAt + availableAt = now + visibilityTimeout. The next pop()
   * reclaims this job once availableAt has passed (see reclaimExpired).
   * complete()/fail()/retry() delete the record.
   */
  private writeReserved(queue: string, job: any): void {
    const now = this.nowIso();
    const vt = this.visibilityTimeout || 0;
    const record = {
      id: job.id,
      payload: job.payload,
      status: "reserved" as const,
      priority: job.priority ?? 0,
      attempts: job.attempts ?? 0,
      error: job.error,
      reservedAt: now,
      availableAt: vt > 0 ? this.futureIso(vt) : now,
      createdAt: job.createdAt ?? now,
      topic: job.topic ?? queue,
    };
    writeFileSync(this.reservedPath(queue, record.id), JSON.stringify(record, null, 2));
  }

  /**
   * Return expired reservations to the queue (at-least-once delivery).
   *
   * A reserved job whose availableAt <= now means its consumer never
   * acknowledged in time (crash / OOM / pod eviction). Atomically claim it
   * (delete the reservation file), increment attempts, and either re-enqueue it
   * (so the next pop picks it up) or dead-letter it once it has hit maxRetries.
   * Disabled when visibilityTimeout <= 0.
   */
  private reclaimExpired(queue: string, maxRetries: number, now: string): void {
    if (!this.visibilityTimeout || this.visibilityTimeout <= 0) return;
    const reservedDir = this.ensureReservedDir(queue);

    let filenames: string[];
    try {
      filenames = readdirSync(reservedDir).filter(f => f.endsWith(".queue-data"));
    } catch {
      return;
    }

    for (const filename of filenames) {
      const filePath = join(reservedDir, filename);
      let record: any;
      try {
        record = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        continue;
      }
      if (record.availableAt && record.availableAt > now) continue; // still valid
      // Atomically claim the expired reservation by deleting its file.
      try {
        unlinkSync(filePath);
      } catch {
        continue; // another worker reclaimed it first
      }

      const attempts = (record.attempts ?? 0) + 1;
      const error = "reservation timed out — consumer did not acknowledge within the visibility timeout";
      const job: QueueJob = {
        id: record.id,
        payload: record.payload,
        status: "reserved",
        createdAt: record.createdAt ?? now,
        attempts,
        delayUntil: null,
        priority: record.priority ?? 0,
        topic: record.topic ?? queue,
        error,
      } as QueueJob;

      if (attempts >= maxRetries) {
        this.deadLetter(queue, job, error);
      } else {
        this.requeue(queue, job, 0, error);
      }
    }
  }

  pop(queue: string, bridge: JobQueueBridge): QueueJob | null {
    const dir = this.ensureDir(queue);
    // First return any reservations whose consumer died mid-flight.
    this.reclaimExpired(queue, bridge.getMaxRetries(), this.nowIso());
    const now = this.nowIso();

    for (const [filename, job] of this.availableCandidates(queue, now)) {
      const filePath = join(dir, filename);
      job.topic = queue;
      job.priority = job.priority ?? 0;
      // Write the reservation BEFORE claiming the pending file, so a crash
      // between claim and reserve can never strand the job. Only the worker
      // that wins the unlink owns — and returns — it.
      this.writeReserved(queue, job);
      try {
        unlinkSync(filePath);
      } catch {
        // Already consumed by another worker — drop the speculative reservation.
        try { unlinkSync(this.reservedPath(queue, job.id)); } catch { /* ignore */ }
        continue;
      }

      job.status = "reserved";
      return createJob(job as any, bridge);
    }

    return null;
  }

  popBatch(queue: string, bridge: JobQueueBridge, count: number): QueueJob[] {
    const dir = this.ensureDir(queue);
    this.reclaimExpired(queue, bridge.getMaxRetries(), this.nowIso());
    const now = this.nowIso();
    const results: QueueJob[] = [];

    for (const [filename, job] of this.availableCandidates(queue, now)) {
      if (results.length >= count) break;
      const filePath = join(dir, filename);
      job.topic = queue;
      job.priority = job.priority ?? 0;
      this.writeReserved(queue, job);
      try {
        unlinkSync(filePath);
      } catch {
        try { unlinkSync(this.reservedPath(queue, job.id)); } catch { /* ignore */ }
        continue; // Already consumed by another worker
      }

      job.status = "reserved";
      results.push(createJob(job as any, bridge));
    }

    return results;
  }

  /**
   * Delete a job's reservation record (best-effort).
   */
  private clearReservation(queue: string, jobId: string): void {
    try {
      unlinkSync(this.reservedPath(queue, jobId));
    } catch {
      // no reservation record — nothing to clear
    }
  }

  /**
   * Acknowledge a completed job — drop its reservation record so the visibility
   * reclaim never re-delivers an already-acked job.
   */
  completeJob(queue: string, job: QueueJob): void {
    this.clearReservation(queue, job.id);
  }

  // Status aliases that live in the failed/ directory (dead-lettered jobs)
  // rather than as pending files in the queue directory.
  private static readonly DEAD_STATES = ["failed", "dead", "dead_letter"];

  size(queue: string, status: string = "pending"): number {
    const isDead = LiteBackend.DEAD_STATES.includes(status);
    const isReserved = status === "reserved";
    const scanDir = isDead
      ? this.ensureFailedDir(queue)
      : isReserved
        ? this.ensureReservedDir(queue)
        : this.ensureDir(queue);

    let files: string[];
    try {
      files = readdirSync(scanDir).filter(f => f.endsWith(".queue-data"));
    } catch {
      return 0;
    }

    if (isDead || isReserved) {
      // Every file in failed/ (or reserved/) matches the requested status;
      // count them all regardless of the exact stored status string.
      return files.length;
    }

    let count = 0;
    for (const file of files) {
      try {
        const job = JSON.parse(readFileSync(join(scanDir, file), "utf-8"));
        if (job.status === status) count++;
      } catch {
        // skip corrupt files
      }
    }
    return count;
  }

  clear(queue: string): number {
    const dir = this.ensureDir(queue);
    let count = 0;
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".queue-data"));
      for (const file of files) {
        unlinkSync(join(dir, file));
        count++;
      }
    } catch {
      // directory might not exist
    }

    // Also clear dead-letter jobs.
    const failedDir = join(dir, "failed");
    try {
      if (existsSync(failedDir)) {
        const files = readdirSync(failedDir).filter(f => f.endsWith(".queue-data"));
        for (const file of files) {
          unlinkSync(join(failedDir, file));
          count++;
        }
      }
    } catch {
      // ignore
    }

    // Also clear reservation records.
    const reservedDir = join(dir, "reserved");
    try {
      if (existsSync(reservedDir)) {
        const files = readdirSync(reservedDir).filter(f => f.endsWith(".queue-data"));
        for (const file of files) {
          unlinkSync(join(reservedDir, file));
          count++;
        }
      }
    } catch {
      // ignore
    }
    return count;
  }

  /**
   * Jobs that have failed at least once but are still being retried.
   *
   * Under the auto-retry lifecycle a failed-but-retryable job lives in the
   * pending queue (not the dead-letter dir), so this scans the queue dir for
   * pending jobs with attempts > 0 that have not yet exhausted their retries.
   * Dead-lettered jobs are returned by deadLetters().
   */
  failed(queue: string, maxRetries: number = 3): QueueJob[] {
    const dir = this.ensureDir(queue);
    const results: QueueJob[] = [];

    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".queue-data")).sort();
      for (const file of files) {
        try {
          const job: QueueJob = JSON.parse(readFileSync(join(dir, file), "utf-8"));
          const attempts = job.attempts || 0;
          if (attempts > 0 && attempts < maxRetries) {
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
   * Revive a specific dead-letter job by id back to the pending queue.
   *
   * Manual override (Queue.retry(jobId) / job.retry()) — always revives a
   * dead-letter regardless of attempt count. Returns false only if no
   * dead-letter with that id exists.
   */
  retry(queue: string, jobId: string, delaySeconds?: number): boolean {
    try {
      const queues = readdirSync(this.basePath);
      for (const q of queues) {
        const failedDir = join(this.basePath, q, "failed");
        const filePath = join(failedDir, `${jobId}.queue-data`);

        if (existsSync(filePath)) {
          const job: QueueJob = JSON.parse(readFileSync(filePath, "utf-8"));
          job.status = "pending";
          job.attempts = (job.attempts || 0) + 1;
          job.error = undefined;
          job.createdAt = new Date().toISOString();
          job.delayUntil = delaySeconds ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null;

          const prefix = this.nextPrefix();
          const queueDir = join(this.basePath, q);
          writeFileSync(join(queueDir, `${prefix}_${jobId}.queue-data`), JSON.stringify(job, null, 2));
          unlinkSync(filePath);
          return true;
        }
      }
    } catch {
      // ignore
    }

    return false;
  }

  deadLetters(queue: string, maxRetries: number = 3): QueueJob[] {
    const failedDir = this.ensureFailedDir(queue);
    const results: QueueJob[] = [];

    try {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".queue-data")).sort();
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

  purge(queue: string, status: string, maxRetries: number = 3): number {
    let count = 0;
    const isDead = LiteBackend.DEAD_STATES.includes(status);

    if (isDead) {
      // Every file in failed/ is a dead-letter — purge them all.
      const failedDir = this.ensureFailedDir(queue);
      try {
        const files = readdirSync(failedDir).filter(f => f.endsWith(".queue-data"));
        for (const file of files) {
          try {
            unlinkSync(join(failedDir, file));
            count++;
          } catch {
            // already removed
          }
        }
      } catch {
        // directory might not exist
      }
    } else {
      const dir = this.ensureDir(queue);
      try {
        const files = readdirSync(dir).filter(f => f.endsWith(".queue-data"));
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
   * Re-queue dead-letter jobs that are under the (possibly raised) limit back
   * to pending. Mirrors Python retry_failed(): a job dead-lettered at the
   * original maxRetries needs a raised limit to qualify again.
   */
  retryFailed(queue: string, maxRetries: number = 3): number {
    const failedDir = this.ensureFailedDir(queue);
    const queueDir = this.ensureDir(queue);
    let count = 0;

    try {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".queue-data"));
      for (const file of files) {
        try {
          const filePath = join(failedDir, file);
          const job: QueueJob = JSON.parse(readFileSync(filePath, "utf-8"));

          if ((job.attempts || 0) >= maxRetries) {
            continue;
          }

          job.status = "pending";
          job.error = undefined;
          job.createdAt = new Date().toISOString();
          job.delayUntil = null;

          const prefix = this.nextPrefix();
          writeFileSync(join(queueDir, `${prefix}_${job.id}.queue-data`), JSON.stringify(job, null, 2));
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

  popById(queue: string, id: string): QueueJob | null {
    const dir = this.ensureDir(queue);

    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".queue-data"));
    } catch {
      return null;
    }

    for (const file of files) {
      if (!file.includes(id)) continue;
      const filePath = join(dir, file);
      let job: QueueJob;
      try {
        job = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        continue;
      }

      if (job.status !== "pending") continue;
      if (job.id === id) {
        job.topic = queue;
        job.priority = job.priority ?? 0;
        // Reserve (so a dead consumer's job is reclaimable) then claim the
        // pending file — mirrors pop().
        this.writeReserved(queue, job);
        try {
          unlinkSync(filePath);
        } catch {
          try { unlinkSync(this.reservedPath(queue, job.id)); } catch { /* ignore */ }
          continue; // already consumed
        }
        job.status = "reserved";
        return job;
      }
    }

    return null;
  }

  /**
   * Write the job back to the pending queue (queue dir).
   *
   * Re-enqueued jobs get a fresh createdAt so that within a priority tier they
   * sort behind jobs that have not yet been attempted. `attempts` already
   * reflects the latest failure count. The job carries its prior error.
   */
  private requeue(queue: string, job: QueueJob, delaySeconds: number = 0, error?: string): void {
    const dir = this.ensureDir(queue);
    const jobData = {
      id: job.id,
      payload: job.payload,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      attempts: job.attempts ?? 0,
      delayUntil: delaySeconds > 0 ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null,
      priority: job.priority ?? 0,
      topic: job.topic,
      error,
    };
    const prefix = this.nextPrefix();
    writeFileSync(join(dir, `${prefix}_${job.id}.queue-data`), JSON.stringify(jobData, null, 2));
  }

  /**
   * Move the job to the dead-letter (failed/) directory. Terminal until a
   * manual retryFailed()/retry() revives it.
   */
  private deadLetter(queue: string, job: QueueJob, error?: string): void {
    const failedDir = this.ensureFailedDir(queue);
    const jobData = {
      id: job.id,
      payload: job.payload,
      status: "dead" as const,
      createdAt: job.createdAt,
      attempts: job.attempts ?? 0,
      delayUntil: null,
      priority: job.priority ?? 0,
      topic: job.topic,
      error,
      failedAt: new Date().toISOString(),
    };
    writeFileSync(join(failedDir, `${job.id}.queue-data`), JSON.stringify(jobData, null, 2));
  }

  /**
   * Record a failed attempt.
   *
   * Increments `attempts` exactly once (the increment lives here, NOT in
   * job.ts — see the double-increment fix). If the job still has retries left
   * (attempts < maxRetries) it is automatically re-enqueued to pending, after
   * an optional retryBackoff delay. Once it has been attempted maxRetries times
   * (attempts >= maxRetries) it is moved to the dead-letter store.
   */
  failJob(queue: string, job: QueueJob, error: string, maxRetries: number, retryBackoff: number = 0): void {
    // Clear the reservation — the consumer acknowledged (with a failure).
    this.clearReservation(queue, job.id);
    job.attempts = (job.attempts || 0) + 1;
    job.error = error;
    if (job.attempts < maxRetries) {
      this.requeue(queue, job, retryBackoff, error);
    } else {
      this.deadLetter(queue, job, error);
    }
  }

  /**
   * Explicit re-queue requested by the caller (job.retry()).
   *
   * Always re-enqueues regardless of the retry limit — manual override,
   * distinct from the automatic failJob() path. Cleans up BOTH the
   * reservation record AND any dead-letter file for this id, so a caller
   * that iterates deadLetters() and calls .retry() on each doesn't leave
   * the failed/ directory carrying duplicates (PY-12-05, 3.13.105).
   * Aligns with retry(queue, jobId) which had always unlinked the
   * dead-letter file -- two spellings of the same intent that previously
   * diverged.
   */
  retryJob(queue: string, job: QueueJob, delaySeconds?: number): void {
    // Clear the reservation — the consumer acknowledged (with an explicit retry).
    this.clearReservation(queue, job.id);
    // Drop any dead-letter file for this id BEFORE the re-queue -- if this
    // job came from deadLetters() it lives in failed/ and would otherwise
    // stay on disk while a fresh pending file appears in the queue dir, so
    // the next deadLetters() call reports the job again and a consumer
    // processes it twice.
    try {
      unlinkSync(join(this.ensureFailedDir(queue), `${job.id}.queue-data`));
    } catch {
      // ENOENT is fine (the job never dead-lettered or was already cleared).
    }
    job.attempts = (job.attempts || 0) + 1;
    job.error = undefined;
    this.requeue(queue, job, delaySeconds ?? 0, undefined);
  }
}

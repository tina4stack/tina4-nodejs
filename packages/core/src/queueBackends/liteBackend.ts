/**
 * LiteBackend — file-based queue backend for Tina4 Queue.
 * Stores jobs as JSON files on disk. Zero dependencies.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type QueueJob } from "../job.js";
import { createJob, type JobQueueBridge } from "../job.js";

export class LiteBackend {
  private basePath: string;
  private seq: number = 0;

  constructor(basePath: string = "data/queue") {
    this.basePath = basePath;
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

  push(queue: string, payload: unknown, delay?: number, priority?: number): string {
    const dir = this.ensureDir(queue);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.seq++;

    const job = {
      id,
      payload,
      status: "pending" as const,
      createdAt: now,
      attempts: 0,
      delayUntil: delay ? new Date(Date.now() + delay * 1000).toISOString() : null,
      priority: priority ?? 0,
    };

    const prefix = `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
    writeFileSync(join(dir, `${prefix}_${id}.queue-data`), JSON.stringify(job, null, 2));
    return id;
  }

  pop(queue: string, bridge: JobQueueBridge): QueueJob | null {
    const dir = this.ensureDir(queue);

    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".queue-data")).sort();
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
      job.topic = queue;
      job.priority = job.priority ?? 0;
      writeFileSync(filePath, JSON.stringify(job, null, 2));

      try {
        unlinkSync(filePath);
      } catch {
        // Already consumed by another worker
      }

      return createJob(job as any, bridge);
    }

    return null;
  }

  size(queue: string, status: string = "pending"): number {
    if (status === "failed") {
      const failedDir = this.ensureFailedDir(queue);
      let files: string[];
      try {
        files = readdirSync(failedDir).filter(f => f.endsWith(".queue-data"));
      } catch {
        return 0;
      }
      return files.length;
    }

    const dir = this.ensureDir(queue);
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".queue-data"));
    } catch {
      return 0;
    }

    let count = 0;
    for (const file of files) {
      try {
        const job = JSON.parse(readFileSync(join(dir, file), "utf-8"));
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

    // Also clear failed jobs
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
    return count;
  }

  failed(queue: string): QueueJob[] {
    const failedDir = this.ensureFailedDir(queue);
    const results: QueueJob[] = [];

    try {
      const files = readdirSync(failedDir).filter(f => f.endsWith(".queue-data")).sort();
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
          job.delayUntil = delaySeconds ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null;

          this.seq++;
          const prefix = `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
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

    if (status === "dead") {
      const failedDir = this.ensureFailedDir(queue);
      try {
        const files = readdirSync(failedDir).filter(f => f.endsWith(".queue-data"));
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
        const files = readdirSync(failedDir).filter(f => f.endsWith(".queue-data"));
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

          this.seq++;
          const prefix = `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
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

  failJob(queue: string, job: QueueJob, error: string, maxRetries: number): void {
    const failedDir = this.ensureFailedDir(queue);
    job.status = "failed";
    job.attempts = (job.attempts || 0) + 1;
    job.error = error;

    writeFileSync(join(failedDir, `${job.id}.queue-data`), JSON.stringify(job, null, 2));
  }

  retryJob(queue: string, job: QueueJob, delaySeconds?: number): void {
    const dir = this.ensureDir(queue);
    job.status = "pending";
    job.attempts = (job.attempts || 0) + 1;
    job.error = undefined;
    job.delayUntil = delaySeconds ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null;

    this.seq++;
    const prefix = `${Date.now()}-${String(this.seq).padStart(6, "0")}`;
    writeFileSync(join(dir, `${prefix}_${job.id}.queue-data`), JSON.stringify(job, null, 2));
  }
}

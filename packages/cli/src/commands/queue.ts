/**
 * CLI command: queue — run queue workers and manage jobs.
 *
 * The top-level `queue` command wires straight to the real @tina4/core Queue
 * (file backend by default; RabbitMQ/Kafka/MongoDB via TINA4_QUEUE_BACKEND).
 * `stats`, `retry` and `clear` operate on the queue without booting the app or a
 * database; `work` runs the app's consumer for a topic. Distinct from
 * `generate queue`, which SCAFFOLDS a consumer file.
 *
 *   tina4nodejs queue work  [topic] [--once] [--poll N] [--services DIR]
 *   tina4nodejs queue stats [topic] [--json]
 *   tina4nodejs queue retry [topic]
 *   tina4nodejs queue clear [status] [topic]
 *
 * Mirrors the Python master's _queue* handlers (tina4_python/cli/__init__.py).
 */
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "../../../core/src/dotenv.js";
import { Queue } from "../../../core/src/queue.js";
import type { QueueJob } from "../../../core/src/job.js";

// ── Flag parsing ─────────────────────────────────────────────────────
//
// --key value and bare --flag, mirroring the Python master's _parse_flags:
// `once` and `json` are boolean-only (they never swallow the next token).

const BOOLEAN_FLAGS = new Set(["once", "json"]);

interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        i += 1;
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  return { flags, positional };
}

/** A per-job handler declared by a consumer module (receives the job payload). */
export type QueueHandler = (payload: unknown) => unknown | Promise<unknown>;

/**
 * Return the per-job handler that a consumer module declares for `topic`.
 *
 * A consumer module (e.g. the one `generate queue <topic>` scaffolds) exposes a
 * default-export config; when its `topic` matches, `queue work` drives the
 * consumer through that config's per-job `handle` callable — so the worker owns
 * the poll loop (honouring --poll and the bounded --once drain) instead of the
 * consumer's own endless loop. Returns the callable, or null when no consumer in
 * `servicesDir` targets this topic. Mirrors Python's _resolve_queue_handler.
 */
export async function resolveQueueHandler(
  servicesDir: string,
  topic: string,
): Promise<QueueHandler | null> {
  let entries: string[];
  try {
    if (!statSync(servicesDir).isDirectory()) return null;
    entries = readdirSync(servicesDir);
  } catch {
    return null;
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith("_")) continue;
    const ext = extname(entry);
    if (ext !== ".ts" && ext !== ".js") continue;

    const fullPath = join(servicesDir, entry);
    try {
      if (!statSync(fullPath).isFile()) continue;
      const mod = await import(pathToFileURL(fullPath).href);
      const config = (mod.default ?? mod) as Record<string, unknown> | undefined;
      if (
        config &&
        typeof config === "object" &&
        config.topic === topic &&
        typeof config.handle === "function"
      ) {
        return config.handle as QueueHandler;
      }
    } catch {
      // A broken sibling must not sink the worker — skip and keep scanning.
      continue;
    }
  }
  return null;
}

/** The single available job out of a possible batch yield. */
function firstJob(yielded: QueueJob | QueueJob[]): QueueJob {
  return Array.isArray(yielded) ? yielded[0] : yielded;
}

// ── Subcommands ──────────────────────────────────────────────────────

/**
 * Run a consumer loop that pops and processes jobs on a topic.
 *
 *   tina4nodejs queue work [topic] [--once] [--poll N] [--services DIR]
 *
 * Long-running by default (polls every --poll seconds, 1.0 default; Ctrl-C to
 * stop). --once does a single-pass drain — it processes every currently
 * available job then exits (poll interval 0). The per-job handler is resolved
 * from the app's consumer for this topic (see resolveQueueHandler); with no
 * handler it drains and acks with a warning rather than inventing behaviour.
 */
async function queueWork(args: string[]): Promise<void> {
  loadEnv();
  const { flags, positional } = parseFlags(args);
  const topic = positional[0] ?? "default";
  const once = Boolean(flags.once);

  // --poll is in SECONDS (parity with the Python master); consume() takes ms.
  let pollSeconds: number;
  if (once) {
    pollSeconds = 0; // single-pass: consume() returns as soon as the topic is empty
  } else {
    const pollRaw = typeof flags.poll === "string" ? flags.poll.trim() : "";
    const parsed = Number(pollRaw);
    pollSeconds = pollRaw && Number.isFinite(parsed) ? parsed : 1.0;
  }

  let servicesDir =
    typeof flags.services === "string" && flags.services
      ? flags.services
      : process.env.TINA4_SERVICE_DIR || "src/services";
  if (flags.services === true) servicesDir = process.env.TINA4_SERVICE_DIR || "src/services";

  const handler = await resolveQueueHandler(servicesDir, topic);
  const queue = new Queue({ topic });

  if (handler === null) {
    console.log(`  ⚠ No consumer handler found for topic '${topic}' in ${servicesDir}.`);
    console.log(`    Scaffold one with: tina4nodejs generate queue ${topic}`);
    console.log("    Draining (consume + ack) without processing.");
  }

  const mode = once ? "single-pass drain" : `polling every ${pollSeconds}s (Ctrl-C to stop)`;
  console.log(`  Queue worker on '${topic}' — ${mode}...`);

  let processed = 0;
  let failed = 0;

  // Long-running mode: Ctrl-C prints the tally and exits cleanly (the poll loop
  // is idle in setTimeout when interrupted). --once is bounded, so no handler.
  let onSigint: (() => void) | undefined;
  if (!once) {
    onSigint = () => {
      console.log("\n  Interrupted — stopping worker.");
      console.log(`  Processed ${processed} job(s), ${failed} failed on '${topic}'.`);
      process.exit(0);
    };
    process.on("SIGINT", onSigint);
  }

  try {
    for await (const yielded of queue.consume(topic, undefined, pollSeconds * 1000)) {
      const job = firstJob(yielded);
      try {
        if (handler !== null) await handler(job.payload);
        job.complete();
        processed += 1;
      } catch (err) {
        job.fail(String(err instanceof Error ? err.message : err));
        failed += 1;
      }
    }
  } finally {
    if (onSigint) process.off("SIGINT", onSigint);
  }

  console.log(`  Processed ${processed} job(s), ${failed} failed on '${topic}'.`);
}

/**
 * Print pending / in-flight / failed / dead-letter / completed counts.
 *
 *   tina4nodejs queue stats [topic] [--json]
 */
async function queueStats(args: string[]): Promise<void> {
  loadEnv();
  const { flags, positional } = parseFlags(args);
  const topic = positional[0] ?? "default";

  const queue = new Queue({ topic });
  const stats = {
    topic,
    pending: queue.size("pending"), // waiting to run
    reserved: queue.size("reserved"), // popped, not yet acked (in-flight)
    failed: queue.failed().length, // failed once, still retrying
    dead: queue.size("dead"), // exhausted retries (dead-letter)
    completed: queue.size("completed"), // terminal-completed (0 on the file backend)
  };

  if (flags.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log(`\n  Queue '${topic}'`);
  console.log(`    pending    ${stats.pending}`);
  console.log(`    reserved   ${stats.reserved}    (in-flight)`);
  console.log(`    failed     ${stats.failed}    (retrying)`);
  console.log(`    dead       ${stats.dead}    (dead-letter)`);
  console.log(`    completed  ${stats.completed}`);
  console.log("");
}

/**
 * Re-queue failed and dead-letter jobs so they run again.
 *
 *   tina4nodejs queue retry [topic]
 *
 * Revives every dead-letter job (manual override, regardless of attempt count)
 * and re-queues any failed-but-still-eligible jobs.
 */
async function queueRetry(args: string[]): Promise<void> {
  loadEnv();
  const { positional } = parseFlags(args);
  const topic = positional[0] ?? "default";

  const queue = new Queue({ topic });

  // maxRetries=0 => every job in the dead-letter store, whatever its attempt
  // count (matches what stats/size("dead") reports), not only attempts>=N.
  const dead = queue.deadLetters(0);
  let revived = 0;
  for (const job of dead) {
    if (queue.retry(job.id)) revived += 1;
  }
  // Any failed-but-retryable jobs still under the limit (no-op on the file
  // backend once the above moved them out, meaningful for other backends).
  const requeued = queue.retryFailed();

  const total = revived + requeued;
  console.log(
    `  Re-queued ${total} job(s) on '${topic}' (${revived} dead-letter, ${requeued} failed).`,
  );
}

/**
 * Purge jobs of a given status (default: completed).
 *
 *   tina4nodejs queue clear [status] [topic]
 *
 * status is one of pending / reserved / completed / failed / dead. The default
 * 'completed' clears finished jobs; pass e.g. `queue clear pending` or
 * `queue clear dead orders` to purge another status / topic.
 */
async function queueClear(args: string[]): Promise<void> {
  loadEnv();
  const { positional } = parseFlags(args);
  const status = positional[0] ?? "completed";
  const topic = positional[1] ?? "default";

  const queue = new Queue({ topic });
  const removed = queue.purge(status);
  console.log(`  Cleared ${removed} '${status}' job(s) from '${topic}'.`);
}

// ── Sub-dispatch table ───────────────────────────────────────────────
//
// The single source for the queue subcommands — drives dispatch AND the
// manifest's queue.subcommands (bin.ts COMMANDS). Mirrors Python's
// _QUEUE_SUBCOMMANDS.

const QUEUE_SUBCOMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  work: queueWork,
  stats: queueStats,
  retry: queueRetry,
  clear: queueClear,
};

/** Subcommand names, in order — surfaced in `commands --json` for the tina4 client. */
export const QUEUE_SUBCOMMAND_NAMES = Object.keys(QUEUE_SUBCOMMANDS);

/**
 * Top-level queue command: run workers and manage jobs. Dispatches to the
 * subcommand handlers above; unknown / missing subcommands fail loud (exit 1).
 */
export async function queueCommand(args: string[] = []): Promise<void> {
  const list = QUEUE_SUBCOMMAND_NAMES.join(", ");

  if (!args || args.length === 0) {
    console.log("Usage: tina4nodejs queue <work|stats|retry|clear> [options]");
    console.log(`  Subcommands: ${list}`);
    process.exit(1);
    return;
  }

  const sub = args[0].toLowerCase();
  const handler = QUEUE_SUBCOMMANDS[sub];
  if (!handler) {
    console.log(`Unknown queue subcommand: ${sub}`);
    console.log(`  Available: ${list}`);
    process.exit(1);
    return;
  }

  await handler(args.slice(1));
}

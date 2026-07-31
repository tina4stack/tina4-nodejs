/**
 * Background tasks — periodic callbacks that run alongside the HTTP server.
 *
 * Mirrors Python's `tina4_python.core.server.background(fn, interval=1.0)`.
 * Use this instead of `setInterval` directly, so timers integrate with the
 * server lifecycle and clear cleanly on graceful shutdown (SIGTERM/SIGINT)
 * or when `stopAllBackgroundTasks()` is called.
 *
 *   import { background } from "@tina4/core";
 *
 *   background(() => processQueue(), 2);          // every 2 seconds
 *   background(async () => await healthCheck(), 30);  // async also fine
 *
 * Errors thrown from a callback are caught and logged so a single failing
 * task cannot bring down the rest of the timer wheel.
 */

import { Log } from "./logger.js";

/** A registered background task — kept so `stopAllBackgroundTasks()` can clear them. */
interface BackgroundTask {
  callback: () => unknown | Promise<unknown>;
  intervalSeconds: number;
  timer: NodeJS.Timeout;
  /** Set by any stop path. Checked around the await so a run in flight never re-arms. */
  stopped: boolean;
}

const _tasks: BackgroundTask[] = [];

// This module deliberately installs NO signal handlers.
//
// It used to bind `process.on("SIGTERM"/"SIGINT", stopAllBackgroundTasks)`,
// described as "additive - it does not call process.exit()". That description
// was the bug. Registering ANY listener for SIGTERM REPLACES Node's default
// disposition, so a handler that does not exit does not "add" to the default,
// it CANCELS it: measured against a real signal, a server with one registered
// background task ignored SIGTERM entirely and ran forever, still answering
// 200s, until SIGKILL. Under Kubernetes that burns the whole
// terminationGracePeriodSeconds on every rolling deploy.
//
// It also bought nothing: `_arm()` unrefs every timer, so a background task
// never holds the event loop open and never needed clearing to let the process
// exit. The server's own graceful shutdown (server.ts) calls
// stopAllBackgroundTasks() as its first step, and a process using background()
// without a server keeps Node's correct default (terminate on SIGTERM).

/**
 * Register a callback to run periodically alongside the HTTP server.
 *
 * @param callback         Function to call (sync or async, no arguments).
 * @param intervalSeconds  Seconds between invocations (default: 1).
 * @returns A handle whose `stop()` clears just this one task.
 */
export function background(
  callback: () => unknown | Promise<unknown>,
  intervalSeconds = 1,
): { stop: () => void } {
  if (typeof callback !== "function") {
    throw new TypeError("background(callback, interval): callback must be a function");
  }
  if (typeof intervalSeconds !== "number" || !isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new RangeError(
      `background(callback, interval): interval must be a positive number (got ${intervalSeconds})`,
    );
  }

  const ms = Math.max(1, Math.round(intervalSeconds * 1000));

  // A task must NEVER overlap itself. setInterval fires on a fixed schedule and
  // does not wait for an async callback, so a run slower than the interval would
  // have a second copy start alongside it (silent double-execution of a slow
  // sweep, with every later tick piling on another). Re-arm a one-shot timer only
  // AFTER the run settles — the interval is then the gap BETWEEN runs. Mirrors the
  // Python master (background_tick_loop) and matches PHP/Ruby, which never overlap.
  const tick = async () => {
    if (task.stopped) return;
    try {
      await callback();
    } catch (err) {
      Log.error?.(`background task error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Re-check AFTER the await: a stop during the run must not re-arm.
    if (task.stopped) return;
    task.timer = _arm();
  };

  const _arm = () => {
    const t = setTimeout(() => { void tick(); }, ms);
    // Don't keep the event loop alive solely for background tasks — this matches
    // Python's behaviour, where background tasks live in the server's loop and
    // exit with it rather than blocking shutdown.
    if (typeof t.unref === "function") t.unref();
    return t;
  };

  const task: BackgroundTask = { callback, intervalSeconds, timer: undefined as unknown as NodeJS.Timeout, stopped: false };
  task.timer = _arm();
  _tasks.push(task);

  return {
    stop: () => {
      task.stopped = true;
      clearTimeout(task.timer);
      const idx = _tasks.indexOf(task);
      if (idx !== -1) _tasks.splice(idx, 1);
    },
  };
}

/**
 * Clear every registered background task. Called by the server's graceful
 * shutdown (its first step on SIGTERM/SIGINT) and by its `close()`, so both a
 * signal and a manual shutdown stop the timer wheel along with the listeners.
 */
export function stopAllBackgroundTasks(): void {
  while (_tasks.length > 0) {
    const task = _tasks.pop()!;
    task.stopped = true;
    clearTimeout(task.timer);
  }
}

/** Number of currently-registered background tasks (test helper). */
export function backgroundTaskCount(): number {
  return _tasks.length;
}

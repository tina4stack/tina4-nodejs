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
}

const _tasks: BackgroundTask[] = [];
let _signalsBound = false;

/**
 * Register signal handlers exactly once so SIGTERM/SIGINT during a long-running
 * process clears all background timers before the runtime exits. The handler
 * is additive — it does not call `process.exit()` or interfere with other
 * shutdown logic registered by the CLI or user code.
 */
function _bindSignalsOnce(): void {
  if (_signalsBound) return;
  _signalsBound = true;
  const cleanup = () => stopAllBackgroundTasks();
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

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

  _bindSignalsOnce();

  const ms = Math.max(1, Math.round(intervalSeconds * 1000));
  const timer = setInterval(() => {
    try {
      const result = callback();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((err) => {
          Log.error?.(`background task error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      Log.error?.(`background task error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, ms);

  // Don't keep the event loop alive solely for background tasks — this matches
  // Python's behaviour, where background tasks live in the server's loop and
  // exit with it rather than blocking shutdown.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  const task: BackgroundTask = { callback, intervalSeconds, timer };
  _tasks.push(task);

  return {
    stop: () => {
      clearInterval(task.timer);
      const idx = _tasks.indexOf(task);
      if (idx !== -1) _tasks.splice(idx, 1);
    },
  };
}

/**
 * Clear every registered background task. Called automatically on SIGTERM/SIGINT;
 * also called from the server's `close()` so a manual server shutdown stops
 * the timer wheel along with HTTP listeners.
 */
export function stopAllBackgroundTasks(): void {
  while (_tasks.length > 0) {
    const task = _tasks.pop()!;
    clearInterval(task.timer);
  }
}

/** Number of currently-registered background tasks (test helper). */
export function backgroundTaskCount(): number {
  return _tasks.length;
}

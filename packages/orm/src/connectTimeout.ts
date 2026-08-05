/**
 * TINA4_DATABASE_CONNECT_TIMEOUT - bound a database connect attempt.
 *
 * THE DEFECT, measured 2026-08-06. The Firebird adapter awaited `fb.attach()` in
 * a bare promise with no timeout, so a driver that never calls back hung the app
 * on connect with no log, no error and no signal. A probe reproduced exactly
 * that against a socket that accepts and never replies: 16 minutes at 0.0% CPU,
 * a process that looked alive to every health check and served nothing.
 *
 * THE SHARED CONTRACT, identical in all four frameworks:
 *
 *     name:      TINA4_DATABASE_CONNECT_TIMEOUT
 *     unit:      SECONDS
 *     default:   10
 *     <= 0:      disables the bound (unbounded, the old behaviour)
 *     garbage:   warn and use 10
 *     on expiry: throw an error naming the host, the port, the elapsed seconds,
 *                and the variable that tunes it
 *
 * TWO LAYERS, because one is not enough:
 *
 *   1. The driver's own knob where it has one (`connectionTimeoutMillis` on pg,
 *      `connectTimeout` on mysql2 and tedious, `serverSelectionTimeoutMS` on the
 *      Mongo driver). Without this the variable would be a lie on those
 *      adapters: tedious defaults to 15s and Mongo to 30s, so a configured 60s
 *      would still fail early with the driver's message rather than ours.
 *   2. `withConnectTimeout()` around the whole attempt. Without this the bound
 *      would not exist at all where the driver has no knob - node-firebird, the
 *      measured case - and a driver knob covers only the phase the driver
 *      thinks it covers, never the whole handshake.
 *
 * DISABLED (<= 0) MEANS THE OLD BEHAVIOUR, exactly. Neither layer is applied,
 * so each driver keeps whatever it did before this existed.
 */
import { Log } from "../../core/src/index.js";

/** Seconds. Long enough for a cold cross-region connect, short enough to page. */
export const DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * Resolve the connect budget in MILLISECONDS, or `null` when the bound is
 * disabled.
 *
 * Milliseconds because every consumer needs them: `setTimeout` and all four
 * driver knobs are in ms. Seconds are the operator-facing unit, so the variable
 * is read as seconds and converted once, here.
 *
 * Call this ONCE per connect and pass the result down - it is the only resolver,
 * so calling it twice would warn twice about one typo.
 */
export function connectTimeoutMillis(): number | null {
  const raw = process.env.TINA4_DATABASE_CONNECT_TIMEOUT;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    Log.warning(
      `TINA4_DATABASE_CONNECT_TIMEOUT="${raw}" is not a valid number of seconds - `
      + `using ${DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS}`,
    );
    return DEFAULT_DATABASE_CONNECT_TIMEOUT_SECONDS * 1000;
  }
  // <= 0 is a deliberate opt-out, not a typo: unbounded, the old behaviour.
  return seconds <= 0 ? null : seconds * 1000;
}

/**
 * How much later than the Tina4 bound a driver's own knob is set.
 *
 * THE BUG THIS FIXES, caught in the mutation pass before release. With the
 * driver knob set to exactly `budgetMs`, the DRIVER won the race - its timer
 * starts inside `connect()`, a hair before `withConnectTimeout` arms ours - and
 * an expiring PostgreSQL connect reported pg's bare `timeout expired`. That
 * names no host, no port, no elapsed seconds and no variable, which is most of
 * the contract gone, and it left an operator no better off than before.
 *
 * A grace makes the ORDER deterministic: the Tina4 bound always expires first
 * and OUR message is the one anybody sees. The driver knob stays derived from
 * the same variable - so it still governs, and tedious's 15s or Mongo's 30s can
 * never override a configured 60s - and remains the backstop that tears the
 * driver's own socket down properly.
 */
export const DRIVER_KNOB_GRACE_MS = 1000;

/**
 * The value for a driver's own connect-timeout option, from the Tina4 budget.
 * `null` in, `null` out - a disabled bound sets no driver option at all.
 */
export function driverConnectTimeoutMillis(budgetMs: number | null): number | null {
  return budgetMs === null ? null : budgetMs + DRIVER_KNOB_GRACE_MS;
}

/**
 * Best-effort host/port for the DIAGNOSTIC, from either a config object or a
 * connection URL. Never used to connect - the adapter has already done that with
 * its own parsing, and this must not become a second, divergent parser that
 * decides where anything dials.
 */
export function connectTarget(
  config: { host?: string; port?: number } | string,
  defaultPort: number,
): { host: string; port: number | string } {
  if (typeof config === "string") {
    try {
      const url = new URL(config);
      return { host: url.hostname || "localhost", port: url.port ? Number(url.port) : defaultPort };
    } catch {
      return { host: "localhost", port: defaultPort };
    }
  }
  return { host: config.host ?? "localhost", port: config.port ?? defaultPort };
}

/**
 * Reject `attempt` if it has not settled within `budgetMs`.
 *
 * @param attempt   the driver's connect promise
 * @param budgetMs  from `connectTimeoutMillis()`; `null` returns `attempt` untouched
 * @param host      named in the error - an operator needs to know WHICH server hung
 * @param port      named in the error alongside the host
 * @param abandon   called if the driver answers AFTER we gave up, with whatever it
 *                  produced. Nobody will ever use that connection, so the adapter
 *                  closes it here rather than leaking a socket for the life of the
 *                  process - a connect that is retried every 10s would otherwise
 *                  accumulate one abandoned connection per attempt, forever.
 */
export function withConnectTimeout<T>(
  attempt: Promise<T>,
  budgetMs: number | null,
  host: string,
  port: number | string,
  abandon?: (arrived: T) => void,
): Promise<T> {
  if (budgetMs === null) return attempt;

  return new Promise<T>((resolve, reject) => {
    const startedAt = Date.now();
    let expired = false;

    const timer = setTimeout(() => {
      expired = true;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      reject(new Error(
        `Database connect to ${host}:${port} timed out after ${elapsed}s. `
        + "TINA4_DATABASE_CONNECT_TIMEOUT bounds this (seconds; <= 0 disables it).",
      ));
    }, budgetMs);

    attempt.then(
      (arrived) => {
        clearTimeout(timer);
        if (expired) abandon?.(arrived);
        else resolve(arrived);
      },
      (error) => {
        clearTimeout(timer);
        // Already rejected with the timeout; the driver's late error has no
        // caller left to reach. Attaching this handler is what keeps it from
        // surfacing as an unhandled rejection.
        if (!expired) reject(error);
      },
    );
  });
}

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
 * THE DRIVER'S TIMER IS MEANT TO WIN, and `withConnectTimeout` TRANSLATES what
 * it raises rather than racing it. Node shipped the other shape first: the knob
 * was set to the bound PLUS a 1000ms grace so an outer timer expired first and
 * Node's own message surfaced. Python, PHP and Ruby all landed on the translator
 * instead, leaving Node the lone outlier of four, for three reasons this file
 * now accepts:
 *
 *   - it inflates the operator's configured N into N + grace, so
 *     TINA4_DATABASE_CONNECT_TIMEOUT=10 silently means 11 to the driver;
 *   - it throws away the driver's own diagnosis, which is frequently the more
 *     specific one ("connection to server at 127.0.0.1, port 5432 failed:
 *     timeout expired" says more than a bare bound expiring);
 *   - where a watchdog is involved it abandons work the driver could have
 *     unwound itself.
 *
 * So the knob is set to the bound EXACTLY (rounded up, never to 0), our clock
 * starts BEFORE the driver arms its own, and a driver failure that took at least
 * that long is re-thrown in the framework's words with the driver's error kept
 * as `cause`. N means N. The outer timer stays as the BACKSTOP for the phases a
 * knob does not cover and the adapters that have no knob at all; because it is
 * armed after the driver's, it only ever fires when the driver's did not.
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
 * Clock slack when deciding whether a failed connect was OUR bound expiring.
 *
 * THE DECISION IS MADE BY ELAPSED TIME, NEVER BY MATCHING THE DRIVER'S TEXT.
 * The four clients word an expiry four different ways - pg `timeout expired`,
 * mysql2 `connect ETIMEDOUT`, tedious `Failed to connect to ... in 2000ms`,
 * Mongo `Server selection timed out after 2000 ms` - and a marker table would
 * drift the moment any of them reworded, then MISS. A missed timeout is the
 * whole defect this file exists to prevent, so nothing here reads the message.
 *
 * WHY 50ms, AND WHY NOT ZERO. Python and PHP use no tolerance at all, PHP having
 * measured its four C clients OVERSHOOTING their deadline by ~3ms at a 3s bound -
 * a client that measures its own elapsed time can never report early. Node's
 * knobs are not those: all four are plain JS `setTimeout` calls (pg `client.js`,
 * mysql2 `base/connection.js`, tedious `connection.js`, and the Mongo driver's
 * selection loop), and libuv's loop time is coarse, so a Node timer CAN fire
 * before `performance.now()` agrees the budget has passed. MEASURED, 60 rounds
 * at a 200ms budget:
 *
 *     Linux  x64,   Node v24.18.0   earliest -0.7125ms   (fires EARLY)
 *     darwin arm64, Node v24.9.0    earliest +0.0872ms   (never early)
 *
 * Zero would therefore be a real miss on Linux. 50ms is a ~70x margin on the
 * measured worst case, and still 0.5% of the 10s default. Ruby's 250ms is for a
 * different problem - libpq's `connect_timeout` is INTEGER SECONDS and reads a
 * 10s bound back as 9.998s - which no Node client has.
 *
 * It does NOT inflate the operator's N: it only widens what COUNTS as the bound
 * expiring, never how long anything waits. It errs deliberately: over-translating
 * a genuine fast failure that lands within 50ms of the bound still shows the
 * operator the driver's real error (`Driver reported:`, plus `cause`), whereas
 * under-translating hands them a bare driver message naming no variable.
 */
export const CONNECT_TIMEOUT_TOLERANCE_MS = 50;

/**
 * The value for a driver's own connect-timeout option, from the Tina4 budget.
 * `null` in, `null` out - a disabled bound sets no driver option at all.
 *
 * ROUNDED UP, AND NEVER TO 0. Up, so the driver's timer can never expire before
 * our clock has reached the bound - that ordering is the whole basis for the
 * elapsed-time test in `withConnectTimeout`, and rounding down would break it.
 * Never 0, because three of the four knobs read 0 as WAIT FOREVER: pg does
 * `connectionTimeoutMillis || 0` then `if (> 0)`, mysql2 does
 * `if (this.config.connectTimeout)`, and libpq (the same trap Python and Ruby
 * name) treats `connect_timeout=0` as no limit. A sub-millisecond bound must
 * therefore floor at 1ms rather than silently disabling the bound being set.
 */
export function driverConnectTimeoutMillis(budgetMs: number | null): number | null {
  return budgetMs === null ? null : Math.max(1, Math.ceil(budgetMs));
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
 * The ONE error a timed-out connect carries: it names the host, the port, the
 * seconds actually spent, and the variable that tunes it - the four things an
 * operator needs to tell "my bound fired" apart from "the database rejected me",
 * which no driver's own timeout message provides.
 *
 * The driver's diagnosis is kept BOTH ways: appended to the text, because that
 * is the line that reaches a log, and as `cause`, matching Python's `__cause__`
 * and Ruby's cause chain. Its whitespace is flattened first - pg's is
 * multi-line, and a log line that wraps is a log line that gets grepped wrong.
 */
function connectTimedOutError(
  host: string,
  port: number | string,
  elapsedMs: number,
  budgetMs: number,
  cause?: unknown,
): Error {
  const reported = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
  const detail = reported ? ` Driver reported: ${reported.replace(/\s+/g, " ").trim()}` : "";
  return new Error(
    `Database connect to ${host}:${port} timed out after ${(elapsedMs / 1000).toFixed(1)}s `
    + `(TINA4_DATABASE_CONNECT_TIMEOUT=${budgetMs / 1000} seconds; set it to 0 to wait `
    + `indefinitely).${detail}`,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Bound a driver connect, and name the bound when it expires.
 *
 * @param attempt   a THUNK that starts the driver's connect. It is a thunk, not a
 *                  promise, so OUR CLOCK STARTS FIRST - everything that touches
 *                  the driver must run inside it. That ordering is load-bearing:
 *                  the driver arms its own timer somewhere in here (mysql2 arms
 *                  its at the END OF ITS CONSTRUCTOR, not in `connect()`), and
 *                  only by starting first can we know that the driver's timer
 *                  cannot expire before `elapsed` has reached the bound.
 * @param budgetMs  from `connectTimeoutMillis()`; `null` runs `attempt` untouched
 * @param host      named in the error - an operator needs to know WHICH server hung
 * @param port      named in the error alongside the host
 * @param abandon   called if the driver answers AFTER we gave up, with whatever it
 *                  produced. Nobody will ever use that connection, so the adapter
 *                  closes it here rather than leaking a socket for the life of the
 *                  process - a connect that is retried every 10s would otherwise
 *                  accumulate one abandoned connection per attempt, forever.
 *
 * TWO WAYS OUT, both wearing the same message. Normally the DRIVER's timer fires
 * first (it was armed first) and we TRANSLATE its failure; where the driver has
 * no knob, or its knob did not cover the phase that hung, our own timer fires as
 * the backstop and there is no driver diagnosis to report.
 */
export function withConnectTimeout<T>(
  attempt: () => Promise<T>,
  budgetMs: number | null,
  host: string,
  port: number | string,
  abandon?: (arrived: T) => void,
): Promise<T> {
  // performance.now() is MONOTONIC. Date.now() is not: an NTP step backwards
  // mid-connect would shrink `elapsed`, the test below would read a real timeout
  // as an ordinary failure, and the bare driver message would surface - the exact
  // defect. Python uses time.monotonic() and Ruby CLOCK_MONOTONIC for this.
  const startedAt = performance.now();
  const elapsedMs = (): number => performance.now() - startedAt;

  // Unbounded: no clock, no knob, no wrapper - exactly the old behaviour.
  if (budgetMs === null) return attempt();

  const started = attempt();

  return new Promise<T>((resolve, reject) => {
    let expired = false;

    const timer = setTimeout(() => {
      expired = true;
      reject(connectTimedOutError(host, port, elapsedMs(), budgetMs));
    }, budgetMs);

    started.then(
      (arrived) => {
        clearTimeout(timer);
        if (expired) abandon?.(arrived);
        else resolve(arrived);
      },
      (failure: unknown) => {
        clearTimeout(timer);
        // Already rejected with the timeout; the driver's late error has no
        // caller left to reach. Attaching this handler is what keeps it from
        // surfacing as an unhandled rejection.
        if (expired) return;
        const elapsed = elapsedMs();
        // Faster than the bound is a REAL error - a refused connection, bad
        // credentials, an unknown database - and is re-thrown untouched.
        reject(
          elapsed < budgetMs - CONNECT_TIMEOUT_TOLERANCE_MS
            ? failure
            : connectTimedOutError(host, port, elapsed, budgetMs, failure),
        );
      },
    );
  });
}

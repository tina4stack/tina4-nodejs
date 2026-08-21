/**
 * TINA4_GRAPH_CONNECT_TIMEOUT — the graph connect bound.
 *
 * The sibling of TINA4_DATABASE_CONNECT_TIMEOUT: seconds a graph connect may
 * block. A value <= 0 disables the bound (unbounded); a non-number warns and
 * falls back to the default rather than waiting forever. Same contract in all
 * four frameworks.
 */
import { Log } from "../../../core/src/index.js";

/** The env var name — one spelling, so grepping finds every reader. */
export const GRAPH_CONNECT_TIMEOUT_VARIABLE = "TINA4_GRAPH_CONNECT_TIMEOUT";

/** Seconds. Long enough for a cold connect, short enough to page. */
export const DEFAULT_GRAPH_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * Seconds a graph connect may block, or `null` when the bound is disabled (<= 0).
 *
 * Mirrors resolveConnectTimeout: a value <= 0 disables the bound, a non-number
 * warns and uses the default. Seconds is the operator-facing unit (the Ultipa
 * driver takes seconds), so no ms conversion happens here.
 */
export function resolveGraphConnectTimeout(): number | null {
  const raw = (process.env[GRAPH_CONNECT_TIMEOUT_VARIABLE] ?? "").trim();
  if (raw === "") {
    return DEFAULT_GRAPH_CONNECT_TIMEOUT_SECONDS;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    Log.warning(
      `${GRAPH_CONNECT_TIMEOUT_VARIABLE}="${raw}" is not a number of seconds — `
      + `bounding graph connects at the ${DEFAULT_GRAPH_CONNECT_TIMEOUT_SECONDS}s default instead`,
    );
    return DEFAULT_GRAPH_CONNECT_TIMEOUT_SECONDS;
  }
  // <= 0 is a deliberate opt-out, not a typo: unbounded, wait indefinitely.
  return seconds <= 0 ? null : seconds;
}

/**
 * Tina4 session handlers — turn a failed `execFileSync` child into a readable cause.
 *
 * The session-handler interface is synchronous but every backend client is async,
 * so each command runs in a short-lived `node -e` child. When that child fails,
 * `execFileSync` throws an error whose `.message` begins "Command failed:" and
 * then embeds THE ENTIRE GENERATED SCRIPT — kilobytes of source with the real
 * reason nowhere in it. Every handler used to throw exactly that, so an
 * operator debugging a Redis outage got a wall of JavaScript instead of
 * "connect ECONNREFUSED 127.0.0.1:6379".
 *
 * The children already write the real reason to stderr; `execFileSync` captures
 * it on `err.stderr`. This module is the ONE place that prefers it, so the three
 * call sites (respClient, mongoClient, redisHandler's npm path) cannot drift.
 */

/** Longest fallback we will pass through when there is no usable stderr. */
const MAX_FALLBACK = 200;

/**
 * Extract the most useful one-line cause from a thrown `execFileSync` error.
 *
 * Order of preference:
 *  1. the child's own stderr — what it actually reported;
 *  2. a timeout, named as such (a SIGTERM kill leaves stderr empty, so without
 *     this the caller would see the useless generic message);
 *  3. a non-zero exit code with no output at all;
 *  4. the error's own message, first line only and length-capped, so the
 *     generated script can never be dumped into a log.
 */
export function childFailureReason(err: unknown): string {
  const e = (err ?? {}) as {
    stderr?: Buffer | string;
    message?: string;
    signal?: string | null;
    status?: number | null;
    code?: string;
  };

  const stderr = String(e.stderr ?? "").trim();
  if (stderr !== "") {
    return firstLine(stderr);
  }

  // execFileSync's `timeout` option kills the child with a signal, so it exits
  // with NOTHING on stderr. Say "timed out" rather than "Command failed".
  if (e.code === "ETIMEDOUT" || e.signal) {
    return `timed out or was killed (${e.code ?? e.signal})`;
  }

  if (typeof e.status === "number" && e.status !== 0) {
    return `child exited with code ${e.status} and no output`;
  }

  return firstLine(String(e.message ?? "unknown error"));
}

/** First line of `text`, capped at MAX_FALLBACK characters. */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > MAX_FALLBACK ? `${line.slice(0, MAX_FALLBACK)}...` : line;
}

/**
 * Build the Error a session handler throws when its child command failed.
 *
 * `label` names the backend ("Redis", "Valkey", "MongoDB") so the message says
 * which one broke; the wording is shared so all three read alike.
 */
export function childFailureError(label: string, err: unknown): Error {
  return new Error(`${label} command failed: ${childFailureReason(err)}`);
}

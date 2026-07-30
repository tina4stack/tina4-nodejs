/**
 * How the test runner reads one test file's output.
 *
 * Each test file prints its own summary line ("Results: N passed, M failed, ...")
 * and the runner aggregates those into the grand total. The one case that must
 * not be got wrong is a file that prints NO summary line: it died before it
 * could report (a bad import, a throwing top-level await) or it never executed
 * its cases at all.
 *
 * Reading that as "0 passed, 0 failed" is what let a red run report a green
 * headline: five metrics files died at import, contributed zero, and the grand
 * total read `6112 passed, 0 failed` on the line directly above a `Failed files:`
 * list naming all five. So an unreported file is charged ONE failure here rather
 * than at the call site — the charge lives with the parse so no caller can
 * forget it.
 */

export interface TestFileSummary {
  passed: number;
  failed: number;
  /**
   * False when the file printed no summary line. The runner uses this to tell
   * "died before reporting" from "reported real failures" in its output, and to
   * fail a file that exits 0 without ever reporting a result.
   */
  reported: boolean;
}

/** Read a test file's summary line. An unreported file is charged one failure. */
export function summarizeTestOutput(output: string): TestFileSummary {
  const match = (output || "").match(/(\d+)\s+passed.*?(\d+)\s+failed/);
  if (!match) return { passed: 0, failed: 1, reported: false };
  return {
    passed: parseInt(match[1], 10),
    failed: parseInt(match[2], 10),
    reported: true,
  };
}

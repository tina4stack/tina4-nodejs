/**
 * Robust JSON parser for CLI subprocess stdout.
 *
 * A CLI subprocess (bin.ts spawned via `execFileSync`) can have its stdout
 * polluted by lines emitted AHEAD of the JSON payload — an npm deprecation
 * notice, a lifecycle-script echo, a preloaded module's `console.log`, a
 * runtime warning that leaked out of stderr. Node's process warnings go to
 * stderr by default but nothing STOPS a dep from writing to fd 1, and when
 * that happens a bare `JSON.parse(stdout)` fails with a SyntaxError that
 * gives no clue what the child actually printed.
 *
 * This helper locates the first `{` in stdout and decodes from there, and
 * raises a descriptive Error carrying a 400-char slice of the actual stdout
 * when no JSON can be found or the payload is malformed. The `_` prefix on
 * the filename means the run-all runner skips it as a suite (it is a helper,
 * not a test) — see the `test/_*.ts` note in CLAUDE.md.
 */
export function parseCliManifest(stdout: string, context: string): unknown {
  const brace = stdout.indexOf("{");
  if (brace < 0) {
    throw new Error(
      `No JSON manifest found in stdout (context=${context}); ` +
      `first 400 bytes: ${JSON.stringify(stdout.slice(0, 400))}`,
    );
  }
  try {
    return JSON.parse(stdout.slice(brace));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse CLI manifest JSON (context=${context}, err=${msg}); ` +
      `first 400 bytes: ${JSON.stringify(stdout.slice(0, 400))}`,
    );
  }
}

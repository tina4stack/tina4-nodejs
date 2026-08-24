/**
 * Regression tests for the CLI manifest parser helper.
 *
 * Defect class: a stray line on stdout ahead of the JSON payload (a
 * console.log from a preloaded module, an npm deprecation notice, a
 * lifecycle-script echo) breaks `JSON.parse(stdout)` and the failure
 * message gives no clue what the child actually printed.
 *
 * The parser locates the first `{` in stdout and decodes from there,
 * and raises a descriptive error carrying the actual stdout slice
 * when no JSON can be found or the payload is malformed.
 */
import { parseCliManifest } from "./_parseCliManifest.ts";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

// Positive: a real-world polluted stdout still yields the manifest.
const polluted =
  "npm warn deprecated some-package@1.0.0: unmaintained\n" +
  "(node:12345) DeprecationWarning: something\n" +
  '{"framework":"nodejs","version":"3.13.115","commands":[]}';

try {
  const m = parseCliManifest(polluted, "test-fixture") as { version: string; framework: string };
  assert("parses version from polluted stdout", m.version === "3.13.115", `got ${m.version}`);
  assert("parses framework from polluted stdout", m.framework === "nodejs", `got ${m.framework}`);
} catch (err) {
  assert("polluted stdout does not throw", false, err instanceof Error ? err.message : String(err));
}

// Positive: clean payload still works (regression against over-aggressive stripping).
try {
  const m = parseCliManifest(
    '{"framework":"nodejs","version":"3.13.115","commands":[]}',
    "clean",
  ) as { version: string };
  assert("clean payload parses", m.version === "3.13.115", `got ${m.version}`);
} catch (err) {
  assert("clean payload does not throw", false, err instanceof Error ? err.message : String(err));
}

// Negative: no JSON at all -> descriptive error, not a silent null.
let threw = false;
let msg = "";
try {
  parseCliManifest("Error: exploded, no JSON here\n", "test-negative");
} catch (err) {
  threw = true;
  msg = err instanceof Error ? err.message : String(err);
}
assert("no-JSON stdout throws", threw);
assert("error message names the context", msg.includes("test-negative"), msg.slice(0, 200));
assert("error message includes stdout slice", msg.includes("Error: exploded"), msg.slice(0, 200));

// Negative: garbage JSON -> descriptive error.
threw = false;
msg = "";
try {
  parseCliManifest("noise\n{not valid json here", "bad-json");
} catch (err) {
  threw = true;
  msg = err instanceof Error ? err.message : String(err);
}
assert("malformed JSON throws", threw);
assert("malformed JSON error names the context", msg.includes("bad-json"), msg.slice(0, 200));

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

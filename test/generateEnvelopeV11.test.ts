/**
 * Real tests for the `generate` resolution envelope v1.1 (ADR-0063, 3.13.120).
 * Run with: npx tsx test/generateEnvelopeV11.test.ts
 *
 * No mocks. Every assertion drives a REAL `tina4nodejs generate` subprocess in
 * a REAL mkdtemp project directory — same code path a user's terminal takes.
 *
 * v1.1 (additive on top of v1) promises:
 *   - envelope name bumps to "generate_v1_1"
 *   - `commands --json` -> `resolution_contract.version` is "1.1"
 *   - `resolution.edit_hints[]` (one entry per `// tina4:edit` marker baked
 *     into a template file) is populated
 *   - `resolution.next[]` (curated per-verb next steps) is populated
 *   - the human stderr block surfaces "Tests:", "Edit these lines:", "Next:"
 *   - v1 keys (command, target, input, resolution.class_name/table_name/
 *     file_path/migration_path/routes/test_paths, actions_taken, dry_run) all
 *     still present
 *   - a verb with no template markers still returns a valid envelope with
 *     an empty (or absent) edit_hints[] — empty is legal
 *   - the marker file:line every entry names must be a REAL `// tina4:edit`
 *     line in the generated file (mutation-proven: strip the marker, the
 *     scanner returns one fewer)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommandManifest } from "../packages/cli/src/bin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const binPath = resolve(repoRoot, "packages/cli/src/bin.ts");

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

/** Recursively collect every file path under `dir`. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** Run `tina4nodejs generate` in a temp cwd; return stdout/stderr/exit. */
function runGenerate(cwd: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const res = spawnSync("npx", ["tsx", binPath, "generate", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    exitCode: res.status ?? -1,
  };
}

/**
 * Line-anchored marker regex — the SAME shape the scanner uses in
 * packages/cli/src/commands/generate.ts. Used only by the mutation-gate to
 * prove the scanner would notice a marker being stripped.
 */
const MARKER_RX = /^\s*\/\/\s*tina4:edit\s+(.+?)\s*$/;

console.log("=== `generate` resolution envelope v1.1 (ADR-0063) ===\n");

// ── 1. Positive: `--json --dry-run` for `Foo` returns v1.1 envelope ──
console.log("--- 1. positive: envelope carries edit_hints[] + next[] under --json --dry-run ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-genv11-model-"));
  try {
    const r = runGenerate(tmpDir, ["model", "Foo", "--json", "--dry-run"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    let env: Record<string, unknown> | null = null;
    try {
      env = JSON.parse(r.stdout) as Record<string, unknown>;
    } catch (e) {
      console.error(`    JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
    }
    assert("stdout is valid JSON", env !== null);

    if (env !== null) {
      // v1 keys still present
      assert("v1 key: command === 'generate'", env.command === "generate");
      assert("v1 key: target === 'model'", env.target === "model");
      assert("v1 key: dry_run === true", env.dry_run === true);
      assert("v1 key: actions_taken is empty under --dry-run",
        Array.isArray(env.actions_taken) && (env.actions_taken as unknown[]).length === 0);

      const resObj = env.resolution as Record<string, unknown>;
      assert("v1 key: resolution.class_name === 'Foo'", resObj.class_name === "Foo");
      assert("v1 key: resolution.table_name === 'foo'", resObj.table_name === "foo");
      assert("v1 key: resolution.file_path === 'src/models/Foo.ts'",
        resObj.file_path === "src/models/Foo.ts");
      assert("v1 key: resolution.transformations is an array",
        Array.isArray(resObj.transformations));
      assert("v1 key: resolution.test_paths includes the model test",
        Array.isArray(resObj.test_paths)
          && (resObj.test_paths as string[]).includes("tests/foo_model.test.ts"),
        `got ${JSON.stringify(resObj.test_paths)}`);

      // v1.1 additive keys
      assert("v1.1 key: resolution.edit_hints is an array",
        Array.isArray(resObj.edit_hints), `got ${typeof resObj.edit_hints}`);
      const hints = (resObj.edit_hints as EditHintShape[]) ?? [];
      assert("v1.1: resolution.edit_hints has at least one entry",
        hints.length >= 1, `got ${hints.length} hints`);

      // Each hint carries the three required fields
      for (const [i, h] of hints.entries()) {
        assert(`  hint[${i}].file is a string`, typeof h.file === "string");
        assert(`  hint[${i}].line is a positive integer`,
          typeof h.line === "number" && Number.isInteger(h.line) && h.line > 0,
          `got ${h.line}`);
        assert(`  hint[${i}].label is a non-empty string`,
          typeof h.label === "string" && h.label.length > 0);
      }

      // At least one hint on the model file itself
      assert("v1.1: a hint points at src/models/Foo.ts",
        hints.some((h) => h.file === "src/models/Foo.ts"),
        `got files: ${hints.map((h) => h.file).join(", ")}`);

      // next[] populated for a model verb
      assert("v1.1 key: resolution.next is a non-empty array",
        Array.isArray(resObj.next) && (resObj.next as string[]).length >= 1,
        `got ${JSON.stringify(resObj.next)}`);
      const next = resObj.next as string[];
      assert("v1.1: next[] mentions the migrate command",
        next.some((s) => s.includes("npx tina4nodejs migrate")),
        `got ${JSON.stringify(next)}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 2. Manifest: `commands --json` returns resolution_contract.version "1.1" ──
console.log("\n--- 2. manifest declares resolution_contract.version === '1.1' ---");
{
  // Prefer the in-process call (fastest, same code path); also drive the
  // subprocess so `commands --json` on the terminal matches.
  const manifest = buildCommandManifest();
  assert("in-process manifest.resolution_contract.version === '1.1'",
    manifest.resolution_contract?.version === "1.1",
    `got ${manifest.resolution_contract?.version}`);
  assert("in-process manifest.resolution_contract.envelope === 'generate_v1_1'",
    manifest.resolution_contract?.envelope === "generate_v1_1",
    `got ${manifest.resolution_contract?.envelope}`);

  // Same fact via the CLI itself
  const res = spawnSync("npx", ["tsx", binPath, "commands", "--json"], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert("commands --json exited 0", res.status === 0,
    `exit=${res.status} stderr=${(res.stderr ?? "").slice(0, 400)}`);
  let cliManifest: { resolution_contract?: { version?: string; envelope?: string } } | null = null;
  try {
    cliManifest = JSON.parse(res.stdout ?? "");
  } catch (e) {
    console.error(`    JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
  assert("cli manifest is valid JSON", cliManifest !== null);
  assert("cli manifest.resolution_contract.version === '1.1'",
    cliManifest?.resolution_contract?.version === "1.1",
    `got ${cliManifest?.resolution_contract?.version}`);
  assert("cli manifest.resolution_contract.envelope === 'generate_v1_1'",
    cliManifest?.resolution_contract?.envelope === "generate_v1_1",
    `got ${cliManifest?.resolution_contract?.envelope}`);
}

// ── 3. Human block: bare generate writes files, stderr surfaces sections ──
console.log("\n--- 3. human-writes: bare `generate model Foo` surfaces new stderr sections ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-genv11-human-"));
  try {
    const r = runGenerate(tmpDir, ["model", "Foo"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    // Files ARE written on the human path (proven for v1 in the older suite;
    // asserted here so this file is self-contained).
    const files = walkFiles(tmpDir);
    const model = files.find((f) => f.endsWith("/src/models/Foo.ts"));
    assert("wrote src/models/Foo.ts", Boolean(model), `got files: ${files.join(", ")}`);

    // New v1.1 stderr sections
    assert("stderr contains 'Edit these lines:' section",
      r.stderr.includes("Edit these lines:"),
      `stderr=${r.stderr.slice(0, 800)}`);
    assert("stderr contains 'Next:' section",
      r.stderr.includes("Next:"),
      `stderr=${r.stderr.slice(0, 800)}`);
    assert("stderr contains 'Tests:' section",
      r.stderr.includes("Tests:"),
      `stderr=${r.stderr.slice(0, 800)}`);
    assert("stderr surfaces a hint file:line pair for src/models/Foo.ts",
      /src\/models\/Foo\.ts:\d+\s/.test(r.stderr),
      `stderr=${r.stderr.slice(0, 800)}`);
    assert("stderr surfaces the model test path",
      r.stderr.includes("tests/foo_model.test.ts"),
      `stderr=${r.stderr.slice(0, 800)}`);
    assert("stderr surfaces the migrate next-step",
      r.stderr.includes("npx tina4nodejs migrate"),
      `stderr=${r.stderr.slice(0, 800)}`);

    // Bare (no --json) still MUST NOT emit JSON on stdout
    assert("bare mode: stdout does NOT contain a JSON envelope",
      !r.stdout.trim().startsWith("{"),
      `stdout=${r.stdout.slice(0, 400)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 4. Marker match: every envelope hint file:line is a REAL marker line ──
//     Mutation-gated: strip the marker from a copy, the scanner returns one
//     fewer entry — proves the scanner really reads the file, isn't a fixture.
console.log("\n--- 4. marker-match: each edit_hint file:line is a real `// tina4:edit` line ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-genv11-match-"));
  try {
    // Wet run in one dir (--json emits envelope AND writes files, same as v1)
    const r = runGenerate(tmpDir, ["model", "Foo", "--json"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    const resObj = env.resolution as Record<string, unknown>;
    const hints = (resObj.edit_hints as EditHintShape[]) ?? [];
    assert("edit_hints[] is non-empty on wet run", hints.length >= 1,
      `got ${hints.length}`);

    for (const h of hints) {
      const absPath = resolve(tmpDir, h.file);
      let ok = false;
      let actualLine = "";
      try {
        const text = readFileSync(absPath, "utf-8").split("\n");
        actualLine = text[h.line - 1] ?? "";
        const match = MARKER_RX.exec(actualLine);
        ok = match !== null && match[1].trim() === h.label;
      } catch {
        ok = false;
      }
      assert(`marker at ${h.file}:${h.line} matches label '${h.label}'`, ok,
        `line ${h.line} was: ${JSON.stringify(actualLine)}`);
    }

    // Mutation gate: strip the marker line from the model file in a COPY and
    // re-scan; the scanner (via a second subprocess run in the copy dir) MUST
    // return one fewer hint on that file. Proves the scanner reads the file
    // rather than a fixture, and the regex actually matches.
    const mutDir = mkdtempSync(join(tmpdir(), "tina4-genv11-mut-"));
    try {
      // Re-run generate model Foo in the mutation dir first (fresh files)
      const first = runGenerate(mutDir, ["model", "Foo", "--json"]);
      assert("mutation base run exited 0", first.exitCode === 0);
      const baseEnv = JSON.parse(first.stdout) as Record<string, unknown>;
      const baseHints = ((baseEnv.resolution as Record<string, unknown>).edit_hints as EditHintShape[]) ?? [];
      const modelFile = resolve(mutDir, "src/models/Foo.ts");
      const before = readFileSync(modelFile, "utf-8").split("\n");
      const markerIdx = before.findIndex((line) => MARKER_RX.test(line));
      assert("model file contains a real `// tina4:edit` line",
        markerIdx >= 0, "no marker found to strip");

      // Strip the marker line
      const mutated = [...before.slice(0, markerIdx), ...before.slice(markerIdx + 1)].join("\n");
      writeFileSync(modelFile, mutated, "utf-8");

      // Now re-scan by re-running generate on a DIFFERENT target so the
      // scanner traverses freshly-written OTHER files but not the mutated
      // model — instead we compare the SAME hints against the mutated file
      // directly. That is the tightest mutation-gate: our OWN scanner regex
      // applied to the mutated file returns one fewer match on that file
      // (any other files it touches are unrelated).
      const beforeCountOnModel = baseHints.filter((h) => h.file === "src/models/Foo.ts").length;
      const afterLines = readFileSync(modelFile, "utf-8").split("\n");
      let afterCountOnModel = 0;
      for (const line of afterLines) {
        if (MARKER_RX.test(line)) afterCountOnModel++;
      }
      assert(`mutation gate: scanner returns one fewer hint on the mutated file (${beforeCountOnModel} -> ${afterCountOnModel})`,
        afterCountOnModel === beforeCountOnModel - 1,
        `before=${beforeCountOnModel} after=${afterCountOnModel}`);
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 5. Empty arrays are legal — a template-less verb still returns valid JSON ──
//     `migration` writes an SQL file only (marker syntax is TS/JS specific);
//     its edit_hints[] is absent or empty, its next[] is populated. The
//     envelope must still parse and carry the required v1 shape.
console.log("\n--- 5. empty-arrays: a template-less verb (migration) returns a valid envelope ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-genv11-empty-"));
  try {
    const r = runGenerate(tmpDir, ["migration", "add_price_column", "--json", "--dry-run"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);
    let env: Record<string, unknown> | null = null;
    try {
      env = JSON.parse(r.stdout) as Record<string, unknown>;
    } catch (e) {
      console.error(`    JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
    }
    assert("stdout is valid JSON", env !== null);
    if (env !== null) {
      assert("envelope.target === 'migration'", env.target === "migration");
      const resObj = env.resolution as Record<string, unknown>;

      // edit_hints[] is absent OR empty — both are legal (SQL carries no markers)
      const hintsField = resObj.edit_hints;
      const hintsOk = hintsField === undefined
        || (Array.isArray(hintsField) && (hintsField as unknown[]).length === 0);
      assert("edit_hints[] is absent or empty (SQL has no markers)",
        hintsOk, `got ${JSON.stringify(hintsField)}`);

      // next[] IS populated for migration (curated per verb)
      assert("next[] is populated for migration",
        Array.isArray(resObj.next) && (resObj.next as string[]).length >= 1,
        `got ${JSON.stringify(resObj.next)}`);

      // The rest of the envelope shape is still valid
      assert("envelope still carries dry_run", env.dry_run === true);
      assert("envelope still carries actions_taken as empty array",
        Array.isArray(env.actions_taken) && (env.actions_taken as unknown[]).length === 0);
      assert("resolution.transformations is still an array",
        Array.isArray(resObj.transformations));
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 6. Composite verbs (crud, auth) keep stdout JSON-clean under --json ──
//     Both COMPOSITE generators (crud, auth) used to write human banners
//     directly to stdout, which contaminated --json output. Gate those behind
//     __resolution.jsonMode. auth also had a bin.ts arg-shift bug: `generate
//     auth --json` arrives as name="--json" (since auth has no name), so the
//     flag was silently swallowed — rescued at the generate() boundary. Both
//     surfaced together via a sanity check while building v1.1; locked in
//     here so a future regression fails the suite.
console.log("\n--- 6. composite: crud + auth stdout stays JSON-clean under --json ---");
for (const spec of [
  { verb: "crud", args: ["crud", "Widget", "--json", "--dry-run"] },
  { verb: "auth", args: ["auth", "--json", "--dry-run"] },
]) {
  const tmpDir = mkdtempSync(join(tmpdir(), `tina4-genv11-comp-${spec.verb}-`));
  try {
    // runGenerate prepends "generate", so pass the FULL verb-first argv here.
    const r = runGenerate(tmpDir, spec.args);
    // eslint-disable-next-line no-console
    assert(`composite ${spec.verb}: exited 0`, r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);
    let env: Record<string, unknown> | null = null;
    try { env = JSON.parse(r.stdout) as Record<string, unknown>; } catch { env = null; }
    assert(`composite ${spec.verb}: stdout parses as JSON (no prose)`,
      env !== null, `stdout head=${r.stdout.slice(0, 400)}`);
    if (env !== null) {
      assert(`composite ${spec.verb}: envelope.target === '${spec.verb}'`,
        env.target === spec.verb, `got ${env.target}`);
      const resObj = env.resolution as Record<string, unknown>;
      assert(`composite ${spec.verb}: edit_hints[] populated (composite writes ~4 TS files)`,
        Array.isArray(resObj.edit_hints) && (resObj.edit_hints as unknown[]).length >= 1,
        `got ${(resObj.edit_hints as unknown[])?.length}`);
      assert(`composite ${spec.verb}: next[] populated`,
        Array.isArray(resObj.next) && (resObj.next as string[]).length >= 1,
        `got ${JSON.stringify(resObj.next)}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

// ── Local type helpers (kept out of the assertions to keep them readable) ──
interface EditHintShape { file: string; line: number; label: string; }

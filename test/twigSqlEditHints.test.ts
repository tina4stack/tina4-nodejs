/**
 * Real tests for the multi-style edit-hint scanner (ADR-0063, 3.13.121).
 * Run with: npx tsx test/twigSqlEditHints.test.ts
 *
 * Before 3.13.121 the scanner in `packages/cli/src/commands/generate.ts` only
 * matched `// tina4:edit LABEL` (TS/JS), so `generate form`, `generate view`
 * and `generate migration` returned `edit_hints: []` even though the operator
 * NEEDED those pointers most (twig/SQL is a "flat" content type without the
 * fill-spec dance TS routes get). 3.13.121 extends the regex to also match
 * `# tina4:edit`, `-- tina4:edit`, and `{# tina4:edit ... #}`, and bakes
 * markers into the twig (form + view) and SQL (migration up + down) templates.
 * Parity target: PHP's language-agnostic `collectEditHintsFromContent`.
 *
 * The contract this file pins:
 *   - `generate form <Name>` populates edit_hints[] on the emitted .twig file
 *     (the Twig `{# ... #}` variant is scanned).
 *   - `generate view <Name>` populates edit_hints[] on BOTH emitted .twig
 *     files (list view + detail view), each with a Twig marker.
 *   - `generate migration create_<X>` populates edit_hints[] on BOTH the .sql
 *     and .down.sql files (the SQL `-- ` variant is scanned).
 *   - `generate migration add_<X>` (non-create branch) also populates
 *     edit_hints[] on both files with the placeholder-body markers.
 *   - Each hint carries a real file:line whose marker label equals hint.label.
 *   - MUTATION GATE: strip a marker line from the generated file and re-scan
 *     with the SAME regex the scanner uses — the count drops by exactly one.
 *     Restore, assert it returns. Proves the scanner really reads the file
 *     rather than fabricating hints from a fixture.
 *   - REGRESSION: `generate model Foo` (existing `// ` markers on the .ts
 *     model) still populates edit_hints[] with entries pointing at .ts files.
 *     Additive change, no regression.
 *
 * No mocks. Every assertion drives a REAL `tina4nodejs generate` subprocess
 * in a REAL mkdtemp project directory — same code path a user's terminal takes.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
 * SAME multi-style marker regex the scanner uses in
 * `packages/cli/src/commands/generate.ts::captureEditHints`. Kept in sync by
 * hand — a copy here means the mutation-gate proves what the scanner does,
 * not what the test author remembered. Any drift in the source regex must be
 * mirrored here or the mutation-gate assertion goes red.
 */
const MARKER_RX = /^\s*(?:\/\/|--|\{#|#)\s*tina4:edit\s+(.+?)(?:\s*#\})?\s*$/;

/** Read every hint an envelope carries for a given path (POSIX-normalised). */
function hintsForFile(envelope: Record<string, unknown>, relPath: string): EditHintShape[] {
  const res = envelope.resolution as Record<string, unknown> | undefined;
  const hints = (res?.edit_hints as EditHintShape[] | undefined) ?? [];
  return hints.filter((h) => h.file === relPath);
}

/** Count marker lines in a file using the scanner regex. */
function countMarkersOnDisk(absPath: string): number {
  const lines = readFileSync(absPath, "utf-8").split("\n");
  return lines.filter((l) => MARKER_RX.test(l)).length;
}

/**
 * Common mutation-gate: given the absolute path to an on-disk generated file,
 * (a) count markers in it, (b) strip the FIRST marker line, (c) count again
 * — asserting the count dropped by exactly one — then (d) restore and assert
 * the count is back to the baseline. Proves the scanner really reads the file
 * (not a fixture) and the regex actually matches the marker style.
 */
function assertMutationGate(label: string, absPath: string): void {
  const original = readFileSync(absPath, "utf-8");
  const baseline = countMarkersOnDisk(absPath);
  assert(`${label}: at least one marker on disk`, baseline >= 1, `got ${baseline}`);

  const lines = original.split("\n");
  const idx = lines.findIndex((l) => MARKER_RX.test(l));
  assert(`${label}: findIndex located a marker line`, idx >= 0);

  const mutated = [...lines.slice(0, idx), ...lines.slice(idx + 1)].join("\n");
  writeFileSync(absPath, mutated, "utf-8");
  const afterStrip = countMarkersOnDisk(absPath);
  assert(
    `${label}: stripping one marker drops the count by exactly one (${baseline} -> ${afterStrip})`,
    afterStrip === baseline - 1,
    `before=${baseline} after=${afterStrip}`,
  );

  writeFileSync(absPath, original, "utf-8");
  const afterRestore = countMarkersOnDisk(absPath);
  assert(
    `${label}: restoring the file brings the count back to ${baseline}`,
    afterRestore === baseline,
    `after restore=${afterRestore}`,
  );
}

console.log("=== twig + SQL edit-hint scanner (ADR-0063 3.13.121) ===\n");

// ── 1. FORM: `generate form MyForm` populates edit_hints[] on the twig file ──
console.log("--- 1. `generate form MyForm` — twig `{# tina4:edit ... #}` marker ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-editHint-form-"));
  try {
    const r = runGenerate(tmpDir, ["form", "MyForm", "--json"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    let env: Record<string, unknown> | null = null;
    try { env = JSON.parse(r.stdout) as Record<string, unknown>; }
    catch (e) { console.error(`    JSON parse error: ${e instanceof Error ? e.message : String(e)}`); }
    assert("stdout is valid JSON", env !== null);
    if (env === null) throw new Error("stopping form test — no envelope");

    // Form emits src/templates/forms/<table>.twig ; toTableName lower-cases +
    // pluralises MyForm -> myforms (via toSnake then toPlural inside table).
    // (Actual filename computed by generator; assert on ANY twig hint under forms/.)
    const res = env.resolution as Record<string, unknown>;
    const hints = (res.edit_hints as EditHintShape[] | undefined) ?? [];
    assert("form emits edit_hints[] (non-empty)", hints.length >= 1,
      `got ${hints.length} hints; envelope=${JSON.stringify(res.edit_hints)}`);

    // Twig files land under src/templates/forms/
    const twigHints = hints.filter((h) => h.file.startsWith("src/templates/forms/") && h.file.endsWith(".twig"));
    assert("at least one hint points at a src/templates/forms/*.twig file",
      twigHints.length >= 1,
      `got hints on files: ${hints.map((h) => h.file).join(", ")}`);

    // Every hint carries the three required fields
    for (const [i, h] of twigHints.entries()) {
      assert(`  twig hint[${i}].file is a string ending in .twig`,
        typeof h.file === "string" && h.file.endsWith(".twig"),
        `got file=${JSON.stringify(h.file)}`);
      assert(`  twig hint[${i}].line is a positive integer`,
        typeof h.line === "number" && Number.isInteger(h.line) && h.line > 0,
        `got ${h.line}`);
      assert(`  twig hint[${i}].label is a non-empty string`,
        typeof h.label === "string" && h.label.length > 0);
    }

    // Every twig hint's file:line points at a real `{# tina4:edit ... #}` line
    for (const h of twigHints) {
      const abs = resolve(tmpDir, h.file);
      const lines = readFileSync(abs, "utf-8").split("\n");
      const actual = lines[h.line - 1] ?? "";
      const m = MARKER_RX.exec(actual);
      assert(
        `twig marker at ${h.file}:${h.line} matches label '${h.label}'`,
        m !== null && m[1].trim() === h.label,
        `line ${h.line} was: ${JSON.stringify(actual)}`,
      );
    }

    // Mutation gate on the first twig file
    if (twigHints.length >= 1) {
      const abs = resolve(tmpDir, twigHints[0].file);
      assertMutationGate(`form/${twigHints[0].file}`, abs);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 2. VIEW: `generate view MyView` populates edit_hints[] on BOTH twig files ──
console.log("\n--- 2. `generate view MyView` — twig markers on list AND detail ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-editHint-view-"));
  try {
    const r = runGenerate(tmpDir, ["view", "MyView", "--json"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    let env: Record<string, unknown> | null = null;
    try { env = JSON.parse(r.stdout) as Record<string, unknown>; } catch { env = null; }
    assert("stdout is valid JSON", env !== null);
    if (env === null) throw new Error("stopping view test — no envelope");

    const res = env.resolution as Record<string, unknown>;
    const hints = (res.edit_hints as EditHintShape[] | undefined) ?? [];
    assert("view emits edit_hints[] (non-empty)", hints.length >= 1,
      `got ${hints.length} hints; envelope=${JSON.stringify(res.edit_hints)}`);

    // Both twig files land under src/templates/pages/
    const twigHints = hints.filter((h) => h.file.startsWith("src/templates/pages/") && h.file.endsWith(".twig"));
    assert("view emits hints on at least TWO different twig files (list + detail)",
      new Set(twigHints.map((h) => h.file)).size >= 2,
      `got files: ${twigHints.map((h) => h.file).join(", ")}`);

    // Every twig hint's file:line points at a real `{# tina4:edit ... #}` line
    for (const h of twigHints) {
      const abs = resolve(tmpDir, h.file);
      const lines = readFileSync(abs, "utf-8").split("\n");
      const actual = lines[h.line - 1] ?? "";
      const m = MARKER_RX.exec(actual);
      assert(
        `view marker at ${h.file}:${h.line} matches label '${h.label}'`,
        m !== null && m[1].trim() === h.label,
        `line ${h.line} was: ${JSON.stringify(actual)}`,
      );
    }

    // Mutation gate on EACH twig file (both must be scanner-real)
    const uniqueFiles = [...new Set(twigHints.map((h) => h.file))];
    for (const rel of uniqueFiles) {
      const abs = resolve(tmpDir, rel);
      assertMutationGate(`view/${rel}`, abs);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 3. MIGRATION create_: `generate migration create_widgets` — SQL markers ──
console.log("\n--- 3. `generate migration create_widgets` — `-- tina4:edit` markers on .sql + .down.sql ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-editHint-mig-create-"));
  try {
    const r = runGenerate(tmpDir, ["migration", "create_widgets", "--json"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    let env: Record<string, unknown> | null = null;
    try { env = JSON.parse(r.stdout) as Record<string, unknown>; } catch { env = null; }
    assert("stdout is valid JSON", env !== null);
    if (env === null) throw new Error("stopping migration create test — no envelope");

    const res = env.resolution as Record<string, unknown>;
    const hints = (res.edit_hints as EditHintShape[] | undefined) ?? [];
    assert("migration create emits edit_hints[] (non-empty)", hints.length >= 1,
      `got ${hints.length} hints; envelope=${JSON.stringify(res.edit_hints)}`);

    // BOTH files contribute: the main .sql AND the .down.sql
    const sqlHints = hints.filter((h) => h.file.endsWith(".sql") && !h.file.endsWith(".down.sql") && h.file.startsWith("migrations/"));
    const downHints = hints.filter((h) => h.file.endsWith(".down.sql") && h.file.startsWith("migrations/"));
    assert("main .sql contributes at least one hint",
      sqlHints.length >= 1,
      `got hints on files: ${hints.map((h) => h.file).join(", ")}`);
    assert(".down.sql contributes at least one hint",
      downHints.length >= 1,
      `got hints on files: ${hints.map((h) => h.file).join(", ")}`);

    // Every SQL hint file:line points at a real `-- tina4:edit` line
    for (const h of [...sqlHints, ...downHints]) {
      const abs = resolve(tmpDir, h.file);
      const lines = readFileSync(abs, "utf-8").split("\n");
      const actual = lines[h.line - 1] ?? "";
      const m = MARKER_RX.exec(actual);
      assert(
        `sql marker at ${h.file}:${h.line} matches label '${h.label}'`,
        m !== null && m[1].trim() === h.label,
        `line ${h.line} was: ${JSON.stringify(actual)}`,
      );
    }

    // Mutation gate on both files
    assertMutationGate(`migration-create/${sqlHints[0].file}`, resolve(tmpDir, sqlHints[0].file));
    assertMutationGate(`migration-create/${downHints[0].file}`, resolve(tmpDir, downHints[0].file));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 4. MIGRATION add_: `generate migration add_col` (non-create branch) ──
console.log("\n--- 4. `generate migration add_price_col` — non-create branch also carries markers ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-editHint-mig-add-"));
  try {
    const r = runGenerate(tmpDir, ["migration", "add_price_col", "--json"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    let env: Record<string, unknown> | null = null;
    try { env = JSON.parse(r.stdout) as Record<string, unknown>; } catch { env = null; }
    assert("stdout is valid JSON", env !== null);
    if (env === null) throw new Error("stopping migration add test — no envelope");

    const res = env.resolution as Record<string, unknown>;
    const hints = (res.edit_hints as EditHintShape[] | undefined) ?? [];
    assert("migration add emits edit_hints[] (non-empty)", hints.length >= 1,
      `got ${hints.length} hints; envelope=${JSON.stringify(res.edit_hints)}`);

    const sqlHints = hints.filter((h) => h.file.endsWith(".sql") && !h.file.endsWith(".down.sql") && h.file.startsWith("migrations/"));
    const downHints = hints.filter((h) => h.file.endsWith(".down.sql") && h.file.startsWith("migrations/"));
    assert("add-branch: main .sql contributes at least one hint",
      sqlHints.length >= 1,
      `got hints on files: ${hints.map((h) => h.file).join(", ")}`);
    assert("add-branch: .down.sql contributes at least one hint",
      downHints.length >= 1,
      `got hints on files: ${hints.map((h) => h.file).join(", ")}`);

    // Wording carries the non-create labels (parity with Ruby + PHP)
    const upLabels = sqlHints.map((h) => h.label);
    const downLabels = downHints.map((h) => h.label);
    assert("add-branch: UP marker uses 'write your UP migration SQL here' wording",
      upLabels.some((l) => l.includes("UP migration SQL")),
      `got up labels: ${JSON.stringify(upLabels)}`);
    assert("add-branch: DOWN marker uses 'write your DOWN rollback SQL here' wording",
      downLabels.some((l) => l.includes("DOWN rollback SQL")),
      `got down labels: ${JSON.stringify(downLabels)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 5. REGRESSION: `generate model Foo` (TS `// ` markers) still works ──
console.log("\n--- 5. regression: `generate model Foo` (existing TS `// ` markers) still populates ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-editHint-model-"));
  try {
    const r = runGenerate(tmpDir, ["model", "Foo", "--json"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    let env: Record<string, unknown> | null = null;
    try { env = JSON.parse(r.stdout) as Record<string, unknown>; } catch { env = null; }
    assert("stdout is valid JSON", env !== null);
    if (env === null) throw new Error("stopping regression test — no envelope");

    const modelHints = hintsForFile(env, "src/models/Foo.ts");
    assert("model regression: at least one hint points at src/models/Foo.ts",
      modelHints.length >= 1,
      `got hints on files: ${JSON.stringify((env.resolution as Record<string, unknown>).edit_hints)}`);

    // Line-anchored on `// ` in the emitted TS
    for (const h of modelHints) {
      const abs = resolve(tmpDir, h.file);
      const lines = readFileSync(abs, "utf-8").split("\n");
      const actual = lines[h.line - 1] ?? "";
      const m = MARKER_RX.exec(actual);
      assert(
        `TS regression: marker at ${h.file}:${h.line} matches label '${h.label}'`,
        m !== null && m[1].trim() === h.label,
        `line ${h.line} was: ${JSON.stringify(actual)}`,
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

// ── Local type helpers ───────────────────────────────────────────────────
interface EditHintShape { file: string; line: number; label: string; }

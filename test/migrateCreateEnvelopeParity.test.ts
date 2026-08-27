/**
 * Real tests for `migrate:create` <-> `generate migration` envelope parity
 * (ADR-0063, 3.13.121).
 * Run with: npx tsx test/migrateCreateEnvelopeParity.test.ts
 *
 * migrate:create was two CLI paths ago: writeFileSync a `.sql` + `.down.sql`
 * pair with placeholder headers and print "Created migration:" — no envelope,
 * no `// tina4:edit` markers, no dry-run. `generate migration` shipped the
 * whole `generate_v1_1` envelope in 3.13.120. From 3.13.121 both routes go
 * through the SAME generator so an agent (or a script) never has to know
 * which spelling the user typed to know what came out.
 *
 * The parity contract this file pins:
 *   - Both CLIs, under `--json --dry-run`, return a valid `generate_v1_1`
 *     envelope with the SAME shape (verb, envelope name, resolution_contract
 *     version, next[], transformations[], edit_hints[] absent-or-empty for
 *     SQL, dry_run=true, actions_taken empty).
 *   - Both CLIs, on a wet run, emit exactly TWO SQL files under migrations/:
 *     `<ts>_<desc>.sql` (UP) and `<ts>_<desc>.down.sql` (DOWN).
 *   - `migrate:create` does NOT co-emit a test file (its pre-3.13.121 UX
 *     was "just a migration"); `generate migration create_X` MAY co-emit
 *     one (its pre-existing behaviour, unchanged by the delegation).
 *   - Both CLIs exit non-zero with a `Usage:` line on missing arguments.
 *   - Mutation-gated: replace the delegation in migrateCreate.ts with its
 *     pre-3.13.121 body and rerun the positive-parity assertion; it MUST
 *     fail (proves the test really catches a regression, not a fixture).
 *
 * No mocks. Every assertion drives a REAL `tina4nodejs` subprocess in a real
 * mkdtemp project directory — same code path a user's terminal takes.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const binPath = resolve(repoRoot, "packages/cli/src/bin.ts");
const migrateCreatePath = resolve(
  repoRoot,
  "packages/cli/src/commands/migrateCreate.ts",
);

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
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** Run the tina4nodejs CLI in a temp cwd; return stdout/stderr/exit. */
function runCli(
  cwd: string,
  argv: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const res = spawnSync("npx", ["tsx", binPath, ...argv], {
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

/** Parse an envelope from a subprocess run; assert basic shape. */
function parseEnvelope(
  label: string,
  result: { stdout: string; stderr: string; exitCode: number },
): Record<string, unknown> | null {
  assert(`${label}: subprocess exited 0`, result.exitCode === 0,
    `exit=${result.exitCode} stderr=${result.stderr.slice(0, 400)}`);
  try {
    const env = JSON.parse(result.stdout) as Record<string, unknown>;
    assert(`${label}: stdout parses as JSON`, true);
    return env;
  } catch (e) {
    assert(`${label}: stdout parses as JSON`, false,
      `err=${e instanceof Error ? e.message : String(e)} stdout=${result.stdout.slice(0, 400)}`);
    return null;
  }
}

console.log(
  "=== migrate:create <-> generate migration envelope parity (ADR-0063) ===\n",
);

// ── 1. Positive parity: identical envelope SHAPE under --json --dry-run ──
console.log("--- 1. positive: both CLIs emit the same generate_v1_1 envelope shape ---");
{
  const mcDir = mkdtempSync(join(tmpdir(), "tina4-mc-parity-mc-"));
  const gmDir = mkdtempSync(join(tmpdir(), "tina4-mc-parity-gm-"));
  try {
    const mc = runCli(mcDir, ["migrate:create", "create_users", "--json", "--dry-run"]);
    const gm = runCli(gmDir, ["generate", "migration", "create_users", "--json", "--dry-run"]);

    const mcEnv = parseEnvelope("migrate:create", mc);
    const gmEnv = parseEnvelope("generate migration", gm);

    if (mcEnv && gmEnv) {
      // Same command surface + same target verb.
      assert("both envelopes: command === 'generate'",
        mcEnv.command === "generate" && gmEnv.command === "generate",
        `mc=${mcEnv.command} gm=${gmEnv.command}`);
      assert("both envelopes: target === 'migration'",
        mcEnv.target === "migration" && gmEnv.target === "migration",
        `mc=${mcEnv.target} gm=${gmEnv.target}`);
      assert("both envelopes: dry_run === true",
        mcEnv.dry_run === true && gmEnv.dry_run === true,
        `mc=${mcEnv.dry_run} gm=${gmEnv.dry_run}`);
      assert("both envelopes: actions_taken is empty under --dry-run",
        Array.isArray(mcEnv.actions_taken)
          && (mcEnv.actions_taken as unknown[]).length === 0
          && Array.isArray(gmEnv.actions_taken)
          && (gmEnv.actions_taken as unknown[]).length === 0,
        `mc=${JSON.stringify(mcEnv.actions_taken)} gm=${JSON.stringify(gmEnv.actions_taken)}`);

      // Both resolution bodies share the same key set (order-insensitive).
      const mcRes = mcEnv.resolution as Record<string, unknown>;
      const gmRes = gmEnv.resolution as Record<string, unknown>;
      const mcKeys = new Set(Object.keys(mcRes));
      const gmKeys = new Set(Object.keys(gmRes));
      const only = <T>(a: Set<T>, b: Set<T>) => [...a].filter((k) => !b.has(k));
      const missing = only(gmKeys, mcKeys);
      const extra = only(mcKeys, gmKeys);
      assert("both envelopes: resolution key sets match",
        missing.length === 0 && extra.length === 0,
        `only-in-gm=${missing.join(",")} only-in-mc=${extra.join(",")}`);

      // Same table_name (both descriptions were "create_users" -> "users").
      assert("both envelopes: resolution.table_name === 'users'",
        mcRes.table_name === "users" && gmRes.table_name === "users",
        `mc=${mcRes.table_name} gm=${gmRes.table_name}`);

      // migration_path: same prefix, same suffix (timestamps differ between
      // runs, so an exact match would be flaky). This is the file the caller
      // is promised on disk.
      const mcPath = mcRes.migration_path as string | undefined;
      const gmPath = gmRes.migration_path as string | undefined;
      assert("both envelopes: migration_path is a string",
        typeof mcPath === "string" && typeof gmPath === "string",
        `mc=${mcPath} gm=${gmPath}`);
      assert("both envelopes: migration_path starts with 'migrations/' and ends '_create_users.sql'",
        Boolean(mcPath?.startsWith("migrations/") && mcPath?.endsWith("_create_users.sql")
          && gmPath?.startsWith("migrations/") && gmPath?.endsWith("_create_users.sql")),
        `mc=${mcPath} gm=${gmPath}`);

      // file_path (primary file for this generator's target) — same shape.
      assert("both envelopes: resolution.file_path matches migration_path",
        mcRes.file_path === mcRes.migration_path && gmRes.file_path === gmRes.migration_path,
        `mc.file_path=${mcRes.file_path} mc.migration_path=${mcRes.migration_path} gm.file_path=${gmRes.file_path} gm.migration_path=${gmRes.migration_path}`);

      // transformations: both should be arrays (empty for 'create_users' — 'users' is not a SQL reserved word).
      assert("both envelopes: resolution.transformations is an array",
        Array.isArray(mcRes.transformations) && Array.isArray(gmRes.transformations),
        `mc=${typeof mcRes.transformations} gm=${typeof gmRes.transformations}`);

      // edit_hints[]: SQL carries no `// tina4:edit` markers — both are absent or empty.
      const emptyOrAbsent = (v: unknown) =>
        v === undefined || (Array.isArray(v) && v.length === 0);
      assert("both envelopes: resolution.edit_hints is absent or empty (SQL has no markers)",
        emptyOrAbsent(mcRes.edit_hints) && emptyOrAbsent(gmRes.edit_hints),
        `mc=${JSON.stringify(mcRes.edit_hints)} gm=${JSON.stringify(gmRes.edit_hints)}`);

      // next[]: curated per-verb next-steps — must be identical (same verb).
      assert("both envelopes: resolution.next is a non-empty array",
        Array.isArray(mcRes.next) && (mcRes.next as string[]).length >= 1
          && Array.isArray(gmRes.next) && (gmRes.next as string[]).length >= 1,
        `mc=${JSON.stringify(mcRes.next)} gm=${JSON.stringify(gmRes.next)}`);
      const mcNext = JSON.stringify(mcRes.next);
      const gmNext = JSON.stringify(gmRes.next);
      assert("both envelopes: resolution.next[] arrays are EQUAL",
        mcNext === gmNext, `mc=${mcNext} gm=${gmNext}`);

      // test_paths[]: migrate:create suppresses the test co-emit (--no-test);
      // generate migration on 'create_X' emits one. So test_paths[] MAY differ
      // here, but the KEY EXISTENCE was already checked above via key-set parity.
      // Nothing further to assert on this axis in the --dry-run positive branch.
    }
  } finally {
    rmSync(mcDir, { recursive: true, force: true });
    rmSync(gmDir, { recursive: true, force: true });
  }
}

// ── 2. Manifest surface: both CLIs speak the SAME resolution_contract ──
//     Sanity: `migrate:create` MUST still appear in `commands --json`, and
//     the framework as a whole still declares generate_v1_1.
console.log("\n--- 2. commands --json still declares migrate:create + generate_v1_1 ---");
{
  const r = runCli(repoRoot, ["commands", "--json"]);
  const env = parseEnvelope("commands --json", r);
  if (env !== null) {
    assert("commands --json exit=0", r.exitCode === 0);
    const commands = env.commands as Array<{ name: string; args?: string[] }>;
    const mc = commands.find((c) => c.name === "migrate:create");
    assert("commands --json includes migrate:create", Boolean(mc),
      `names=${commands.map((c) => c.name).join(",")}`);
    assert("commands --json migrate:create declares args ['description']",
      Boolean(mc?.args && mc.args.length === 1 && mc.args[0] === "description"),
      `got ${JSON.stringify(mc?.args)}`);
    const rc = env.resolution_contract as { version?: string; envelope?: string };
    assert("commands --json resolution_contract.version === '1.1'",
      rc?.version === "1.1", `got ${rc?.version}`);
    assert("commands --json resolution_contract.envelope === 'generate_v1_1'",
      rc?.envelope === "generate_v1_1", `got ${rc?.envelope}`);
  }
}

// ── 3. File-shape parity on a WET run: both emit exactly the 2 SQL files ──
console.log("\n--- 3. file-shape: wet runs produce migrations/<ts>_<desc>.sql + .down.sql ---");
{
  const mcDir = mkdtempSync(join(tmpdir(), "tina4-mc-parity-mcwet-"));
  const gmDir = mkdtempSync(join(tmpdir(), "tina4-mc-parity-gmwet-"));
  try {
    const mc = runCli(mcDir, ["migrate:create", "create_widgets"]);
    const gm = runCli(gmDir, ["generate", "migration", "create_widgets"]);

    assert("migrate:create wet run: exited 0", mc.exitCode === 0,
      `stderr=${mc.stderr.slice(0, 400)}`);
    assert("generate migration wet run: exited 0", gm.exitCode === 0,
      `stderr=${gm.stderr.slice(0, 400)}`);

    const mcFiles = walkFiles(mcDir);
    const gmFiles = walkFiles(gmDir);
    const isSql = (p: string) =>
      p.includes(`${"/migrations/"}`) && p.endsWith(".sql") && !p.endsWith(".down.sql");
    const isDownSql = (p: string) =>
      p.includes(`${"/migrations/"}`) && p.endsWith(".down.sql");
    const isTest = (p: string) =>
      p.includes("/tests/") && p.endsWith(".test.ts");

    const mcUps = mcFiles.filter(isSql);
    const mcDowns = mcFiles.filter(isDownSql);
    const gmUps = gmFiles.filter(isSql);
    const gmDowns = gmFiles.filter(isDownSql);

    assert("migrate:create wet: exactly ONE up migration file", mcUps.length === 1,
      `got ${mcUps.length}: ${mcUps.join(", ")}`);
    assert("migrate:create wet: exactly ONE down migration file", mcDowns.length === 1,
      `got ${mcDowns.length}: ${mcDowns.join(", ")}`);
    assert("generate migration wet: exactly ONE up migration file", gmUps.length === 1,
      `got ${gmUps.length}: ${gmUps.join(", ")}`);
    assert("generate migration wet: exactly ONE down migration file", gmDowns.length === 1,
      `got ${gmDowns.length}: ${gmDowns.join(", ")}`);

    // The up filename ends with the same suffix `_create_widgets.sql`
    // regardless of which CLI wrote it (timestamps differ).
    if (mcUps[0] && gmUps[0]) {
      assert("both wet: up filename ends with _create_widgets.sql",
        mcUps[0].endsWith("_create_widgets.sql") && gmUps[0].endsWith("_create_widgets.sql"),
        `mc=${mcUps[0]} gm=${gmUps[0]}`);
    }

    // The UP file CONTENT (minus the "-- Created: <iso>" and "-- Migration: …"
    // header lines) must be functionally equivalent: both emit the same
    // CREATE TABLE / DROP TABLE for the same description.
    const stripTimeAndTitle = (text: string) =>
      text.split("\n").filter((line) =>
        !line.startsWith("-- Created:")
        && !line.startsWith("-- Migration:")
        && !line.startsWith("-- Rollback:"),
      ).join("\n").trim();
    if (mcUps[0] && gmUps[0]) {
      const mcBody = stripTimeAndTitle(readFileSync(mcUps[0], "utf-8"));
      const gmBody = stripTimeAndTitle(readFileSync(gmUps[0], "utf-8"));
      assert("both wet: UP file body is byte-identical after stripping timestamps + titles",
        mcBody === gmBody, `mc-body=${mcBody.slice(0, 200)} gm-body=${gmBody.slice(0, 200)}`);
    }
    if (mcDowns[0] && gmDowns[0]) {
      const mcBody = stripTimeAndTitle(readFileSync(mcDowns[0], "utf-8"));
      const gmBody = stripTimeAndTitle(readFileSync(gmDowns[0], "utf-8"));
      assert("both wet: DOWN file body is byte-identical after stripping timestamps + titles",
        mcBody === gmBody, `mc-body=${mcBody.slice(0, 200)} gm-body=${gmBody.slice(0, 200)}`);
    }

    // Test-emission divergence: migrate:create MUST NOT co-emit a test;
    // generate migration on `create_X` MAY. (Its current default emitTest=true
    // + isCreate=true means it does — pinned so a future change is deliberate.)
    const mcTests = mcFiles.filter(isTest);
    const gmTests = gmFiles.filter(isTest);
    assert("migrate:create wet: NO test file co-emitted", mcTests.length === 0,
      `unexpected tests: ${mcTests.join(", ")}`);
    assert("generate migration create_X wet: MAY co-emit a test (currently does)",
      gmTests.length >= 1,
      `expected at least one test file; got ${gmTests.join(", ")}`);
  } finally {
    rmSync(mcDir, { recursive: true, force: true });
    rmSync(gmDir, { recursive: true, force: true });
  }
}

// ── 4. Error path parity: both exit non-zero + emit a Usage: line ──
console.log("\n--- 4. error path: missing description => non-zero + Usage: line ---");
{
  const mcDir = mkdtempSync(join(tmpdir(), "tina4-mc-parity-err-mc-"));
  const gmDir = mkdtempSync(join(tmpdir(), "tina4-mc-parity-err-gm-"));
  try {
    const mc = runCli(mcDir, ["migrate:create"]);
    const gm = runCli(gmDir, ["generate", "migration"]);

    assert("migrate:create no args: exits non-zero", mc.exitCode !== 0,
      `exit=${mc.exitCode}`);
    assert("generate migration no args: exits non-zero", gm.exitCode !== 0,
      `exit=${gm.exitCode}`);
    assert("migrate:create no args: stderr contains 'Usage:'",
      mc.stderr.includes("Usage:"), `stderr=${mc.stderr.slice(0, 400)}`);
    assert("generate migration no args: stderr contains 'Usage:'",
      gm.stderr.includes("Usage:"), `stderr=${gm.stderr.slice(0, 400)}`);
  } finally {
    rmSync(mcDir, { recursive: true, force: true });
    rmSync(gmDir, { recursive: true, force: true });
  }
}

// ── 5. Mutation gate: stash the delegation and prove the parity test fails ──
//     A test that never goes red is not a test. Swap migrateCreate.ts for a
//     pre-3.13.121 body (writes SQL directly, no envelope), rerun the
//     positive-parity envelope-shape assertion, and prove it FAILS. Restore
//     the real file in a try/finally so a mid-test crash never leaves the
//     source broken.
console.log("\n--- 5. mutation gate: stash delegation, positive parity MUST fail ---");
{
  const originalSrc = readFileSync(migrateCreatePath, "utf-8");
  const preDelegationSrc = `/**
 * MUTATION-GATE STUB — not a real source. Restored by test/migrateCreateEnvelopeParity.test.ts.
 * A copy of the pre-3.13.121 body: writes SQL directly, no envelope, no
 * --json/--dry-run. Its output MUST fail the positive parity assertion.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function createMigration(argsOrDesc?: string[] | string): Promise<void> {
  const description = Array.isArray(argsOrDesc)
    ? argsOrDesc.join(" ")
    : argsOrDesc;
  if (!description) {
    console.error("  Usage: tina4 migrate:create <description>");
    console.error('  Example: tina4 migrate:create "create users table"');
    process.exit(1);
  }
  const dir = resolve("migrations");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safeName = description.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  writeFileSync(join(dir, ts + "_" + safeName + ".sql"), "-- MUTATION: no envelope\\n", "utf-8");
  writeFileSync(join(dir, ts + "_" + safeName + ".down.sql"), "-- MUTATION: no envelope\\n", "utf-8");
  console.log("  Created migration (mutation stub)");
}
`;

  let mutationCaughtRegression = false;
  try {
    writeFileSync(migrateCreatePath, preDelegationSrc, "utf-8");
    const mcDir = mkdtempSync(join(tmpdir(), "tina4-mc-parity-mut-"));
    try {
      const mc = runCli(mcDir, ["migrate:create", "create_users", "--json", "--dry-run"]);
      // The mutated stub writes SQL to disk and prints "Created migration"
      // to stdout; that is NOT valid JSON. A parity test that DEMANDS a
      // JSON envelope must therefore FAIL. That is exactly the regression
      // the parity gate exists to catch.
      let parsed: unknown = null;
      try { parsed = JSON.parse(mc.stdout); } catch { parsed = null; }
      const stdoutIsEnvelope = parsed !== null
        && typeof parsed === "object"
        && (parsed as Record<string, unknown>).command === "generate";
      // Regression is CAUGHT when the mutated CLI does NOT emit a valid envelope.
      mutationCaughtRegression = !stdoutIsEnvelope;
    } finally {
      rmSync(mcDir, { recursive: true, force: true });
    }
  } finally {
    // ALWAYS restore, even on assertion or crash — a broken source file
    // would break every subsequent test run.
    writeFileSync(migrateCreatePath, originalSrc, "utf-8");
  }
  assert("mutation gate: stashed delegation makes positive-parity FAIL",
    mutationCaughtRegression,
    "the pre-3.13.121 body emitted a valid envelope; the parity gate is not a gate");

  // Sanity: after restore, the real CLI still emits a valid envelope.
  const mcDir = mkdtempSync(join(tmpdir(), "tina4-mc-parity-restored-"));
  try {
    const mc = runCli(mcDir, ["migrate:create", "create_users", "--json", "--dry-run"]);
    let parsed: unknown = null;
    try { parsed = JSON.parse(mc.stdout); } catch { parsed = null; }
    const restoredOk = parsed !== null
      && typeof parsed === "object"
      && (parsed as Record<string, unknown>).command === "generate"
      && (parsed as Record<string, unknown>).target === "migration";
    assert("mutation gate: restore succeeded — real CLI emits envelope again",
      restoredOk, `stdout head=${mc.stdout.slice(0, 400)} stderr=${mc.stderr.slice(0, 400)}`);
  } finally {
    rmSync(mcDir, { recursive: true, force: true });
  }
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Real tests for the `generate` resolution envelope + reserved-word handling.
 * Run with: npx tsx test/generateResolution.test.ts
 *
 * No mocks. Every assertion drives a REAL `tina4nodejs generate` subprocess in
 * a REAL mkdtemp project directory — same code path a user's terminal takes.
 *
 * Feature (3.13.117):
 *   • `--json` emits the stable envelope on STDOUT (schema
 *     `generate_v1`, discoverable via `commands --json` -> `resolution_contract`).
 *   • `--dry-run` writes NO files.
 *   • The bare `generate model Order` (no --json) still writes files but prints
 *     the same resolution as a human block on STDERR before writing.
 *   • Reserved SQL words auto-pluralise (`order` -> `orders`) with an explicit
 *     `reserved_word_pluralize` transformation in the envelope.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESOLUTION_ENVELOPE_VERSION,
  SQL_RESERVED_TABLE_NAMES,
  pluralizeReserved,
  toTableName,
} from "../packages/cli/src/commands/generate.ts";
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

/**
 * Recursively collect every file path under `dir`. Used to prove `--dry-run`
 * really wrote nothing (files, not just directories).
 */
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

console.log("=== `generate` resolution transparency tests ===\n");

// ── pure-function coverage first (fast + verifies exports are wired) ─────
console.log("--- helpers (in-process, no subprocess) ---");
assert("SQL_RESERVED_TABLE_NAMES contains 'order'", SQL_RESERVED_TABLE_NAMES.has("order"));
assert("SQL_RESERVED_TABLE_NAMES contains 'user'", SQL_RESERVED_TABLE_NAMES.has("user"));
assert("SQL_RESERVED_TABLE_NAMES does NOT contain 'product'", !SQL_RESERVED_TABLE_NAMES.has("product"));
assert("pluralizeReserved('order') === 'orders'", pluralizeReserved("order") === "orders",
  `got ${pluralizeReserved("order")}`);
assert("pluralizeReserved('index') === 'indexes'", pluralizeReserved("index") === "indexes");
assert("pluralizeReserved('foreign') === 'foreigns'", pluralizeReserved("foreign") === "foreigns");
// toTableName pluralises only reserved words; Product stays singular.
assert("toTableName('Product') === 'product'", toTableName("Product") === "product");

// ── commands --json now carries the resolution contract ─────────────────
console.log("\n--- manifest declares the resolution contract ---");
const manifest = buildCommandManifest();
assert("manifest has resolution_contract object",
  typeof manifest.resolution_contract === "object" && manifest.resolution_contract !== null);
assert("resolution_contract.version === '1'",
  manifest.resolution_contract?.version === "1",
  `got ${manifest.resolution_contract?.version}`);
assert(`resolution_contract.envelope === '${RESOLUTION_ENVELOPE_VERSION}'`,
  manifest.resolution_contract?.envelope === RESOLUTION_ENVELOPE_VERSION,
  `got ${manifest.resolution_contract?.envelope}`);

// ── envelope-shape: --json --dry-run emits a valid, complete envelope ───
console.log("\n--- 1. envelope-shape: model + --json + --dry-run (reserved word) ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-gen-envelope-"));
  try {
    const r = runGenerate(tmpDir, ["model", "Order", "--json", "--dry-run"]);
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
      assert("envelope.command === 'generate'", env.command === "generate", `got ${env.command}`);
      assert("envelope.target === 'model'", env.target === "model", `got ${env.target}`);
      assert("envelope.dry_run === true", env.dry_run === true);
      assert("envelope.actions_taken is empty array under --dry-run",
        Array.isArray(env.actions_taken) && (env.actions_taken as unknown[]).length === 0,
        `got ${JSON.stringify(env.actions_taken)}`);

      const input = env.input as Record<string, unknown> | undefined;
      assert("envelope.input.name === 'Order'", input?.name === "Order");
      assert("envelope.input.fields === null", input?.fields === null,
        `got ${JSON.stringify(input?.fields)}`);

      const resObj = env.resolution as Record<string, unknown> | undefined;
      assert("resolution.class_name === 'Order'", resObj?.class_name === "Order");
      assert("resolution.table_name === 'orders' (auto-pluralised)",
        resObj?.table_name === "orders", `got ${resObj?.table_name}`);
      assert("resolution.file_path === 'src/models/Order.ts'",
        resObj?.file_path === "src/models/Order.ts", `got ${resObj?.file_path}`);
      assert("resolution.migration_path starts with 'migrations/' and ends with '_create_orders.sql'",
        typeof resObj?.migration_path === "string"
          && (resObj?.migration_path as string).startsWith("migrations/")
          && (resObj?.migration_path as string).endsWith("_create_orders.sql"),
        `got ${resObj?.migration_path}`);
      assert("resolution.transformations is an array of length >= 1",
        Array.isArray(resObj?.transformations)
          && (resObj?.transformations as unknown[]).length >= 1);
      const t = ((resObj?.transformations as unknown[]) ?? [])[0] as Record<string, unknown> | undefined;
      assert("transformation.kind === 'reserved_word_pluralize'",
        t?.kind === "reserved_word_pluralize", `got ${t?.kind}`);
      assert("transformation.from === 'order'", t?.from === "order", `got ${t?.from}`);
      assert("transformation.to === 'orders'", t?.to === "orders", `got ${t?.to}`);
      assert("transformation.reason mentions 'SQL reserved word'",
        typeof t?.reason === "string" && (t?.reason as string).includes("SQL reserved word"),
        `got ${t?.reason}`);
      assert("transformation.override names --table and --quote as the opt-out",
        typeof t?.override === "string"
          && (t?.override as string).includes("--table")
          && (t?.override as string).includes("--quote"),
        `got ${t?.override}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── not-reserved: no transformation for a plain word ─────────────────────
console.log("\n--- 2. not-reserved: model Product records NO transformations ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-gen-noresv-"));
  try {
    const r = runGenerate(tmpDir, ["model", "Product", "--json", "--dry-run"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    const resObj = env.resolution as Record<string, unknown>;
    assert("resolution.table_name === 'product' (singular, not reserved)",
      resObj.table_name === "product", `got ${resObj.table_name}`);
    assert("resolution.transformations is an empty array",
      Array.isArray(resObj.transformations) && (resObj.transformations as unknown[]).length === 0,
      `got ${JSON.stringify(resObj.transformations)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── dry-run-no-writes: temp dir stays UNCHANGED after --dry-run ─────────
console.log("\n--- 3. dry-run-no-writes: real mkdtemp dir is empty after run ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-gen-drydir-"));
  try {
    assert("temp dir starts empty", readdirSync(tmpDir).length === 0);
    const r = runGenerate(tmpDir, ["model", "Order", "--json", "--dry-run"]);
    assert("subprocess exited 0", r.exitCode === 0);
    const files = walkFiles(tmpDir);
    assert("no files created under --dry-run (real proof)",
      files.length === 0,
      `got ${files.length} files: ${files.join(", ")}`);
    assert("no directories created either (env is genuinely untouched)",
      readdirSync(tmpDir).length === 0,
      `got entries: ${readdirSync(tmpDir).join(", ")}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── human-writes: bare `generate model Order` DOES write + prints stderr ─
console.log("\n--- 4. human-writes: bare `generate model Order` writes files + prints stderr ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-gen-human-"));
  try {
    const r = runGenerate(tmpDir, ["model", "Order"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    // Files ARE written on the human path.
    const files = walkFiles(tmpDir);
    const model = files.find((f) => f.endsWith("/src/models/Order.ts"));
    const migration = files.find((f) => f.endsWith("_create_orders.sql") && !f.endsWith(".down.sql"));
    assert("wrote src/models/Order.ts", Boolean(model), `got files: ${files.join(", ")}`);
    assert("wrote a matching migrations/*_create_orders.sql", Boolean(migration),
      `got files: ${files.join(", ")}`);

    // Resolution block prints to STDERR (so stdout stays clean for pipes).
    assert("stderr contains 'Generated model Order'",
      r.stderr.includes("Generated model Order"),
      `stderr=${r.stderr.slice(0, 400)}`);
    assert("stderr names 'orders' AS the table",
      r.stderr.includes("orders"), `stderr=${r.stderr.slice(0, 400)}`);
    assert("stderr flags 'SQL reserved word' for the pluralisation",
      r.stderr.includes("SQL reserved word"),
      `stderr=${r.stderr.slice(0, 400)}`);
    assert("stderr includes the '--table order --quote' opt-out hint",
      r.stderr.includes("--table order")
        && r.stderr.includes("--quote"),
      `stderr=${r.stderr.slice(0, 400)}`);

    // Bare (no --json) MUST NOT emit JSON on stdout — a downstream `| jq` would
    // otherwise see mixed prose + JSON. The bin still prints its human "Created
    // <path>" lines to STDOUT; those are the ONLY thing stdout should have.
    assert("bare mode: stdout does NOT contain a JSON envelope",
      !r.stdout.trim().startsWith("{"),
      `stdout=${r.stdout.slice(0, 400)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── bonus: --json --dry-run for `middleware` also works ────────────────
console.log("\n--- 5. bonus: middleware --json --dry-run emits an envelope too ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-gen-mid-"));
  try {
    const r = runGenerate(tmpDir, ["middleware", "Audit", "--json", "--dry-run"]);
    assert("subprocess exited 0", r.exitCode === 0,
      `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    assert("envelope.target === 'middleware'", env.target === "middleware", `got ${env.target}`);
    const resObj = env.resolution as Record<string, unknown>;
    assert("resolution.file_path === 'src/middleware/audit.ts'",
      resObj.file_path === "src/middleware/audit.ts", `got ${resObj.file_path}`);
    assert("dry_run: no files were created",
      walkFiles(tmpDir).length === 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

// silence unused imports (kept for consistency with other real-subprocess suites)
void execFileSync;

/**
 * `generate model` on a reserved-word class name (issue #123).
 * Run with: npx tsx test/generateModelReservedTable.test.ts
 *
 * The scaffolder no longer renames SILENTLY: it auto-pluralises a reserved-word
 * table (`Order` -> `orders`, the SAFE choice, because Tina4 interpolates table
 * names UNQUOTED) but says so out loud, and `--table-name` lets the developer
 * force their own name (owning the quoting in raw SQL if it is itself reserved).
 * No ORM quoting change -- identifier quoting is a global storage invariant, not
 * a local fix, so that footgun stays shut.
 *
 * No mocks: the resolver is a pure function (its note/warning is captured off the
 * real console.error); the end-to-end cases drive a REAL `tina4nodejs generate`
 * subprocess in a REAL mkdtemp project directory and read the generated file back
 * -- the same code path a user's terminal takes.
 *
 * Port of tina4-python/tests/test_gen_model_reserved_table.py (Python master
 * feature/release3.13.129, commit b5d8384).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SQL_RESERVED_TABLE_NAMES,
  parseCliArgs,
  resolveTable,
} from "../packages/cli/src/commands/generate.ts";

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
 * Run `fn` with console.error captured, so the resolver's real note/warning is
 * asserted without a mock (it writes to the REAL console.error; we only redirect
 * the sink for the duration of the call, then restore it).
 */
function captureStderr(fn: () => string): { result: string; out: string } {
  const original = console.error;
  let out = "";
  console.error = (...args: unknown[]): void => {
    out += args.map((a) => String(a)).join(" ") + "\n";
  };
  try {
    const result = fn();
    return { result, out };
  } finally {
    console.error = original;
  }
}

/** Run `tina4nodejs generate` in a temp cwd; return stdout/stderr/exit. */
function runGenerate(cwd: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const res = spawnSync("npx", ["tsx", binPath, "generate", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1", TINA4_NO_BROWSER: "true" },
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    exitCode: res.status ?? -1,
  };
}

console.log("=== `generate model` reserved-word table resolver (issue #123) ===\n");

// ── 1. Pure resolver — in-process, no subprocess ─────────────────────────
console.log("--- 1. resolveTable (pure, console.error captured) ---");

// exports are wired
assert("SQL_RESERVED_TABLE_NAMES contains 'order'", SQL_RESERVED_TABLE_NAMES.has("order"));
assert("SQL_RESERVED_TABLE_NAMES contains 'select'", SQL_RESERVED_TABLE_NAMES.has("select"));
assert("SQL_RESERVED_TABLE_NAMES does NOT contain 'product'", !SQL_RESERVED_TABLE_NAMES.has("product"));

// non-reserved -> singular, silent (even when announcing)
{
  const { result, out } = captureStderr(() => resolveTable("Product", {}, { announce: true }));
  assert("non-reserved Product -> product", result === "product", `got ${result}`);
  assert("non-reserved is silent even when announcing", out === "", `got ${JSON.stringify(out)}`);
}

// reserved -> plural + a loud NOTE WHEN announcing
{
  const { result, out } = captureStderr(() => resolveTable("Order", {}, { announce: true }));
  assert("reserved Order -> orders", result === "orders", `got ${result}`);
  assert("announcing prints a note naming the word, 'reserved', and --table-name",
    out.includes("order") && out.includes("reserved") && out.includes("--table-name"),
    `got ${JSON.stringify(out)}`);
  assert("the note names the chosen table 'orders'", out.includes("orders"), `got ${JSON.stringify(out)}`);
}

// reserved -> plural but SILENT when NOT announcing (composite / existing-table generators)
{
  const { result, out } = captureStderr(() => resolveTable("Order", {}));
  assert("reserved Order -> orders (not announcing)", result === "orders", `got ${result}`);
  assert("reserved is SILENT when not announcing", out === "", `got ${JSON.stringify(out)}`);
}

// --table-name wins verbatim; a non-reserved override needs no warning
{
  const { result, out } = captureStderr(() =>
    resolveTable("Order", { "table-name": "customer_orders" }, { announce: true }));
  assert("--table-name customer_orders wins verbatim", result === "customer_orders", `got ${result}`);
  assert("a non-reserved override is silent (no warning)", out === "", `got ${JSON.stringify(out)}`);
}

// forcing a RESERVED override -> warn loudly but obey
{
  const { result, out } = captureStderr(() =>
    resolveTable("Order", { "table-name": "select" }, { announce: true }));
  assert("forced reserved override is obeyed verbatim", result === "select", `got ${result}`);
  assert("forced reserved override warns (names it, 'reserved', 'UNQUOTED')",
    out.includes("select") && out.includes("reserved") && out.includes("UNQUOTED"),
    `got ${JSON.stringify(out)}`);
}

// a bare --table-name (parses to boolean true) is ignored -> falls back to orders
{
  const { result } = captureStderr(() =>
    resolveTable("Order", { "table-name": true }, { announce: true }));
  assert("bare --table-name (true) is ignored -> orders", result === "orders", `got ${result}`);
}

// ── 2. Arg parser accepts --table-name <value> ───────────────────────────
console.log("\n--- 2. parseCliArgs accepts --table-name <value> ---");
{
  const { flags } = parseCliArgs(["--table-name", "my_orders"]);
  assert("--table-name <value> parses to the value", flags["table-name"] === "my_orders",
    `got ${JSON.stringify(flags["table-name"])}`);
  const bare = parseCliArgs(["--table-name"]);
  assert("bare --table-name parses to true", bare.flags["table-name"] === true,
    `got ${JSON.stringify(bare.flags["table-name"])}`);
}

// ── 3. End-to-end: reserved class -> plural table + note (real subprocess) ─
console.log("\n--- 3. generate model Order writes tableName 'orders' + prints a note ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-gen-resv-order-"));
  try {
    const r = runGenerate(tmpDir, ["model", "Order", "--no-migration"]);
    assert("subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    const modelText = readFileSync(join(tmpDir, "src", "models", "Order.ts"), "utf-8");
    assert('generated model declares static tableName = "orders"',
      modelText.includes('static tableName = "orders"'),
      `model=\n${modelText}`);

    assert("stderr surfaces the reserved-word note (not silent)",
      r.stderr.includes("reserved") && r.stderr.includes("--table-name"),
      `stderr=${r.stderr.slice(0, 600)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 4. End-to-end: --table-name override is used verbatim ────────────────
console.log("\n--- 4. generate model Order --table-name my_orders writes tableName 'my_orders' ---");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-gen-resv-override-"));
  try {
    const r = runGenerate(tmpDir, ["model", "Order", "--no-migration", "--table-name", "my_orders"]);
    assert("subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 400)}`);

    const modelText = readFileSync(join(tmpDir, "src", "models", "Order.ts"), "utf-8");
    assert('generated model declares static tableName = "my_orders"',
      modelText.includes('static tableName = "my_orders"'),
      `model=\n${modelText}`);

    // A non-reserved override needs no warning: stderr must not flag it reserved.
    assert("non-reserved override does not print a reserved-word warning for my_orders",
      !r.stderr.includes("'my_orders' is a SQL reserved word"),
      `stderr=${r.stderr.slice(0, 600)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * `--help` / `-h` print usage and change nothing, for every command; unknown
 * options are refused; value options need a value.
 * Run with: npx tsx test/cliHelpFlags.test.ts
 *
 * Handlers never looked for a help flag, so it ran the command for real:
 * `generate model --help` wrote a model named `--help` (four files), `ai --help`
 * and `ai --all` installed into a folder named after the flag, `init --help`
 * scaffolded a project called `--help`.
 *
 * NO MOCKS: the CLI is built first (esbuild, the same `npm run build` the
 * package ships), then every case runs the REAL `node packages/cli/dist/bin.js`
 * in a real temp project and hashes the directory before and after.
 * Mirrors tina4-python/tests/test_cli_help_flags.py.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { COMMANDS } from "../packages/cli/src/bin.ts";
import { GENERATORS, RESOLUTION_FLAGS } from "../packages/cli/src/commands/generate.ts";
import { QUEUE_FLAGS } from "../packages/cli/src/commands/queue.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const binPath = join(repoRoot, "packages/cli/dist/bin.js");

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}\n${detail}`);
    fail++;
  }
}

// ── Build the real CLI so the cases run what ships, not a stale dist ──
{
  const build = spawnSync("npm", ["run", "build", "-w", "packages/cli"], {
    cwd: repoRoot, encoding: "utf-8", shell: process.platform === "win32",
  });
  if (build.status !== 0 || !existsSync(binPath)) {
    console.log(`  FAIL build packages/cli\n${build.stdout}${build.stderr}`);
    console.log("\nResults: 0 passed, 1 failed");
    process.exit(1);
  }
}

const sandbox = mkdtempSync(join(tmpdir(), "tina4-clihelp-"));
// The child gets its own HOME (ai writes ~/.claude/skills) and a PATH holding
// only node, so a command that ran for real could never npm-install or pip-install.
const childHome = join(sandbox, "home");
mkdirSync(childHome);
const childEnv = { ...process.env, HOME: childHome, USERPROFILE: childHome, PATH: dirname(process.execPath), TINA4_NO_BROWSER: "true" };

let counter = 0;
function project(): string {
  const dir = join(sandbox, `p${counter++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), '{"name":"demo","version":"0.0.0","type":"module"}\n');
  writeFileSync(join(dir, "app.ts"), "console.log('app');\n");
  return dir;
}

function runCli(argv: string[], cwd: string, timeout = 30_000): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [binPath, ...argv], {
    cwd, env: childEnv, encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Every path under root with a hash of its bytes. */
function snapshot(root: string): string {
  const seen: string[] = [];
  const walk = (dir: string): void => {
    // withFileTypes: the type comes with the listing, so there is no separate
    // stat to race the read below (CodeQL js/file-system-race).
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        seen.push(`${relative(root, path)}/`);
        walk(path);
      } else {
        seen.push(`${relative(root, path)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  walk(root);
  return seen.join("\n");
}

// ── --help / -h on every command and generator: usage, exit 0, nothing written ──
const commandCases = Object.keys(COMMANDS).filter((n) => n !== "help").map((n) => [n]);
const generatorCases = Object.keys(GENERATORS).map((n) => ["generate", n]);
for (const flag of ["--help", "-h"]) {
  for (const argv of [...commandCases, ...generatorCases]) {
    const dir = project();
    const before = snapshot(dir);
    const r = runCli([...argv, flag], dir);
    const label = `${argv.join(" ")} ${flag}`;
    assert(`${label}: exit 0`, r.code === 0, r.out + r.err);
    assert(`${label}: prints usage`, r.out.includes(`Usage: tina4nodejs ${argv.join(" ")}`), r.out + r.err);
    assert(`${label}: project unchanged`, snapshot(dir) === before, snapshot(dir));
  }
}

for (const flag of ["--help", "-h"]) {
  const dir = project();
  const before = snapshot(dir);
  const r = runCli(["generate", "model", "Product", "--fields", "name:string", flag], dir);
  assert(`help flag after the name still wins (${flag})`,
    r.code === 0 && r.out.includes("Usage: tina4nodejs generate model") && snapshot(dir) === before, r.out + r.err);
}

for (const flag of ["--help", "-h"]) {
  const r = runCli([flag], project());
  assert(`top-level ${flag} prints the reference`, r.code === 0 && r.out.includes("Usage: tina4nodejs <command>"), r.out + r.err);
}

for (const argv of [["help"], ["help", "--help"], ["help", "-h"]]) {
  const r = runCli(argv, project());
  assert(`${argv.join(" ")} prints the reference`,
    r.code === 0 && r.out.includes("Usage: tina4nodejs <command>") && !(r.out + r.err).includes("Unknown option"), r.out + r.err);
}

{
  const r = runCli(["generate", "--help"], project());
  assert("generate --help lists every generator",
    r.code === 0 && r.out.includes("Generators:") && Object.keys(GENERATORS).every((n) => r.out.includes(`  ${n} `)), r.out + r.err);
}

// ── A name that looks like an option is refused ──
for (const argv of [["generate", "model", "--fields", "name:string"], ["generate", "route", "--public"]]) {
  const dir = project();
  const before = snapshot(dir);
  const r = runCli(argv, dir);
  assert(`name that looks like an option refused: ${argv.join(" ")}`,
    r.code === 1 && r.out.includes("can't start with '-'") && snapshot(dir) === before, r.out + r.err);
}

// ── Options: unknown ones, missing values, --name=value ──
for (const [argv, wrong, suggestion] of [
  [["generate", "model", "Product", "--feilds", "name:string"], "--feilds", "--fields"],
  [["generate", "model", "Product", "--feilds=name:string"], "--feilds", "--fields"],
  [["generate", "route", "products", "--publc"], "--publc", "--public"],
  [["serve", "--prot", "9000"], "--prot", "--port"],
  [["queue", "work", "--onse"], "--onse", "--once"],
] as [string[], string, string][]) {
  const dir = project();
  const before = snapshot(dir);
  const r = runCli(argv, dir);
  assert(`misspelled option refused with a suggestion: ${argv.join(" ")}`,
    r.code === 1 && r.out.includes(`Unknown option ${wrong} for`) && r.out.includes(`Did you mean ${suggestion}?`)
      && r.out.includes("--help\" for its options.") && snapshot(dir) === before, r.out + r.err);
}

for (const argv of [
  ["generate", "model", "Product", "-f", "name:string"], // short options don't exist
  ["lint", "--everything"],
  ["migrate", "--force"],
  ["test", "--verbose"], // Node's test takes a [file]; nothing is forwarded to a runner
]) {
  const dir = project();
  const before = snapshot(dir);
  const r = runCli(argv, dir);
  assert(`option the command does not have refused: ${argv.join(" ")}`,
    r.code === 1 && r.out.includes("Unknown option") && !r.out.includes("Did you mean") && snapshot(dir) === before, r.out + r.err);
}

for (const [argv, option] of [
  [["generate", "model", "Product", "--fields"], "--fields"],
  [["generate", "service", "Nightly", "--every"], "--every"],
  [["generate", "model", "Product", "--fields", "--no-migration"], "--fields"],
] as [string[], string][]) {
  const dir = project();
  const before = snapshot(dir);
  const r = runCli(argv, dir);
  assert(`value option without a value refused: ${argv.join(" ")}`,
    r.code === 1 && r.out.includes(`Option ${option} for`) && r.out.includes("needs a value")
      && !/\bat .*\.js:\d+/.test(r.err) && snapshot(dir) === before, r.out + r.err);
}

for (const fieldsArg of [["--fields", "price:float"], ["--fields=price:float"]]) {
  const dir = project();
  const r = runCli(["generate", "model", "Product", ...fieldsArg], dir);
  const model = join(dir, "src/models/Product.ts");
  assert(`value option works as ${fieldsArg.join(" ")}`,
    r.code === 0 && existsSync(model) && readFileSync(model, "utf-8").includes("price"), r.out + r.err);
}

{
  // migrate:create forwards its options to `generate migration`; the value
  // must not be folded into the description.
  const dir = project();
  const r = runCli(["migrate:create", "create_items", "--fields", "price:float"], dir);
  const files = existsSync(join(dir, "migrations")) ? readdirSync(join(dir, "migrations")) : [];
  const up = files.find((f) => f.endsWith("_create_items.sql"));
  assert("migrate:create --fields reaches the migration",
    r.code === 0 && up !== undefined && readFileSync(join(dir, "migrations", up), "utf-8").includes("price"),
    r.out + r.err + files.join(","));
}

{
  // crud --skip-model builds the CRUD around a model that already exists.
  const dir = project();
  const first = runCli(["generate", "model", "Product", "--fields", "price:float"], dir);
  const model = join(dir, "src/models/Product.ts");
  const modelBefore = existsSync(model) ? readFileSync(model) : Buffer.alloc(0);
  const r = runCli(["generate", "crud", "Product", "--skip-model"], dir);
  assert("generate crud --skip-model keeps the existing model and writes the CRUD",
    first.code === 0 && r.code === 0 && !(r.out + r.err).includes("already exists")
      && readFileSync(model).equals(modelBefore) && modelBefore.length > 0
      && existsSync(join(dir, "src/routes/admin/product/get.ts")) && existsSync(join(dir, "src/templates/crud")),
    r.out + r.err);
}

// ── ai --all installs without the menu, into the project ──
{
  const dir = project();
  const r = runCli(["ai", "--all"], dir, 120_000);
  assert("ai --all installs CLAUDE.md into the project without the menu",
    r.code === 0 && existsSync(join(dir, "CLAUDE.md")) && !existsSync(join(dir, "--all")), r.out + r.err);
}

// ── Drift guard: every option in a usage string is an accepted option ──
{
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(COMMANDS)) {
    for (const [, option] of (spec.usage ?? "").matchAll(/--([a-z][a-z-]*)/g)) {
      if (!Object.hasOwn(spec.flags ?? {}, option)) problems.push(`${name}: --${option} documented, not accepted`);
    }
  }
  for (const [name, spec] of Object.entries(GENERATORS)) {
    const accepted = { ...spec.flags, ...RESOLUTION_FLAGS };
    for (const [, option] of spec.usage.matchAll(/--([a-z][a-z-]*)/g)) {
      if (!Object.hasOwn(accepted, option)) problems.push(`generate ${name}: --${option} documented, not accepted`);
    }
  }
  const queueSubs = COMMANDS.queue.subcommands ?? [];
  if (Object.keys(QUEUE_FLAGS).sort().join() !== [...queueSubs].sort().join()) problems.push("QUEUE_FLAGS != queue subcommands");
  assert("every option in the help is an accepted option", problems.length === 0, problems.join("\n"));
}

try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

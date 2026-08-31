/**
 * Real tests for the self-describing `commands` CLI subcommand.
 * Run with: npx tsx test/commandsManifest.test.ts
 *
 * No mocks. These exercise the ACTUAL CLI code path two ways:
 *
 *   • in-process — the real `buildCommandManifest` builder and `runCommands`
 *     handler, asserting the manifest's shape and that it is DERIVED from the
 *     single-source COMMANDS / GENERATORS registries (so it can never drift
 *     from what main() dispatches);
 *   • as a real subprocess running the `tina4nodejs` entrypoint (bin.ts) in a
 *     clean temp dir with NO database configured — proving `commands --json`
 *     is cheap and side-effect-free (no bootstrap, no DB, no migrations, no
 *     files created). This is the contract the tina4 Rust client relies on
 *     when it calls the command on every `tina4 --help`, in any directory.
 *
 * bin.ts guards main() behind an entrypoint check, so importing it here only
 * loads the registries — it does not dispatch a command.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCommandManifest,
  runCommands,
  COMMANDS,
  DELEGATED,
  type CommandManifest,
} from "../packages/cli/src/bin.ts";
import { GENERATORS } from "../packages/cli/src/commands/generate.ts";
import { parseCliManifest } from "./_parseCliManifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, "../packages/cli/src/bin.ts");

// The command set the tina4 client must be able to discover truthfully.
const KNOWN_COMMANDS = ["migrate", "migrate:create", "seed", "test", "lint", "routes", "generate", "commands",
  "queue", "build"];

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

/** Capture console.log emitted while `fn` runs. */
function captureLog(fn: () => void): string {
  const orig = console.log;
  let buf = "";
  console.log = (...a: unknown[]) => { buf += a.map(String).join(" ") + "\n"; };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return buf;
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

console.log("=== CLI `commands` Manifest Tests ===\n");

// ── In-process: manifest content, asserted against the real builder ──
console.log("--- manifest content (in-process, real builder) ---");
const manifest: CommandManifest = buildCommandManifest();

assert("framework is 'nodejs'", manifest.framework === "nodejs", `got ${manifest.framework}`);
assert("version is a non-empty string", typeof manifest.version === "string" && manifest.version.trim().length > 0);
assert("version looks like a version", /^\d+\.\d+/.test(manifest.version), `got ${manifest.version}`);
assert("commands is a non-empty array", Array.isArray(manifest.commands) && manifest.commands.length > 0);
assert("every command entry has name + summary",
  manifest.commands.every((c) => typeof c.name === "string" && c.name.length > 0
    && typeof c.summary === "string" && c.summary.length > 0));

const names = manifest.commands.map((c) => c.name);
const missing = KNOWN_COMMANDS.filter((k) => !names.includes(k));
assert("all known commands present", missing.length === 0, `missing: ${missing.join(", ")}`);

// ── Anti-drift: the manifest is DERIVED from the dispatch registries ──
// Natively dispatched COMMANDS plus the DELEGATED commands the tina4 client
// implements — one derived list, never a hand-kept second one.
console.log("\n--- anti-drift (manifest == dispatch registries) ---");
const expectedNames = [...Object.keys(COMMANDS), ...Object.keys(DELEGATED)];
assert("manifest command names == COMMANDS + DELEGATED (same order, no separate list)",
  JSON.stringify(names) === JSON.stringify(expectedNames),
  `\n    manifest: ${names.join(",")}\n    expected: ${expectedNames.join(",")}`);

const entriesByName = Object.fromEntries(manifest.commands.map((c) => [c.name, c]));
assert("only the delegated commands carry delegated: true",
  Object.keys(DELEGATED).every((n) => entriesByName[n]?.delegated === true)
  && Object.keys(COMMANDS).every((n) => entriesByName[n]?.delegated === undefined));

// ── generate subcommands derived from the real GENERATORS registry ──
console.log("\n--- generate subcommands ---");
const generateEntry = manifest.commands.find((c) => c.name === "generate");
assert("generate entry exists", generateEntry !== undefined);
assert("generate has a non-empty subcommands array",
  Array.isArray(generateEntry?.subcommands) && (generateEntry?.subcommands?.length ?? 0) > 0);
assert("generate subcommands include model + crud",
  ["model", "crud"].every((s) => generateEntry?.subcommands?.includes(s)));
assert("generate subcommands == Object.keys(GENERATORS) (single source, no fourth list)",
  JSON.stringify(generateEntry?.subcommands) === JSON.stringify(Object.keys(GENERATORS)));

// ── migrate:create declares its positional arg ──
console.log("\n--- args declarations ---");
const migrateCreate = manifest.commands.find((c) => c.name === "migrate:create");
assert("migrate:create declares args ['description']",
  JSON.stringify(migrateCreate?.args) === JSON.stringify(["description"]));
const initEntry = manifest.commands.find((c) => c.name === "init");
assert("init declares an optional dir arg ['dir?']",
  JSON.stringify(initEntry?.args) === JSON.stringify(["dir?"]));

// ── Phase 3: `queue` is now BOTH a top-level command AND a generator ──
console.log("\n--- phase 3: queue + build top-level commands ---");
const queueEntry = manifest.commands.find((c) => c.name === "queue");
assert("queue IS a top-level command", names.includes("queue"));
assert("queue declares subcommands [work, stats, retry, clear]",
  JSON.stringify(queueEntry?.subcommands) === JSON.stringify(["work", "stats", "retry", "clear"]),
  `got ${JSON.stringify(queueEntry?.subcommands)}`);
// Still a scaffolding generator too (the two surfaces are distinct).
assert("queue IS also a generate subcommand", Object.keys(GENERATORS).includes("queue"));
const buildEntry = manifest.commands.find((c) => c.name === "build");
assert("build IS a top-level command", names.includes("build"));
assert("build declares a Docker-oriented summary",
  (buildEntry?.summary ?? "").includes("Docker"), `got ${buildEntry?.summary}`);

// ── runCommands handler emits exactly what the builder returns ──
console.log("\n--- runCommands handler (real, in-process) ---");
const jsonOut = captureLog(() => runCommands(["--json"]));
let handlerManifest: CommandManifest | null = null;
try {
  handlerManifest = parseCliManifest(jsonOut, "commandsManifest handler") as CommandManifest;
} catch (err) {
  console.error(`    parseCliManifest error: ${err instanceof Error ? err.message : String(err)}`);
}
assert("`commands --json` handler prints valid JSON", handlerManifest !== null);
assert("`commands --json` handler output equals buildCommandManifest()",
  JSON.stringify(handlerManifest) === JSON.stringify(manifest));

const humanOut = captureLog(() => runCommands([]));
assert("human `commands` output lists every command name",
  Object.keys(COMMANDS).every((n) => humanOut.includes(n)));

// ══════════════════════════════════════════════════════════════════════
// Real subprocess: `commands --json` must run with NO database configured,
// in an EMPTY project dir (no migrations/, no app.ts), exit 0 fast with valid
// JSON, and create NO files — proving it never bootstraps the framework.
// ══════════════════════════════════════════════════════════════════════
console.log("\n--- subprocess: app/DB-free `commands --json` in a clean temp dir ---");
const tmpDir = mkdtempSync(join(tmpdir(), "tina4-cmd-"));
try {
  // A genuinely fresh, empty project dir — nothing to bootstrap from.
  assert("temp dir starts empty", readdirSync(tmpDir).length === 0);

  const env = { ...process.env, NODE_NO_WARNINGS: "1" };
  delete env.TINA4_DATABASE_URL; // no DB configured at all

  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("npx", ["tsx", binPath, "commands", "--json"], {
      cwd: tmpDir,
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    exitCode = e.status ?? 1;
    stdout = e.stdout ?? "";
    console.log(`    subprocess stderr: ${(e.stderr ?? "").slice(0, 400)}`);
  }

  assert("subprocess exited 0", exitCode === 0, `exit ${exitCode}`);

  let subManifest: CommandManifest | null = null;
  try {
    subManifest = parseCliManifest(stdout, "commandsManifest subprocess") as CommandManifest;
  } catch (err) {
    console.error(`    parseCliManifest error: ${err instanceof Error ? err.message : String(err)}`);
  }
  assert("subprocess printed valid JSON", subManifest !== null);
  assert("subprocess framework is 'nodejs'", subManifest?.framework === "nodejs");
  assert("subprocess version is non-empty", (subManifest?.version ?? "").trim().length > 0);
  assert("subprocess manifest includes the `commands` command",
    (subManifest?.commands ?? []).some((c) => c.name === "commands"));
  assert("subprocess manifest includes the `generate` command",
    (subManifest?.commands ?? []).some((c) => c.name === "generate"));

  // App/DB-free proof: the command opened nothing — the temp dir is UNCHANGED,
  // and in particular no SQLite file was created anywhere under it.
  const created = walkFiles(tmpDir);
  const createdDbs = created.filter((f) => /\.(db|sqlite3?|db-journal)$/i.test(f));
  assert("no database file created under the project dir", createdDbs.length === 0,
    createdDbs.join(", "));
  assert("no files created at all (never bootstrapped)", created.length === 0,
    created.join(", "));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

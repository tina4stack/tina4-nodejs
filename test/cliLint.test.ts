/**
 * Real tests for the `lint` CLI command (Node mirror of the Python master's
 * tests/test_cli_lint.py).
 *
 * `tina4nodejs lint` uses the PROJECT's own eslint and installs it as a DEV
 * dependency on demand when it is absent; the zero-dependency baseline is
 * `tsc --noEmit` (TS project) or `node --check` (plain JS). No mocks:
 *
 *   • Baseline — `runLint` is driven IN-PROCESS with process.exit intercepted
 *     into a throw (the Node analogue of pytest.raises(SystemExit), same trick as
 *     cliBuild.test.ts) over REAL temp files. The `tsc` path uses the repo's own
 *     REAL typescript (the temp project lives inside the repo so it resolves it);
 *     the `node --check` path runs the REAL stdlib syntax parse.
 *   • Registration — the REAL CLI's `commands --json` is spawned and parsed; the
 *     `lint` entry must be there.
 *   • On-demand install — the REAL CLI is spawned in a REAL throwaway project and
 *     runs a REAL `npm i -D eslint @eslint/js` (npm is present in the dev env;
 *     this needs network), then the mutated package.json is read back and the
 *     scaffolded eslint.config.js is asserted, and eslint (not the baseline) is
 *     shown to have run.
 *
 * FINDING baked into the probes (verified against a live eslint 10): the minimal
 * `[js.configs.recommended]` flat config the command scaffolds lints `.js`
 * files but REPORTS `.ts` files "File ignored because no matching configuration
 * was supplied" (a warning, exit 0) — it has no TypeScript parser. So the
 * "eslint ran and flagged something" probe is a `.js` file (`no-unused-vars`),
 * which the baseline (tsc/node --check) would NOT flag — that is what proves
 * eslint, not the baseline, ran. TypeScript linting stays with the `tsc`
 * baseline. See the command's report for the parity note.
 *
 * Run with: npx tsx test/cliLint.test.ts   (TINA4_NO_BROWSER=true)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLint } from "../packages/cli/src/commands/lint.ts";
import { parseCliManifest } from "./_parseCliManifest.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");
const cliBin = join(repoRoot, "packages/cli/src/bin.ts");

/**
 * Drive runLint IN-PROCESS with a real cwd, intercepting process.exit into a
 * throw so its exit code is observed — the Node analogue of
 * pytest.raises(SystemExit) (same pattern as cliBuild.test.ts). console.log is
 * captured; a spawned child (tsc / node --check) still writes to the real
 * stdout, which is fine — the assertion is on the exit code and the summary.
 */
interface RunResult { code: number | null; out: string }
function runLintInProc(args: string[], cwd: string): RunResult {
  const prevCwd = process.cwd();
  const prevExit = process.exit;
  const prevLog = console.log;
  let out = "";
  let code: number | null = null;

  console.log = (...a: unknown[]) => { out += a.map(String).join(" ") + "\n"; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (c?: number) => { throw { __exit: true, code: c ?? 0 }; };

  try {
    process.chdir(cwd);
    runLint(args);
  } catch (e: unknown) {
    const ex = e as { __exit?: boolean; code?: number };
    if (ex && ex.__exit) { code = ex.code ?? 0; }
    else { console.log = prevLog; process.exit = prevExit; process.chdir(prevCwd); throw e; }
  } finally {
    process.chdir(prevCwd);
    process.exit = prevExit;
    console.log = prevLog;
  }
  return { code, out };
}

// tsc-baseline temp projects MUST resolve the repo's own typescript, so they live
// inside the repo tree (walked up to repoRoot/node_modules/typescript). Invisible
// to the repo's tooling: `.tmp_*` is in no tsconfig include and run-all only
// collects test/*.test.ts.
const repoTmp = join(repoRoot, `.tmp_lint_${process.pid}`);
// Install-test projects run a real `npm install`, so they live OUTSIDE the repo
// (os.tmpdir, honouring the run-all TMPDIR sandbox) to avoid workspace clashes.
const outsideTmp = mkdtempSync(join(tmpdir(), "tina4-clilint-"));

function makeRepoProject(name: string, files: Record<string, string>): string {
  const dir = join(repoTmp, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

// A permissive tsconfig: --noEmit is forced by the command; only genuine
// syntax/type errors fail. skipLibCheck keeps a clean file fast + clean.
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
    strict: true, skipLibCheck: true, noEmit: true,
  },
}) + "\n";

const CLEAN_TS = "export const answer: number = 42;\n";
const BROKEN_TS = "export const x = ;\n";        // TS1109 Expression expected
const PKG_MODULE = (n: string) => JSON.stringify({ name: n, version: "0.0.0", type: "module", private: true }) + "\n";

console.log("=== CLI `lint` command (real tsc / node --check / npm, no mocks) ===\n");

try {
  // ── 1. Baseline: tsc --noEmit over the user's src/ + app.ts ──────────
  console.log("--- baseline: tsc --noEmit (TypeScript project) ---");
  {
    // Clean src/ .ts -> exit 0.
    const dir = makeRepoProject("tsc_clean", {
      "package.json": PKG_MODULE("tsc-clean"),
      "tsconfig.json": TSCONFIG,
      "src/ok.ts": CLEAN_TS,
    });
    const r = runLintInProc(["--no-install"], dir);
    ok("clean src/*.ts passes (--no-install -> exit 0) [tsc]", r.code === 0, `exit ${r.code}: ${r.out}`);
    ok("clean summary names the tool [tsc]", /\[tsc\]/.test(r.out), r.out);
  }
  {
    // A TS syntax error -> exit 1.
    const dir = makeRepoProject("tsc_broken", {
      "package.json": PKG_MODULE("tsc-broken"),
      "tsconfig.json": TSCONFIG,
      "src/bad.ts": BROKEN_TS,
    });
    const r = runLintInProc(["--no-install"], dir);
    ok("a .ts syntax error fails (exit 1) [tsc]", r.code === 1, `exit ${r.code}: ${r.out}`);
  }
  {
    // app.ts (no src/) is IN SCOPE — a broken entrypoint fails.
    const dir = makeRepoProject("tsc_app_scope", {
      "package.json": PKG_MODULE("tsc-app"),
      "tsconfig.json": TSCONFIG,
      "app.ts": BROKEN_TS,
    });
    const r = runLintInProc(["--no-install"], dir);
    ok("app.ts is in scope (broken app.ts -> exit 1) [tsc]", r.code === 1, `exit ${r.code}: ${r.out}`);
  }

  // ── 2. Baseline: node --check (plain JS, no tsconfig) ────────────────
  // A CJS-safe probe (no package.json "type", non-export syntax error): Node's
  // auto-ESM detection makes `node --check` unreliable for `export`-bearing
  // module files, so the zero-dep JS fallback is exercised with CommonJS-shaped
  // code where `node --check` is a true syntax gate.
  console.log("\n--- baseline: node --check (plain JS, no tsconfig) ---");
  {
    const dir = makeRepoProject("nodecheck_clean", {
      "src/ok.js": "const value = 1;\nmodule.exports = value;\n",
    });
    const r = runLintInProc(["--no-install"], dir);
    ok("clean .js passes (exit 0) [node --check]", r.code === 0, `exit ${r.code}: ${r.out}`);
    ok("clean summary names the tool [node --check]", /\[node --check\]/.test(r.out), r.out);
  }
  {
    const dir = makeRepoProject("nodecheck_broken", {
      "src/bad.js": "function broken( {\n",   // Unexpected end of input
    });
    const r = runLintInProc(["--no-install"], dir);
    ok("a .js syntax error fails (exit 1) [node --check]", r.code === 1, `exit ${r.code}: ${r.out}`);
  }

  // ── 3. Nothing to lint -> clean exit 0 ──────────────────────────────
  console.log("\n--- nothing to lint ---");
  {
    const dir = makeRepoProject("empty", {});
    mkdirSync(dir, { recursive: true });
    const r = runLintInProc(["--no-install"], dir);
    ok("nothing to lint exits 0", r.code === 0, `exit ${r.code}: ${r.out}`);
    ok("nothing-to-lint says so", /nothing to lint/.test(r.out), r.out);
  }

  // ── 4. Registration: lint appears in `commands --json` ──────────────
  console.log("\n--- registration (real `commands --json`) ---");
  {
    const res = spawnSync(tsxBin, [cliBin, "commands", "--json"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000, env: { ...process.env, TINA4_NO_BROWSER: "true" },
    });
    let entry: { name: string; summary?: string } | undefined;
    try {
      const manifest = parseCliManifest(res.stdout ?? "", "commands --json") as {
        commands: { name: string; summary?: string }[];
      };
      entry = manifest.commands.find((c) => c.name === "lint");
    } catch (err) {
      ok("commands --json parses", false, err instanceof Error ? err.message : String(err));
    }
    ok("lint is a registered command in commands --json", entry !== undefined, res.stdout?.slice(0, 300));
    ok("lint carries a non-empty summary", !!entry?.summary && entry.summary.length > 0, entry?.summary);
  }

  // ── 5. On-demand install (REAL npm i -D eslint @eslint/js) ───────────
  console.log("\n--- on-demand install (real npm + eslint, needs network) ---");
  const npmPresent = spawnSync("npm", ["--version"], { stdio: "ignore" }).status === 0;
  ok("npm is available (the install path needs it)", npmPresent);

  /** Spawn the REAL `tina4nodejs lint` (no --no-install) in `cwd`. */
  function runLintCli(cwd: string): { code: number | null; out: string } {
    const res = spawnSync(tsxBin, [cliBin, "lint"], {
      cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 180_000, env: { ...process.env, TINA4_NO_BROWSER: "true" },
    });
    return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
  }

  if (npmPresent) {
    // 5a. A clean project: eslint gets added dev-only, a flat config is
    //     scaffolded, and the clean file passes.
    {
      const dir = join(outsideTmp, "install_clean");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "package.json"), PKG_MODULE("lintprobe-clean"));
      writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
      writeFileSync(join(dir, "src", "ok.js"), "export const ok = 1;\n"); // eslint-clean
      ok("no eslint before the run", !existsSync(join(dir, "node_modules", "eslint")));

      const r = runLintCli(dir);

      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      const devDeps = manifest.devDependencies ?? {};
      ok("eslint added to devDependencies (dev-only)", "eslint" in devDeps, JSON.stringify(devDeps));
      ok("@eslint/js added to devDependencies", "@eslint/js" in devDeps, JSON.stringify(devDeps));
      ok("eslint is NOT a runtime dependency", !("eslint" in (manifest.dependencies ?? {})));
      ok("eslint.config.js scaffolded", existsSync(join(dir, "eslint.config.js")));
      ok(
        "scaffold is @eslint/js recommended",
        /@eslint\/js/.test(readFileSync(join(dir, "eslint.config.js"), "utf-8")),
      );
      ok("eslint is now installed in the project", existsSync(join(dir, "node_modules", "eslint")));
      ok("clean project passes after install (exit 0) [eslint]", r.code === 0, `exit ${r.code}: ${r.out}`);
      ok("eslint ran (summary names it)", /\[eslint\]/.test(r.out), r.out);
    }

    // 5b. A file with a real eslint finding (unused var) that is VALID syntax:
    //     the baseline (tsc/node --check) would pass it, so exit 1 proves eslint
    //     itself ran and flagged it.
    {
      const dir = join(outsideTmp, "install_finding");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "package.json"), PKG_MODULE("lintprobe-finding"));
      writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
      writeFileSync(join(dir, "src", "smelly.js"), "const unused = 1;\n"); // no-unused-vars, valid JS

      const r = runLintCli(dir);

      const devDeps = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).devDependencies ?? {};
      ok("eslint added to devDependencies (finding case)", "eslint" in devDeps, JSON.stringify(devDeps));
      ok("installed eslint flags the unused var (exit 1)", r.code === 1, `exit ${r.code}: ${r.out}`);
      ok("failure summary names eslint (not the baseline)", /\[eslint\]/.test(r.out), r.out);
      ok("no-unused-vars is reported", /no-unused-vars/.test(r.out), r.out);
    }
  } else {
    ok("install path exercised", false, "npm unavailable — cannot run the real integration");
  }
} finally {
  rmSync(repoTmp, { recursive: true, force: true });
  rmSync(outsideTmp, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

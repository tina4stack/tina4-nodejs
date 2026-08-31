/**
 * CLI command: lint — lint the project's source. The FRAMEWORK ships no linter
 * (a Tina4 app stays zero-dependency); `tina4nodejs lint` uses the project's own
 * eslint and INSTALLS it as a DEV dependency of the PROJECT on demand when it is
 * absent — running the command is the consent. Layers, in order:
 *
 *   • eslint present (resolvable from the project's node_modules) AND a flat
 *     config present (`eslint.config.{js,mjs,cjs,ts,mts,cts}`): run it. `--fix`
 *     runs `eslint --fix` (safe autofixes). eslint reports syntax too, so it is
 *     the whole pass when present.
 *   • eslint absent (and NOT `--no-install`): silently `npm i -D eslint
 *     @eslint/js typescript-eslint` into the PROJECT (dev-only, never the app's
 *     runtime deps — typescript-eslint pulls its own `typescript` peer), and
 *     scaffold a minimal flat config at `eslint.config.js` when none exists that
 *     lints BOTH `.js` and `.ts`, then run eslint. A one-line `  · installing
 *     eslint...` notice is printed. If npm is missing or the install fails, a
 *     one-line notice is printed and the command falls through to the baseline.
 *   • Baseline (zero new dependency): `tsc --noEmit` when a `tsconfig.json`
 *     exists (the type+syntax check every tina4-nodejs project already owns,
 *     forced to emit nothing); otherwise stdlib `node --check` over `.js`/`.mjs`/
 *     `.cjs` files. Used with `--no-install`, or when the install cannot run.
 *
 * Contract (identical across all four frameworks): exit 0 = clean, non-zero =
 * findings; the summary names the tool that ran in `[...]`; `--fix` only
 * autofixes on the eslint path. Scope is the user's app (`src/` + the entrypoint
 * `app.ts`/`app.js`), mirroring how `tina4nodejs test` runs the project's own
 * tests — not the framework's code.
 *
 *     tina4nodejs lint             # eslint (installed dev-only on demand), else baseline
 *     tina4nodejs lint --fix       # eslint --fix
 *     tina4nodejs lint --no-install # eslint if already present, else the baseline
 *
 * Mirrors the Python master's _lint (tina4_python/cli/__init__.py) — ruff there,
 * eslint here.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

// Source extensions we count as lintable app code. `.d.ts` declaration files are
// deliberately excluded — they carry no runnable code for `node --check` and are
// covered by the tsconfig for `tsc`.
const LINT_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
// The subset `node --check` can parse (it does not understand TypeScript).
const JS_EXTENSIONS = [".js", ".mjs", ".cjs"];
// Directories a source walk must never descend into.
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** True for a lintable source filename (excludes `.d.ts`). */
function isLintFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  return LINT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Recursively collect lintable source files under `dir`. */
function walkSource(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSource(full, out);
    } else if (isLintFile(name)) {
      out.push(full);
    }
  }
}

/**
 * The user's app source in lint scope: everything under `src/` plus the
 * entrypoint (`app.ts`/`app.js`, with `.mts`/`.mjs` variants). Mirrors how the
 * Python master lints `src/` + `app.py` — the developer's code, never the
 * framework's.
 */
function collectAppFiles(cwd: string): string[] {
  const files: string[] = [];
  const srcDir = join(cwd, "src");
  try {
    if (statSync(srcDir).isDirectory()) walkSource(srcDir, files);
  } catch {
    // no src/ — fall through to the entrypoint check
  }
  for (const entry of ["app.ts", "app.mts", "app.js", "app.mjs"]) {
    const p = join(cwd, entry);
    try {
      if (statSync(p).isFile()) files.push(p);
    } catch {
      // not present
    }
  }
  return files;
}

/**
 * Flat-config filenames to DETECT (any one means the project already configured
 * eslint, so we never scaffold over it). Legacy `.eslintrc*` is deliberately NOT
 * detected: eslint 9 ignores it under flat config, so treating it as "configured"
 * would make eslint run and then error "no flat config found". Flat config only.
 */
const ESLINT_FLAT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];

// The filename we SCAFFOLD when a project has no flat config. `.js` (not `.mjs`)
// per the shared design; every tina4-nodejs project is `"type": "module"`, so a
// `.js` flat config is ESM and loads as written.
const ESLINT_SCAFFOLD_FILE = "eslint.config.js";

// The minimal flat config we scaffold — eslint's own recommended rule set PLUS
// typescript-eslint's recommended (the non-type-checked / syntactic preset, so no
// tsconfig or parserOptions.project wiring is needed) so BOTH `.js` and `.ts` are
// linted. Without the typescript-eslint half, eslint reports every `.ts` file
// "File ignored" and a TS project lints vacuously. IDENTICAL content across the
// shared design.
const ESLINT_SCAFFOLD = `import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default [js.configs.recommended, ...tseslint.configs.recommended];
`;

/** Absolute path of an eslint flat config in `cwd`, or null when none exists. */
function findEslintConfig(cwd: string): string | null {
  for (const name of ESLINT_FLAT_CONFIGS) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve a package's bin script FROM the user's project, or null when the
 * package is not installed there.
 *
 * The DIRECT `node_modules/<pkg>/<bin>` path is checked FIRST because it is
 * immune to the CJS resolver's caches: `runLint` calls this both BEFORE and
 * AFTER an in-process `npm install`, and Node can negatively-cache the pre-install
 * "not found" so a post-install `require.resolve` still misses (the same
 * dir-listing-cache footgun Python's importlib has). `existsSync` hits the real
 * filesystem every call, so it sees the just-installed bin. The resolver is the
 * fallback for hoisted / workspace layouts where the package is not a direct
 * child of `cwd/node_modules`.
 */
function resolvePackageBin(cwd: string, pkg: string, binRelative: string): string | null {
  const direct = join(cwd, "node_modules", pkg, binRelative);
  if (existsSync(direct)) return direct;

  const require = createRequire(join(cwd, "package.json"));
  let entry: string;
  try {
    entry = require.resolve(pkg);
  } catch {
    return null; // not installed / not resolvable from the project
  }
  let dir = dirname(entry);
  for (let i = 0; i < 8; i++) {
    const pkgJson = join(dir, "package.json");
    if (existsSync(pkgJson)) {
      try {
        if (JSON.parse(readFileSync(pkgJson, "utf-8")).name === pkg) {
          const bin = join(dir, binRelative);
          return existsSync(bin) ? bin : null;
        }
      } catch {
        // malformed package.json — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** eslint's runnable bin from the project (`bin/eslint.js`), or null. */
function resolveEslintBin(cwd: string): string | null {
  return resolvePackageBin(cwd, "eslint", "bin/eslint.js");
}

/**
 * True when `pkg` is installed directly under the project's node_modules (a
 * `package.json` at `node_modules/<pkg>/`). Direct filesystem check, immune to
 * the module-resolver cache — the scaffold imports `@eslint/js` and
 * `typescript-eslint`, so it must not be written until both are on disk.
 */
function hasPackage(cwd: string, pkg: string): boolean {
  return existsSync(join(cwd, "node_modules", ...pkg.split("/"), "package.json"));
}

/**
 * Absolute path of `npm` on PATH, or null. Scanned directly (no `which` shell-out)
 * so it behaves the same on every platform — mirrors bin.ts's findClient().
 */
function resolveNpm(): string | null {
  const windows = process.platform === "win32";
  const names = windows ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not there — keep looking
      }
    }
  }
  return null;
}

/**
 * Lint the project's source. Exits 0 = clean, 1 = findings (parity with the
 * Python master and with `tina4nodejs test`'s exit-code contract).
 */
export function runLint(args: string[]): void {
  const fix = args.includes("--fix");
  const noInstall = args.includes("--no-install");
  const cwd = process.cwd();

  const files = collectAppFiles(cwd);
  if (files.length === 0) {
    console.log("  lint: nothing to lint (no src/ or app.ts).");
    process.exit(0);
  }

  let eslintBin = resolveEslintBin(cwd);
  let eslintConfig = findEslintConfig(cwd);

  // ── Silent on-demand bootstrap ──────────────────────────────────────
  // Running `tina4 lint` is the consent to add eslint as a DEV dependency of the
  // PROJECT and scaffold a minimal flat config. --no-install opts out (CI /
  // offline) and falls through to the zero-dependency baseline. We only bootstrap
  // what is missing, and only scaffold a config once eslint is actually available
  // to use it (so a failed install never leaves a stray eslint.config.js).
  if (!noInstall && (!eslintBin || !eslintConfig)) {
    const npm = resolveNpm();
    if (!npm) {
      console.log("  · npm not found — using the zero-dependency baseline.");
    } else {
      if (!eslintBin) {
        console.log("  · installing eslint (npm i -D eslint @eslint/js typescript-eslint)...");
        const rc = spawnSync(npm, ["install", "-D", "eslint", "@eslint/js", "typescript-eslint"], {
          cwd,
          stdio: "inherit",
        }).status;
        if (rc === 0) {
          eslintBin = resolveEslintBin(cwd);
        } else {
          console.log("  · could not install eslint — using the zero-dependency baseline.");
        }
      }
      // Scaffold ONLY once all three the config imports are on disk (eslint bin +
      // @eslint/js + typescript-eslint), so a partial/failed install never leaves
      // an eslint.config.js that cannot load.
      if (
        eslintBin && !eslintConfig &&
        hasPackage(cwd, "@eslint/js") && hasPackage(cwd, "typescript-eslint")
      ) {
        const scaffold = join(cwd, ESLINT_SCAFFOLD_FILE);
        try {
          writeFileSync(scaffold, ESLINT_SCAFFOLD, "utf-8");
          eslintConfig = scaffold;
          console.log(`  · scaffolded ${ESLINT_SCAFFOLD_FILE} (@eslint/js + typescript-eslint recommended).`);
        } catch (err) {
          console.log(
            `  · could not scaffold ${ESLINT_SCAFFOLD_FILE} (${err instanceof Error ? err.message : String(err)}).`,
          );
        }
      }
    }
  }

  // ── eslint: the project's own linter (installed dev-only on demand) ──
  // Only when a config exists AND eslint resolves from the project. eslint reports
  // syntax errors too, so when present it is the entire pass.
  if (eslintBin && eslintConfig) {
    const label = fix ? "eslint --fix" : "eslint";
    const eslintArgs = [eslintBin, ...files, ...(fix ? ["--fix"] : [])];
    const code = spawnSync(process.execPath, eslintArgs, { cwd, stdio: "inherit" }).status ?? 1;
    if (code !== 0) {
      console.log(`  ✗ lint failed — ${files.length} file(s) [${label}]`);
      process.exit(1);
    }
    console.log(`  ✓ lint clean — ${files.length} file(s) [${label}]`);
    process.exit(0);
  }

  // From here on nothing can autofix — say so once when --fix was asked for.
  if (fix) {
    console.log("  · --fix needs eslint — the baseline check has no autofix.");
  }

  // ── Baseline (TypeScript): the project's own `tsc --noEmit` ──────────
  // Every tina4-nodejs project ships tsconfig.json + typescript. `--noEmit` forces
  // a type+syntax check that writes NOTHING (the project's tsconfig may set outDir,
  // so this must never emit). tsc reports syntax errors too. Run from cwd so tsc
  // reads THIS tsconfig.json; diagnostics stream straight through.
  const hasTsconfig = existsSync(join(cwd, "tsconfig.json"));
  const tscBin = hasTsconfig ? resolvePackageBin(cwd, "typescript", "bin/tsc") : null;
  if (tscBin) {
    const code = spawnSync(process.execPath, [tscBin, "--noEmit"], { cwd, stdio: "inherit" }).status ?? 1;
    if (code !== 0) {
      console.log(`  ✗ lint failed — ${files.length} file(s) [tsc]`);
      process.exit(1);
    }
    console.log(`  ✓ lint clean — ${files.length} file(s) [tsc]`);
    process.exit(0);
  }

  // ── Baseline (plain JS): stdlib `node --check` over .js/.mjs/.cjs ────
  // Ships with node — zero dependency. A full syntax parse that never runs the
  // code. TypeScript files are out of its reach (they belong to the tsc path).
  const jsFiles = files.filter((f) => JS_EXTENSIONS.some((ext) => f.endsWith(ext)));
  if (jsFiles.length === 0) {
    console.log(
      "  lint: no JavaScript files to check — add tsconfig.json + typescript to type-check .ts files.",
    );
    process.exit(0);
  }

  let syntaxErrors = 0;
  for (const file of jsFiles) {
    const result = spawnSync(process.execPath, ["--check", file], { cwd, encoding: "utf-8" });
    if ((result.status ?? 1) !== 0) {
      const stderr = (result.stderr || "").trim();
      // node --check ends its stderr with a `SyntaxError: ...` line — surface it.
      const detail =
        stderr
          .split("\n")
          .reverse()
          .find((line) => line.includes("Error:")) || "syntax error";
      console.log(`  ✗ ${relative(cwd, file)}: ${detail.trim()}`);
      syntaxErrors++;
    }
  }

  if (syntaxErrors > 0) {
    console.log(
      `  ✗ lint failed — ${syntaxErrors} syntax error(s) in ${jsFiles.length} file(s) [node --check]`,
    );
    process.exit(1);
  }
  console.log(`  ✓ lint clean — ${jsFiles.length} file(s) [node --check]`);
  process.exit(0);
}

/**
 * A tree in which a bare package specifier GENUINELY cannot be resolved.
 *
 * WHY THIS EXISTS
 *
 * Some behaviour can only be observed in the opposite of the normal
 * environment. "the adapter tells you to install pg when pg is missing" cannot
 * be observed on a machine where pg is installed — and the lab installs every
 * driver by design. Tests for that behaviour therefore skipped forever, which
 * is not a pass: it is a code path nobody has ever seen execute.
 *
 * WHY NOT A SHIM
 *
 * The obvious workaround is to patch `Module._resolveFilename` and throw a
 * hand-made MODULE_NOT_FOUND. That is a mock of the module resolver — the one
 * collaborator whose real behaviour the test exists to exercise. It proves the
 * adapter's catch handles the error THE TEST fabricated, not the error Node
 * produces, and the two can differ (shape, code, `cause`, timing) exactly when
 * it matters. `test/_hidePackages.mjs` did this and was deleted with this file.
 *
 * WHAT THIS DOES INSTEAD
 *
 * It COPIES the framework source out of the repository into a temp directory
 * with no `node_modules` anywhere above it, then runs plain
 * `node --experimental-transform-types` there. Module resolution walks up from the
 * IMPORTING FILE, so from inside that tree every bare specifier genuinely fails.
 * Nothing is stubbed or intercepted; the failure is the real resolver's.
 *
 * THE INSTRUMENT REPORTS ITSELF, which is the part worth reviewing.
 *
 * Every child prints a SELFTEST line FIRST giving an exact count of how many of
 * the named packages it can still resolve, which must be 0 — and it resolves
 * them from the SAME FILE the code under test resolves from (`resolveFrom`),
 * not from the tree root, because resolution depends on the importer's
 * directory. A child that quietly inherited a `node_modules` would otherwise
 * make every case pass while proving nothing. Building the temp tree INSIDE the
 * repository is precisely how that happens, so it is built in `os.tmpdir()`.
 *
 * `import.meta.dirname` is deliberately NOT used to locate the repo: a consumer
 * passes its own repo root, so this module never assumes where it lives.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Copy `<repoRoot>/packages` into a fresh temp directory and rewrite the copy's
 * RELATIVE module specifiers from `.js` to `.ts`.
 *
 * The whole `packages` tree is copied, not one package: `core/src` imports
 * siblings such as `../../orm/src/databaseUrl.js`, so a partial copy breaks
 * resolution for a reason that has nothing to do with the missing driver.
 *
 * The source uses TypeScript's ESM convention of importing a sibling as
 * "./x.js" even though the file on disk is "x.ts". tsx remaps that; plain
 * `node` does not, so the COPY gets its relative
 * specifiers rewritten. This rewrites module specifiers only, in a throwaway
 * copy — no statement, branch or value the code executes is altered. BARE
 * specifiers are deliberately left untouched: they are exactly what must still
 * fail to resolve, and the SELFTEST line asserts that they do.
 *
 * Returns the tree root. The caller owns removing it.
 */
export function buildDriverlessTree(repoRoot: string): string {
  const root = mkdtempSync(join(tmpdir(), "tina4-driverless-"));

  // Never copy a node_modules. npm workspaces can leave one inside a package
  // (packages/core/node_modules exists in this repo), and resolution from a
  // file under that package would then find it — the instrument would be broken
  // in the one direction that turns every case green.
  cpSync(join(repoRoot, "packages"), join(root, "packages"), {
    recursive: true,
    filter: (src) => !src.split("/").includes("node_modules"),
  });

  const strays = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => String(entry).split("/").includes("node_modules"));
  if (strays.length > 0) {
    throw new Error(
      `the driverless tree contains node_modules (${strays.slice(0, 3).join(", ")}) — the instrument is broken`,
    );
  }

  for (const file of readdirSync(join(root, "packages"), { recursive: true, encoding: "utf8" })) {
    const path = join(root, "packages", String(file));
    if (!String(file).endsWith(".ts") || !statSync(path).isFile()) continue;
    const rewritten = readFileSync(path, "utf8").replace(
      /(from\s+|import\s*\(\s*)(["'])(\.\.?\/[^"']+)\.js\2/g,
      (_m, lead, quote, spec) => `${lead}${quote}${spec}.ts${quote}`,
    );
    writeFileSync(path, rewritten, "utf8");
  }
  return root;
}

/** Options for a driverless child run. */
export interface DriverlessRun {
  /** Bare specifiers that must be UNRESOLVABLE. The child counts them. */
  packages: string[];
  /**
   * Tree-relative path of the file the code under test resolves FROM, e.g.
   * "packages/orm/src/adapters/postgres.ts". Resolution walks up from the
   * importer, so checking from the tree root would check a strict SUBSET of the
   * directories the adapter actually consults.
   */
  resolveFrom: string;
}

/**
 * Run `source` inside the driverless tree with plain `node`, type-stripped.
 * Returns stdout. The child prints its SELFTEST line first; callers assert it
 * with `selftestPassed()` before believing anything else the child said.
 */
export function runDriverless(root: string, source: string, run: DriverlessRun): string {
  if (!existsSync(join(root, run.resolveFrom))) {
    throw new Error(`resolveFrom ${run.resolveFrom} is not in the driverless tree — the instrument is broken`);
  }
  const script = join(root, `probe-${Math.random().toString(16).slice(2, 10)}.ts`);
  const preamble = `
import { createRequire } from "node:module";
import { writeSync as tina4WriteSync } from "node:fs";
const requireThere = createRequire(new URL(${JSON.stringify("./" + run.resolveFrom)}, import.meta.url));
const resolvable: string[] = [];
for (const pkg of ${JSON.stringify(run.packages)}) {
  try { requireThere.resolve(pkg); resolvable.push(pkg); } catch { /* genuinely absent */ }
}
// The instrument reports itself BEFORE anything is asserted. A child that
// quietly inherited a node_modules is caught here rather than passing.
//
// writeSync, not console.log: console.log to a PIPE is asynchronous in Node, so
// a child that ends with process.exit() can lose the very line the parent
// parses. Every line this instrument depends on is written synchronously.
tina4WriteSync(1, "SELFTEST resolvable=" + resolvable.length + " [" + resolvable.join(",") + "]\\n");
`;
  writeFileSync(script, preamble + source, "utf8");
  // --experimental-transform-types, not --experimental-strip-types: strip-only
  // mode refuses any TypeScript that erases to something other than whitespace,
  // and packages/orm/src/adapters/postgres.ts uses a parameter property
  // (`constructor(private config: ...)`). That is a REAL Node flag doing a real
  // compile — module resolution is untouched by it, which is the only property
  // this instrument depends on.
  return execFileSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", script],
    { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_PATH: "" } },
  );
}

/** Did the child prove it could resolve NONE of the named packages? */
export function selftestPassed(output: string): boolean {
  return selftestLine(output).includes("resolvable=0");
}

/** The child's raw SELFTEST line, for a failure detail that names what leaked. */
export function selftestLine(output: string): string {
  return output.split("\n").find((line) => line.startsWith("SELFTEST ")) ?? "(no SELFTEST line)";
}

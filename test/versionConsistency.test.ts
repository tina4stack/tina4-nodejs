/** Release guard: docs, published workspaces, and lockfile must match root. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo root under check. Defaults to this file's own repo; a release worker (or
// the drift regression test) can point the guard at any tree via
// TINA4_VERSION_CHECK_ROOT so the SAME assertions run against a copied/corrupted
// skeleton without editing this file.
const root = process.env.TINA4_VERSION_CHECK_ROOT
  ? resolve(process.env.TINA4_VERSION_CHECK_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): any => JSON.parse(readFileSync(join(root, path), "utf-8"));

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS ${name}`);
    passed++;
  } else {
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

const rootPackage = readJson("package.json");
const expected = rootPackage.version;
// The intended release version is NOT hardcoded: a release worker passes it as an
// arg (`release:precheck <version>`) or via RELEASE_VERSION, so a version bump never
// edits this file. With neither set it falls back to root package.json — the CI gate
// then runs as a pure self-consistency check (root vs every other file below).
const expectedArg = process.argv[2] || process.env.RELEASE_VERSION || rootPackage.version;
const workspacePaths = ["packages/cli", "packages/core", "packages/frond", "packages/orm", "packages/swagger"];

assert(
  "root package is the intended release",
  expected === expectedArg,
  `intended ${expectedArg}, root package.json is ${expected}`,
);
const claude = readFileSync(join(root, "CLAUDE.md"), "utf-8");
assert(`CLAUDE.md title shows (v${expected})`, claude.includes(`tina4-nodejs (v${expected})`));
assert(`CLAUDE.md intro shows v${expected}`, claude.includes(`Tina4 for Node.js/TypeScript v${expected} -`));
for (const workspace of workspacePaths) {
  const actual = readJson(`${workspace}/package.json`).version;
  assert(`${workspace} matches root`, actual === expected, `expected ${expected}, got ${actual}`);
}

const lock = readJson("package-lock.json");
assert("package-lock root version matches", lock.version === expected, `expected ${expected}, got ${lock.version}`);
assert(
  "package-lock root package matches",
  lock.packages?.[""]?.version === expected,
  `expected ${expected}, got ${lock.packages?.[""]?.version}`,
);
for (const workspace of workspacePaths) {
  const actual = lock.packages?.[workspace]?.version;
  assert(`package-lock ${workspace} matches`, actual === expected, `expected ${expected}, got ${actual}`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

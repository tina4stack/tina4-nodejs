/** Release guard: docs, published workspaces, and lockfile must match root. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
const workspacePaths = ["packages/cli", "packages/core", "packages/frond", "packages/orm", "packages/swagger"];

assert("root package is the intended release", expected === "3.13.116", `got ${expected}`);
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

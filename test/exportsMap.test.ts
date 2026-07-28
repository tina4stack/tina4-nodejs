/**
 * REGRESSION: nodejs#32, second offence. Run with: npx tsx test/exportsMap.test.ts
 *
 * The exports map pointed "types" at packages/*'/'src/index.ts -- raw TypeScript --
 * while "import" pointed at dist. Any consumer running tsc therefore pulled the
 * FRAMEWORK's source into their own program and failed to compile on types the
 * framework needs but never declared (@types/pg, @types/node >= 22 for
 * node:sqlite). The first fix corrected the runtime half only, so the issue was
 * closed while consumers still could not build.
 *
 * That is why the generated Docker image ran `npx tsx` in production: you could
 * not tsc a Tina4 Node app at all, so the image shipped a transpiler and fetched
 * it over the network at container start.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Every "types" target, labelled, so a failure names the offending entry. */
function typeEntries(): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (typeof pkg.types === "string") entries.push(["types", pkg.types]);
  for (const [name, value] of Object.entries<any>(pkg.exports ?? {})) {
    if (typeof value?.types === "string") entries.push([`exports["${name}"]`, value.types]);
  }
  return entries;
}

console.log("\n--- exports map: types must be declarations, not source ---");

const entries = typeEntries();
assert("the exports map declares at least one types entry", entries.length > 0);

for (const [label, target] of entries) {
  assert(
    `${label} points at a .d.ts, not raw TypeScript`,
    !(target.endsWith(".ts") && !target.endsWith(".d.ts")),
    target,
  );
  // A path resolving to nothing is the same outage as pointing at src: the
  // consumer gets no types and tsc compiles whatever it can reach instead.
  assert(
    `${label} exists on disk`,
    existsSync(join(ROOT, target)),
    `${target} missing -- run npm run build:types`,
  );
}

console.log("\n--- the declarations have to actually ship ---");
assert(
  'package.json files[] includes "types"',
  (pkg.files ?? []).includes("types"),
  "declarations would be built locally and never published",
);
assert(
  "build script emits declarations",
  typeof pkg.scripts?.build === "string" && pkg.scripts.build.includes("build:types"),
  "npm run build must produce the .d.ts the exports map promises",
);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

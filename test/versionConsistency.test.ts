/**
 * Guard against release-bump drift: package.json is bumped at release, but
 * CLAUDE.md (the AI-facing doc assistants read as ground truth) has historically
 * lagged, so tools reported an outdated "latest version". Pure file check, no
 * deps. run-all.ts spawns this file and treats a non-zero exit as a failure.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version as string;
const claude = readFileSync(join(root, "CLAUDE.md"), "utf-8");

let failed = 0;
function assert(label: string, condition: boolean) {
  console.log((condition ? "  PASS " : "  FAIL ") + label);
  if (!condition) failed++;
}

// The two current-version markers in CLAUDE.md (the H1 title and the intro line).
// Historical "(v3.13.42)"-style feature references are left alone on purpose.
assert(`CLAUDE.md title shows (v${version})`, claude.includes(`tina4-nodejs (v${version})`));
assert(`CLAUDE.md intro shows v${version}`, claude.includes(`Tina4 for Node.js/TypeScript v${version} -`));

console.log(`\n=== versionConsistency: ${failed === 0 ? "ok" : `${failed} failed`} ===`);
process.exit(failed > 0 ? 1 : 0);

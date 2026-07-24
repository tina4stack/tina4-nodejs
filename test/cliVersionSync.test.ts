/**
 * Lock-in: the CLI package version tracks the framework version.
 *
 * Regression this pins down
 * -------------------------
 * `readCliVersion()` in packages/cli/src/bin.ts walks up to the NEAREST
 * package.json, which is packages/cli/package.json in both the source tree and
 * the built dist/. That value is what `tina4nodejs commands --json` reports as
 * the framework version, and the Rust `tina4` CLI reads that manifest to
 * discover this framework's command surface.
 *
 * packages/cli/package.json was bumped every release through 3.13.81, then
 * missed. By 3.13.84 the manifest was still announcing 3.13.81 -- the
 * self-describing CLI was describing a version that had not shipped for three
 * releases. Nothing caught it because nothing compared the two files.
 *
 * A plain read of two JSON files: no dependency, no double.
 *
 * Run with: npx tsx test/cliVersionSync.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const readVersion = (rel: string): string =>
  JSON.parse(readFileSync(join(repoRoot, rel), "utf-8")).version;

const rootVersion = readVersion("package.json");
const cliVersion = readVersion("packages/cli/package.json");
const coreVersion = readVersion("packages/core/package.json");

assert(
  "packages/cli/package.json version === root version",
  cliVersion === rootVersion,
  `cli=${cliVersion} root=${rootVersion}. Bump packages/cli/package.json: the ` +
    `manifest that the tina4 CLI reads takes its version from THIS file.`,
);

assert(
  "packages/core/package.json version === root version",
  coreVersion === rootVersion,
  `core=${coreVersion} root=${rootVersion}`,
);

assert(
  "root version looks like a release version",
  /^\d+\.\d+\.\d+$/.test(rootVersion),
  rootVersion,
);

console.log(
  `\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`,
);
process.exit(fail > 0 ? 1 : 0);

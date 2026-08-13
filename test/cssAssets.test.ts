/**
 * Lock-in: the shipped tina4css assets must be fully compiled CSS.
 * Run with: npx tsx test/cssAssets.test.ts
 *
 * The March 2026 artifacts vendored into all four frameworks contained literal
 * SCSS variables inside calc() -- `calc($grid-gutter / 2)` and
 * `calc($border-radius-lg - 1px)`. A browser treats those as invalid and DROPS
 * the whole declaration, so .container padding, .row negative margins,
 * .row > * padding and the card first/last-child corner radii silently did not
 * apply. 12 declarations shipped broken in every framework.
 *
 * These tests read the REAL shipped files off disk -- no mocks, no fixtures.
 *
 * NODE-3.13.99: the framework no longer vendors an SCSS source tree per
 * package (chore(scss): remove the bundled tina4css SCSS source from the
 * framework; "Remove the framework SCSS compilers; the Rust CLI owns SCSS").
 * Only the compiled CSS ships, in packages/core/public/css/ -- that is what
 * this file checks below. The companion "is the shipped CSS a current
 * compile of source" check now lives centrally in
 * tina4-documentation/scripts/build-tina4css.py --check, not per framework.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_DIR = join(__dirname, "..", "packages", "core", "public", "css");

// A `$name` that is not the CSS `[attr$="x"]` suffix operator.
const UNRESOLVED_VARIABLE = /\$(?!=)[A-Za-z_][A-Za-z0-9_-]*/g;
const CALC_WITH_VARIABLE = /calc\([^()]*\$[^()]*\)/g;

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

function read(name: string): string {
  const path = join(CSS_DIR, name);
  if (!existsSync(path)) {
    assert(`${name} exists`, false, path);
    return "";
  }
  return readFileSync(path, "utf8");
}

for (const name of ["tina4.css", "tina4.min.css"]) {
  console.log(`\n--- ${name} ---`);
  const css = read(name);

  // NEGATIVE: nothing unresolved may survive into the artifact.
  const leakedVariables = [...new Set(css.match(UNRESOLVED_VARIABLE) ?? [])];
  assert(
    `${name}: no unresolved SCSS variable`,
    leakedVariables.length === 0,
    leakedVariables.join(", "),
  );

  // NEGATIVE: calc() is the exact construct that leaked -- pin it explicitly.
  const leakedCalc = [...new Set(css.match(CALC_WITH_VARIABLE) ?? [])];
  assert(
    `${name}: no calc() containing a SCSS variable`,
    leakedCalc.length === 0,
    leakedCalc.join(", "),
  );

  // POSITIVE: an empty file would pass the negative assertions on its own.
  // The minifier drops a leading zero (0.75rem -> .75rem); accept both.
  assert(
    `${name}: ships the resolved gutter padding`,
    /padding-right:\s*0?\.75rem/.test(css),
  );
  assert(
    `${name}: ships the resolved row negative margin`,
    /margin-right:\s*-0?\.75rem/.test(css),
  );

  // POSITIVE: mixed units (rem - px) cannot fold, so a real calc() is correct.
  assert(
    `${name}: ships the resolved card corner radius`,
    /calc\(0?\.5rem - 1px\)/.test(css),
  );
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Lock-in: exactly one dev-admin bundle ships.
 * Run with: npx tsx test/devAdminBundleDedup.test.ts
 *
 * packages/core/public/ carried tina4-dev-admin.js AND tina4-dev-admin.min.js as
 * BYTE-IDENTICAL copies -- roughly 940K of dead weight in every install of the
 * package, referenced by nothing. Every consumer names the .min.js: the route
 * table, the SPA shell, and all four candidate paths in resolveDevAdminJs().
 *
 * Copying the bundle back under a second name would silently double the package
 * again, so assert the duplicate stays gone AND that the one we keep is the real
 * bundle rather than a stub.
 *
 * Reads the REAL shipped files off disk -- no mocks, no fixtures.
 *
 * Parity: Python tests/test_static.py, PHP tests/DevAdminBundleDedupTest.php,
 * Ruby spec/dev_admin_spec.rb.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JS_DIR = join(__dirname, "..", "packages", "core", "public", "js");

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

const minified = join(JS_DIR, "tina4-dev-admin.min.js");
const unminified = join(JS_DIR, "tina4-dev-admin.js");

assert("the shipped bundle exists", existsSync(minified), minified);

assert(
  "no unminified duplicate alongside it",
  !existsSync(unminified),
  "tina4-dev-admin.js is back -- that is ~940K of byte-identical dead weight",
);

// Guard the general case too: only ONE file may match tina4-dev-admin*.js, so a
// differently-named copy (…-full.js, …-dev.js) cannot slip the check above.
const copies = existsSync(JS_DIR)
  ? readdirSync(JS_DIR).filter((f) => /^tina4-dev-admin.*\.js$/.test(f))
  : [];
assert(
  "exactly one tina4-dev-admin*.js in public/js",
  copies.length === 1,
  JSON.stringify(copies),
);

// The kept file must be the genuine bundle, not a stub left behind by a bad dedup.
if (existsSync(minified)) {
  const js = readFileSync(minified, "utf-8");
  assert("kept bundle is substantial (> 100KB)", js.length > 100_000, `${js.length} bytes`);
  assert("kept bundle contains the dashboard markers", js.includes("db-table-list"));
}

console.log(
  `\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`,
);
process.exit(fail > 0 ? 1 : 0);

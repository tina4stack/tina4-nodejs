/**
 * The shared .env corpus (feature 1 of the feature audit).
 *
 * `test/fixtures/dotenv_corpus.json` is byte-identical in all four frameworks.
 * One answer key, four suites: a line that parses here and differently in Ruby
 * is a parity bug with a name, not a difference somebody has to notice.
 *
 * Real files on disk in a temp directory, real process environment. A .env is a
 * file, so the real dependency is trivially available and there is nothing to mock.
 *
 * Run with: npx tsx test/dotenvCorpus.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTruthy, loadEnv } from "../packages/core/src/dotenv.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "fixtures", "dotenv_corpus.json"), "utf-8"));

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

/**
 * Fresh temp dir with the shared .env, and every key it declares cleared from
 * the real environment first. Loading is FIRST-WINS, so a leftover key would
 * mask the file and quietly pass a test that proves nothing.
 */
function freshLoad(content = corpus.env_file, alsoLocal?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tina4-dotenv-"));
  const keys = [
    ...Object.keys(corpus.expected),
    ...corpus._never_set.keys,
    ...Object.keys(corpus.precedence.expected_without_real_env),
  ];
  for (const k of keys) delete process.env[k];
  writeFileSync(join(dir, ".env"), content, "utf-8");
  if (alsoLocal !== undefined) {
    writeFileSync(join(dir, ".env.local"), alsoLocal, "utf-8");
    loadEnv(join(dir, ".env.local"));
  }
  loadEnv(join(dir, ".env"));
  return dir;
}

console.log("=== .env corpus ===\n");

console.log("--- every key parses to the agreed value ---");
let dir = freshLoad();
for (const [key, want] of Object.entries(corpus.expected)) {
  assert(key, process.env[key] === want, `got ${JSON.stringify(process.env[key])} want ${JSON.stringify(want)}`);
}
rmSync(dir, { recursive: true, force: true });

console.log("\n--- the export prefix ---");
dir = freshLoad();
assert("reads an export prefixed line", process.env.EXPORTED === "shellstyle");
// Absent is the failure mode that hid this in Ruby: a .env copied out of a shell
// profile lost keys, and the failure surfaced somewhere unrelated.
assert("does not silently skip an export line", "EXPORTED" in process.env);

console.log("\n--- a trailing comment ---");
assert("is stripped from an unquoted value", process.env.WITH_HASH === "value");
assert("is not kept in the value", !(process.env.WITH_HASH ?? "").includes("#"));
assert("keeps a hash INSIDE a quoted value", process.env.QUOTED_HASH === "a # b");
assert("does not truncate a quoted value at a hash", (process.env.QUOTED_HASH ?? "").endsWith("b"));

console.log("\n--- interpolation ---");
assert("expands a dollar-brace reference", process.env.INTERP === "example.com/api");
assert("expands inside double quotes", process.env.DQ_INTERP === "example.com/v2");
// Single quotes are the documented escape for a literal ${...}, and the
// migration path for the breaking half of this change.
assert("does not expand inside single quotes", process.env.LITERAL === "${HOST}/api");
assert("leaves an unknown reference literal", process.env.UNKNOWN === "${NOPE}/x");
// PHP emptied it, so `URL=${DB_HOST}/db` with a typo became `/db` - a
// plausible-looking wrong value that reaches a connection attempt before failing.
assert("does not resolve an unknown reference to nothing", process.env.UNKNOWN !== "/x");

console.log("\n--- empty, escapes, whitespace ---");
assert("sets an empty string for a bare equals", process.env.EMPTY === "");
// An empty value IS a value. Absent and blank are different things.
assert("does not unset a key declared empty", "EMPTY" in process.env);
assert("processes escapes in a double-quoted value", process.env.ESCAPES === "line1\nline2\ttabbed");
assert("trims whitespace around a key", process.env.SPACED_KEY === "spaced");

console.log("\n--- a malformed line ---");
// The malformed lines sit in the MIDDLE of the fixture, so keys declared after
// them must still load and the bad keys must not exist.
assert("does not abort the whole file", process.env.ESCAPES === "line1\nline2\ttabbed");
for (const key of corpus._never_set.keys) {
  assert(`never sets ${key}`, !(key in process.env));
}
rmSync(dir, { recursive: true, force: true });

console.log("\n--- precedence: real environment > .env.local > .env ---");
const p = corpus.precedence;
dir = freshLoad(p.env, p.env_local);
for (const [key, want] of Object.entries(p.expected_without_real_env)) {
  assert(`.env.local overrides .env for ${key}`, process.env[key] === want, `got ${process.env[key]}`);
}
rmSync(dir, { recursive: true, force: true });

// A stray gitignored .env.local must never clobber a production value. This is
// the security-correct ordering, not a convenience.
for (const k of Object.keys(p.expected_without_real_env)) delete process.env[k];
process.env[p.real_env_wins.key] = p.real_env_wins.value;
dir = freshLoadKeepingRealEnv(p.env, p.env_local);
assert("does not overwrite an existing process variable",
  process.env[p.real_env_wins.key] === p.real_env_wins.value,
  `got ${process.env[p.real_env_wins.key]}`);
rmSync(dir, { recursive: true, force: true });

/** Same as freshLoad but does NOT clear the real env - that is the point here. */
function freshLoadKeepingRealEnv(content: string, local: string): string {
  const d = mkdtempSync(join(tmpdir(), "tina4-dotenv-"));
  writeFileSync(join(d, ".env"), content, "utf-8");
  writeFileSync(join(d, ".env.local"), local, "utf-8");
  loadEnv(join(d, ".env.local"));
  loadEnv(join(d, ".env"));
  return d;
}

// ---------------------------------------------------------------------------
// One truthiness table, every subsystem, every framework.
//
// The parser is only half the contract - the other half is what a parsed value
// MEANS as a boolean. It was not one table: Ruby's Env.bool also accepted
// y/t/n/f while its own Log and Mcp checks did not, so one .env gave two
// answers in one process. Node holds TWO copies of the table (core/dotenv.ts
// and orm/cachedDatabase.ts) because @tina4/orm has no dependencies and core
// dynamically imports orm - a value import the other way would be a package
// cycle, which is worse than the duplicate. So the corpus is the control:
// both copies are asserted against it.
// ---------------------------------------------------------------------------
console.log("\n--- Env truthiness (shared corpus) ---");

for (const value of corpus.truthiness.truthy) {
  assert(`isTruthy(${JSON.stringify(value)}) is true`, isTruthy(value) === true);
}
for (const value of corpus.truthiness.falsy) {
  assert(`isTruthy(${JSON.stringify(value)}) is false`, isTruthy(value) === false);
}

// The ORM's private copy, exercised through real behaviour rather than by
// exporting it: TINA4_DB_CACHE is read through that copy to default the
// persistent-cache mode. A real sqlite database, no doubles.
async function ormCopyAgrees() {
  const { initDatabase, closeDatabase } = await import("../packages/orm/src/index.ts");
  const saved = process.env.TINA4_DB_CACHE;
  const savedAuto = process.env.TINA4_AUTO_CACHING;
  delete process.env.TINA4_AUTO_CACHING;
  try {
    for (const [value, wantMode] of [["true", "persistent"], ["y", "off"]] as const) {
      process.env.TINA4_DB_CACHE = value;
      closeDatabase();
      const db = await initDatabase({ url: `sqlite:///tmp/tina4_truthiness_${value}_${process.pid}.db` });
      const mode = db.cacheStats().mode;
      assert(
        `orm copy: TINA4_DB_CACHE=${JSON.stringify(value)} -> mode "${wantMode}"`,
        mode === wantMode,
        `got "${mode}"`,
      );
      closeDatabase();
    }
  } finally {
    if (saved === undefined) delete process.env.TINA4_DB_CACHE; else process.env.TINA4_DB_CACHE = saved;
    if (savedAuto === undefined) delete process.env.TINA4_AUTO_CACHING; else process.env.TINA4_AUTO_CACHING = savedAuto;
  }
}

await ormCopyAgrees();

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Unit tests for the DotEnv parser.
 * Run with: npx tsx test/dotenv.test.ts
 */
import { loadEnv, getEnv, requireEnv } from "../packages/core/src/index.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/tina4-dotenv-test";
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

// Clean slate
try { rmSync(TEST_DIR, { recursive: true }); } catch {}
mkdirSync(TEST_DIR, { recursive: true });

console.log("=== DotEnv Tests ===\n");

// --- Basic parsing ---
console.log("--- Basic Parsing ---");

const envContent = `
# This is a comment
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mydb

# Quoted values
DB_PASSWORD="s3cret with spaces"
SINGLE_QUOTED='no escape \\n here'

# Export prefix
export MY_API_KEY=abc123

# Multi-line with backslash
LONG_VALUE=hello\\
world

# Empty value
EMPTY_VAR=
`;

writeFileSync(join(TEST_DIR, ".env"), envContent);

// Clear any existing values
delete process.env.DB_HOST;
delete process.env.DB_PORT;
delete process.env.DB_NAME;
delete process.env.DB_PASSWORD;
delete process.env.SINGLE_QUOTED;
delete process.env.MY_API_KEY;
delete process.env.LONG_VALUE;
delete process.env.EMPTY_VAR;

const parsed = loadEnv(join(TEST_DIR, ".env"));

assert("Parses basic KEY=value", parsed.DB_HOST === "localhost");
assert("Parses numeric value as string", parsed.DB_PORT === "5432");
assert("Parses double-quoted value", parsed.DB_PASSWORD === "s3cret with spaces");
assert("Parses single-quoted value literally", parsed.SINGLE_QUOTED === "no escape \\n here");
assert("Strips export prefix", parsed.MY_API_KEY === "abc123");
assert("Handles multi-line with backslash", parsed.LONG_VALUE === "helloworld");
assert("Handles empty value", parsed.EMPTY_VAR === "");
assert("Skips comments", parsed["# This is a comment"] === undefined);

// --- Sets process.env ---
console.log("\n--- Process.env Integration ---");

assert("Sets process.env.DB_HOST", process.env.DB_HOST === "localhost");
assert("Sets process.env.DB_PORT", process.env.DB_PORT === "5432");

// --- Does not override existing ---
process.env.EXISTING_VAR = "original";
writeFileSync(join(TEST_DIR, ".env2"), "EXISTING_VAR=overridden\n");
loadEnv(join(TEST_DIR, ".env2"));
assert("Does not override existing process.env", process.env.EXISTING_VAR === "original");
delete process.env.EXISTING_VAR;

// --- getEnv ---
console.log("\n--- getEnv ---");

assert("getEnv returns set value", getEnv("DB_HOST") === "localhost");
assert("getEnv returns default for unset", getEnv("MISSING_VAR", "fallback") === "fallback");
assert("getEnv returns undefined for unset without default", getEnv("MISSING_VAR") === undefined);

// --- requireEnv ---
console.log("\n--- requireEnv ---");

// Returns a MAP now, and takes varargs - parity with Python, PHP and Ruby.
assert("requireEnv returns the requested map", requireEnv("DB_HOST").DB_HOST === "localhost");

let threwError = false;
try {
  requireEnv("DEFINITELY_NOT_SET_XYZ");
} catch (e) {
  threwError = true;
  assert("requireEnv error message is descriptive",
    (e as Error).message.includes("DEFINITELY_NOT_SET_XYZ"));
}
assert("requireEnv throws for missing var", threwError);

// An operator fixing a deployment wants the whole list, not one name per
// restart. The old single-key signature could not express this.
let multiMessage = "";
try {
  requireEnv("MISSING_X_1", "MISSING_Y_2");
} catch (e) {
  multiMessage = (e as Error).message;
}
assert("requireEnv names EVERY missing var in one throw",
  multiMessage.includes("MISSING_X_1") && multiMessage.includes("MISSING_Y_2"),
  multiMessage);

// --- Non-existent file ---
console.log("\n--- Edge Cases ---");

const emptyResult = loadEnv("/tmp/does-not-exist.env");
assert("Returns empty object for non-existent file", Object.keys(emptyResult).length === 0);

// --- Inline comments ---
writeFileSync(join(TEST_DIR, ".env3"), "INLINE=value # comment\n");
delete process.env.INLINE;
const parsed3 = loadEnv(join(TEST_DIR, ".env3"));
assert("Strips inline comments", parsed3.INLINE === "value");

// Cleanup
rmSync(TEST_DIR, { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

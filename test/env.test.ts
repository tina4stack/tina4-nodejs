/**
 * Unit tests for the typed env-var helpers (Env class).
 *
 * Mirrors tina4-python's tests/test_env.py — same truthy/falsy sets,
 * same parse-failure-falls-back-to-default behaviour, same whitespace
 * handling. Parity feature #43 across all four Tina4 frameworks.
 *
 * Run with: npx tsx test/env.test.ts
 */
import { Env } from "../packages/core/src/index.ts";

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

// Use a single namespaced key so we don't leak across other tests in run-all.
const KEY = "TINA4_ENV_TEST_VAR";
function setEnv(value: string | undefined): void {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
}

console.log("=== Env Helper Tests ===\n");

// ── bool() ──────────────────────────────────────────────────────────
console.log("--- Env.bool ---");

setEnv(undefined);
assert("unset → default(false)", Env.bool(KEY) === false);
assert("unset with default true → true", Env.bool(KEY, true) === true);

const TRUTHY = ["1", "true", "on", "yes", "y", "t"];
for (const v of TRUTHY) {
  setEnv(v);
  assert(`truthy "${v}" → true`, Env.bool(KEY) === true);
  setEnv(v.toUpperCase());
  assert(`truthy "${v.toUpperCase()}" (case-insensitive) → true`, Env.bool(KEY) === true);
}

const FALSY = ["0", "false", "off", "no", "n", "f"];
for (const v of FALSY) {
  setEnv(v);
  assert(`falsy "${v}" → false (even when default=true)`, Env.bool(KEY, true) === false);
  setEnv(v.toUpperCase());
  assert(`falsy "${v.toUpperCase()}" (case-insensitive) → false`, Env.bool(KEY, true) === false);
}

setEnv("");
assert("empty string → falsy (returns false even with default=true)", Env.bool(KEY, true) === false);

setEnv("  yes  ");
assert("whitespace stripped → true", Env.bool(KEY) === true);

setEnv("garbage");
assert("garbage uses default(false)", Env.bool(KEY) === false);
assert("garbage uses default(true)", Env.bool(KEY, true) === true);

// ── int() ───────────────────────────────────────────────────────────
console.log("\n--- Env.int ---");

setEnv(undefined);
assert("unset → default(0)", Env.int(KEY) === 0);
assert("unset with default → that default", Env.int(KEY, 42) === 42);

setEnv("17");
assert("'17' → 17", Env.int(KEY) === 17);

setEnv("-9");
assert("negative '-9' → -9", Env.int(KEY) === -9);

setEnv("  100  ");
assert("whitespace stripped before parse", Env.int(KEY) === 100);

setEnv("not-a-number");
assert("garbage → default(0)", Env.int(KEY) === 0);
assert("garbage with explicit default", Env.int(KEY, 7) === 7);

setEnv("");
assert("empty string → default", Env.int(KEY, 5) === 5);

// ── float() ─────────────────────────────────────────────────────────
console.log("\n--- Env.float ---");

setEnv(undefined);
assert("unset → default(0.0)", Env.float(KEY) === 0.0);
assert("unset with default 3.14", Env.float(KEY, 3.14) === 3.14);

setEnv("2.5");
assert("'2.5' → 2.5", Env.float(KEY) === 2.5);

setEnv("-1.25");
assert("negative '-1.25' → -1.25", Env.float(KEY) === -1.25);

setEnv("1e3");
assert("scientific '1e3' → 1000.0", Env.float(KEY) === 1000.0);

setEnv("  4.2  ");
assert("whitespace stripped before parse", Env.float(KEY) === 4.2);

setEnv("nope");
assert("garbage → default(0.0)", Env.float(KEY) === 0.0);
assert("garbage with explicit default", Env.float(KEY, 9.9) === 9.9);

// ── str() ───────────────────────────────────────────────────────────
console.log("\n--- Env.str ---");

setEnv(undefined);
assert("unset → default ''", Env.str(KEY) === "");
assert("unset with default 'us-east-1'", Env.str(KEY, "us-east-1") === "us-east-1");

setEnv("hello");
assert("'hello' → 'hello'", Env.str(KEY) === "hello");

setEnv("");
assert("empty string preserved (not default)", Env.str(KEY, "fallback") === "");

setEnv("  spaced  ");
assert("whitespace preserved (not stripped)", Env.str(KEY) === "  spaced  ");

setEnv("multi\nline");
assert("newline preserved", Env.str(KEY) === "multi\nline");

// Cleanup
setEnv(undefined);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

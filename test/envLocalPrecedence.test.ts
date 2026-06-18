/**
 * Regression guard for the .env.local precedence bug.
 *
 * The committed dev-secret work loaded `.env.local` with override=TRUE AFTER
 * `.env`. override=true overwrites keys ALREADY PRESENT in the real process
 * environment, so a stray gitignored `.env.local` (auto-generated on a prior
 * dev-mode boot) clobbered an explicitly-set real env var — breaking the
 * integration test (real TINA4_SECRET signed a token, stale .env.local overrode
 * the secret → every write route returned 401) and is a security hazard (a
 * stray .env.local could override a real production TINA4_SECRET).
 *
 * CORRECT PRECEDENCE: real-env > .env.local > .env. Because loadEnv(override=
 * false) is first-wins ("set only if not already present"), the boot sequence
 * loads `.env.local` BEFORE `.env`, both override=false.
 *
 * This test is engine-agnostic (no server) — it replicates the exact boot load
 * sequence in a temp dir and asserts both precedence rules.
 *
 * Run with: npx tsx test/envLocalPrecedence.test.ts
 */
import { loadEnv } from "../packages/core/src/index.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/tina4-env-local-precedence";
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

// The boot load sequence from server.ts, verbatim in order: .env.local first
// then .env, both override=false (the default). Explicit paths so we control
// exactly which files are read, independent of CWD.
function bootLoad(dir: string) {
  loadEnv(join(dir, ".env.local"));
  loadEnv(join(dir, ".env"));
}

console.log("=== .env.local Precedence Tests ===\n");

// --- (a) Real env var set before boot MUST WIN over .env.local ---
console.log("--- (a) real-env wins over .env.local ---");
{
  const dir = join(TEST_DIR, "a");
  try { rmSync(dir, { recursive: true }); } catch {}
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env.local"), "TINA4_SECRET=from_local\n");

  // Real env var, set BEFORE the load (mirrors integration.ts which sets a real
  // TINA4_SECRET then signs a token with it).
  delete process.env.TINA4_SECRET;
  process.env.TINA4_SECRET = "from_real";

  bootLoad(dir);

  assert(
    "real TINA4_SECRET wins over .env.local (the bug showed 'from_local')",
    process.env.TINA4_SECRET === "from_real",
    `got '${process.env.TINA4_SECRET}'`,
  );

  delete process.env.TINA4_SECRET;
  rmSync(dir, { recursive: true });
}

// --- (b) With NO real env var, .env.local MUST WIN over .env ---
console.log("\n--- (b) .env.local wins over .env ---");
{
  const dir = join(TEST_DIR, "b");
  try { rmSync(dir, { recursive: true }); } catch {}
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env.local"), "TINA4_SECRET=from_local\n");
  writeFileSync(join(dir, ".env"), "TINA4_SECRET=from_dotenv\n");

  // No real env var present.
  delete process.env.TINA4_SECRET;

  bootLoad(dir);

  assert(
    ".env.local wins over .env",
    process.env.TINA4_SECRET === "from_local",
    `got '${process.env.TINA4_SECRET}'`,
  );

  delete process.env.TINA4_SECRET;
  rmSync(dir, { recursive: true });
}

// Cleanup
try { rmSync(TEST_DIR, { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

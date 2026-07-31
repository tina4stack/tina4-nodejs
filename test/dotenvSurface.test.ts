/**
 * Feature 1, step 5: the dotenv SURFACE is the same shape in all four.
 *
 * The parser behaviour was reconciled on 2026-07-30 and is pinned by the shared
 * corpus. The CALL SHAPE was not, and that is what these lock in.
 *
 * Node took a FILE path, like Python and PHP, and pushed the precedence rule
 * (real-env > .env.local > .env) onto the caller. Worse than the other two: the
 * rule was only ever written in a DOC COMMENT telling callers to load
 * `.env.local` first and `.env` second, both with override=false. Every caller
 * had to remember, and getting it wrong lets a stray gitignored `.env.local`
 * beat a production variable. The directory form encapsulates it.
 *
 * NO MOCKS and no doubles: a .env is a file, so the real dependency is a real
 * file in a real temp directory, and the real process environment.
 *
 * Identical case names in all four frameworks:
 *   tina4-python/tests/test_dotenv_surface.py
 *   tina4-php/tests/DotEnvSurfaceTest.php
 *   tina4-ruby/spec/dotenv_surface_spec.rb
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dotenv from "../packages/core/src/dotenv.ts";

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

const KEYS = ["SURFACE_BASE", "SURFACE_SHARED", "SURFACE_LOCAL"];
function clearKeys() {
  for (const k of KEYS) delete process.env[k];
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "tina4-surface-"));
  writeFileSync(join(root, ".env"), "SURFACE_BASE=from_env\nSURFACE_SHARED=from_env\n");
  writeFileSync(join(root, ".env.local"), "SURFACE_SHARED=from_local\nSURFACE_LOCAL=only_local\n");
  clearKeys();
  try {
    return fn(root);
  } finally {
    clearKeys();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("=== DotEnv Surface ===\n");

// POSITIVE: the canonical form. A directory loads BOTH files, in order.
withRoot((root) => {
  const result = dotenv.loadEnv(root);
  assert("load_env accepts a root directory",
    process.env.SURFACE_BASE === "from_env" && process.env.SURFACE_LOCAL === "only_local",
    `base=${process.env.SURFACE_BASE} local=${process.env.SURFACE_LOCAL}`);
  assert("the returned map carries the loaded keys", result.SURFACE_BASE === "from_env");
});

// The whole reason the directory form exists: .env.local beats .env. A caller
// doing this by hand in the wrong order gets the opposite, silently.
withRoot((root) => {
  dotenv.loadEnv(root);
  assert("load_env directory form gives env local precedence",
    process.env.SURFACE_SHARED === "from_local", String(process.env.SURFACE_SHARED));
});

// NEGATIVE: the directory form must not break the file form.
withRoot((root) => {
  dotenv.loadEnv(join(root, ".env"));
  assert("load_env still accepts a single file", process.env.SURFACE_BASE === "from_env");
  assert("naming ONE file reads only that file",
    process.env.SURFACE_LOCAL === undefined,
    "the caller owns the ordering when they name a file");
});

// NEGATIVE: the obvious call must not raise.
{
  const names = ["loadEnv", "getEnv", "requireEnv", "hasEnv", "allEnv", "resetEnv", "isTruthy"];
  const missing = names.filter((n) => typeof (dotenv as never as Record<string, unknown>)[n] !== "function");
  assert("load_env is reachable from the top level namespace",
    missing.length === 0, `not reachable: ${missing.join(", ")}`);
}

// A fresh checkout has no .env.local, and the directory form reads it anyway.
{
  const solo = mkdtempSync(join(tmpdir(), "tina4-solo-"));
  writeFileSync(join(solo, ".env"), "SOLO=1\n");
  delete process.env.SOLO;
  let threw = false;
  try {
    dotenv.loadEnv(solo);
  } catch {
    threw = true;
  }
  assert("a missing env local is not an error", !threw && process.env.SOLO === "1");
  delete process.env.SOLO;
  rmSync(solo, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

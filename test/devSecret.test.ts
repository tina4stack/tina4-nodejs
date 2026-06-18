/**
 * Dev-secret bootstrap (ensureDevSecret) — fail-safe defaults.
 * Mirrors tina4_python/tests/test_dev_secret.py. No DB needed.
 *
 * Rules under test (parity with the Python master):
 *   • TINA4_SECRET already set      → no-op (no generation, no file write).
 *   • dev (TINA4_DEBUG truthy), not CI, not production, blank secret
 *                                   → generate 64-hex secret, set process.env,
 *                                     write ONLY .env.local (never .env).
 *   • CI=true / TINA4_ENV=production / non-dev with a blank secret
 *                                   → DO NOT generate, DO NOT write (warning path).
 *   • .env.local write failure      → keep in-memory secret, never crash.
 *
 * Run with: npx tsx test/devSecret.test.ts
 */
import { ensureDevSecret } from "../packages/core/src/index.ts";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/** Fresh temp cwd for a test (so .env.local lands in isolation). */
function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "tina4-devsecret-"));
}

/** Reset the four env vars the bootstrap reads to a known-clean state. */
function clearEnv(): void {
  delete process.env.TINA4_SECRET;
  delete process.env.CI;
  delete process.env.TINA4_ENV;
  delete process.env.TINA4_DEBUG;
}

// Save any pre-existing values so the suite doesn't leak into sibling tests.
const SAVED = {
  TINA4_SECRET: process.env.TINA4_SECRET,
  CI: process.env.CI,
  TINA4_ENV: process.env.TINA4_ENV,
  TINA4_DEBUG: process.env.TINA4_DEBUG,
};

console.log("=== Dev Secret Bootstrap Tests ===\n");

// ── Dev generates ──────────────────────────────────────────
console.log("--- Dev generates a secret to .env.local ---");
{
  // Dev, not CI, not prod, blank secret → mints + writes .env.local only.
  clearEnv();
  process.env.TINA4_DEBUG = "true";
  const dir = tmpCwd();
  const secret = ensureDevSecret(dir);

  assert("dev: returns a 64-hex secret", typeof secret === "string" && /^[0-9a-f]{64}$/.test(secret as string), String(secret));
  assert("dev: sets process.env.TINA4_SECRET to the new value", process.env.TINA4_SECRET === secret);
  assert("dev: writes .env.local", existsSync(join(dir, ".env.local")));
  assert("dev: does NOT write .env", !existsSync(join(dir, ".env")));
  const body = existsSync(join(dir, ".env.local")) ? readFileSync(join(dir, ".env.local"), "utf-8") : "";
  assert("dev: .env.local contains the secret line", body.includes(`TINA4_SECRET=${secret}`), body);
  assert("dev: .env.local ends with a newline", body.endsWith("\n"), JSON.stringify(body));
  rmSync(dir, { recursive: true, force: true });
}

{
  // Appends to an existing .env.local without corrupting its last line
  // (existing content has NO trailing newline → bootstrap prepends one).
  clearEnv();
  process.env.TINA4_DEBUG = "true";
  const dir = tmpCwd();
  writeFileSync(join(dir, ".env.local"), "FOO=bar"); // no trailing newline
  const secret = ensureDevSecret(dir);
  const body = readFileSync(join(dir, ".env.local"), "utf-8");
  assert("append: preserves existing FOO=bar line intact", body.includes("FOO=bar\n"), JSON.stringify(body));
  assert("append: adds the secret on its own line", body.includes(`\nTINA4_SECRET=${secret}\n`), JSON.stringify(body));
  rmSync(dir, { recursive: true, force: true });
}

{
  // An existing TINA4_SECRET is left untouched — no generation, no write.
  clearEnv();
  process.env.TINA4_DEBUG = "true";
  process.env.TINA4_SECRET = "already-set-secret";
  const dir = tmpCwd();
  const result = ensureDevSecret(dir);
  assert("already-set: returns null (no-op)", result === null);
  assert("already-set: TINA4_SECRET unchanged", process.env.TINA4_SECRET === "already-set-secret");
  assert("already-set: no .env.local written", !existsSync(join(dir, ".env.local")));
  rmSync(dir, { recursive: true, force: true });
}

// ── CI / prod / non-dev never generate ─────────────────────
console.log("\n--- CI / production / non-dev do NOT generate ---");
{
  // CI=true with a blank secret → warning path, no generation, no file.
  clearEnv();
  process.env.TINA4_DEBUG = "true"; // dev flag on, but CI must veto generation
  process.env.CI = "true";
  const dir = tmpCwd();
  const result = ensureDevSecret(dir);
  assert("CI: returns null (no generation)", result === null);
  assert("CI: TINA4_SECRET still unset", process.env.TINA4_SECRET === undefined);
  assert("CI: no .env.local written", !existsSync(join(dir, ".env.local")));
  rmSync(dir, { recursive: true, force: true });
}

{
  // production → no generation, no file.
  clearEnv();
  process.env.TINA4_DEBUG = "true";
  process.env.TINA4_ENV = "production";
  const dir = tmpCwd();
  const result = ensureDevSecret(dir);
  assert("prod: returns null (no generation)", result === null);
  assert("prod: TINA4_SECRET still unset", process.env.TINA4_SECRET === undefined);
  assert("prod: no .env.local written", !existsSync(join(dir, ".env.local")));
  rmSync(dir, { recursive: true, force: true });
}

{
  // non-dev (debug off / unset) → no generation, no file.
  clearEnv();
  process.env.TINA4_DEBUG = "false";
  const dir = tmpCwd();
  const result = ensureDevSecret(dir);
  assert("non-dev: returns null (no generation)", result === null);
  assert("non-dev: TINA4_SECRET still unset", process.env.TINA4_SECRET === undefined);
  assert("non-dev: no .env.local written", !existsSync(join(dir, ".env.local")));
  rmSync(dir, { recursive: true, force: true });
}

// ── Never crashes on a write failure ───────────────────────
console.log("\n--- Never crashes when .env.local cannot be written ---");
{
  // Point cwd at a regular FILE so `<file>/.env.local` open raises → the
  // bootstrap must keep the in-memory secret and NOT throw.
  clearEnv();
  process.env.TINA4_DEBUG = "true";
  const dir = tmpCwd();
  const filePath = join(dir, "iam-a-file");
  writeFileSync(filePath, "x");
  let threw = false;
  let secret: string | null = null;
  try {
    secret = ensureDevSecret(filePath); // join(filePath, ".env.local") is unwritable
  } catch {
    threw = true;
  }
  assert("write-fail: did not throw (boot survives)", !threw);
  assert("write-fail: still returned an in-memory secret", typeof secret === "string" && /^[0-9a-f]{64}$/.test(secret as string), String(secret));
  assert("write-fail: in-memory secret set in process.env", process.env.TINA4_SECRET === secret);
  rmSync(dir, { recursive: true, force: true });
}

// Restore the original env so this test file doesn't leak.
clearEnv();
for (const [k, v] of Object.entries(SAVED)) {
  if (v !== undefined) process.env[k] = v;
}

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);

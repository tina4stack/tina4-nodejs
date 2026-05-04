/**
 * Regression test for the v3.12 legacy env var boot guard.
 *
 * The guard refuses to start the server when any pre-3.12 un-prefixed
 * env var (DATABASE_URL, SECRET, SMTP_HOST, …) is set, because silently
 * ignoring them would let auth/db/mail fall back to defaults while the
 * user thinks their config is being read.
 *
 * The boot guard calls `process.exit(2)`, so each scenario is run in a
 * fresh child process via `child_process.spawn` — we can't import the
 * server here because the moment we call startServer() the test runner
 * itself would die.
 *
 * Run with: npx tsx test/legacyEnvGuard.test.ts
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

let pass = 0;
let fail = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
    fail++;
  }
}

console.log("=== Legacy Env Guard Tests (v3.12) ===\n");

// Build a tiny harness script that imports the guard and invokes it.
// Run as a child process so the guard's process.exit(2) doesn't kill us.
const HARNESS_DIR = mkdtempSync(join(tmpdir(), "tina4-legacy-guard-"));
const harnessPath = join(HARNESS_DIR, "boot.ts");
writeFileSync(
  harnessPath,
  `import { _checkLegacyEnvVars } from "${rootDir}/packages/core/src/server.ts";\n` +
    `_checkLegacyEnvVars();\n` +
    `console.log("BOOT_OK");\n`,
);

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGuard(extraEnv: Record<string, string | undefined> = {}): RunResult {
  // Strip any inherited legacy names so we control exactly what's set.
  const cleanEnv = { ...process.env };
  const legacyNames = [
    "DATABASE_URL", "DATABASE_USERNAME", "DATABASE_PASSWORD", "DB_URL",
    "SECRET", "API_KEY", "JWT_ALGORITHM",
    "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD",
    "SMTP_FROM", "SMTP_FROM_NAME",
    "IMAP_HOST", "IMAP_PORT", "IMAP_USER", "IMAP_PASS",
    "HOST_NAME", "SWAGGER_TITLE", "SWAGGER_DESCRIPTION", "SWAGGER_VERSION",
    "ORM_PLURAL_TABLE_NAMES",
    "TINA4_ALLOW_LEGACY_ENV",
  ];
  for (const k of legacyNames) delete cleanEnv[k];
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete cleanEnv[k];
    else cleanEnv[k] = v;
  }

  const result = spawnSync("npx", ["tsx", harnessPath], {
    cwd: rootDir,
    env: cleanEnv,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ── 1. Clean environment — guard must not exit ──────────────────────────
console.log("--- Clean environment ---");
{
  const r = runGuard();
  assert("clean env: exit 0", r.status === 0, `(got ${r.status})`);
  assert("clean env: prints BOOT_OK", r.stdout.includes("BOOT_OK"));
  assert("clean env: no migration banner", !r.stderr.includes("Tina4 v3.12 requires"));
}

// ── 2. Each individual legacy var triggers exit(2) ──────────────────────
console.log("\n--- Each legacy var triggers exit(2) ---");
const legacyMap: Record<string, string> = {
  DATABASE_URL:           "TINA4_DATABASE_URL",
  DATABASE_USERNAME:      "TINA4_DATABASE_USERNAME",
  DATABASE_PASSWORD:      "TINA4_DATABASE_PASSWORD",
  DB_URL:                 "TINA4_DATABASE_URL",
  SECRET:                 "TINA4_SECRET",
  API_KEY:                "TINA4_API_KEY",
  JWT_ALGORITHM:          "TINA4_JWT_ALGORITHM",
  SMTP_HOST:              "TINA4_MAIL_HOST",
  SMTP_PORT:              "TINA4_MAIL_PORT",
  SMTP_USERNAME:          "TINA4_MAIL_USERNAME",
  SMTP_PASSWORD:          "TINA4_MAIL_PASSWORD",
  SMTP_FROM:              "TINA4_MAIL_FROM",
  SMTP_FROM_NAME:         "TINA4_MAIL_FROM_NAME",
  IMAP_HOST:              "TINA4_MAIL_IMAP_HOST",
  IMAP_PORT:              "TINA4_MAIL_IMAP_PORT",
  IMAP_USER:              "TINA4_MAIL_IMAP_USERNAME",
  IMAP_PASS:              "TINA4_MAIL_IMAP_PASSWORD",
  HOST_NAME:              "TINA4_HOST_NAME",
  SWAGGER_TITLE:          "TINA4_SWAGGER_TITLE",
  SWAGGER_DESCRIPTION:    "TINA4_SWAGGER_DESCRIPTION",
  SWAGGER_VERSION:        "TINA4_SWAGGER_VERSION",
  ORM_PLURAL_TABLE_NAMES: "TINA4_ORM_PLURAL_TABLE_NAMES",
};

for (const [legacy, replacement] of Object.entries(legacyMap)) {
  const r = runGuard({ [legacy]: "anything" });
  assert(
    `${legacy}: exits with code 2`,
    r.status === 2,
    `(got ${r.status}, stderr: ${r.stderr.slice(0, 120)})`,
  );
  assert(
    `${legacy}: stderr lists ${legacy} → ${replacement}`,
    r.stderr.includes(legacy) && r.stderr.includes(replacement),
  );
  assert(
    `${legacy}: never prints BOOT_OK`,
    !r.stdout.includes("BOOT_OK"),
  );
}

// ── 3. Multiple legacy vars all listed in the error ─────────────────────
console.log("\n--- Multiple legacy vars listed together ---");
{
  const r = runGuard({
    DATABASE_URL: "sqlite:///foo.db",
    SECRET: "whatever",
    SMTP_HOST: "mail.example.com",
  });
  assert("multi: exits with code 2", r.status === 2, `(got ${r.status})`);
  assert("multi: lists DATABASE_URL", r.stderr.includes("DATABASE_URL"));
  assert("multi: lists SECRET", r.stderr.includes("SECRET"));
  assert("multi: lists SMTP_HOST", r.stderr.includes("SMTP_HOST"));
  assert("multi: lists TINA4_DATABASE_URL replacement", r.stderr.includes("TINA4_DATABASE_URL"));
  assert("multi: lists TINA4_SECRET replacement", r.stderr.includes("TINA4_SECRET"));
  assert("multi: lists TINA4_MAIL_HOST replacement", r.stderr.includes("TINA4_MAIL_HOST"));
  assert("multi: shows migration banner", r.stderr.includes("Tina4 v3.12 requires"));
  assert("multi: mentions release notes URL", r.stderr.includes("https://tina4.com/release/3.12.0"));
}

// ── 4. TINA4_ALLOW_LEGACY_ENV bypass ────────────────────────────────────
console.log("\n--- TINA4_ALLOW_LEGACY_ENV bypass ---");
{
  const r = runGuard({
    DATABASE_URL: "sqlite:///foo.db",
    SECRET: "x",
    TINA4_ALLOW_LEGACY_ENV: "true",
  });
  assert("bypass=true: exits 0", r.status === 0, `(got ${r.status}, stderr: ${r.stderr.slice(0, 120)})`);
  assert("bypass=true: prints BOOT_OK", r.stdout.includes("BOOT_OK"));
  assert("bypass=true: no migration banner", !r.stderr.includes("Tina4 v3.12 requires"));
}
{
  const r = runGuard({
    DATABASE_URL: "x",
    TINA4_ALLOW_LEGACY_ENV: "1",
  });
  assert("bypass=1: exits 0", r.status === 0, `(got ${r.status})`);
}
{
  const r = runGuard({
    DATABASE_URL: "x",
    TINA4_ALLOW_LEGACY_ENV: "yes",
  });
  assert("bypass=yes: exits 0", r.status === 0, `(got ${r.status})`);
}
{
  // Any non-truthy value should NOT bypass
  const r = runGuard({
    DATABASE_URL: "x",
    TINA4_ALLOW_LEGACY_ENV: "false",
  });
  assert("bypass=false: still exits 2", r.status === 2, `(got ${r.status})`);
}
{
  const r = runGuard({
    DATABASE_URL: "x",
    TINA4_ALLOW_LEGACY_ENV: "",
  });
  assert("bypass=empty: still exits 2", r.status === 2, `(got ${r.status})`);
}

// Cleanup
rmSync(HARNESS_DIR, { recursive: true, force: true });

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

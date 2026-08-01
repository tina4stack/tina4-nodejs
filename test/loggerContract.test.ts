/**
 * The SETTLED LOGGER CONTRACT (owner decision 2026-08-01) — regression gates.
 * Run with: npx tsx test/loggerContract.test.ts
 *
 * These are the clauses that were measured to be WRONG or MISSING, one named
 * gate per clause, each with its negative half:
 *
 *   L1  Format is TEXT by default. TINA4_LOG_FORMAT=json is the ONLY switch.
 *       MEASURED: Node reformatted every line to JSON whenever TINA4_DEBUG was
 *       unset, so the same .env produced four different formats across the four
 *       frameworks ("production" meant !TINA4_DEBUG here, TINA4_ENV/RACK_ENV/
 *       RUBY_ENV in Ruby, a configure() kwarg in Python, and nothing at all in
 *       PHP where JSON was simply the default). The implicit switch is deleted.
 *       An OBJECT passed as the message is still JSON-encoded INLINE in the text
 *       line — that behaviour was already right and is pinned here so a future
 *       "make it all text" does not flatten it to [object Object].
 *
 *   L2  The env is read LAZILY, on first use. A script / worker / CLI tool / test
 *       that logs without booting a server must still get the operator's config.
 *       Node already did this; nothing pinned it.
 *
 *   L3  TINA4_LOG_STRICT: documented on all four env-var pages, implemented only
 *       in Ruby — a documented no-op here. When truthy a log-write failure must
 *       RAISE instead of being swallowed.
 *
 * NO MOCKS. The format cases run the REAL logger in a REAL child process and
 * read its REAL stdout bytes (which is also the L2 proof: those processes never
 * call configure() and never boot a server). The strict cases write to a REAL
 * path on disk that cannot accept a write — a directory sitting where the log
 * file should be — so the EISDIR is genuine, not simulated.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOGGER_MODULE = join(ROOT, "packages", "core", "src", "logger.ts");

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

/** True when the whole line parses as a JSON object — i.e. the JSON format. */
function isJsonLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line.trim());
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

const TMP = mkdtempSync(join(tmpdir(), "tina4-logger-contract-"));

// ── The child script ────────────────────────────────────────────────────────
// It imports the REAL logger module and logs two messages: a plain string and
// an object. It never calls Log.configure() and never starts a server, so every
// setting it honours had to be resolved lazily from the environment (L2).
const CHILD = join(TMP, "logChild.ts");
writeFileSync(
  CHILD,
  [
    `import { Log } from ${JSON.stringify(LOGGER_MODULE)};`,
    `Log.info("contract-string-message");`,
    `Log.info({ user: 42, action: "login" });`,
    "",
  ].join("\n"),
  "utf-8",
);

/** Run the child with an explicit log environment; return its stdout lines. */
function runChild(env: Record<string, string | undefined>): string[] {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Start from a clean logger environment so the developer's own shell can
    // never decide the outcome of a format assertion.
    if (k.startsWith("TINA4_LOG_") || k === "TINA4_DEBUG" || k === "TINA4_ENV") continue;
    if (v !== undefined) childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const out = execFileSync("npx", ["tsx", CHILD], {
    cwd: ROOT,
    encoding: "utf-8",
    env: childEnv,
    timeout: 40_000,
  });
  return out.trim().split("\n").filter((l) => l.trim() !== "");
}

console.log("=== Logger Contract Tests (L1 format, L2 lazy env, L3 strict) ===\n");

// ── L1: format is TEXT by default ───────────────────────────────────────────
console.log("--- L1: TEXT by default; TINA4_LOG_FORMAT=json is the only switch ---");

// POSITIVE half of the deleted switch: TINA4_DEBUG unset (what Node called
// "production") must NOT change the format. Before 3.13.95 both of these lines
// came out as JSON.
{
  const lines = runChild({ TINA4_LOG_LEVEL: "INFO" });
  assert(
    "L1 default+no-TINA4_DEBUG: stdout line is TEXT, not JSON",
    lines.length >= 1 && !isJsonLine(lines[0]),
    `line was: ${lines[0]}`,
  );
  assert(
    "L1 default+no-TINA4_DEBUG: text line carries level and message",
    (lines[0] ?? "").includes("[INFO") && (lines[0] ?? "").includes("contract-string-message"),
    `line was: ${lines[0]}`,
  );
  // An OBJECT message is JSON-encoded INLINE inside that text line — the line as
  // a whole is still text, the object is still readable, never "[object Object]".
  const objLine = lines[1] ?? "";
  assert(
    "L1 object message: JSON-encoded INLINE inside the text line",
    !isJsonLine(objLine) && objLine.includes('{"user":42,"action":"login"}'),
    `line was: ${objLine}`,
  );
  assert(
    "L1 object message: never rendered as [object Object]",
    !objLine.includes("[object Object]"),
    `line was: ${objLine}`,
  );
}

// NEGATIVE half: the explicit opt-in must still work — and it must work with
// TINA4_DEBUG unset AND set, because format no longer depends on it at all.
{
  const lines = runChild({ TINA4_LOG_FORMAT: "json", TINA4_LOG_LEVEL: "INFO" });
  assert(
    "L1 TINA4_LOG_FORMAT=json: stdout line IS JSON",
    lines.length >= 1 && isJsonLine(lines[0]),
    `line was: ${lines[0]}`,
  );
  const entry = isJsonLine(lines[0] ?? "") ? JSON.parse(lines[0]) : {};
  assert(
    "L1 TINA4_LOG_FORMAT=json: JSON line carries level + message",
    entry.level === "INFO" && entry.message === "contract-string-message",
    `entry was: ${lines[0]}`,
  );
}
{
  const lines = runChild({ TINA4_LOG_FORMAT: "json", TINA4_DEBUG: "true", TINA4_LOG_LEVEL: "INFO", TINA4_LOG_DIR: join(TMP, "devjson") });
  const stripped = (lines[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  assert(
    "L1 TINA4_LOG_FORMAT=json in DEV: stdout line IS JSON too",
    isJsonLine(stripped),
    `line was: ${lines[0]}`,
  );
}

// The other three frameworks' notions of "production" must not sneak the switch
// back in through a different env var name. None of these may select a format.
{
  const lines = runChild({
    TINA4_ENV: "production",
    NODE_ENV: "production",
    RACK_ENV: "production",
    TINA4_LOG_LEVEL: "INFO",
  });
  assert(
    "L1 TINA4_ENV/NODE_ENV/RACK_ENV=production: stdout is STILL text",
    lines.length >= 1 && !isJsonLine(lines[0]),
    `line was: ${lines[0]}`,
  );
}

// Dev (TINA4_DEBUG=true) is text as well — colour is the only thing TINA4_DEBUG
// decides, so ANSI is present but the payload is the same human-readable line.
{
  const devDir = join(TMP, "dev");
  const lines = runChild({ TINA4_DEBUG: "true", TINA4_LOG_LEVEL: "INFO", TINA4_LOG_DIR: devDir });
  const raw = lines[0] ?? "";
  const stripped = raw.replace(/\x1b\[[0-9;]*m/g, "");
  assert("L1 dev: stdout line is TEXT", !isJsonLine(stripped), `line was: ${raw}`);
  assert("L1 dev: stdout line is coloured (ANSI present)", raw.includes("\x1b["), `line was: ${raw}`);
  // L2 corroboration: the child never called configure(), yet TINA4_LOG_DIR was
  // honoured — the dev default writes logs/tina4.log under the configured dir.
  assert(
    "L2 dev child honoured TINA4_LOG_DIR with no configure() call",
    existsSync(join(devDir, "tina4.log")),
    `expected ${join(devDir, "tina4.log")}`,
  );
}

// ── L2: the env is read lazily, on every call ───────────────────────────────
console.log("\n--- L2: env resolved on first use, no configure() required ---");

// This whole FILE never calls Log.configure(). Import the logger and log — the
// file must land where the env says, and a LATER env change must be picked up
// without any re-configuration. (Python and PHP only read TINA4_LOG_* inside
// configure(), which only the server calls; Node and Ruby resolve per call.)
const { Log } = await import("../packages/core/src/logger.ts");

{
  const dirA = join(TMP, "lazy-a");
  process.env.TINA4_LOG_OUTPUT = "file";
  process.env.TINA4_LOG_DIR = dirA;
  process.env.TINA4_LOG_LEVEL = "INFO";
  delete process.env.TINA4_LOG_FILE;
  delete process.env.TINA4_LOG_FORMAT;
  Log.info("lazy-first-use");
  assert(
    "L2 first log with no configure(): file written under TINA4_LOG_DIR",
    existsSync(join(dirA, "tina4.log")) &&
      readFileSync(join(dirA, "tina4.log"), "utf-8").includes("lazy-first-use"),
    `expected ${join(dirA, "tina4.log")}`,
  );

  // Change the env AFTER the first write — still no configure() — and the next
  // line must follow it.
  const dirB = join(TMP, "lazy-b");
  process.env.TINA4_LOG_DIR = dirB;
  Log.info("lazy-second-dir");
  assert(
    "L2 env change between calls is picked up with no configure()",
    existsSync(join(dirB, "tina4.log")) &&
      readFileSync(join(dirB, "tina4.log"), "utf-8").includes("lazy-second-dir"),
    `expected ${join(dirB, "tina4.log")}`,
  );
  assert(
    "L2 the first file did NOT receive the second line",
    !readFileSync(join(dirA, "tina4.log"), "utf-8").includes("lazy-second-dir"),
  );
}

// ── L3: TINA4_LOG_STRICT ────────────────────────────────────────────────────
console.log("\n--- L3: TINA4_LOG_STRICT raises on a log-write failure ---");

// A REAL unwritable target: a DIRECTORY sitting exactly where the log file
// should be. appendFileSync raises EISDIR — a genuine failure of the real write,
// not a simulated one, and it reproduces on any user (unlike a chmod, which root
// walks straight through).
const strictDir = join(TMP, "strict");
const blockedPath = join(strictDir, "blocked.log");
mkdirSync(blockedPath, { recursive: true });

process.env.TINA4_LOG_OUTPUT = "file";
process.env.TINA4_LOG_DIR = strictDir;
process.env.TINA4_LOG_FILE = blockedPath;
process.env.TINA4_LOG_LEVEL = "INFO";

// NEGATIVE half: default (strict off) still swallows. Logging must never crash
// an app that did not ask for it — deleting the swallow entirely is the obvious
// wrong "fix" and this is the gate against it.
{
  delete process.env.TINA4_LOG_STRICT;
  let threw = false;
  try {
    Log.info("write must fail silently");
  } catch {
    threw = true;
  }
  assert("L3 default (no TINA4_LOG_STRICT): a failed write is swallowed", !threw);
}

// Explicitly falsy is the same as unset.
{
  process.env.TINA4_LOG_STRICT = "false";
  let threw = false;
  try {
    Log.info("write must still fail silently");
  } catch {
    threw = true;
  }
  assert("L3 TINA4_LOG_STRICT=false: a failed write is still swallowed", !threw);
}

// POSITIVE half: truthy → the failure reaches the caller.
{
  process.env.TINA4_LOG_STRICT = "true";
  let caught: unknown = null;
  try {
    Log.info("write must raise");
  } catch (err) {
    caught = err;
  }
  assert("L3 TINA4_LOG_STRICT=true: a failed write RAISES", caught !== null);
  assert(
    "L3 the raised error is the real fs failure (EISDIR on the log path)",
    String((caught as NodeJS.ErrnoException | null)?.code ?? caught).includes("EISDIR"),
    `error was: ${String(caught)}`,
  );
}

// And strict must NOT turn a healthy write into a failure.
{
  const okDir = join(TMP, "strict-ok");
  process.env.TINA4_LOG_STRICT = "true";
  process.env.TINA4_LOG_DIR = okDir;
  process.env.TINA4_LOG_FILE = join(okDir, "ok.log");
  let threw = false;
  try {
    Log.info("strict but writable");
  } catch {
    threw = true;
  }
  assert(
    "L3 TINA4_LOG_STRICT=true with a writable target: no throw, line written",
    !threw &&
      existsSync(join(okDir, "ok.log")) &&
      readFileSync(join(okDir, "ok.log"), "utf-8").includes("strict but writable"),
  );
}

// ── L4: the canonical rotation names, and ONLY those ────────────────────────
console.log("\n--- L4: TINA4_LOG_ROTATE_* only — no legacy aliases ---");

// Owner rule: no alias methods / no alias env vars — rename the primary instead.
// TINA4_LOG_KEEP and TINA4_LOG_MAX_SIZE are documented as legacy aliases on all
// four env-var pages and are being deleted from Python and PHP. Node never read
// them; this pins that, so a future "parity" pass cannot quietly add them here.
{
  delete process.env.TINA4_LOG_STRICT;
  const rotDir = join(TMP, "rotate");
  process.env.TINA4_LOG_OUTPUT = "file";
  process.env.TINA4_LOG_DIR = rotDir;
  process.env.TINA4_LOG_FILE = join(rotDir, "rot.log");

  // POSITIVE: the canonical names drive rotation. 200 bytes is a couple of lines,
  // so 24 lines rotate several times; the default keep (5) leaves .1 .. .3 behind.
  process.env.TINA4_LOG_ROTATE_SIZE = "200";
  delete process.env.TINA4_LOG_ROTATE_KEEP;
  // NEGATIVE: the legacy alias names are set to values that WOULD be visible if
  // they were read — keep=1 would leave only rot.log.1, and a max-size read as
  // bytes would rotate on every single line.
  process.env.TINA4_LOG_KEEP = "1";
  process.env.TINA4_LOG_MAX_SIZE = "1";
  for (let i = 0; i < 24; i++) Log.info(`rotate-line-${i}`);

  assert(
    "L4 canonical TINA4_LOG_ROTATE_SIZE rotates the log file",
    existsSync(join(rotDir, "rot.log.1")),
    `expected ${join(rotDir, "rot.log.1")}`,
  );
  assert(
    "L4 legacy TINA4_LOG_KEEP is NOT read (default keep=5 retains .2 and .3)",
    existsSync(join(rotDir, "rot.log.2")) && existsSync(join(rotDir, "rot.log.3")),
    `dir held: ${existsSync(join(rotDir, "rot.log.2"))}/${existsSync(join(rotDir, "rot.log.3"))}`,
  );

  // And with NO canonical size at all, the default 10MB applies — the legacy
  // TINA4_LOG_MAX_SIZE alone must not cause any rotation.
  const aliasDir = join(TMP, "alias-only");
  delete process.env.TINA4_LOG_ROTATE_SIZE;
  process.env.TINA4_LOG_DIR = aliasDir;
  process.env.TINA4_LOG_FILE = join(aliasDir, "alias.log");
  for (let i = 0; i < 24; i++) Log.info(`alias-line-${i}`);
  assert(
    "L4 legacy TINA4_LOG_MAX_SIZE alone causes NO rotation (default 10MB stands)",
    !existsSync(join(aliasDir, "alias.log.1")),
    `unexpected ${join(aliasDir, "alias.log.1")}`,
  );
  delete process.env.TINA4_LOG_KEEP;
  delete process.env.TINA4_LOG_MAX_SIZE;
}

// Cleanup
delete process.env.TINA4_LOG_STRICT;
delete process.env.TINA4_LOG_OUTPUT;
delete process.env.TINA4_LOG_DIR;
delete process.env.TINA4_LOG_FILE;
delete process.env.TINA4_LOG_LEVEL;
try { rmSync(TMP, { recursive: true }); } catch { /* best effort */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

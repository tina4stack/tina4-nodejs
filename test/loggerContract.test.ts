/**
 * The SETTLED LOGGER CONTRACT (owner decision 2026-08-09/10) — regression
 * gates, superseding the 2026-08-01 pass this file used to pin.
 * Run with: npx tsx test/loggerContract.test.ts
 *
 * L1  FORMAT IS DEBUG-DERIVED (Decision 3, supersedes the 2026-08-01 "text
 *     always unless TINA4_LOG_FORMAT=json" rule): explicit TINA4_LOG_FORMAT
 *     wins; otherwise truthy TINA4_DEBUG selects text, and a falsy/absent
 *     TINA4_DEBUG selects JSON. An OBJECT passed as the message is still
 *     JSON-encoded INLINE inside a text line — that behaviour is unchanged
 *     and pinned here so a future "make it all text" does not flatten it to
 *     [object Object].
 *
 * L2  THE ENV IS RESOLVED ONCE, ON FIRST USE, THEN STABLE (LOG-C05/C06,
 *     BREAKING vs the pre-3.13.99 pass this file used to pin): a mid-process
 *     environment mutation is IGNORED until an explicit reset() — the
 *     opposite of the old "every log() call re-reads the environment"
 *     contract. This is what lets a snapshot be a coherent, defensive
 *     `Log.configuration()` copy (LOG-C10) instead of a value that could
 *     change out from under a caller between two reads.
 *
 * L3  TINA4_LOG_STRICT: a log-write failure RAISES the structured
 *     Tina4::LogWriteError-equivalent (Node: LogWriteError) instead of being
 *     swallowed, carrying sink/operation for diagnosis.
 *
 * NO MOCKS. The format cases run the REAL logger in a REAL child process and
 * read its REAL stdout bytes. The strict cases write to a REAL path on disk
 * that cannot accept a write — a directory sitting where the log file should
 * be — so the EISDIR is genuine, not simulated.
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
// an object. It never calls Log.configure() and never starts a server, so
// every setting it honours had to be resolved from the environment on first
// use (L2's "lazily, once" half).
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

console.log("=== Logger Contract Tests (L1 format, L2 stable snapshot, L3 strict) ===\n");

// ── L1: format is DEBUG-DERIVED ─────────────────────────────────────────────
console.log("--- L1: debug-derived format; TINA4_LOG_FORMAT is the explicit override ---");

// TINA4_DEBUG unset/falsy ("production") selects JSON by default.
{
  const lines = runChild({ TINA4_LOG_LEVEL: "INFO" });
  assert(
    "L1 default+no-TINA4_DEBUG: stdout line IS JSON",
    lines.length >= 1 && isJsonLine(lines[0]),
    `line was: ${lines[0]}`,
  );
  const entry = isJsonLine(lines[0] ?? "") ? JSON.parse(lines[0]) : {};
  assert(
    "L1 default+no-TINA4_DEBUG: JSON line carries level + message",
    entry.level === "INFO" && entry.message === "contract-string-message",
    `entry was: ${lines[0]}`,
  );
  // An OBJECT message is still JSON-encoded (compact, sorted keys) — never
  // "[object Object]" — whichever format wraps it.
  const objEntry = isJsonLine(lines[1] ?? "") ? JSON.parse(lines[1]) : {};
  assert(
    "L1 object message: JSON message field, never [object Object]",
    objEntry.message === '{"action":"login","user":42}',
    `line was: ${lines[1]}`,
  );
}

// TINA4_DEBUG truthy selects TEXT by default.
{
  const devDir = join(TMP, "dev");
  const lines = runChild({ TINA4_DEBUG: "true", TINA4_LOG_LEVEL: "INFO", TINA4_LOG_DIR: devDir });
  const raw = lines[0] ?? "";
  const stripped = raw.replace(/\x1b\[[0-9;]*m/g, "");
  assert("L1 dev (TINA4_DEBUG truthy): stdout line is TEXT", !isJsonLine(stripped), `line was: ${raw}`);
  // ANSI colour is gated on a REAL interactive TTY (LOG-F07), not merely on
  // TINA4_DEBUG — a piped child's stdout is never a TTY, so no colour here is
  // the CORRECT outcome, not a gap. The genuine TTY-gated colour proof lives
  // in test/loggerFixtureContract.test.ts (LOG-F07), which drives a real pty.
  assert("L1 dev: stdout line carries NO ANSI over a real pipe (not a TTY)", !raw.includes("\x1b["), `line was: ${raw}`);
  assert(
    "L1 dev: text line carries level + message",
    stripped.includes("[INFO") && stripped.includes("contract-string-message"),
    `line was: ${raw}`,
  );
  const objLine = (lines[1] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  assert(
    "L1 dev object message: JSON-encoded INLINE inside the text line",
    !isJsonLine(objLine) && objLine.includes('{"action":"login","user":42}'),
    `line was: ${objLine}`,
  );
}

// The explicit opt-in wins over the debug-derived default in BOTH directions.
{
  const lines = runChild({ TINA4_LOG_FORMAT: "json", TINA4_LOG_LEVEL: "INFO" });
  assert(
    "L1 TINA4_LOG_FORMAT=json (TINA4_DEBUG unset): stdout line IS JSON",
    lines.length >= 1 && isJsonLine(lines[0]),
    `line was: ${lines[0]}`,
  );
}
{
  const lines = runChild({
    TINA4_LOG_FORMAT: "text",
    TINA4_DEBUG: "true",
    TINA4_LOG_LEVEL: "INFO",
    TINA4_LOG_DIR: join(TMP, "explicit-text-dev"),
  });
  const stripped = (lines[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  assert(
    "L1 NEGATIVE: TINA4_LOG_FORMAT=text still text even with TINA4_DEBUG truthy",
    !isJsonLine(stripped),
    `line was: ${lines[0]}`,
  );
}
{
  const lines = runChild({
    TINA4_LOG_FORMAT: "json",
    TINA4_DEBUG: "true",
    TINA4_LOG_LEVEL: "INFO",
    TINA4_LOG_DIR: join(TMP, "devjson"),
  });
  const stripped = (lines[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  assert(
    "L1 NEGATIVE: TINA4_LOG_FORMAT=json wins even with TINA4_DEBUG truthy",
    isJsonLine(stripped),
    `line was: ${lines[0]}`,
  );
}

// The other three frameworks' notions of "production" must not sneak a
// format switch back in through a different env var name — only
// TINA4_LOG_FORMAT and TINA4_DEBUG participate in this decision.
{
  const lines = runChild({
    TINA4_ENV: "production",
    NODE_ENV: "production",
    RACK_ENV: "production",
    TINA4_LOG_LEVEL: "INFO",
  });
  assert(
    "L1 TINA4_ENV/NODE_ENV/RACK_ENV=production: format unaffected (still JSON, TINA4_DEBUG unset)",
    lines.length >= 1 && isJsonLine(lines[0]),
    `line was: ${lines[0]}`,
  );
}

// ── L2: the env is resolved ONCE, then STABLE (LOG-C05/C06) ────────────────
console.log("\n--- L2: env resolved on first use, then stable until reset() ---");

const { Log } = await import("../packages/core/src/logger.ts");

{
  const dirA = join(TMP, "lazy-a");
  process.env.TINA4_LOG_OUTPUT = "file";
  process.env.TINA4_LOG_DIR = dirA;
  process.env.TINA4_LOG_LEVEL = "INFO";
  delete process.env.TINA4_LOG_FILE;
  delete process.env.TINA4_LOG_FORMAT;
  Log.reset();
  Log.info("lazy-first-use");
  assert(
    "L2 first log with no configure(): file written under TINA4_LOG_DIR",
    existsSync(join(dirA, "tina4.log")) &&
      readFileSync(join(dirA, "tina4.log"), "utf-8").includes("lazy-first-use"),
    `expected ${join(dirA, "tina4.log")}`,
  );

  // Change the env AFTER the first write, WITHOUT reset() — the snapshot
  // resolved on first use is now STABLE (LOG-C05): the change must be
  // IGNORED, and the next line must still land in dirA.
  const dirB = join(TMP, "lazy-b");
  process.env.TINA4_LOG_DIR = dirB;
  Log.info("lazy-second-line-ignored-dir-change");
  assert(
    "L2 NEGATIVE (LOG-C05): an env change after first use is ignored without reset()",
    !existsSync(join(dirB, "tina4.log")) &&
      readFileSync(join(dirA, "tina4.log"), "utf-8").includes("lazy-second-line-ignored-dir-change"),
    `dirB should not exist yet; dirA should carry the second line too`,
  );

  // reset() reloads the environment (LOG-C06) — the pending TINA4_LOG_DIR=
  // dirB change now takes effect.
  Log.reset();
  Log.info("lazy-third-after-reset");
  assert(
    "L2 (LOG-C06): reset() reloads the environment — dirB now takes effect",
    existsSync(join(dirB, "tina4.log")) &&
      readFileSync(join(dirB, "tina4.log"), "utf-8").includes("lazy-third-after-reset"),
    `expected ${join(dirB, "tina4.log")}`,
  );
}

// ── L3: TINA4_LOG_STRICT ────────────────────────────────────────────────────
console.log("\n--- L3: TINA4_LOG_STRICT raises Tina4's structured LogWriteError ---");

const { LogWriteError } = await import("../packages/core/src/logger.ts");

// configure() itself proves the sink opens (LOG-E01) — a target that is
// ALREADY unwritable fails at CONFIGURE time with LogConfigurationError, not
// at write time, so it can never exercise TINA4_LOG_STRICT (which governs
// WRITE failures only). Each variant below therefore: configures against a
// GENUINELY writable path (proving the open succeeds), THEN swaps that exact
// path for a directory — a REAL unwritable target, appendFileSync raises
// EISDIR — so the NEXT write is what fails, which is the case strict governs.
function sabotage(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* fresh */ }
  mkdirSync(path, { recursive: true });
}

// NEGATIVE half: default (strict off) still swallows. Logging must never crash
// an app that did not ask for it — deleting the swallow entirely is the obvious
// wrong "fix" and this is the gate against it.
{
  const dir = join(TMP, "strict-off");
  const target = join(dir, "target.log");
  delete process.env.TINA4_LOG_STRICT;
  process.env.TINA4_LOG_OUTPUT = "file";
  process.env.TINA4_LOG_DIR = dir;
  process.env.TINA4_LOG_FILE = target;
  process.env.TINA4_LOG_LEVEL = "INFO";
  Log.reset();
  Log.info("first line, sink opens fine"); // proves open succeeded
  sabotage(target);
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
  const dir = join(TMP, "strict-false");
  const target = join(dir, "target.log");
  process.env.TINA4_LOG_STRICT = "false";
  process.env.TINA4_LOG_DIR = dir;
  process.env.TINA4_LOG_FILE = target;
  Log.reset();
  Log.info("first line, sink opens fine");
  sabotage(target);
  let threw = false;
  try {
    Log.info("write must still fail silently");
  } catch {
    threw = true;
  }
  assert("L3 TINA4_LOG_STRICT=false: a failed write is still swallowed", !threw);
}

// POSITIVE half: truthy → the structured LogWriteError reaches the caller.
{
  const dir = join(TMP, "strict-true");
  const target = join(dir, "target.log");
  process.env.TINA4_LOG_STRICT = "true";
  process.env.TINA4_LOG_DIR = dir;
  process.env.TINA4_LOG_FILE = target;
  Log.reset();
  Log.info("first line, sink opens fine");
  sabotage(target);
  let caught: unknown = null;
  try {
    Log.info("write must raise");
  } catch (err) {
    caught = err;
  }
  assert("L3 TINA4_LOG_STRICT=true: a failed write RAISES", caught !== null);
  assert(
    "L3 the raised error IS the structured LogWriteError",
    caught instanceof LogWriteError,
    `error was: ${String(caught)}`,
  );
  assert(
    "L3 LogWriteError carries the real cause (EISDIR on the log path)",
    String((caught as Error).message).includes("EISDIR"),
    `error was: ${String(caught)}`,
  );
  assert(
    "L3 LogWriteError names the operation as write",
    (caught as InstanceType<typeof LogWriteError>).operation === "write",
    `operation was: ${(caught as InstanceType<typeof LogWriteError>)?.operation}`,
  );
}

// And strict must NOT turn a healthy write into a failure.
{
  const okDir = join(TMP, "strict-ok");
  process.env.TINA4_LOG_STRICT = "true";
  process.env.TINA4_LOG_DIR = okDir;
  process.env.TINA4_LOG_FILE = join(okDir, "ok.log");
  Log.reset();
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
console.log("\n--- L4: TINA4_LOG_ROTATE_* only — removed settings now hard-fail ---");

// Owner rule: no alias methods / no alias env vars — rename the primary
// instead. BREAKING (Decision 19 / LOG-V04, supersedes the pre-3.13.99 "the
// legacy names are silently not read" pass this file used to pin):
// TINA4_LOG_KEEP and TINA4_LOG_MAX_SIZE are REMOVED settings — their mere
// PRESENCE now hard-fails configure() naming the removed setting, rather
// than being tolerated as an inert no-op. TINA4_LOG_ROTATE_SIZE now has a
// real 1024-byte minimum (LOG-V02) so every positive value here is >= 1024.
{
  delete process.env.TINA4_LOG_STRICT;
  delete process.env.TINA4_LOG_KEEP;
  delete process.env.TINA4_LOG_MAX_SIZE;
  const rotDir = join(TMP, "rotate");
  process.env.TINA4_LOG_OUTPUT = "file";
  process.env.TINA4_LOG_DIR = rotDir;
  process.env.TINA4_LOG_FILE = join(rotDir, "rot.log");
  process.env.TINA4_LOG_ROTATE_SIZE = "1024";
  delete process.env.TINA4_LOG_ROTATE_KEEP;
  Log.reset();
  for (let i = 0; i < 60; i++) Log.info(`rotate-line-${i}-padding-padding-padding-padding`);

  assert(
    "L4 canonical TINA4_LOG_ROTATE_SIZE rotates the log file",
    existsSync(join(rotDir, "rot.log.1")),
    `expected ${join(rotDir, "rot.log.1")}`,
  );
  assert(
    "L4 default TINA4_LOG_ROTATE_KEEP=5 retains .2 and .3",
    existsSync(join(rotDir, "rot.log.2")) && existsSync(join(rotDir, "rot.log.3")),
    `dir held: ${existsSync(join(rotDir, "rot.log.2"))}/${existsSync(join(rotDir, "rot.log.3"))}`,
  );

  // NEGATIVE (LOG-V04): the removed legacy names now hard-fail configuration.
  const { LogConfigurationError } = await import("../packages/core/src/logger.ts");
  for (const legacy of ["TINA4_LOG_KEEP", "TINA4_LOG_MAX_SIZE"]) {
    const aliasDir = join(TMP, `removed-${legacy}`);
    process.env.TINA4_LOG_DIR = aliasDir;
    process.env.TINA4_LOG_FILE = join(aliasDir, "removed.log");
    process.env[legacy] = "1";
    Log.reset();
    let caught: unknown = null;
    try {
      Log.info("must not log — configuration must fail first");
    } catch (err) {
      caught = err;
    }
    assert(
      `L4 removed setting ${legacy} hard-fails configuration`,
      caught instanceof LogConfigurationError && String((caught as Error).message).includes(legacy),
      `error was: ${String(caught)}`,
    );
    assert(
      `L4 removed setting ${legacy}: no file written (fails before any sink mutation)`,
      !existsSync(join(aliasDir, "removed.log")),
      `unexpected ${join(aliasDir, "removed.log")}`,
    );
    delete process.env[legacy];
  }
  Log.reset();
}

// ── L5: explicit argument > environment > default (ADR-0041) ────────────────
//
// The coordinate under test IS "which value wins", so the child must not ask
// the logger which directory it chose -- that delegates the asserted property
// to the code under test. It controls both candidates and reports the
// FILESYSTEM, plus what process.env still holds afterwards.
console.log("\n--- L5: explicit argument beats the env, without mutating it (ADR-0041) ---");

const PREC_CHILD = join(TMP, "precedenceChild.ts");
writeFileSync(
  PREC_CHILD,
  [
    `import { Log } from ${JSON.stringify(LOGGER_MODULE)};`,
    `import { existsSync } from "node:fs";`,
    `const envDir = process.env.PROBE_ENV_DIR!;`,
    `const argDir = process.env.PROBE_ARG_DIR!;`,
    `if (process.env.PROBE_PASS_ARG === "1") Log.configure({ logDir: argDir });`,
    `else Log.configure();`,
    `Log.info("which directory won?");`,
    `console.log(JSON.stringify({`,
    `  inEnvDir: existsSync(envDir + "/tina4.log"),`,
    `  inArgDir: existsSync(argDir + "/tina4.log"),`,
    `  envAfter: process.env.TINA4_LOG_DIR ?? null,`,
    `}));`,
    "",
  ].join("\n"),
  "utf-8",
);

function runPrecedenceChild(passArg: boolean): { inEnvDir: boolean; inArgDir: boolean; envAfter: string | null } {
  const dir = mkdtempSync(join(TMP, "prec-"));
  const envDir = join(dir, "from_env");
  const argDir = join(dir, "from_argument");
  mkdirSync(envDir);
  mkdirSync(argDir);
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("TINA4_LOG_") || k === "TINA4_DEBUG" || k === "TINA4_ENV") continue;
    if (v !== undefined) childEnv[k] = v;
  }
  childEnv.TINA4_LOG_OUTPUT = "file";
  childEnv.TINA4_LOG_DIR = envDir;
  childEnv.PROBE_ENV_DIR = envDir;
  childEnv.PROBE_ARG_DIR = argDir;
  childEnv.PROBE_PASS_ARG = passArg ? "1" : "0";
  const out = execFileSync("npx", ["tsx", PREC_CHILD], {
    cwd: ROOT, encoding: "utf-8", env: childEnv, timeout: 40_000,
  });
  const line = out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop()!;
  return JSON.parse(line);
}

const withArg = runPrecedenceChild(true);
assert(
  "L5 an explicit configure() directory beats a conflicting TINA4_LOG_DIR",
  withArg.inArgDir && !withArg.inEnvDir,
  `inArgDir=${withArg.inArgDir} inEnvDir=${withArg.inEnvDir} — the environment beat the explicit argument`,
);
assert(
  "L5 configure() does NOT overwrite process.env.TINA4_LOG_DIR",
  withArg.envAfter !== null && withArg.envAfter.endsWith("from_env"),
  `TINA4_LOG_DIR reads ${JSON.stringify(withArg.envAfter)} after configure() — the operator's value was destroyed, and every child process spawned afterwards inherits the argument instead`,
);

// NEGATIVE half: without it, an implementation that ignored TINA4_LOG_DIR
// ENTIRELY would satisfy both assertions above.
const noArg = runPrecedenceChild(false);
assert(
  "L5 NEGATIVE: TINA4_LOG_DIR still applies when configure() is given no argument",
  noArg.inEnvDir && !noArg.inArgDir,
  `inEnvDir=${noArg.inEnvDir} inArgDir=${noArg.inArgDir} — TINA4_LOG_DIR was ignored with no explicit argument to outrank it`,
);

delete process.env.TINA4_LOG_STRICT;
delete process.env.TINA4_LOG_OUTPUT;
delete process.env.TINA4_LOG_DIR;
delete process.env.TINA4_LOG_FILE;
delete process.env.TINA4_LOG_LEVEL;
Log.reset();
try { rmSync(TMP, { recursive: true }); } catch { /* best effort */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

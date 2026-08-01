/**
 * Unit tests for the structured logger.
 * Run with: npx tsx test/logger.test.ts
 */
import { Log } from "../packages/core/src/index.ts";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_LOG_DIR = "/tmp/tina4-logger-test/logs";
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
 * Parse a human-readable log line into structured parts.
 * Format: {timestamp} [{LEVEL  }] [{requestId}] {message} {jsonData}
 */
function parseLogLine(line: string): {
  timestamp: string;
  level: string;
  requestId?: string;
  message: string;
  data?: unknown;
} {
  // Match: timestamp [LEVEL  ] [optional-req-id] message optional-json
  const match = line.match(
    /^(\S+)\s+\[(\w+)\s*\](?:\s+\[([^\]]+)\])?\s+(.+)$/
  );
  if (!match) throw new Error(`Cannot parse log line: ${line}`);
  const [, timestamp, level, requestId, rest] = match;

  // Try to split message from trailing JSON data
  let message = rest;
  let data: unknown = undefined;

  // Check if the line ends with a JSON object/array
  const jsonStart = rest.lastIndexOf(" {");
  if (jsonStart !== -1) {
    try {
      data = JSON.parse(rest.slice(jsonStart + 1));
      message = rest.slice(0, jsonStart);
    } catch {
      // Not JSON, entire rest is the message
    }
  }

  return { timestamp, level: level.trim(), requestId, message, data };
}

// Clean slate
try { rmSync("/tmp/tina4-logger-test", { recursive: true }); } catch {}

console.log("=== Logger Tests ===\n");

// Configure logger to use test directory
Log.configure({ logDir: TEST_LOG_DIR, logFile: "test.log" });

// --- Basic logging ---
console.log("--- Development Mode Logging ---");

// Ensure we're genuinely in DEV mode: isProduction() is !TINA4_DEBUG, so
// dev requires TINA4_DEBUG truthy. Dev → human-readable text in the file
// (parseLogLine parses the text format); production would write JSON.
delete process.env.TINA4_ENV;
delete process.env.NODE_ENV;
process.env.TINA4_DEBUG = "true";

Log.info("Test info message");
Log.debug("Test debug message");
Log.warning("Test warning message");
Log.error("Test error message");

const logPath = join(TEST_LOG_DIR, "test.log");
assert("Log file created", existsSync(logPath));

const logContent = readFileSync(logPath, "utf-8");
const lines = logContent.trim().split("\n");
assert("Four log entries written", lines.length === 4);

const firstEntry = parseLogLine(lines[0]);
assert("Log entry has timestamp", typeof firstEntry.timestamp === "string");
assert("Log entry has level INFO", firstEntry.level === "INFO");
assert("Log entry has message", firstEntry.message === "Test info message");

const debugEntry = parseLogLine(lines[1]);
assert("Debug entry level is DEBUG", debugEntry.level === "DEBUG");

const warnEntry = parseLogLine(lines[2]);
assert("Warning entry level is WARNING", warnEntry.level === "WARNING");

const errorEntry = parseLogLine(lines[3]);
assert("Error entry level is ERROR", errorEntry.level === "ERROR");

// --- Request ID ---
console.log("\n--- Request ID ---");

Log.setRequestId("req-abc-123");
Log.info("Request with ID");

const logContent2 = readFileSync(logPath, "utf-8");
const lastLine = logContent2.trim().split("\n").pop()!;
const lastEntry = parseLogLine(lastLine);
assert("Request ID included in log", lastEntry.requestId === "req-abc-123");
assert("getRequestId returns current ID", Log.getRequestId() === "req-abc-123");

Log.setRequestId(undefined);
Log.info("No request ID");

const logContent3 = readFileSync(logPath, "utf-8");
const lastLine2 = logContent3.trim().split("\n").pop()!;
const lastEntry2 = parseLogLine(lastLine2);
assert("No requestId when cleared", lastEntry2.requestId === undefined);

// --- Data parameter ---
console.log("\n--- Data Parameter ---");

Log.info("With data", { userId: 42, action: "login" });
const logContent4 = readFileSync(logPath, "utf-8");
const dataLine = logContent4.trim().split("\n").pop()!;
assert("Data included in log line", dataLine.includes('"userId":42'));
assert("Data preserves all fields", dataLine.includes('"action":"login"'));

// --- Production mode ---
console.log("\n--- Production Mode ---");

// Switch to production log file
Log.configure({ logDir: TEST_LOG_DIR, logFile: "prod.log" });

// Save and clear TINA4_DEBUG so isProduction() returns true
const savedDebug = process.env.TINA4_DEBUG;
delete process.env.TINA4_DEBUG;

// v3.13.14: production MUST write to stdout — containers read PID 1 stdout
// (docker logs / k8s). Capture stdout and verify the line is present AND has no
// ANSI colour codes, so a log shipper gets clean bytes.
const originalLog = console.log;
let consoleOutput = "";
console.log = (...args: unknown[]) => {
  consoleOutput += args.join(" ");
};

Log.info("Production log message");

console.log = originalLog;

assert("Production writes to stdout (docker logs)", consoleOutput.includes("Production log message"));
assert("Production stdout has no ANSI colour codes", !consoleOutput.includes("\x1b["));
{
  // SETTLED CONTRACT (2026-08-01): format is TEXT by default and
  // TINA4_LOG_FORMAT is the ONLY thing that selects JSON. An unset TINA4_DEBUG
  // used to silently reformat every line — the same .env produced four
  // different formats across the four frameworks. These two assertions are the
  // deliberate INVERSE of the pre-3.13.95 pair: they are the regression gate on
  // the DELETED switch, not a relaxation of it. TINA4_DEBUG now decides colour
  // only (asserted directly above).
  let prodStdoutIsJson = true;
  try { JSON.parse(consoleOutput.trim()); } catch { prodStdoutIsJson = false; }
  assert(
    "Production stdout is TEXT by default (implicit prod→JSON deleted)",
    !prodStdoutIsJson,
    `line was: ${consoleOutput}`,
  );
  assert(
    "Production stdout text line carries level + message",
    consoleOutput.includes("INFO") && consoleOutput.includes("Production log message"),
    `line was: ${consoleOutput}`,
  );
}

const prodLogPath = join(TEST_LOG_DIR, "prod.log");
assert("Production log file created", existsSync(prodLogPath));

const prodContent = readFileSync(prodLogPath, "utf-8");
// The FILE follows the SAME single format rule — one decision, both sinks.
const prodLine = prodContent.trim().split("\n").pop()!;
let prodFileIsJson = true;
try { JSON.parse(prodLine); } catch { prodFileIsJson = false; }
assert("Production log FILE is TEXT by default too", !prodFileIsJson, `line was: ${prodLine}`);
const prodEntry = parseLogLine(prodLine);
assert("Production log has level INFO", prodEntry.level === "INFO");

// The explicit opt-in still works in production — that is the ONE switch.
{
  process.env.TINA4_LOG_FORMAT = "json";
  let jsonStdout = "";
  const restore = console.log;
  console.log = (...args: unknown[]) => { jsonStdout += args.join(" "); };
  Log.info("Production explicit json");
  console.log = restore;

  let stdoutEntry: any = null;
  try { stdoutEntry = JSON.parse(jsonStdout.trim()); } catch { /* leave null */ }
  assert(
    "TINA4_LOG_FORMAT=json in production: stdout IS JSON with level INFO",
    stdoutEntry?.level === "INFO" && stdoutEntry?.message === "Production explicit json",
    `line was: ${jsonStdout}`,
  );

  const jsonFileLine = readFileSync(prodLogPath, "utf-8").trim().split("\n").pop()!;
  let fileEntry: any = null;
  try { fileEntry = JSON.parse(jsonFileLine); } catch { /* leave null */ }
  assert(
    "TINA4_LOG_FORMAT=json in production: FILE line IS JSON",
    fileEntry?.message === "Production explicit json",
    `line was: ${jsonFileLine}`,
  );
  delete process.env.TINA4_LOG_FORMAT;
}

// Restore
if (savedDebug !== undefined) {
  process.env.TINA4_DEBUG = savedDebug;
} else {
  delete process.env.TINA4_DEBUG;
}
delete process.env.TINA4_ENV;

// --- Caller-name injection (TINA4_LOG_FUNC) ---
console.log("\n--- TINA4_LOG_FUNC (caller-name injection) ---");

// Use a separate file so we can assert byte-level on the most recent line.
Log.configure({ logDir: TEST_LOG_DIR, logFile: "func.log" });
const funcLogPath = join(TEST_LOG_DIR, "func.log");

// Ensure we're in dev mode so the file path is exercised (writeToFile fires regardless).
process.env.TINA4_DEBUG = "true";

// Default: TINA4_LOG_FUNC unset → no caller-name segment in the line.
delete process.env.TINA4_LOG_FUNC;
function unrelatedHelper() {
  Log.info("default-no-func");
}
unrelatedHelper();

const noFuncContent = readFileSync(funcLogPath, "utf-8");
const noFuncLine = noFuncContent.trim().split("\n").pop()!;
assert("default: no [unrelatedHelper] segment in log line", !noFuncLine.includes("[unrelatedHelper]"));

// Enable TINA4_LOG_FUNC — text mode injects [callerName] segment.
process.env.TINA4_LOG_FUNC = "true";
function myUserFunction() {
  Log.info("with-func-enabled");
}
myUserFunction();

const withFuncContent = readFileSync(funcLogPath, "utf-8");
const withFuncLine = withFuncContent.trim().split("\n").pop()!;
assert(
  "TINA4_LOG_FUNC=true injects [myUserFunction] segment",
  withFuncLine.includes("[myUserFunction]"),
  `line was: ${withFuncLine}`,
);

// JSON mode adds a `function` field.
process.env.TINA4_LOG_FORMAT = "json";
function jsonModeCaller() {
  Log.info("with-func-json");
}
jsonModeCaller();

const jsonContent = readFileSync(funcLogPath, "utf-8");
const jsonLine = jsonContent.trim().split("\n").pop()!;
let parsedJson: any = null;
try { parsedJson = JSON.parse(jsonLine); } catch { /* leave null */ }
assert("JSON mode produces valid JSON line", parsedJson !== null);
assert(
  "JSON mode includes function: 'jsonModeCaller'",
  parsedJson?.function === "jsonModeCaller",
  `function field was: ${parsedJson?.function}`,
);

delete process.env.TINA4_LOG_FORMAT;

// Anonymous frames — calls from a top-level callback should not bleed
// internal/anonymous names through. We verify the field is either absent or
// a real identifier (never "anonymous" / "<anonymous>").
(function () {
  Log.info("inside-iife");
})();
const anonContent = readFileSync(funcLogPath, "utf-8");
const anonLine = anonContent.trim().split("\n").pop()!;
assert(
  "anonymous IIFE frames filtered out (no '[anonymous]' / '[<anonymous>]')",
  !anonLine.includes("[anonymous]") && !anonLine.includes("[<anonymous>]"),
  `line was: ${anonLine}`,
);

// Cleanup TINA4_LOG_FUNC + debug
delete process.env.TINA4_LOG_FUNC;
delete process.env.TINA4_DEBUG;

// --- CRITICAL is first-class and ALWAYS logs (toggle retired) ---
console.log("\n--- Log.critical (first-class, always logs) ---");

// Dedicated file so we can assert on exactly the critical line(s).
Log.configure({ logDir: TEST_LOG_DIR, logFile: "critical.log" });
const critLogPath = join(TEST_LOG_DIR, "critical.log");
process.env.TINA4_DEBUG = "true"; // dev → human-readable text line (parseable)

// (1) With the toggle env var ABSENT, critical() must still emit — never a no-op.
delete process.env.TINA4_LOG_CRITICAL;
Log.critical("Critical without toggle");
{
  const critContent = readFileSync(critLogPath, "utf-8");
  const critLine = critContent.trim().split("\n").pop()!;
  const critEntry = parseLogLine(critLine);
  assert("critical(): emits a line with no TINA4_LOG_CRITICAL set", critEntry.message === "Critical without toggle");
  assert("critical(): level is CRITICAL", critEntry.level === "CRITICAL");
}

// (2) The retired env var must NOT suppress critical, even set to a falsy value.
process.env.TINA4_LOG_CRITICAL = "false";
Log.critical("Critical with retired toggle false");
{
  const critContent = readFileSync(critLogPath, "utf-8");
  const critLine = critContent.trim().split("\n").pop()!;
  const critEntry = parseLogLine(critLine);
  assert("critical(): still emits when retired TINA4_LOG_CRITICAL=false", critEntry.message === "Critical with retired toggle false");
}
delete process.env.TINA4_LOG_CRITICAL;

// (3) critical() renders magenta (\x1b[35m) on the dev console.
{
  const originalLog = console.log;
  let captured = "";
  console.log = (...args: unknown[]) => { captured += args.join(" "); };
  Log.critical("Magenta critical");
  console.log = originalLog;
  assert("critical(): console line is magenta (\\x1b[35m)", captured.includes("\x1b[35m"));
  assert("critical(): console line carries the message", captured.includes("Magenta critical"));
}

// (4) CRITICAL outranks ERROR — a CRITICAL threshold suppresses error but NOT critical.
process.env.TINA4_LOG_LEVEL = "CRITICAL";
{
  const before = readFileSync(critLogPath, "utf-8").trim().split("\n").length;
  Log.error("error at CRITICAL threshold (suppressed from console, still teed to file)");
  Log.critical("critical at CRITICAL threshold (always emits)");
  const after = readFileSync(critLogPath, "utf-8").trim().split("\n");
  const lastEntry = parseLogLine(after[after.length - 1]);
  assert("critical(): emits even when threshold is CRITICAL", lastEntry.level === "CRITICAL" && lastEntry.message.startsWith("critical at CRITICAL threshold"));
  // File always tees every level (legacy behaviour) — both lines persisted.
  assert("critical(): file teed error + critical regardless of threshold", after.length === before + 2);
}
delete process.env.TINA4_LOG_LEVEL;
delete process.env.TINA4_DEBUG;

// Restore the test log file for the remaining assertions.
Log.configure({ logDir: TEST_LOG_DIR, logFile: "test.log" });

// --- isEnabled — console-threshold predicate (parity with Python Log.is_enabled) ---
console.log("\n--- Log.isEnabled (console-threshold predicate) ---");

// Snapshot env we mutate so this block can't leak into later assertions.
const savedLevel = process.env.TINA4_LOG_LEVEL;
const savedCritical = process.env.TINA4_LOG_CRITICAL;

// Standard severity order — the same set the logger compares (debug < info < warning < error).
const STANDARD_LEVELS = ["debug", "info", "warning", "error"] as const;

// LEVEL_PRIORITY is not exported; re-derive the same threshold check the
// logger uses so the "equals the internal check" assertion below is meaningful
// (LEVEL_PRIORITY keys are uppercased; minLevel defaults to INFO=1).
const PRIORITY: Record<string, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };
function internalShouldLog(level: string, minLevel: number): boolean {
  return (PRIORITY[level.toUpperCase()] ?? 0) >= minLevel;
}

// Threshold at INFO: debug suppressed, info/warning/error visible.
process.env.TINA4_LOG_LEVEL = "INFO";
assert("isEnabled at info: debug is False", Log.isEnabled("debug") === false);
assert("isEnabled at info: info is True", Log.isEnabled("info") === true);
assert("isEnabled at info: warning is True", Log.isEnabled("warning") === true);
assert("isEnabled at info: error is True", Log.isEnabled("error") === true);

// Threshold at ERROR: info/warning suppressed, error visible.
process.env.TINA4_LOG_LEVEL = "ERROR";
assert("isEnabled at error: info is False", Log.isEnabled("info") === false);
assert("isEnabled at error: warning is False", Log.isEnabled("warning") === false);
assert("isEnabled at error: error is True", Log.isEnabled("error") === true);

// Case-insensitive: at INFO, "INFO" passes, "Debug" does not.
process.env.TINA4_LOG_LEVEL = "INFO";
assert('isEnabled case-insensitive: "INFO" is True', Log.isEnabled("INFO") === true);
assert('isEnabled case-insensitive: "Debug" is False', Log.isEnabled("Debug") === false);
assert('isEnabled case-insensitive: "WaRnInG" is True', Log.isEnabled("WaRnInG") === true);

// Contract lock-in: isEnabled(level) === the internal threshold check for every
// standard level at multiple thresholds — it must never disagree with what print does.
let contractHolds = true;
for (const minLevelName of ["DEBUG", "INFO", "WARNING", "ERROR"] as const) {
  process.env.TINA4_LOG_LEVEL = minLevelName;
  const minLevel = PRIORITY[minLevelName];
  for (const lvl of STANDARD_LEVELS) {
    if (Log.isEnabled(lvl) !== internalShouldLog(lvl, minLevel)) {
      contractHolds = false;
      console.log(`    mismatch at minLevel=${minLevelName} level=${lvl}: isEnabled=${Log.isEnabled(lvl)} internal=${internalShouldLog(lvl, minLevel)}`);
    }
  }
}
assert("isEnabled(level) === internal threshold check for all standard levels", contractHolds);

// CRITICAL is the highest severity (priority 4 > error 3) and a FIRST-CLASS level.
// There is no TINA4_LOG_CRITICAL toggle — isEnabled("critical") is ordinary
// threshold logic (critical 4 >= configured min), exactly like every other level.
process.env.TINA4_LOG_LEVEL = "INFO";

// With the toggle env var RETIRED, its presence/absence must NOT change the result.
delete process.env.TINA4_LOG_CRITICAL;
assert("isEnabled critical: True at INFO (no toggle needed)", Log.isEnabled("critical") === true);

process.env.TINA4_LOG_CRITICAL = "false";
assert("isEnabled critical: still True even with retired TINA4_LOG_CRITICAL=false", Log.isEnabled("critical") === true);
delete process.env.TINA4_LOG_CRITICAL;

assert('isEnabled critical: case-insensitive "CRITICAL" is True', Log.isEnabled("CRITICAL") === true);

// CRITICAL outranks ERROR — wherever error is enabled, critical is too.
process.env.TINA4_LOG_LEVEL = "ERROR";
assert("isEnabled critical: True at ERROR threshold (outranks error)", Log.isEnabled("critical") === true);
assert("isEnabled critical: tracks error at ERROR threshold", Log.isEnabled("critical") === Log.isEnabled("error"));

// CRITICAL is priority 4, so it passes the threshold at every standard level —
// there is no level above it. Lock that in across all thresholds.
let criticalAlwaysPasses = true;
for (const minLevelName of ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const) {
  process.env.TINA4_LOG_LEVEL = minLevelName;
  if (Log.isEnabled("critical") !== internalShouldLog("critical", PRIORITY[minLevelName])) {
    criticalAlwaysPasses = false;
  }
}
assert("isEnabled critical: ordinary threshold logic at every level (4 >= min)", criticalAlwaysPasses);

// Restore env we mutated.
if (savedLevel !== undefined) process.env.TINA4_LOG_LEVEL = savedLevel;
else delete process.env.TINA4_LOG_LEVEL;
if (savedCritical !== undefined) process.env.TINA4_LOG_CRITICAL = savedCritical;
else delete process.env.TINA4_LOG_CRITICAL;

// --- Default file output: dev writes a file, prod is stdout-only (v3.13.39) ---
// Mirrors Python master (4c6d881) TestLogDefaultFileOutput. When
// TINA4_LOG_OUTPUT is unset (default), the log FILE is written ONLY in dev
// (TINA4_DEBUG truthy). In production / containers the logger is stdout-only —
// no file to bloat the writable layer / disk. Explicit TINA4_LOG_OUTPUT
// (file/both) OR an explicit TINA4_LOG_FILE path always forces a file.
//
// IMPORTANT: these cases must NOT route through Log.configure({ logFile }) —
// configure() SETS process.env.TINA4_LOG_FILE, which is itself an explicit
// file override that would mask the dev/prod default. They set TINA4_LOG_DIR
// directly and assert against logs/tina4.log under a fresh dir each time.
console.log("\n--- Default file output (dev=file, prod=stdout-only) ---");

const DEFAULT_OUT_DIR = "/tmp/tina4-logger-test/default-output";

// Snapshot every env knob the default-output logic reads so this block can't
// leak into anything that runs after it (logger.test runs as its own child
// process, but be a good citizen).
const savedDefaultEnv = {
  output: process.env.TINA4_LOG_OUTPUT,
  file: process.env.TINA4_LOG_FILE,
  dir: process.env.TINA4_LOG_DIR,
  debug: process.env.TINA4_DEBUG,
  level: process.env.TINA4_LOG_LEVEL,
  format: process.env.TINA4_LOG_FORMAT,
};

function resetDefaultOutputEnv(subdir: string): string {
  delete process.env.TINA4_LOG_OUTPUT;
  delete process.env.TINA4_LOG_FILE; // critical: no explicit file → exercise the default
  delete process.env.TINA4_LOG_FORMAT;
  process.env.TINA4_LOG_LEVEL = "INFO";
  const dir = join(DEFAULT_OUT_DIR, subdir);
  try { rmSync(dir, { recursive: true }); } catch {}
  process.env.TINA4_LOG_DIR = dir;
  return join(dir, "tina4.log");
}

// (a) Production (TINA4_DEBUG unset/falsy), default output → NO file written —
//     neither the main tina4.log nor (for an error) an error.log. stdout only.
{
  const mainPath = resetDefaultOutputEnv("prod-no-file");
  delete process.env.TINA4_DEBUG;
  const dir = process.env.TINA4_LOG_DIR!;
  // Capture stdout so the prod log line doesn't pollute test output.
  const origLog = console.log;
  console.log = () => {};
  Log.error("prod default — no file");
  console.log = origLog;
  assert(
    "default+prod: main tina4.log NOT written",
    !existsSync(mainPath),
    `unexpected file at ${mainPath}`,
  );
  // Node tees every level into one tina4.log (no split error.log), but assert
  // the dir holds no log file at all — true stdout-only.
  const wroteAnything = existsSync(dir) && existsSync(join(dir, "error.log"));
  assert(
    "default+prod: no error.log written either",
    !wroteAnything,
    `unexpected error.log under ${dir}`,
  );
}

// (b) Development (TINA4_DEBUG truthy), default output → file IS written.
{
  const mainPath = resetDefaultOutputEnv("dev-file");
  process.env.TINA4_DEBUG = "true";
  Log.info("dev default — file written");
  assert("default+dev: tina4.log IS written", existsSync(mainPath), `expected file at ${mainPath}`);
  if (existsSync(mainPath)) {
    assert(
      "default+dev: file carries the message",
      readFileSync(mainPath, "utf-8").includes("dev default — file written"),
    );
  }
  delete process.env.TINA4_DEBUG;
}

// (c) Explicit TINA4_LOG_OUTPUT=both with TINA4_DEBUG off → file STILL written
//     (explicit output always wins, regardless of dev/prod).
{
  const mainPath = resetDefaultOutputEnv("explicit-both");
  process.env.TINA4_LOG_OUTPUT = "both";
  delete process.env.TINA4_DEBUG;
  // Suppress the stdout half of "both" so it doesn't pollute test output.
  const origLog = console.log;
  console.log = () => {};
  Log.info("explicit both — file even in prod");
  console.log = origLog;
  assert(
    "explicit output=both + prod: tina4.log STILL written (explicit wins)",
    existsSync(mainPath),
    `expected file at ${mainPath}`,
  );
  if (existsSync(mainPath)) {
    assert(
      "explicit output=both: file carries the message",
      readFileSync(mainPath, "utf-8").includes("explicit both — file even in prod"),
    );
  }
  delete process.env.TINA4_LOG_OUTPUT;
}

// (c2) Explicit TINA4_LOG_FILE path with TINA4_DEBUG off → file STILL written.
{
  const dir = join(DEFAULT_OUT_DIR, "explicit-file");
  try { rmSync(dir, { recursive: true }); } catch {}
  delete process.env.TINA4_LOG_OUTPUT;
  delete process.env.TINA4_DEBUG;
  process.env.TINA4_LOG_DIR = dir;
  process.env.TINA4_LOG_FILE = "explicit.log";
  process.env.TINA4_LOG_LEVEL = "INFO";
  const explicitPath = join(dir, "explicit.log");
  Log.info("explicit file path — prod");
  assert(
    "explicit TINA4_LOG_FILE + prod: file STILL written (explicit wins)",
    existsSync(explicitPath),
    `expected file at ${explicitPath}`,
  );
  delete process.env.TINA4_LOG_FILE;
}

// (d) stdout still receives logs in production (default output) — the platform
//     captures PID 1 stdout; only the FILE is suppressed in prod, never stdout.
{
  resetDefaultOutputEnv("prod-stdout");
  delete process.env.TINA4_DEBUG;
  const origLog = console.log;
  let captured = "";
  console.log = (...args: unknown[]) => { captured += args.join(" "); };
  Log.info("prod stdout still on");
  console.log = origLog;
  assert("default+prod: stdout still receives logs", captured.includes("prod stdout still on"));
  // Prod stdout is clean structured JSON (no ANSI) so aggregators can parse it.
  assert("default+prod: stdout line has no ANSI colour codes", !captured.includes("\x1b["));
}

// Restore the default-output env knobs.
for (const [key, val] of Object.entries({
  TINA4_LOG_OUTPUT: savedDefaultEnv.output,
  TINA4_LOG_FILE: savedDefaultEnv.file,
  TINA4_LOG_DIR: savedDefaultEnv.dir,
  TINA4_DEBUG: savedDefaultEnv.debug,
  TINA4_LOG_LEVEL: savedDefaultEnv.level,
  TINA4_LOG_FORMAT: savedDefaultEnv.format,
})) {
  if (val !== undefined) process.env[key] = val;
  else delete process.env[key];
}

// Cleanup
rmSync("/tmp/tina4-logger-test", { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

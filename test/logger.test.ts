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
// (docker logs / k8s). Capture stdout and verify the line is present AND
// is clean structured JSON (no ANSI colour codes) so aggregators can parse it.
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
  // Production stdout is structured JSON (parity with Python/Ruby).
  const stdoutEntry = JSON.parse(consoleOutput.trim());
  assert("Production stdout is JSON with level INFO", stdoutEntry.level === "INFO");
  assert("Production stdout JSON carries the message", stdoutEntry.message === "Production log message");
}

const prodLogPath = join(TEST_LOG_DIR, "prod.log");
assert("Production log file created", existsSync(prodLogPath));

const prodContent = readFileSync(prodLogPath, "utf-8");
// Production file is JSON too (parity with Python/Ruby — was text pre-v3.13.14).
const prodEntry = JSON.parse(prodContent.trim());
assert("Production log has level INFO", prodEntry.level === "INFO");

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

// Cleanup
rmSync("/tmp/tina4-logger-test", { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

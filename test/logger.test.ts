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

// Ensure we're not in production
delete process.env.TINA4_ENV;
delete process.env.NODE_ENV;

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

// Capture stdout to verify no console output in production
const originalLog = console.log;
let consoleOutput = "";
console.log = (...args: unknown[]) => {
  consoleOutput += args.join(" ");
};

Log.info("Production log message");

console.log = originalLog;

assert("No stdout output in production", consoleOutput === "");

const prodLogPath = join(TEST_LOG_DIR, "prod.log");
assert("Production log file created", existsSync(prodLogPath));

const prodContent = readFileSync(prodLogPath, "utf-8");
const prodEntry = parseLogLine(prodContent.trim());
assert("Production log has level INFO", prodEntry.level === "INFO");

// Restore
if (savedDebug !== undefined) {
  process.env.TINA4_DEBUG = savedDebug;
} else {
  delete process.env.TINA4_DEBUG;
}
delete process.env.TINA4_ENV;

// Cleanup
rmSync("/tmp/tina4-logger-test", { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

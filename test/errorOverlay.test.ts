/**
 * Unit tests for the error overlay (errorOverlay.ts).
 * Run with: npx tsx test/errorOverlay.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { renderErrorOverlay, renderProductionError, isDebugMode } from "../packages/core/src/index.ts";

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

console.log("=== Error Overlay Tests ===\n");

// --- Exports exist ---
console.log("--- Exports ---");
assert("renderErrorOverlay is a function", typeof renderErrorOverlay === "function");
assert("renderProductionError is a function", typeof renderProductionError === "function");
assert("isDebugMode is a function", typeof isDebugMode === "function");

// --- renderErrorOverlay basic output ---
console.log("\n--- renderErrorOverlay ---");

const testError = new Error("Something went wrong");
const html = renderErrorOverlay(testError);

assert("Returns a string", typeof html === "string");
assert("Contains DOCTYPE", html.includes("<!DOCTYPE html>"));
assert("Contains error message", html.includes("Something went wrong"));
assert("Contains error type name", html.includes("Error"));
assert("Contains Tina4 branding", html.includes("Tina4"));
assert("Contains debug overlay text", html.includes("Debug Overlay"));
assert("Contains html tag", html.includes("<html"));
assert("Contains body tag", html.includes("<body>"));

// --- renderErrorOverlay with request context ---
console.log("\n--- Error Overlay with Request ---");

const mockRequest = {
  method: "GET",
  url: "/api/test?foo=bar",
  path: "/api/test",
  headers: {
    "content-type": "application/json",
    "host": "localhost:3000",
  },
  params: { id: "42" },
  query: { foo: "bar" },
};

const htmlWithReq = renderErrorOverlay(testError, mockRequest);
assert("Contains request method", htmlWithReq.includes("GET"));
assert("Contains request URL", htmlWithReq.includes("/api/test"));
assert("Contains Request Details section", htmlWithReq.includes("Request Details"));
assert("Contains Environment section", htmlWithReq.includes("Environment"));

// --- renderErrorOverlay with custom error type ---
console.log("\n--- Custom Error Types ---");

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const customErr = new ValidationError("Field is required");
const customHtml = renderErrorOverlay(customErr);
assert("Contains custom error type", customHtml.includes("ValidationError"));
assert("Contains custom error message", customHtml.includes("Field is required"));

// --- renderProductionError ---
console.log("\n--- renderProductionError ---");

const prodHtml = renderProductionError();
assert("Production error returns string", typeof prodHtml === "string");
assert("Production error contains 500", prodHtml.includes("500"));
assert("Production error contains Internal Server Error", prodHtml.includes("Internal Server Error"));
assert("Production error contains DOCTYPE", prodHtml.includes("<!DOCTYPE html>"));
assert("Production error does NOT contain stack trace", !prodHtml.includes("Stack Trace"));

const custom404 = renderProductionError(404, "Not Found");
assert("Custom status code 404", custom404.includes("404"));
assert("Custom message Not Found", custom404.includes("Not Found"));

const custom503 = renderProductionError(503, "Service Unavailable");
assert("Custom status code 503", custom503.includes("503"));

// --- isDebugMode ---
console.log("\n--- isDebugMode ---");

const originalDebug = process.env.TINA4_DEBUG;

delete process.env.TINA4_DEBUG;
assert("No env var => not debug mode", isDebugMode() === false);

process.env.TINA4_DEBUG = "true";
assert("true => debug mode", isDebugMode() === true);

process.env.TINA4_DEBUG = "TRUE";
assert("TRUE => debug mode (case insensitive)", isDebugMode() === true);

process.env.TINA4_DEBUG = "1";
assert("1 => debug mode", isDebugMode() === true);

process.env.TINA4_DEBUG = "yes";
assert("yes => debug mode", isDebugMode() === true);

process.env.TINA4_DEBUG = "on";
assert("on => debug mode", isDebugMode() === true);

process.env.TINA4_DEBUG = "false";
assert("false => not debug mode", isDebugMode() === false);

process.env.TINA4_DEBUG = "0";
assert("0 => not debug mode", isDebugMode() === false);

process.env.TINA4_DEBUG = "";
assert("empty string => not debug mode", isDebugMode() === false);

// Restore
if (originalDebug !== undefined) {
  process.env.TINA4_DEBUG = originalDebug;
} else {
  delete process.env.TINA4_DEBUG;
}

// --- Stale-file badge (Feature A / Tier 5) ---
console.log("\n--- Stale-file badge ---");

// Build an Error whose stack points at a file we control on disk, then
// touch the file's mtime to simulate "AI rewrote it between captures".
const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-stale-"));
try {
  const targetFile = path.join(staleDir, "frame_source.ts");
  fs.writeFileSync(targetFile, "// line 1\n// line 2\nthrow new Error('boom');\n", "utf-8");

  // Forge an Error with a stack referencing our file at line 3.
  function buildErr(file: string, line: number): Error {
    const e = new Error("simulated failure");
    e.stack = `Error: simulated failure\n    at handler (${file}:${line}:5)\n`;
    return e;
  }

  // Case 1: file mtime is 5 seconds in the FUTURE relative to capturedAt.
  // The overlay stamps capturedAt = now/1000 internally; bumping the file
  // mtime forward guarantees mtime > capturedAt + 0.5.
  const future = (Date.now() + 5000) / 1000;
  fs.utimesSync(targetFile, future, future);
  const staleHtml = renderErrorOverlay(buildErr(targetFile, 3));
  assert("shows stale badge when file modified after capture",
    staleHtml.includes("FILE MODIFIED @"));
  assert("stale badge has UTC label", staleHtml.includes("UTC"));
  assert("stale badge mentions source mismatch",
    staleHtml.includes("source may not match what failed"));

  // Case 2: file mtime is 10 seconds in the PAST — no badge.
  const past = (Date.now() - 10_000) / 1000;
  fs.utimesSync(targetFile, past, past);
  const freshHtml = renderErrorOverlay(buildErr(targetFile, 3));
  assert("omits stale badge when file unchanged",
    !freshHtml.includes("FILE MODIFIED"));
} finally {
  fs.rmSync(staleDir, { recursive: true, force: true });
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

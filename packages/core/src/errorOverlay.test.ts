/**
 * Tests for errorOverlay module.
 */

import { renderErrorOverlay, renderProductionError, isDebugMode } from "./errorOverlay.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertIncludes(html: string, needle: string, label: string): void {
  assert(html.includes(needle), `${label}: expected HTML to include "${needle}"`);
}

function assertNotIncludes(html: string, needle: string, label: string): void {
  assert(!html.includes(needle), `${label}: expected HTML NOT to include "${needle}"`);
}

function makeError(): Error {
  try {
    throw new TypeError("something broke");
  } catch (e) {
    return e as Error;
  }
}

// ── renderErrorOverlay ──

const err = makeError();
const html = renderErrorOverlay(err);

assert(typeof html === "string", "returns a string");
assert(html.startsWith("<!DOCTYPE html>"), "starts with DOCTYPE");
assertIncludes(html, "TypeError", "contains exception type");
assertIncludes(html, "something broke", "contains exception message");
assertIncludes(html, "errorOverlay.test", "contains file path");
assertIncludes(html, "&#x25b6;", "contains error line marker");
assertIncludes(html, "Stack Trace", "contains stack trace section");
assertIncludes(html, "<details", "uses details element");
assertIncludes(html, "open", "stack trace open by default");
assertIncludes(html, "Environment", "contains environment section");
assertIncludes(html, "Tina4 Node.js", "contains framework name");
assertIncludes(html, "TINA4_DEBUG", "contains debug reference");

// With request
const htmlWithReq = renderErrorOverlay(err, {
  method: "GET",
  url: "/api/users",
  headers: { host: "localhost" },
});
assertIncludes(htmlWithReq, "GET", "request method shown");
assertIncludes(htmlWithReq, "/api/users", "request URL shown");
assertIncludes(htmlWithReq, "localhost", "request header shown");
assertIncludes(htmlWithReq, "Request Details", "request section present");

// Without request
assertNotIncludes(html, "Request Details", "no request section when no request");

// XSS escaping
const xssErr = new Error('<script>alert("xss")</script>');
const xssHtml = renderErrorOverlay(xssErr);
assertNotIncludes(xssHtml, "<script>", "escapes script tags");
assertIncludes(xssHtml, "&lt;script&gt;", "HTML-encodes script tags");

// ── renderProductionError ──

const prodHtml = renderProductionError();
assert(prodHtml.startsWith("<!DOCTYPE html>"), "production: starts with DOCTYPE");
assertIncludes(prodHtml, "500", "production: contains 500");
assertIncludes(prodHtml, "Internal Server Error", "production: default message");
assertNotIncludes(prodHtml, "Stack Trace", "production: no stack trace");

const prod404 = renderProductionError(404, "Not Found");
assertIncludes(prod404, "404", "production 404: contains code");
assertIncludes(prod404, "Not Found", "production 404: contains message");

// ── isDebugMode ──

const origDebug = process.env.TINA4_DEBUG;

process.env.TINA4_DEBUG = "true";
assert(isDebugMode() === true, "isDebugMode: true => true");

process.env.TINA4_DEBUG = "false";
assert(isDebugMode() === false, "isDebugMode: false => false");

process.env.TINA4_DEBUG = "TRUE";
assert(isDebugMode() === true, "isDebugMode: TRUE (uppercase) => true (case insensitive)");

process.env.TINA4_DEBUG = "1";
assert(isDebugMode() === true, "isDebugMode: 1 => true");

process.env.TINA4_DEBUG = "yes";
assert(isDebugMode() === true, "isDebugMode: yes => true");

process.env.TINA4_DEBUG = "on";
assert(isDebugMode() === true, "isDebugMode: on => true");

process.env.TINA4_DEBUG = "0";
assert(isDebugMode() === false, "isDebugMode: 0 => false");

delete process.env.TINA4_DEBUG;
assert(isDebugMode() === false, "isDebugMode: unset => false");

// Restore
if (origDebug !== undefined) {
  process.env.TINA4_DEBUG = origDebug;
}

// ── Summary ──
console.log(`\nerrorOverlay tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

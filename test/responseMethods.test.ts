/**
 * Unit tests for additional Response methods: file(), render(), status().json() chaining.
 * Run with: npx tsx test/responseMethods.test.ts
 */
import { createResponse } from "../packages/core/src/index.ts";
import type { ServerResponse } from "node:http";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

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

/** Create a mock ServerResponse that tracks calls. */
function mockServerResponse(): {
  res: ServerResponse;
  ended: { data: string | Buffer; statusCode: number; headers: Record<string, string | string[]>; writableEnded: boolean };
} {
  const state = {
    data: "" as string | Buffer,
    statusCode: 200,
    headers: {} as Record<string, string | string[]>,
    writableEnded: false,
  };

  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader(name: string, value: string | string[]) {
      state.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    end(data?: unknown) {
      if (Buffer.isBuffer(data)) {
        state.data = data;
      } else {
        state.data = data == null ? "" : String(data);
      }
      state.statusCode = (res as any).statusCode;
      state.writableEnded = true;
      (res as any).writableEnded = true;
    },
  } as unknown as ServerResponse;

  return { res, ended: state };
}

console.log("=== Response Methods Tests ===\n");

// --- Setup: create temp files for file() tests ---
const tmpDir = join(import.meta.dirname ?? ".", "__tmp_response_test__");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

const htmlFile = join(tmpDir, "test.html");
writeFileSync(htmlFile, "<h1>Hello</h1>");

const jsonFile = join(tmpDir, "data.json");
writeFileSync(jsonFile, '{"key":"value"}');

const pdfFile = join(tmpDir, "doc.pdf");
writeFileSync(pdfFile, "fake-pdf-content");

// --- res.file() serves file with correct MIME type ---
console.log("--- res.file() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.file(htmlFile);
  assert("file() serves HTML with correct MIME", ended.headers["content-type"] === "text/html");
  assert("file() sets Content-Length", ended.headers["content-length"] !== undefined);
  assert("file() sends file content", Buffer.isBuffer(ended.data) ? ended.data.toString() === "<h1>Hello</h1>" : ended.data === "<h1>Hello</h1>");
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.file(jsonFile);
  assert("file() serves JSON with correct MIME", ended.headers["content-type"] === "application/json");
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.file(pdfFile);
  assert("file() serves PDF with correct MIME", ended.headers["content-type"] === "application/pdf");
}

// --- res.file() returns 404 for missing file ---
console.log("\n--- res.file() 404 ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.file("/nonexistent/file.txt");
  assert("file() returns 404 for missing file", ended.statusCode === 404);
  assert("file() sends 'File not found' message", String(ended.data).includes("File not found"));
}

// --- res.file() with download sets Content-Disposition ---
console.log("\n--- res.file() download ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.file(htmlFile, { download: true });
  const disposition = ended.headers["content-disposition"] as string;
  assert("file() with download sets Content-Disposition", disposition !== undefined);
  assert("file() Content-Disposition includes filename", disposition.includes("test.html"));
  assert("file() Content-Disposition is attachment", disposition.startsWith("attachment"));
}

// --- res.file() with custom contentType ---
{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.file(htmlFile, { contentType: "application/octet-stream" });
  assert("file() respects custom contentType", ended.headers["content-type"] === "application/octet-stream");
}

// --- res.status() sets status code ---
console.log("\n--- res.status() ---");

{
  const { res } = mockServerResponse();
  const response = createResponse(res);
  const result = response.status(404);
  assert("status() sets status code", res.statusCode === 404);
  assert("status() returns response for chaining", result === response);
}

// --- res.status().json() chaining ---
console.log("\n--- res.status().json() chaining ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.status(201).json({ created: true });
  assert("status().json() chaining sets status", ended.statusCode === 201);
  assert("status().json() chaining sends JSON", ended.data === '{"created":true}');
  assert("status().json() chaining sets content-type", ended.headers["content-type"] === "application/json");
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.status(400).text("Bad request");
  assert("status().text() chaining sets status", ended.statusCode === 400);
  assert("status().text() chaining sends text", ended.data === "Bad request");
}

// --- res.header() sets header and is chainable ---
console.log("\n--- res.header() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  const result = response.header("X-Custom", "value");
  assert("header() sets custom header", ended.headers["x-custom"] === "value");
  assert("header() returns response for chaining", result === response);
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.header("X-Request-Id", "abc").header("X-Version", "1.0").json({ ok: true });
  assert("header() chaining sets multiple headers", ended.headers["x-request-id"] === "abc");
  assert("header() chaining sets second header", ended.headers["x-version"] === "1.0");
  assert("header() chain to json() works", ended.data === '{"ok":true}');
}

// --- res.cookie() sets Set-Cookie header with options ---
console.log("\n--- res.cookie() with options ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  const result = response.cookie("session", "abc123", {
    path: "/",
    maxAge: 3600,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  const cookies = ended.headers["set-cookie"];
  const cookieStr = Array.isArray(cookies) ? cookies[0] : String(cookies);
  assert("cookie() sets Set-Cookie header", cookies !== undefined);
  assert("cookie() includes name=value", cookieStr.includes("session=abc123"));
  assert("cookie() includes Path", cookieStr.includes("Path=/"));
  assert("cookie() includes Max-Age", cookieStr.includes("Max-Age=3600"));
  assert("cookie() includes HttpOnly", cookieStr.includes("HttpOnly"));
  assert("cookie() includes Secure", cookieStr.includes("Secure"));
  assert("cookie() includes SameSite", cookieStr.includes("SameSite=Lax"));
  assert("cookie() returns response for chaining", result === response);
}

// --- res.render() renders a template (graceful failure without Frond) ---
console.log("\n--- res.render() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  assert("render() method exists", typeof response.render === "function");
  // render() will fail without @tina4/twig installed, but should handle gracefully
  await response.render("test.twig", { name: "World" });
  // Since @tina4/twig might not be available, it should return a 500 error
  assert("render() handles missing template engine gracefully", ended.statusCode === 500 || (ended.headers["content-type"] as string)?.includes("text/html"));
}

// --- Cleanup ---
rmSync(tmpDir, { recursive: true, force: true });

// --- Summary ---
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

/**
 * Unit tests for the Response module.
 * Run with: npx tsx test/response.test.ts
 */
import { createResponse } from "../packages/core/src/index.ts";
import type { ServerResponse } from "node:http";

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
  ended: { data: string; statusCode: number; headers: Record<string, string | string[]> };
} {
  const state = {
    data: "",
    statusCode: 200,
    headers: {} as Record<string, string | string[]>,
  };

  const res = {
    statusCode: 200,
    setHeader(name: string, value: string | string[]) {
      state.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    end(data?: unknown) {
      state.data = data == null ? "" : String(data);
      state.statusCode = (res as any).statusCode;
    },
  } as unknown as ServerResponse;

  return { res, ended: state };
}

console.log("=== Response Tests ===\n");

// --- createResponse wraps ServerResponse ---
console.log("--- createResponse ---");

{
  const { res } = mockServerResponse();
  const response = createResponse(res);
  assert("createResponse returns a function", typeof response === "function");
  assert("response has raw property", response.raw === res);
  assert("response has json method", typeof response.json === "function");
  assert("response has html method", typeof response.html === "function");
  assert("response has text method", typeof response.text === "function");
  assert("response has send method", typeof response.send === "function");
  assert("response has status method", typeof response.status === "function");
  assert("response has header method", typeof response.header === "function");
  assert("response has redirect method", typeof response.redirect === "function");
  assert("response has cookie method", typeof response.cookie === "function");
  assert("response has clearCookie method", typeof response.clearCookie === "function");
}

// --- .json() sets content-type and sends JSON ---
console.log("\n--- .json() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.json({ name: "Alice", age: 30 });
  assert("json sets content-type to application/json", ended.headers["content-type"] === "application/json");
  assert("json sends JSON string", ended.data === '{"name":"Alice","age":30}');
  assert("json default status is 200", ended.statusCode === 200);
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.json({ created: true }, 201);
  assert("json with status sets status code", ended.statusCode === 201);
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  const chainResult = response.json([1, 2, 3]);
  assert("json returns response for chaining", chainResult === response);
  assert("json handles arrays", ended.data === "[1,2,3]");
}

// --- .html() sends HTML ---
console.log("\n--- .html() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.html("<h1>Hello</h1>");
  assert("html sets content-type to text/html", (ended.headers["content-type"] as string).includes("text/html"));
  assert("html sends HTML string", ended.data === "<h1>Hello</h1>");
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.html("<p>Not found</p>", 404);
  assert("html with status sets status code", ended.statusCode === 404);
}

// --- .text() sends plain text ---
console.log("\n--- .text() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.text("Hello World");
  assert("text sets content-type to text/plain", (ended.headers["content-type"] as string).includes("text/plain"));
  assert("text sends string", ended.data === "Hello World");
}

// --- .status() sets status code ---
console.log("\n--- .status() ---");

{
  const { res } = mockServerResponse();
  const response = createResponse(res);
  const chainResult = response.status(404);
  assert("status sets status code on underlying response", res.statusCode === 404);
  assert("status returns response for chaining", chainResult === response);
}

// --- .redirect() sends 302 ---
console.log("\n--- .redirect() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.redirect("/login");
  assert("redirect sets status 302 by default", ended.statusCode === 302);
  assert("redirect sets Location header", ended.headers["location"] === "/login");
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.redirect("/new-page", 301);
  assert("redirect with custom code", ended.statusCode === 301);
  assert("redirect with custom code sets Location", ended.headers["location"] === "/new-page");
}

// --- .cookie() sets Set-Cookie header ---
console.log("\n--- .cookie() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.cookie("session", "abc123");
  const cookies = ended.headers["set-cookie"];
  assert("cookie sets Set-Cookie header", cookies !== undefined);
  const cookieStr = Array.isArray(cookies) ? cookies[0] : cookies;
  assert("cookie value is encoded", cookieStr.includes("session=abc123"));
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.cookie("token", "xyz", {
    maxAge: 3600,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  });
  const cookies = ended.headers["set-cookie"];
  const cookieStr = Array.isArray(cookies) ? cookies[0] : String(cookies);
  assert("cookie includes Max-Age", cookieStr.includes("Max-Age=3600"));
  assert("cookie includes Path", cookieStr.includes("Path=/"));
  assert("cookie includes HttpOnly", cookieStr.includes("HttpOnly"));
  assert("cookie includes Secure", cookieStr.includes("Secure"));
  assert("cookie includes SameSite", cookieStr.includes("SameSite=Strict"));
}

// --- Multiple cookies ---
console.log("\n--- Multiple cookies ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.cookie("a", "1");
  response.cookie("b", "2");
  const cookies = ended.headers["set-cookie"];
  assert("multiple cookies are set", Array.isArray(cookies) && cookies.length === 2);
}

// --- .clearCookie() ---
console.log("\n--- .clearCookie() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.clearCookie("session");
  const cookies = ended.headers["set-cookie"];
  const cookieStr = Array.isArray(cookies) ? cookies[0] : String(cookies);
  assert("clearCookie sets Max-Age=0", cookieStr.includes("Max-Age=0"));
}

// --- .header() sets custom header ---
console.log("\n--- .header() ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  const chainResult = response.header("X-Custom", "value");
  assert("header sets custom header", ended.headers["x-custom"] === "value");
  assert("header returns response for chaining", chainResult === response);
}

// --- Callable response auto-detection ---
console.log("\n--- Auto-detection ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response({ users: [] });
  assert("object auto-detected as JSON", ended.headers["content-type"] === "application/json");
  assert("object stringified", ended.data === '{"users":[]}');
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response("<h1>Hello</h1>");
  assert("HTML string auto-detected", (ended.headers["content-type"] as string).includes("text/html"));
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response("plain text");
  assert("plain text auto-detected", (ended.headers["content-type"] as string).includes("text/plain"));
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response(null);
  assert("null sends empty string", ended.data === "");
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response({ ok: true }, 201);
  assert("callable with status sets status code", ended.statusCode === 201);
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response("data", 200, "text/csv");
  assert("explicit content type is used", ended.headers["content-type"] === "text/csv");
}

// --- Buffer handling ---
console.log("\n--- Buffer handling ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response(Buffer.from("binary data"));
  assert("buffer sets application/octet-stream", ended.headers["content-type"] === "application/octet-stream");
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

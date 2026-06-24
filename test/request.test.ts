/**
 * Unit tests for request parsing (request.ts).
 * Run with: npx tsx test/request.test.ts
 */
import { createRequest } from "../packages/core/src/index.ts";
import type { Tina4Request } from "../packages/core/src/index.ts";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";

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

// Helper to create a fake IncomingMessage
function fakeIncoming(url: string, method = "GET", headers: Record<string, string> = {}): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.url = url;
  req.method = method;
  req.headers = { host: "localhost:3000", ...headers };
  return req;
}

// Helper to create a readable request with body data
function fakeIncomingWithBody(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string> = {},
): Tina4Request {
  const socket = new Socket();
  const req = new IncomingMessage(socket) as Tina4Request;
  req.url = url;
  req.method = method;
  req.headers = { host: "localhost:3000", ...headers };
  // Push body data and end the stream
  req.push(Buffer.from(body));
  req.push(null);

  return createRequest(req);
}

console.log("=== Request Parsing Tests ===\n");

// --- Exports ---
console.log("--- Exports ---");
// Behavioural guard: exercise createRequest end-to-end rather than asserting it
// merely exists. A wrapped request must carry the parsed query and the original
// HTTP method through unchanged.
const exportReq = createRequest(fakeIncoming("/api/x?n=1"));
assert(
  "createRequest wraps an IncomingMessage into a usable Tina4Request",
  exportReq.query.n === "1" && exportReq.method === "GET",
  `query.n=${exportReq.query.n} method=${exportReq.method}`,
);
// parseBody is now an instance method on Tina4Request (req.parseBody())

// --- createRequest basic ---
console.log("\n--- createRequest Basic ---");

const req1 = createRequest(fakeIncoming("/"));
assert("Creates Tina4Request from IncomingMessage", req1 !== null);
assert("Initializes params as empty object", typeof req1.params === "object" && Object.keys(req1.params).length === 0);
assert("Initializes query as empty object", typeof req1.query === "object" && Object.keys(req1.query).length === 0);
assert("Initializes body as undefined", req1.body === undefined);
assert("Initializes files as empty object", typeof req1.files === "object" && Object.keys(req1.files).length === 0);
assert("Sets ip address", typeof req1.ip === "string" && req1.ip.length > 0);

// --- Query string parsing ---
console.log("\n--- Query String Parsing ---");

const req2 = createRequest(fakeIncoming("/api/users?name=alice&age=30&active=true"));
assert("Parses query param 'name'", req2.query.name === "alice");
assert("Parses query param 'age'", req2.query.age === "30");
assert("Parses query param 'active'", req2.query.active === "true");

const req3 = createRequest(fakeIncoming("/search?q=hello+world"));
assert("Parses URL-encoded spaces", req3.query.q === "hello world");

const req4 = createRequest(fakeIncoming("/search?q=hello%20world"));
assert("Parses percent-encoded spaces", req4.query.q === "hello world");

const reqNoQuery = createRequest(fakeIncoming("/plain"));
assert("No query string => empty query", Object.keys(reqNoQuery.query).length === 0);

// --- IP address detection ---
console.log("\n--- IP Address ---");

const reqXFF = createRequest(fakeIncoming("/", "GET", { "x-forwarded-for": "10.0.0.1, 10.0.0.2" }));
assert("X-Forwarded-For extracts first IP", reqXFF.ip === "10.0.0.1");

const reqNoXFF = createRequest(fakeIncoming("/", "GET"));
assert("No X-Forwarded-For uses socket address", typeof reqNoXFF.ip === "string");

// --- parseBody with JSON ---
console.log("\n--- parseBody JSON ---");

const jsonReq = fakeIncomingWithBody(
  "/api/data",
  "POST",
  JSON.stringify({ name: "Alice", age: 30 }),
  { "content-type": "application/json" },
);
await jsonReq.parseBody();
assert("JSON body parsed as object", typeof jsonReq.body === "object" && jsonReq.body !== null);
assert("JSON body has correct name", (jsonReq.body as any).name === "Alice");
assert("JSON body has correct age", (jsonReq.body as any).age === 30);

// --- parseBody with form-urlencoded ---
console.log("\n--- parseBody URL-encoded ---");

const formReq = fakeIncomingWithBody(
  "/submit",
  "POST",
  "username=alice&password=secret",
  { "content-type": "application/x-www-form-urlencoded" },
);
await formReq.parseBody();
assert("Form body parsed as object", typeof formReq.body === "object");
assert("Form body has username", (formReq.body as any).username === "alice");
assert("Form body has password", (formReq.body as any).password === "secret");

// --- parseBody skips GET ---
console.log("\n--- parseBody Skips GET ---");

const getReq = fakeIncomingWithBody("/data", "GET", "ignored", { "content-type": "application/json" });
await getReq.parseBody();
assert("GET request body remains undefined", getReq.body === undefined);

// --- parseBody skips HEAD ---
const headReq = fakeIncomingWithBody("/data", "HEAD", "ignored", { "content-type": "application/json" });
await headReq.parseBody();
assert("HEAD request body remains undefined", headReq.body === undefined);

// --- parseBody skips OPTIONS ---
const optReq = fakeIncomingWithBody("/data", "OPTIONS", "ignored", { "content-type": "application/json" });
await optReq.parseBody();
assert("OPTIONS request body remains undefined", optReq.body === undefined);

// --- parseBody with invalid JSON ---
console.log("\n--- parseBody Invalid JSON ---");

const badJsonReq = fakeIncomingWithBody(
  "/api/data",
  "POST",
  "not valid json {{{",
  { "content-type": "application/json" },
);
await badJsonReq.parseBody();
assert("Invalid JSON stored as raw string", typeof badJsonReq.body === "string");

// --- parseBody with plain text ---
console.log("\n--- parseBody Plain Text ---");

const textReq = fakeIncomingWithBody(
  "/text",
  "POST",
  "Hello World",
  { "content-type": "text/plain" },
);
await textReq.parseBody();
assert("Plain text body stored as string", textReq.body === "Hello World");

// --- parseBody multipart boundary extraction ---
console.log("\n--- Multipart Boundary ---");

const boundary = "----WebKitFormBoundary123";
const multipartBody = [
  `------WebKitFormBoundary123`,
  `Content-Disposition: form-data; name="field1"`,
  ``,
  `value1`,
  `------WebKitFormBoundary123`,
  `Content-Disposition: form-data; name="field2"`,
  ``,
  `value2`,
  `------WebKitFormBoundary123--`,
].join("\r\n");

const multiReq = fakeIncomingWithBody(
  "/upload",
  "POST",
  multipartBody,
  { "content-type": `multipart/form-data; boundary=----WebKitFormBoundary123` },
);
await multiReq.parseBody();
assert("Multipart body parsed", multiReq.body !== undefined);
assert("Multipart field1 extracted", (multiReq.body as any).field1 === "value1");
assert("Multipart field2 extracted", (multiReq.body as any).field2 === "value2");

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

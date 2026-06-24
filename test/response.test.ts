/**
 * Unit tests for the Response module.
 * Run with: npx tsx test/response.test.ts
 */
import { createResponse } from "../packages/core/src/index.ts";
import http from "node:http";
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

// --- Real-server harness ----------------------------------------------------
// The flagged "smoke"/"existence" cases below were rewritten to drive
// createResponse() against a REAL node:http ServerResponse over a real socket,
// rather than the hand-rolled mockServerResponse(). Each probe runs inside a
// live request handler; we then assert on the bytes/headers/status the HTTP
// client actually received off the wire — the strongest proof the callable and
// its methods produce the real observable effect (no fakes, no stubs).

interface RealResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Start a one-shot real HTTP server, run `probe(response, raw)` inside its
 * request handler, fire a single real GET request, and resolve with the actual
 * response the client received. `probe` may end the response itself; if it does
 * not (e.g. it only mutates raw), the harness ends it so the request completes.
 */
async function withRealResponse(
  probe: (response: ReturnType<typeof createResponse>, raw: ServerResponse) => void,
): Promise<RealResult> {
  const server = http.createServer((_req, res) => {
    const response = createResponse(res);
    probe(response, res);
    if (!res.writableEnded) res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    return await new Promise<RealResult>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: addr.port, path: "/", method: "GET" },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () =>
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// --- createResponse wraps a real ServerResponse -----------------------------
console.log("--- createResponse (real socket) ---");

{
  // 1. createResponse returns a CALLABLE that actually serialises + ends the
  //    response. Invoke it once and assert the real wire effect.
  const r = await withRealResponse((response) => {
    response({ ok: true });
  });
  assert(
    "createResponse callable serialises body to the socket",
    r.body === '{"ok":true}',
    r.body,
  );
  assert(
    "createResponse callable sets application/json on the socket",
    r.headers["content-type"] === "application/json",
    String(r.headers["content-type"]),
  );
}

{
  // 2. response.raw is the LIVE underlying socket: mutating through the wrapper
  //    is visible on response.raw (and lands on the wire).
  let rawIsLive = false;
  const r = await withRealResponse((response, raw) => {
    response.status(418);
    rawIsLive = response.raw === raw && (response.raw as ServerResponse).statusCode === 418;
  });
  assert("response.raw is the live underlying ServerResponse", rawIsLive);
  assert("mutation via wrapper reaches the wire (418)", r.statusCode === 418, String(r.statusCode));
}

{
  // 3. json() serialises and sets content-type — asserted off the wire.
  const r = await withRealResponse((response) => {
    response.json({ a: 1 });
  });
  assert("json writes serialised body to socket", r.body === '{"a":1}', r.body);
  assert("json sets application/json on socket", r.headers["content-type"] === "application/json");
}

{
  // 4. html() sends the literal HTML with a text/html content type.
  const r = await withRealResponse((response) => {
    response.html("<b>x</b>");
  });
  assert("html writes literal HTML to socket", r.body === "<b>x</b>", r.body);
  assert(
    "html sets text/html on socket",
    String(r.headers["content-type"]).includes("text/html"),
    String(r.headers["content-type"]),
  );
}

{
  // 5. text() sends the literal string with a text/plain content type.
  const r = await withRealResponse((response) => {
    response.text("hi");
  });
  assert("text writes literal string to socket", r.body === "hi", r.body);
  assert(
    "text sets text/plain on socket",
    String(r.headers["content-type"]).includes("text/plain"),
    String(r.headers["content-type"]),
  );
}

{
  // 6. send() delegates to the callable, honouring an explicit content type.
  const r = await withRealResponse((response) => {
    response.send("data", 200, "text/csv");
  });
  assert("send honours explicit content type on socket", r.headers["content-type"] === "text/csv");
  assert("send writes the body to socket", r.body === "data", r.body);
}

{
  // 7. status() sets the code on the live response and returns itself for chaining.
  let chained = false;
  const r = await withRealResponse((response) => {
    const ret = response.status(404);
    chained = ret === response;
    response.text("nope");
  });
  assert("status sets status code on the wire", r.statusCode === 404, String(r.statusCode));
  assert("status returns response for chaining", chained);
}

{
  // 8. header() emits a custom header that arrives at the client.
  const r = await withRealResponse((response) => {
    response.header("X-A", "1");
    response.text("ok");
  });
  assert("header reaches the client", r.headers["x-a"] === "1", String(r.headers["x-a"]));
}

{
  // 9. redirect() sets 302 + Location on the wire.
  const r = await withRealResponse((response) => {
    response.redirect("/x");
  });
  assert("redirect sets 302 on the wire", r.statusCode === 302, String(r.statusCode));
  assert("redirect sets Location on the wire", r.headers["location"] === "/x", String(r.headers["location"]));
}

{
  // 10. cookie() emits a Set-Cookie header the client receives.
  const r = await withRealResponse((response) => {
    response.cookie("s", "v");
    response.text("ok");
  });
  const c = r.headers["set-cookie"];
  const cookieStr = Array.isArray(c) ? c[0] : String(c);
  assert("cookie sets Set-Cookie on the wire", cookieStr.includes("s=v"), cookieStr);
}

{
  // 11. clearCookie() emits a Max-Age=0 expiry cookie the client receives.
  const r = await withRealResponse((response) => {
    response.clearCookie("s");
    response.text("ok");
  });
  const c = r.headers["set-cookie"];
  const cookieStr = Array.isArray(c) ? c[0] : String(c);
  assert("clearCookie emits Max-Age=0 on the wire", cookieStr.includes("Max-Age=0"), cookieStr);
}

{
  // 12. addHeader() (parity primary) applies the header to the live response.
  const r = await withRealResponse((response) => {
    response.addHeader("X-Custom", "value-1");
    response.text("ok");
  });
  assert(
    "addHeader reaches the client",
    r.headers["x-custom"] === "value-1",
    String(r.headers["x-custom"]),
  );
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

// --- addHeader (parity with Python/PHP/Ruby) ---
console.log("\n--- addHeader ---");

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  assert("response has addHeader method", typeof response.addHeader === "function");
  response.addHeader("X-Custom", "value-1");
  assert("addHeader sets header on underlying response", ended.headers["x-custom"] === "value-1");
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  response.addHeader("X-One", "1");
  response.addHeader("X-Two", "2");
  response.json({ ok: true });
  assert("addHeader + json coexist (X-One)", ended.headers["x-one"] === "1");
  assert("addHeader + json coexist (X-Two)", ended.headers["x-two"] === "2");
  assert("json content-type still set", ended.headers["content-type"] === "application/json");
}

{
  const { res, ended } = mockServerResponse();
  const response = createResponse(res);
  const ret = response.addHeader("X-Void", "y") as unknown;
  assert("addHeader returns void (undefined)", ret === undefined);
  assert("addHeader still applied header", ended.headers["x-void"] === "y");
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

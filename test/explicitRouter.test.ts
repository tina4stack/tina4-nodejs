/**
 * Unit tests for explicit routing (Router.get/post/put/delete/websocket static methods).
 * Verifies that explicit routes can coexist with file-based routes.
 *
 * Run with: npx tsx test/explicitRouter.test.ts
 */
import { Router, defaultRouter } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, WebSocketRouteHandler } from "../packages/core/src/index.ts";

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

console.log("=== Explicit Router Tests ===\n");

// Clean slate
defaultRouter.clear();

// --- Router.get() static method ---
console.log("--- Router.get() static ---");

const getHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ users: [] });
};
Router.get("/api/users", getHandler);

const getRoutes = defaultRouter.getRoutes();
const hasGet = getRoutes.some((r) => r.method === "GET" && r.pattern === "/api/users");
assert("Router.get() registers on defaultRouter", hasGet);

const getMatch = defaultRouter.match("GET", "/api/users");
assert("Router.get() route matches correctly", getMatch !== null);
assert("Router.get() returns correct handler", getMatch?.handler === getHandler);

// --- Router.post() static method ---
console.log("\n--- Router.post() static ---");

const postHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ created: true });
};
Router.post("/api/users", postHandler);

const postMatch = defaultRouter.match("POST", "/api/users");
assert("Router.post() registers and matches", postMatch !== null);
assert("Router.post() returns correct handler", postMatch?.handler === postHandler);

// --- Router.put() with path params ---
console.log("\n--- Router.put() with path params ---");

const putHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ updated: true });
};
Router.put("/api/users/{id}", putHandler);

const putMatch = defaultRouter.match("PUT", "/api/users/42");
assert("Router.put() registers and matches with param", putMatch !== null);
assert("Router.put() extracts path param correctly", putMatch?.params?.id === "42");
assert("Router.put() returns correct handler", putMatch?.handler === putHandler);

const putNoMatch = defaultRouter.match("PUT", "/api/users");
assert("Router.put() does NOT match without param", putNoMatch === null);

// --- Router.delete() ---
console.log("\n--- Router.delete() static ---");

const deleteHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ deleted: true });
};
Router.delete("/api/users/{id}", deleteHandler);

const deleteMatch = defaultRouter.match("DELETE", "/api/users/99");
assert("Router.delete() registers and matches", deleteMatch !== null);
assert("Router.delete() extracts path param", deleteMatch?.params?.id === "99");
assert("Router.delete() returns correct handler", deleteMatch?.handler === deleteHandler);

// --- Explicit routes coexist with file-based routes ---
console.log("\n--- Coexistence with file-based routes ---");

// Simulate file-based route by using instance method addRoute (as routeDiscovery does)
const fileBasedHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ method: "file-based" });
};
defaultRouter.addRoute({
  method: "GET",
  pattern: "/api/file-route",
  handler: fileBasedHandler,
  filePath: "src/routes/api/file-route/get.ts",
});

// Explicit route added alongside
const explicitHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ method: "explicit" });
};
Router.get("/api/explicit-route", explicitHandler);

const fileMatch = defaultRouter.match("GET", "/api/file-route");
assert("File-based route still matches", fileMatch !== null);
assert("File-based route returns correct handler", fileMatch?.handler === fileBasedHandler);

const explicitMatch = defaultRouter.match("GET", "/api/explicit-route");
assert("Explicit route matches alongside file-based", explicitMatch !== null);
assert("Explicit route returns correct handler", explicitMatch?.handler === explicitHandler);

// Both /api/users (explicit) and /api/file-route (file-based) should work
const bothGetUsers = defaultRouter.match("GET", "/api/users");
assert("Previously registered explicit route still works", bothGetUsers !== null);

// --- Router.websocket() static method ---
console.log("\n--- Router.websocket() static ---");

const wsHandler: WebSocketRouteHandler = async (conn, msg) => {
  conn.send(`echo: ${msg}`);
};
Router.websocket("/ws/chat", wsHandler);

const wsRoutes = defaultRouter.getWebSocketRoutes();
assert("Router.websocket() registers a ws route", wsRoutes.length >= 1);

const wsRoute = wsRoutes.find((r) => r.pattern === "/ws/chat");
assert("WebSocket route has correct pattern", wsRoute !== undefined);
assert("WebSocket route has correct handler", wsRoute?.handler === wsHandler);

// Test matchWebSocket
const wsMatch = defaultRouter.matchWebSocket("/ws/chat");
assert("matchWebSocket() finds registered route", wsMatch !== null);
assert("matchWebSocket() returns correct handler", wsMatch?.handler === wsHandler);

const wsNoMatch = defaultRouter.matchWebSocket("/ws/nonexistent");
assert("matchWebSocket() returns null for unregistered path", wsNoMatch === null);

// --- WebSocket handler signature test ---
console.log("\n--- WebSocket handler signature ---");

let echoed = "";
const testConn = {
  id: "test-123",
  send: (data: string) => { echoed = data; },
  close: () => {},
};

// Invoke the handler to verify signature works (synchronous invocation, await resolves immediately)
wsHandler(testConn, "hello");
assert("WebSocket handler receives conn and message", echoed === "echo: hello");

// --- Router.any() static method ---
console.log("\n--- Router.any() static ---");

const anyHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ method: req.method });
};
Router.any("/api/anything", anyHandler);

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
  const anyMatch = defaultRouter.match(method, "/api/anything");
  assert(`Router.any() matches ${method}`, anyMatch !== null && anyMatch.handler === anyHandler);
}

// --- Router.group() static method ---
console.log("\n--- Router.group() static ---");

const groupHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ grouped: true });
};

Router.group("/v2", (group) => {
  group.get("/items", groupHandler);
  group.post("/items", groupHandler);
});

const groupGetMatch = defaultRouter.match("GET", "/v2/items");
assert("Router.group() registers GET with prefix", groupGetMatch !== null);

const groupPostMatch = defaultRouter.match("POST", "/v2/items");
assert("Router.group() registers POST with prefix", groupPostMatch !== null);

// --- Router.patch() static ---
console.log("\n--- Router.patch() static ---");

const patchHandler = async (req: Tina4Request, res: Tina4Response) => {
  res.json({ patched: true });
};
Router.patch("/api/users/{id}", patchHandler);

const patchMatch = defaultRouter.match("PATCH", "/api/users/7");
assert("Router.patch() registers and matches", patchMatch !== null);
assert("Router.patch() extracts param", patchMatch?.params?.id === "7");

// --- Multiple WebSocket routes ---
console.log("\n--- Multiple WebSocket routes ---");

const wsHandler2: WebSocketRouteHandler = async (conn, msg) => {
  conn.send(`notify: ${msg}`);
};
Router.websocket("/ws/notifications", wsHandler2);

const allWs = defaultRouter.getWebSocketRoutes();
assert("Multiple WebSocket routes registered", allWs.length >= 2);

const wsChat = defaultRouter.matchWebSocket("/ws/chat");
const wsNotify = defaultRouter.matchWebSocket("/ws/notifications");
assert("First WS route still matches", wsChat?.handler === wsHandler);
assert("Second WS route matches", wsNotify?.handler === wsHandler2);

// --- Summary ---
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

/**
 * Lock-in tests for per-route WebSocket authentication on the upgrade.
 *
 * Mirrors tina4-python/tests/test_ws_auth.py (master commit b5976d4):
 *   - ws_token / wsToken extracts a JWT from the Authorization header, the
 *     "bearer" Sec-WebSocket-Protocol subprotocol, OR a ?token= query param.
 *   - ws_authorized / wsAuthorized: a PUBLIC route always passes; a SECURED
 *     route requires a valid JWT, returns the verified payload, and rejects a
 *     missing or invalid token.
 *   - BOTH ways of declaring a secured WS route set the flag: imperative
 *     `{ secured: true }` / `.secure()` AND a `_secured` flag on the handler.
 *   - End-to-end through the real upgrade path (serveWebSocketRoute, the same
 *     entry server.ts wires into its `upgrade` event): a public route ACCEPTS
 *     with no token; a secured route REJECTS missing AND invalid tokens (the
 *     upgrade is refused, NOT accepted) and ACCEPTS a valid token via the
 *     Authorization header, via the bearer subprotocol (echoing `bearer` back),
 *     and via ?token=; the connection exposes the verified payload as conn.auth.
 *
 * Run with: npx tsx test/wsAuth.test.ts
 */
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";

import {
  Router,
  defaultRouter,
  getToken,
  wsToken,
  wsAuthorized,
  serveWebSocketRoute,
  computeAcceptKey,
} from "../packages/core/src/index.ts";
import type { WebSocketRouteHandler, WebSocketConnection } from "../packages/core/src/index.ts";

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

console.log("=== WebSocket Per-Route Auth Tests ===\n");

// A known secret so getToken / validToken agree.
process.env.TINA4_SECRET = "ws-auth-test-secret";
const validJwt = getToken({ userId: 42, role: "admin" });
const invalidJwt = validJwt + "tampered";

// ── Unit: wsToken extracts from all three transports ────────────────────────
console.log("--- wsToken transports ---");

assert(
  "wsToken reads Authorization: Bearer header",
  wsToken({ authorization: `Bearer ${validJwt}` }) === validJwt,
);
assert(
  "wsToken header lookup is case-insensitive on the key",
  wsToken({ Authorization: `Bearer ${validJwt}` }) === validJwt,
);
assert(
  'wsToken reads the "bearer, <jwt>" subprotocol (browser transport)',
  wsToken({}, "", `bearer, ${validJwt}`) === validJwt,
);
assert(
  "wsToken reads the bearer subprotocol from the header form too",
  wsToken({ "sec-websocket-protocol": `bearer, ${validJwt}` }) === validJwt,
);
assert(
  "wsToken reads ?token= query param",
  wsToken({}, `token=${validJwt}`) === validJwt,
);
assert(
  "wsToken returns null when no token is present anywhere",
  wsToken({}, "", "") === null,
);
assert(
  "wsToken ignores a lone 'bearer' subprotocol with no token",
  wsToken({}, "", "bearer") === null,
);

// ── Unit: wsAuthorized public vs secured ────────────────────────────────────
console.log("\n--- wsAuthorized public vs secured ---");

{
  const [payload, ok] = wsAuthorized({ authRequired: false }, {}, "", "");
  assert("public route passes with NO token", ok === true);
  assert("public route exposes null payload", payload === null);
}
{
  const [payload, ok] = wsAuthorized(undefined, {}, "", "");
  assert("undefined route (no WS route) passes (non-breaking)", ok === true && payload === null);
}
{
  const [payload, ok] = wsAuthorized({ authRequired: true }, {}, "", "");
  assert("secured route REJECTS a missing token", ok === false);
  assert("secured route exposes null payload when rejected", payload === null);
}
{
  const [payload, ok] = wsAuthorized(
    { authRequired: true },
    { authorization: `Bearer ${invalidJwt}` },
  );
  assert("secured route REJECTS an invalid token", ok === false && payload === null);
}
{
  const [payload, ok] = wsAuthorized(
    { authRequired: true },
    { authorization: `Bearer ${validJwt}` },
  );
  assert("secured route ACCEPTS a valid token via header", ok === true);
  assert("secured route returns the verified payload", (payload as any)?.userId === 42);
}
{
  const [, ok] = wsAuthorized({ authRequired: true }, {}, "", `bearer, ${validJwt}`);
  assert("secured route ACCEPTS a valid token via bearer subprotocol", ok === true);
}
{
  const [, ok] = wsAuthorized({ authRequired: true }, {}, `token=${validJwt}`);
  assert("secured route ACCEPTS a valid token via ?token=", ok === true);
}

// ── Declaration: both ways set authRequired ─────────────────────────────────
console.log("\n--- both declaration styles set authRequired ---");

const noop: WebSocketRouteHandler = async () => {};

// (1) imperative options bag
Router.websocket("/ws/sec-options", noop, { secured: true });
assert(
  "imperative { secured: true } sets authRequired",
  Router.matchWebSocket("/ws/sec-options")?.authRequired === true,
);

// (2) chained .secure() on the returned ref
Router.websocket("/ws/sec-chain", noop).secure();
assert(
  ".secure() on the returned ref sets authRequired",
  Router.matchWebSocket("/ws/sec-chain")?.authRequired === true,
);

// (3) decorator-style _secured flag on the handler
const securedHandler: WebSocketRouteHandler = Object.assign(async () => {}, { _secured: true });
Router.websocket("/ws/sec-flag", securedHandler);
assert(
  "handler._secured flag sets authRequired (decorator style)",
  Router.matchWebSocket("/ws/sec-flag")?.authRequired === true,
);

// public by default
Router.websocket("/ws/public-default", noop);
assert(
  "a plain WS route is PUBLIC by default",
  Router.matchWebSocket("/ws/public-default")?.authRequired === false,
);

// ── End-to-end through the real upgrade path (serveWebSocketRoute) ──────────
console.log("\n--- live upgrade enforcement ---");

// Capture the auth payload the route handler observed on open, per path.
const observedAuth = new Map<string, Record<string, unknown> | null>();

const publicHandler: WebSocketRouteHandler = async (conn: WebSocketConnection, event) => {
  if (event === "open") observedAuth.set("/ws/echo", conn.auth);
};
const securedRouteHandler: WebSocketRouteHandler = async (conn: WebSocketConnection, event) => {
  if (event === "open") observedAuth.set("/ws/secure", conn.auth);
};

defaultRouter.clear();
Router.websocket("/ws/echo", publicHandler);                       // public
Router.websocket("/ws/secure", securedRouteHandler, { secured: true }); // secured

const srv = createServer((_req, res) => {
  res.writeHead(426);
  res.end("Upgrade Required");
});
// Wire EXACTLY as server.ts does: user WS routes go through serveWebSocketRoute.
srv.on("upgrade", (req, socket, head) => {
  if (serveWebSocketRoute(req, socket, head)) return;
  try {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  } catch {
    /* gone */
  }
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as any).port;

/** Perform a raw RFC 6455 handshake; resolve with the status code + response headers. */
function handshake(
  path: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 4000,
): Promise<{ status: number; headers: string }> {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString("base64");
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      let req =
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
      for (const [k, v] of Object.entries(extraHeaders)) req += `${k}: ${v}\r\n`;
      req += "\r\n";
      sock.write(req);
    });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ status: 0, headers: "" });
    }, timeoutMs);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString();
      const status = parseInt(head.split("\r\n")[0].split(" ")[1] ?? "0", 10);
      clearTimeout(timer);
      // Give the open handler a moment to record conn.auth before we close.
      setTimeout(() => {
        sock.destroy();
        resolve({ status, headers: head });
      }, 60);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve({ status: 0, headers: "" });
    });
  });
}

// Public route: accepts with NO token.
{
  const r = await handshake("/ws/echo");
  assert("public WS route ACCEPTS with no token (101)", r.status === 101);
  await new Promise((res) => setTimeout(res, 80));
  assert("public route connection.auth is null", observedAuth.get("/ws/echo") === null);
}

// Secured route: rejects a MISSING token.
{
  const r = await handshake("/ws/secure");
  assert("secured WS route REJECTS a missing token (NOT 101)", r.status !== 101);
  assert("secured missing-token rejection is 401", r.status === 401);
}

// Secured route: rejects an INVALID token.
{
  const r = await handshake("/ws/secure", { Authorization: `Bearer ${invalidJwt}` });
  assert("secured WS route REJECTS an invalid token (NOT 101)", r.status !== 101);
  assert("secured invalid-token rejection is 401", r.status === 401);
}

// Secured route: accepts a VALID token via the Authorization header.
{
  observedAuth.delete("/ws/secure");
  const r = await handshake("/ws/secure", { Authorization: `Bearer ${validJwt}` });
  assert("secured WS route ACCEPTS a valid token via header (101)", r.status === 101);
  await new Promise((res) => setTimeout(res, 80));
  assert(
    "secured connection exposes the verified payload (userId=42)",
    (observedAuth.get("/ws/secure") as any)?.userId === 42,
  );
}

// Secured route: accepts a VALID token via the bearer subprotocol + echoes "bearer".
{
  const r = await handshake("/ws/secure", { "Sec-WebSocket-Protocol": `bearer, ${validJwt}` });
  assert("secured WS route ACCEPTS a valid token via bearer subprotocol (101)", r.status === 101);
  assert(
    "handshake echoes the accepted `bearer` subprotocol",
    /Sec-WebSocket-Protocol:\s*bearer/i.test(r.headers),
  );
}

// Secured route: accepts a VALID token via ?token=.
{
  const r = await handshake(`/ws/secure?token=${validJwt}`);
  assert("secured WS route ACCEPTS a valid token via ?token= (101)", r.status === 101);
}

srv.close();

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

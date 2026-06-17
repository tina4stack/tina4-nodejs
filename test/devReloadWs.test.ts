/**
 * Tests for the WebSocket-primary DevReload path.
 *
 * DevReload is WebSocket-primary: POST /__dev/api/reload re-imports the changed
 * route in-process and then broadcasts an instant reload message to every
 * browser connected on /__dev_reload. The mtime poll is only a fallback.
 *
 * Mirrors tina4-python/tests/test_dev_reload_ws.py:
 *   - devReloadWs accepts a /__dev_reload handshake and holds the socket.
 *   - devReloadWs.broadcast() reaches a connected client; failures never throw.
 *   - End-to-end against a live server (no Rust CLI — the POST is issued
 *     directly, exactly as the CLI watcher does): a real browser WS on
 *     /__dev_reload receives {type:"reload",...}, the edited route is served
 *     in-process (V1 -> V2), and the server is NOT respawned.
 *
 * Run with: npx tsx test/devReloadWs.test.ts
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { devReloadWs, computeAcceptKey } from "../packages/core/src/index.ts";

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

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

console.log("=== DevReload WebSocket Tests ===\n");

// ── Unit: devReloadWs accepts the handshake + broadcasts ────────────────────

console.log("--- devReloadWs handshake + broadcast ---");

await (async () => {
  // Stand up a bare HTTP server and wire its upgrade event to devReloadWs,
  // exactly as server.ts does for the /__dev_reload route in debug mode.
  const srv = createServer((_req, res) => {
    res.writeHead(426);
    res.end("Upgrade Required");
  });
  srv.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] === "/__dev_reload") {
      devReloadWs.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;

  // Raw RFC 6455 client: handshake, then await the first text frame.
  const key = randomBytes(16).toString("base64");
  const sizeBefore = devReloadWs.size;
  const result = await new Promise<{ accepted: boolean; payload: string | null }>((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(
        `GET /__dev_reload HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    let accepted = false;
    const timer = setTimeout(() => { sock.destroy(); resolve({ accepted, payload: null }); }, 5000);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        accepted = head.includes("101") &&
          head.includes(`Sec-WebSocket-Accept: ${computeAcceptKey(key)}`);
        handshakeDone = true;
        buf = buf.slice(idx + 4);
        // Once connected, trigger a broadcast from the server side.
        setTimeout(() => devReloadWs.broadcast(JSON.stringify({ type: "reload", file: "x", mtime: 1 })), 50);
      }
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len).toString("utf-8");
      clearTimeout(timer);
      sock.destroy();
      resolve({ accepted, payload });
    });
    sock.on("error", () => { clearTimeout(timer); resolve({ accepted, payload: null }); });
  });

  assert("handshake accepted (101 + correct Sec-WebSocket-Accept)", result.accepted);
  assert("client tracked while open (size grew)", devReloadWs.size > sizeBefore,
    `before=${sizeBefore} after=${devReloadWs.size}`);
  assert("broadcast delivered a text frame", result.payload !== null);
  let parsed: any = null;
  try { parsed = JSON.parse(result.payload ?? ""); } catch { /* leave null */ }
  assert("broadcast payload is JSON {type:reload,...}", parsed?.type === "reload" && parsed?.file === "x");

  srv.close();
})();

// broadcast() must never throw, even with zero clients.
console.log("\n--- broadcast safety ---");
let threw = false;
try {
  devReloadWs.broadcast(JSON.stringify({ type: "reload", file: "y", mtime: 2 }));
} catch {
  threw = true;
}
assert("broadcast with no/extra clients never throws", !threw);

// ── Integration: live server, real WebSocket round-trip ─────────────────────

console.log("\n--- live round-trip (edit + reload, no respawn) ---");

await (async () => {
  // Throwaway project lives UNDER the monorepo so `@tina4/core` resolves the
  // workspace exactly as the monorepo does (node_modules resolution walks up to
  // REPO_ROOT/node_modules). A tmpdir + symlink trips Node's CJS exports
  // resolver on the .ts "import" condition.
  const proj = join(REPO_ROOT, "tmp", `devreload-test-${Date.now()}`);
  const routes = join(proj, "src", "routes");
  mkdirSync(routes, { recursive: true });
  // .js route: routeDiscovery's mtime cache-bust re-import is reliable for .js
  // under Node's native ESM loader (the production/built path). See the
  // tsx-.ts caveat noted in the report.
  const routeFile = join(routes, "get.js");
  writeFileSync(routeFile, 'export default async function (req, res) {\n  return res.html("<h1>Version 1</h1>");\n}\n');
  writeFileSync(join(proj, "app.ts"), 'import { startServer } from "@tina4/core";\nstartServer();\n');
  writeFileSync(join(proj, ".env"),
    "TINA4_DEBUG=true\nTINA4_LOG_LEVEL=ERROR\nTINA4_OVERRIDE_CLIENT=true\n" +
    "TINA4_NO_BROWSER=true\nTINA4_SUPPRESS=true\nTINA4_NO_AI_PORT=true\n");

  // Free port.
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
  });

  const log: string[] = [];
  const proc = spawn("npx", ["tsx", "app.ts"], {
    cwd: proj,
    env: { ...process.env, NODE_PATH: join(REPO_ROOT, "node_modules"), PORT: String(port) },
  });
  proc.stdout.on("data", (d) => log.push(d.toString()));
  proc.stderr.on("data", (d) => log.push(d.toString()));

  const httpGet = (path: string) => new Promise<{ status: number; body: string }>((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "GET", timeout: 8000 }, (resp) => {
      let d = ""; resp.on("data", (c) => d += c); resp.on("end", () => res({ status: resp.statusCode ?? 0, body: d }));
    });
    r.on("error", rej); r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); }); r.end();
  });
  const httpPost = (path: string, body: unknown) => new Promise<{ status: number }>((res, rej) => {
    const p = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, path, method: "POST", timeout: 8000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p) } }, (resp) => {
      let d = ""; resp.on("data", (c) => d += c); resp.on("end", () => res({ status: resp.statusCode ?? 0 }));
    });
    r.on("error", rej); r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); }); r.write(p); r.end();
  });
  const wsRecvOne = (path: string, timeoutMs: number) => new Promise<{ connected: boolean; payload: string | null }>((resolve) => {
    const key = randomBytes(16).toString("base64");
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0), hs = false, connected = false;
    const timer = setTimeout(() => { sock.destroy(); resolve({ connected, payload: null }); }, timeoutMs);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!hs) {
        const idx = buf.indexOf("\r\n\r\n"); if (idx === -1) return;
        connected = buf.slice(0, idx).toString().split("\r\n")[0].includes("101");
        if (!connected) { clearTimeout(timer); sock.destroy(); return resolve({ connected: false, payload: null }); }
        hs = true; buf = buf.slice(idx + 4);
      }
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len).toString("utf-8");
      clearTimeout(timer); sock.destroy(); resolve({ connected: true, payload });
    });
    sock.on("error", () => { clearTimeout(timer); resolve({ connected, payload: null }); });
  });

  try {
    // Wait until the server serves V1.
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await httpGet("/"); if (r.status === 200 && r.body.includes("Version 1")) { ready = true; break; } } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) console.log("  [server log]\n" + log.join("").split("\n").map((l) => "    " + l).join("\n"));
    assert("server started serving Version 1", ready);
    assert("server process alive at startup", proc.exitCode === null);
    const pidBefore = proc.pid;

    // Connect a browser-like WS client; once it's up, edit + POST.
    const clientP = wsRecvOne("/__dev_reload", 15000);
    await new Promise((r) => setTimeout(r, 700));

    // Edit handler V1 -> V2 and bump mtime so the in-process re-import detects it.
    writeFileSync(routeFile, 'export default async function (req, res) {\n  return res.html("<h1>Version 2</h1>");\n}\n');
    const future = (Date.now() + 5000) / 1000;
    utimesSync(routeFile, future, future);

    const post = await httpPost("/__dev/api/reload", { type: "code", file: "src/routes/get.js" });
    assert("POST /__dev/api/reload -> 200", post.status === 200);

    const ws = await clientP;
    assert("WS handshake on /__dev_reload succeeded (route registered)", ws.connected,
      "404 means /__dev_reload was never registered");
    let msg: any = null;
    try { msg = JSON.parse(ws.payload ?? ""); } catch { /* leave null */ }
    assert("WS client received the broadcast", ws.payload !== null);
    assert("broadcast type === reload", msg?.type === "reload");
    assert("broadcast file === src/routes/get.js", msg?.file === "src/routes/get.js");
    assert("broadcast has numeric mtime", typeof msg?.mtime === "number");

    // In-process re-import — V2 served, no restart.
    const v2 = await httpGet("/");
    assert("GET / now serves Version 2 (in-process re-import)", v2.body.includes("Version 2"),
      "served: " + v2.body.slice(0, 40));

    // Same process — no respawn.
    assert("server process still alive (no respawn)", proc.exitCode === null);
    assert("server PID unchanged (no respawn)", proc.pid === pidBefore, `${pidBefore} -> ${proc.pid}`);
    assert("no shutdown logged", !/shutting down|shutdown/i.test(log.join("")));
  } finally {
    proc.kill("SIGKILL");
    try { rmSync(proj, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})();

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

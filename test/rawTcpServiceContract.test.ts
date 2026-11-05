// Copyright (c) 2026 Code Infinity
// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Raw TCP service contract — feature 142, ADR-0102 (Node port of the Python
// reference tests). Every case runs a REAL client socket against a REAL
// in-process listener — no mocks, no doubles. The pure cases drive the service's
// own net.Server on this event loop; two cases spawn a REAL framework child
// server so the listener folds into the genuine boot and shutdown path.
//
// Each test names, in a comment, the mutation that must turn it red.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { request } from "node:http";
import { TcpService, tcpService, tcp, clearTcpRegistry } from "../packages/core/src/tcp.ts";

const __dirname = import.meta.dirname;
const REPO = resolve(__dirname, "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const spawned = new Set<ChildProcess>();
function reapAll(): void {
  for (const child of spawned) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* group gone */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
  spawned.clear();
}
process.on("exit", reapAll);

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => res(p));
    });
  });
}

function portAccepts(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (v: boolean) => { sock.destroy(); res(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function connect(port: number): Promise<Socket> {
  return new Promise((res, rej) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => res(sock));
    sock.once("error", rej);
  });
}

// Read exactly n bytes from a client socket, or "" on timeout.
function readExactly(sock: Socket, n: number, timeoutMs = 2000): Promise<Buffer> {
  return new Promise((res) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) finish();
    };
    const finish = (): void => {
      clearTimeout(timer);
      sock.off("data", onData);
      res(Buffer.concat(chunks).subarray(0, Math.max(n, total)));
    };
    const timer = setTimeout(finish, timeoutMs);
    sock.on("data", onData);
  });
}

async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(10);
  }
  return fn();
}

const started: TcpService[] = [];
async function startService(options: ConstructorParameters<typeof TcpService>[1]): Promise<TcpService> {
  const svc = new TcpService(0, options);
  await svc.start("127.0.0.1");
  started.push(svc);
  return svc;
}

function loginService(): Promise<TcpService> {
  return startService({
    onData: (conn, data) => {
      const text = data.toString("latin1");
      if (text.startsWith("LOGIN:")) conn.identify(text.slice(6));
    },
  });
}

// ── Pure cases ────────────────────────────────────────────────────────────────

async function pureCases(): Promise<void> {
  // tcp-callbacks-raw-and-line: on_data raw, not newline-split.
  // Mutation: split onData on newlines and the joined bytes differ.
  {
    const received: Buffer[] = [];
    const svc = await startService({ onData: (_c, d) => { received.push(d); } });
    const sock = await connect(svc.boundPort);
    sock.write("a\nb\nc");
    await waitUntil(() => Buffer.concat(received).toString() === "a\nb\nc");
    const joined = Buffer.concat(received).toString();
    assert("on_data delivers raw bytes not split on newlines", joined === "a\nb\nc" && joined.includes("\n"), `got ${JSON.stringify(joined)}`);
    sock.destroy();
  }

  // on_line splits, terminator stripped, tail buffered.
  // Mutation: stop stripping \r, or deliver the tail early.
  {
    const lines: string[] = [];
    const svc = await startService({ onLine: (_c, l) => { lines.push(l.toString()); } });
    const sock = await connect(svc.boundPort);
    sock.write("a\r\nb\nc");
    await waitUntil(() => lines.join(",") === "a,b");
    assert("on_line splits a newline stream, terminator stripped, tail buffered", lines.join(",") === "a,b", `got ${JSON.stringify(lines)}`);
    sock.write("\n");
    await waitUntil(() => lines.join(",") === "a,b,c");
    assert("on_line delivers the tail only once terminated", lines.join(",") === "a,b,c", `got ${JSON.stringify(lines)}`);
    sock.destroy();
  }

  // on_close fires once when the peer closes.
  // Mutation: fire onClose twice/never, or skip removal.
  {
    let closes = 0;
    const svc = await startService({ onClose: () => { closes += 1; } });
    const sock = await connect(svc.boundPort);
    await waitUntil(() => svc.count() === 1);
    sock.destroy();
    await waitUntil(() => closes === 1 && svc.count() === 0);
    assert("on_close fires exactly once when the peer closes", closes === 1 && svc.count() === 0, `closes=${closes} count=${svc.count()}`);
  }

  // tcp-binary-roundtrip-ack.
  // Mutation: have send() mangle/reorder bytes and the read fails.
  {
    const ack = Buffer.from([0x78, 0x78, 0x05, 0x01]);
    const svc = await startService({ onData: (c) => { c.send(ack); } });
    const sock = await connect(svc.boundPort);
    sock.write(Buffer.from([0x78, 0x78, 0x11, 0x0a, 0xff, 0x00]));
    const got = await readExactly(sock, ack.length);
    assert("a binary frame round-trips and is ACKed", got.equals(ack), `got ${got.toString("hex")}`);
    sock.destroy();
  }

  // tcp-identify-registry-push: identify + send_to reaches that socket.
  // Mutation: make _registerId a no-op and send_to never arrives.
  {
    const svc = await loginService();
    const sock = await connect(svc.boundPort);
    sock.write("LOGIN:imeiA");
    const ok = await waitUntil(() => svc.connection("imeiA") !== null);
    assert("identify registers the connection under its id", ok);
    svc.sendTo("imeiA", "CMD1");
    const got = await readExactly(sock, 4);
    assert("send_to reaches the identified socket", got.toString() === "CMD1", `got ${JSON.stringify(got.toString())}`);
    sock.destroy();
  }

  // send_to is isolated to the addressed device.
  // Mutation: broadcast instead of addressing one, and B wrongly receives.
  {
    const svc = await loginService();
    const a = await connect(svc.boundPort);
    const b = await connect(svc.boundPort);
    a.write("LOGIN:imeiA");
    b.write("LOGIN:imeiB");
    await waitUntil(() => svc.connection("imeiA") !== null && svc.connection("imeiB") !== null);
    let bReceived = 0;
    b.on("data", () => { bReceived += 1; });
    svc.sendTo("imeiA", "ONLYA");
    const got = await readExactly(a, 5);
    await sleep(200);
    assert("send_to is isolated to the addressed device", got.toString() === "ONLYA" && bReceived === 0, `a=${got.toString()} bReceived=${bReceived}`);
    a.destroy();
    b.destroy();
  }

  // send_to to an unknown id is a no-op, not a throw.
  {
    const svc = await loginService();
    let threw = false;
    let result = true;
    try { result = svc.sendTo("ghost", "CMD"); } catch { threw = true; }
    assert("send_to to an unknown id is a no-op not a throw", !threw && result === false);
  }

  // broadcast reaches every live connection.
  // Mutation: iterate a subset and a client misses the message.
  {
    const svc = await loginService();
    const socks: Socket[] = [];
    for (const id of ["imei1", "imei2", "imei3"]) {
      const s = await connect(svc.boundPort);
      s.write(`LOGIN:${id}`);
      socks.push(s);
    }
    await waitUntil(() => svc.count() === 3);
    const delivered = svc.broadcast("PING!");
    let allGot = delivered === 3;
    for (const s of socks) {
      const got = await readExactly(s, 5);
      if (got.toString() !== "PING!") allGot = false;
      s.destroy();
    }
    assert("broadcast reaches every live connection", allGot, `delivered=${delivered}`);
  }

  // re-identify with the same id supersedes the first.
  // Mutation: keep the first registered and send_to reaches the stale socket.
  {
    const svc = await loginService();
    const s1 = await connect(svc.boundPort);
    s1.write("LOGIN:imeiA");
    await waitUntil(() => svc.connection("imeiA") !== null);
    const first = svc.connection("imeiA");
    const s2 = await connect(svc.boundPort);
    s2.write("LOGIN:imeiA");
    await waitUntil(() => svc.connection("imeiA") !== first);
    let s1Received = 0;
    s1.on("data", () => { s1Received += 1; });
    svc.sendTo("imeiA", "TO2!!");
    const got = await readExactly(s2, 5);
    await sleep(200);
    assert("re-identify supersedes the first", got.toString() === "TO2!!" && s1Received === 0, `got=${got.toString()} s1Received=${s1Received}`);
    s1.destroy();
    s2.destroy();
  }

  // tcp-connection-object: remoteAddr is the raw socket peer.
  // Mutation: return a header value and the loopback assert fails.
  {
    const seen: string[] = [];
    const svc = await startService({ onConnect: (c) => { seen.push(c.remoteAddr); } });
    const sock = await connect(svc.boundPort);
    await waitUntil(() => seen.length > 0);
    assert("remoteAddr is the raw socket peer", seen[0]?.includes("127.0.0.1") ?? false, `got ${seen[0]}`);
    sock.destroy();
  }

  // context persists across on_data calls for one connection.
  // Mutation: rebuild context per call and the accumulated buffer is lost.
  {
    const svc = await startService({
      onData: (c, d) => { c.context.buf = String(c.context.buf ?? "") + d.toString(); },
    });
    const s1 = await connect(svc.boundPort);
    s1.write("AA");
    await sleep(60);
    s1.write("BB");
    const bufReached = await waitUntil(() => anyContextBuf(svc, "AABB"));
    const s2 = await connect(svc.boundPort);
    s2.write("ZZ");
    await waitUntil(() => anyContextBuf(svc, "ZZ"));
    assert("context persists across on_data for one connection", bufReached && anyContextBuf(svc, "AABB") && anyContextBuf(svc, "ZZ"));
    s1.destroy();
    s2.destroy();
  }

  // close() ends the connection, fires on_close, removes the registry entry.
  // Mutation: skip removal in close() and count stays 1.
  {
    const closed: (string | null)[] = [];
    const svc = await loginService();
    (svc as unknown as { _callbacks: { onClose?: (c: TcpConnection) => void } })._callbacks.onClose = (c) => { closed.push(c.id); };
    const sock = await connect(svc.boundPort);
    sock.write("LOGIN:imeiZ");
    await waitUntil(() => svc.connection("imeiZ") !== null);
    const conn = svc.connection("imeiZ")!;
    let eof = false;
    sock.on("end", () => { eof = true; });
    sock.on("close", () => { eof = true; });
    conn.close();
    await waitUntil(() => eof);
    await waitUntil(() => closed.length === 1 && svc.count() === 0);
    assert("close ends the connection, fires on_close once, removes registry entry", eof && closed.length === 1 && closed[0] === "imeiZ" && svc.connection("imeiZ") === null, `closed=${JSON.stringify(closed)} count=${svc.count()}`);
    sock.destroy();
  }

  // tcp-max-connections-refusal.
  // Mutation: drop the limit check and count hits 3.
  {
    const svc = await startService({ maxConnections: 2 });
    const a = await connect(svc.boundPort);
    const b = await connect(svc.boundPort);
    await waitUntil(() => svc.count() === 2);
    const c = await connect(svc.boundPort);
    let cClosed = false;
    c.on("close", () => { cClosed = true; });
    await waitUntil(() => cClosed);
    await sleep(100);
    assert("the (N+1)th connection is refused", cClosed && svc.count() === 2, `count=${svc.count()} cClosed=${cClosed}`);
    a.destroy(); b.destroy(); c.destroy();
  }

  // tcp-idle-reaper-default-off: idle_timeout=0 keeps a silent connection open.
  // Mutation: reap when timeout==0 and the silent connection is closed.
  {
    const svc = await startService({ idleTimeout: 0 });
    const sock = await connect(svc.boundPort);
    await waitUntil(() => svc.count() === 1);
    await sleep(600);
    assert("idle_timeout=0 keeps a silent connection open", svc.count() === 1, `count=${svc.count()}`);
    sock.destroy();
  }

  // idle_timeout>0 reaps only the silent connection.
  // Mutation: reap on activity too and the active one dies.
  {
    let closes = 0;
    const svc = await startService({ idleTimeout: 0.3, onClose: () => { closes += 1; } });
    const silent = await connect(svc.boundPort);
    const active = await connect(svc.boundPort);
    await waitUntil(() => svc.count() === 2);
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      active.write("x");
      await sleep(80);
    }
    const reaped = await waitUntil(() => closes === 1, 1500);
    assert("idle_timeout>0 reaps only the silent connection", reaped && svc.count() === 1, `closes=${closes} count=${svc.count()}`);
    silent.destroy();
    active.destroy();
  }

  // tcp-backpressure: a stalled reader is bounded and dropped, others serve.
  // Mutation: remove the backlog check in send() and the loop never returns false.
  {
    const conns: TcpConnectionLike[] = [];
    const svc = await startService({
      maxBacklog: 65536,
      onConnect: (c) => { conns.push(c); },
      onData: (c, d) => { c.send(d); },
    });
    const stalled = await connect(svc.boundPort);
    stalled.pause(); // never read
    await waitUntil(() => conns.length === 1);
    const serverConn = conns[0];
    let dropped = false;
    for (let i = 0; i < 2000; i++) {
      if (!serverConn.send(Buffer.alloc(16384, 0x78))) { dropped = true; break; }
    }
    assert("a stalled reader is bounded and dropped", dropped && serverConn.isClosed, `dropped=${dropped} closed=${serverConn.isClosed}`);
    const ok = await connect(svc.boundPort);
    ok.write("ping");
    const echoed = await readExactly(ok, 4);
    assert("other connections keep serving after a stalled drop", echoed.toString() === "ping", `got ${echoed.toString()}`);
    stalled.destroy();
    ok.destroy();
  }

  // tcp-single-owner-bind.
  // Mutation: let the second bind succeed / throw and this fails.
  {
    const port = await freePort();
    const owner = new TcpService(port, { name: "owner" });
    const second = new TcpService(port, { name: "owner" });
    started.push(owner, second);
    const ownerBound = await owner.start("127.0.0.1");
    const secondBound = await second.start("127.0.0.1");
    const sock = await connect(port);
    const accepted = await waitUntil(() => owner.count() === 1);
    assert("only one owner binds the TCP port", ownerBound && owner.isOwner && secondBound === false && second.isOwner === false && accepted);
    sock.destroy();
  }

  // the public tcpService() + tcp() registry accessor.
  {
    const svc = tcpService(0, { name: "trackers" });
    started.push(svc);
    let threw = false;
    try { tcp("nope"); } catch { threw = true; }
    assert("tcpService registers a service reachable via tcp(); unknown throws", tcp("trackers") === svc && threw);
  }

  // stop() drains live connections (client sees EOF) and fires on_close.
  // Mutation: make drain() skip closing connections and the client never sees EOF.
  {
    let closes = 0;
    const svc = await startService({ onClose: () => { closes += 1; } });
    const sock = await connect(svc.boundPort);
    let eof = false;
    sock.on("close", () => { eof = true; });
    await waitUntil(() => svc.count() === 1);
    await svc.stop();
    await waitUntil(() => eof && closes === 1);
    assert("stop() drains live connections and fires on_close", eof && closes === 1, `eof=${eof} closes=${closes}`);
    sock.destroy();
  }
}

interface TcpConnectionLike { send(data: Buffer | string): boolean; isClosed: boolean }

function anyContextBuf(svc: TcpService, want: string): boolean {
  const conns = (svc as unknown as { connections: Set<{ context: Record<string, unknown> }> }).connections;
  for (const c of conns) if (c.context.buf === want) return true;
  return false;
}

// ── Child-server cases (REAL spawned framework server) ──────────────────────────

interface Booted { child: ChildProcess; httpPort: number; tcpPort: number; logPath: string }

async function bootChild(extraEnv: Record<string, string> = {}): Promise<Booted> {
  const httpPort = await freePort();
  const tcpPort = httpPort + 1;
  const root = mkdtempSync(join(tmpdir(), "tina4-tcp-"));
  const routes = join(root, "src", "routes", "ping");
  mkdirSync(routes, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"tcp-probe","type":"module","private":true}\n');
  writeFileSync(join(routes, "get.ts"), "export default async function (_req: any, res: any) { return res({ ok: true }, 200); }\n");
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer, tcpService } from '${REPO}/packages/core/src/index.ts';\n` +
      `tcpService(${tcpPort}, { name: 'trackers', onConnect: (c) => c.send('HELLO\\n'), onData: (c, d) => c.send(Buffer.concat([Buffer.from('ECHO:'), d])) });\n` +
      `await startServer({ port: ${httpPort}, routesDir: '${join(root, "src", "routes")}' } as never);\n`,
  );
  const logPath = join(root, "server.log");
  const logFd = openSync(logPath, "w");
  const child = spawn(TSX, ["app.ts"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, TINA4_OVERRIDE_CLIENT: "true", TINA4_NO_BROWSER: "true", TINA4_SUPPRESS: "true", TINA4_NO_AI_PORT: "true", TINA4_DEBUG: "false", TINA4_SECRET: "tina4-raw-tcp-contract-suite-secret-0123456789", PORT: String(httpPort), ...extraEnv },
  });
  spawned.add(child);
  closeSync(logFd);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await portAccepts(httpPort)) && (await portAccepts(tcpPort))) return { child, httpPort, tcpPort, logPath };
    if (child.exitCode !== null) throw new Error(`child died during boot:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
    await sleep(50);
  }
  throw new Error(`child never opened both ports:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
}

function httpStatus(port: number): Promise<number> {
  return new Promise((res) => {
    const req = request({ host: "127.0.0.1", port, path: "/ping", method: "GET", timeout: 5000 }, (r) => {
      r.on("data", () => undefined);
      r.on("end", () => res(r.statusCode ?? 0));
    });
    req.once("error", () => res(0));
    req.once("timeout", () => { req.destroy(); res(0); });
    req.end();
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((res) => {
    if (child.exitCode !== null) { res(child.exitCode); return; }
    const timer = setTimeout(() => res(null), timeoutMs);
    child.once("exit", (code) => { clearTimeout(timer); res(code); });
  });
}

async function childCases(): Promise<void> {
  // tcp-listen-accept-in-process while HTTP still serves.
  // Mutation: don't start TCP services in startServer and the greeting never arrives.
  {
    const b = await bootChild();
    const tcpSock = await connect(b.tcpPort);
    const greeting = await readExactly(tcpSock, 6, 5000);
    const status = await httpStatus(b.httpPort);
    assert("listen+accept in-process while HTTP still serves", greeting.toString() === "HELLO\n" && status === 200, `greeting=${JSON.stringify(greeting.toString())} status=${status}`);
    tcpSock.destroy();
    if (b.child.pid) { try { process.kill(-b.child.pid, "SIGKILL"); } catch { /* gone */ } }
  }

  // tcp-graceful-shutdown-drain: SIGTERM drains the live TCP connection, exit 0.
  // Mutation: skip drainAllTcpServices() on shutdown and the client EOF/exit stalls.
  {
    const b = await bootChild({ TINA4_SHUTDOWN_TIMEOUT: "10" });
    const tcpSock = await connect(b.tcpPort);
    await readExactly(tcpSock, 6, 5000);
    let eof = false;
    tcpSock.on("close", () => { eof = true; });
    if (b.child.pid) process.kill(-b.child.pid, "SIGTERM");
    await waitUntil(() => eof, 12000);
    const code = await waitForExit(b.child, 12000);
    assert("SIGTERM drains the live TCP connection and exits 0", eof && code === 0, `eof=${eof} code=${code}`);
    tcpSock.destroy();
  }
}

async function main(): Promise<void> {
  console.log("Raw TCP service contract (feature 142, ADR-0102)");
  try {
    await pureCases();
    if (!process.env.TCP_PURE_ONLY) await childCases();
  } finally {
    for (const svc of started) { try { await svc.stop(); } catch { /* ignore */ } }
    clearTcpRegistry();
    reapAll();
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

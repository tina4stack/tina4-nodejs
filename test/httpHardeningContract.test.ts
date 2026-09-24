/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * HTTP hardening contract (ADR-0068) - the Node runner for
 * tina4-documentation/plan/v3/fixtures/http_hardening_contract.json.
 *
 * node:http's setHeader() already refuses CR, LF and NUL, so a header or a
 * redirect built from request input never reached the wire here. Two gaps
 * remained, both closed in response.ts:
 *
 *  - Cookie ATTRIBUTE values were written as given, so a ';' in a path added
 *    an attribute the application never set. Measured before the fix over a
 *    real socket: `?v=/a%3B%20Domain%3Devil.com` answered
 *    `Set-Cookie: pref=v; Path=/a; Domain=evil.com`.
 *  - node:http names a broken header raw (a CR/LF in the name lands in the
 *    message and the log line). The ADR wording quotes it as a JSON literal.
 *
 * Cookie names and values keep being percent-encoded (the ADR's exception for
 * a framework that already encoded them): encoded, they cannot carry CR, LF,
 * NUL or ';' to the wire.
 *
 * All six http_hardening invariants are carried here. The transport side
 * (packages/core/src/transport.ts) was owed until this change; measured before
 * it on a real server: node:http answered 400 with an empty body and no
 * security headers, TINA4_MAX_REQUEST_HEADER and TINA4_REQUEST_TIMEOUT were
 * not read (a 9000-byte head under an 8192 limit was served, a stalled request
 * was never answered 408), and a refused upload stayed open and was read to
 * the end - 64MB read per client after a 413.
 *
 * Two Content-Length headers are refused even when they agree (maintainer
 * ruling on ADR-0068, all four frameworks); llhttp already refuses any pair.
 *
 * NO MOCKS. The response cases run createResponse() over a REAL node:http
 * ServerResponse; the server cases boot a real Tina4 server in a child process
 * and read its answers byte for byte over a raw loopback socket (a real HTTP
 * client would fold or hide the very lines under test). RSS is read from ps.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import net from "node:net";
import { createResponse } from "../packages/core/src/index.ts";
import { createTina4HttpServer } from "../packages/core/src/transport.ts";

const REPO = resolve(import.meta.dirname, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");
const LIMIT = 1_048_576; // TINA4_MAX_UPLOAD_SIZE for every server here
const HEADER_LIMIT = 8192; // TINA4_MAX_REQUEST_HEADER
const IDLE_SECONDS = 3; // TINA4_REQUEST_TIMEOUT

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-xss-protection": "0",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── the real Response over a real node:http ServerResponse ───────────────────

/** Run `probe` inside a real request handler; resolve with what the client got, or what probe threw. */
async function withResponse(
  probe: (response: ReturnType<typeof createResponse>) => void,
): Promise<{ thrown: (Error & { code?: string }) | null; status: number; headers: http.IncomingHttpHeaders }> {
  let thrown: (Error & { code?: string }) | null = null;
  const server = http.createServer((_req, res) => {
    try {
      probe(createResponse(res));
    } catch (err) {
      thrown = err as Error;
    }
    if (!res.writableEnded) res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  try {
    const answer = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolveAnswer, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/" }, (res) => {
          res.resume();
          res.on("end", () => resolveAnswer({ status: res.statusCode ?? 0, headers: res.headers }));
        })
        .on("error", reject);
    });
    return { thrown, ...answer };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function expectRefused(message: string, code: string, probe: (response: ReturnType<typeof createResponse>) => void) {
  const result = await withResponse(probe);
  expect(result.thrown, `expected the refusal: ${message}`).not.toBeNull();
  expect(result.thrown).toBeInstanceOf(TypeError);
  expect(result.thrown!.message).toBe(message);
  expect(result.thrown!.code).toBe(code);
  return result;
}

// ── a real Tina4 server in a child process ───────────────────────────────────

const ROUTES: Record<string, string> = {
  "hello/get.ts": `export default async function (_req: any, res: any) { return res.json({ ok: true }); }`,
  "redirect/get.ts": `export default async function (req: any, res: any) { return res.redirect(req.query.to ?? "/"); }`,
  "echo-header/get.ts": `export default async function (req: any, res: any) { res.header("X-Echo", req.query.v ?? ""); return res.json({ ok: true }); }`,
  "cookie-path/get.ts": `export default async function (req: any, res: any) { res.cookie("pref", "v", { path: req.query.v ?? "/" }); return res.json({ ok: true }); }`,
  "cookie-value/get.ts": `export default async function (req: any, res: any) { res.cookie("pref", req.query.v ?? ""); return res.json({ ok: true }); }`,
  "cookies/get.ts": `export default async function (_req: any, res: any) { res.cookie("first", "one"); res.cookie("second", "two", { path: "/app" }); return res.json({ ok: true }); }`,
  // Bypasses Tina4's Response on purpose: straight onto node:http's header list.
  "direct-append/get.ts": `export default async function (_req: any, res: any) { res.raw.setHeader("X-Direct", "a" + String.fromCharCode(13, 10) + "X-Injected: yes"); return res.json({ ok: true }); }`,
  "upload/post.ts":
    `export const noAuth = true;\n` +
    `export default async function (req: any, res: any) {\n` +
    `  const body = typeof req.body === "string" ? req.body : ""; // octet-stream arrives as text; empty leaves it unset\n` +
    `  return res.json({ size: Buffer.byteLength(body), body });\n` +
    `}\n`,
};

interface Server {
  child: ChildProcess;
  port: number;
  root: string;
  log: () => string;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function bootServer(dotenv?: string): Promise<Server> {
  const root = mkdtempSync(join(tmpdir(), "tina4-hardening-"));
  const routes = join(root, "src", "routes");
  for (const [file, source] of Object.entries(ROUTES)) {
    mkdirSync(join(routes, file, ".."), { recursive: true });
    writeFileSync(join(routes, file), source + "\n");
  }
  const port = await freePort();
  writeFileSync(join(root, "package.json"), '{"name":"hardening","type":"module","private":true}\n');
  if (dotenv !== undefined) writeFileSync(join(root, ".env"), dotenv);
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
      `await startServer({ port: ${port}, routesDir: '${routes}' } as never);\n`,
  );
  const logPath = join(root, "server.log");
  const fd = openSync(logPath, "w");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["TINA4_CSP", "TINA4_FRAME_OPTIONS", "TINA4_REFERRER_POLICY", "TINA4_PERMISSIONS_POLICY", "TINA4_HSTS", "TINA4_MAX_UPLOAD_SIZE", "TINA4_MAX_REQUEST_HEADER", "TINA4_REQUEST_TIMEOUT"]) {
    delete env[name];
  }
  const child = spawn(TSX, ["app.ts"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...env,
      TINA4_OVERRIDE_CLIENT: "true",
      TINA4_NO_BROWSER: "true",
      TINA4_NO_AI_PORT: "true",
      TINA4_DEBUG: "false",
      TINA4_PORT: String(port),
      // With a .env under test, the limits come from it alone.
      ...(dotenv === undefined
        ? {
            TINA4_MAX_UPLOAD_SIZE: String(LIMIT),
            TINA4_MAX_REQUEST_HEADER: String(HEADER_LIMIT),
            TINA4_REQUEST_TIMEOUT: String(IDLE_SECONDS),
          }
        : {}),
    },
  });
  closeSync(fd);
  const server = { child, port, root, log: () => readFileSync(logPath, "utf8") };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/hello`)).status === 200) return server;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  stopServer(server);
  throw new Error(`server never came up on ${port}:\n${server.log().slice(-2000)}`);
}

function stopServer(server: Server): void {
  try {
    if (server.child.pid && server.child.exitCode === null) process.kill(-server.child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(server.root, { recursive: true, force: true });
}

interface Answer {
  status: number | null;
  headers: Record<string, string[]>;
  body: string;
  raw: string;
  firstByteMs: number | null;
}

/** Send raw bytes, read until the server closes the connection or `timeoutMs` passes. */
function exchange(port: number, raw: string | Buffer, timeoutMs = 8000): Promise<Answer> {
  return new Promise((resolveAnswer) => {
    const started = Date.now();
    let firstByteMs: number | null = null;
    let data = Buffer.alloc(0);
    const socket = net.connect(port, "127.0.0.1");
    const finish = (): void => {
      socket.destroy();
      const text = data.toString("latin1");
      const headEnd = text.indexOf("\r\n\r\n");
      const answer: Answer = { status: null, headers: {}, body: "", raw: text, firstByteMs };
      if (headEnd >= 0) {
        const lines = text.slice(0, headEnd).split("\r\n");
        answer.status = Number(lines.shift()!.split(" ")[1]);
        for (const line of lines) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).trim().toLowerCase();
          (answer.headers[name] ??= []).push(line.slice(colon + 1).trim());
        }
        answer.body = text.slice(headEnd + 4);
      }
      resolveAnswer(answer);
    };
    socket.on("data", (chunk) => {
      firstByteMs ??= Date.now() - started;
      data = Buffer.concat([data, chunk]);
    });
    socket.on("error", () => {
      /* a server that answers and closes mid-upload resets the write side */
    });
    socket.on("close", finish);
    socket.setTimeout(timeoutMs, finish);
    socket.write(raw);
  });
}

const get = (path: string): string => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;
const postHead = (extra: string): string =>
  `POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\n${extra}\r\n`;
const describeAnswer = (answer: Answer): string => ` - got: ${JSON.stringify(answer.raw.slice(0, 600))}`;

function rssMegabytes(pid: number): number {
  try {
    const out = execFileSync("bash", ["-c", `ps -Ao rss,pgid | awk -v g=${pid} '$2==g {s+=$1} END {print s+0}'`]).toString().trim();
    return Number(out) / 1024;
  } catch {
    return -1;
  }
}

let server: Server;

beforeAll(async () => {
  server = await bootServer();
}, 90_000);

afterAll(() => {
  if (server) stopServer(server);
});

async function expectServing(port = server.port): Promise<void> {
  const answer = await exchange(port, get("/hello"));
  expect(answer.status, "the server must still serve a normal request" + describeAnswer(answer)).toBe(200);
}

// ── response-header-refuses-crlf-nul ─────────────────────────────────────────

describe("response headers refuse CR, LF and NUL", () => {
  it("a header value containing cr lf or nul is refused", async () => {
    for (const bad of ["a\rb", "a\nb", "a\0b", "a\r\nX-Other: 1"]) {
      const expected = 'Invalid character in header content ["X-Test"]';
      const viaHeader = await expectRefused(expected, "ERR_INVALID_CHAR", (response) => response.header("X-Test", bad));
      expect(viaHeader.headers["x-test"], "a refused header is not stored").toBeUndefined();
      expect(viaHeader.headers["x-other"]).toBeUndefined();
      await expectRefused(expected, "ERR_INVALID_CHAR", (response) => response.addHeader("X-Test", bad));
      await expectRefused(expected, "ERR_INVALID_CHAR", (response) => response.header("X-Test", ["fine", bad]));
    }
  });

  it("a header name that is not a token is refused", async () => {
    // The name is a JSON string literal with non-ASCII escaped - the bytes
    // Python's json.dumps writes - so these are spelled out, not derived.
    const cases: Array<[string, string]> = [
      ["X Test", '"X Test"'],
      ["X:Test", '"X:Test"'],
      ["", '""'],
      ["X\r\nTest", '"X\\r\\nTest"'],
      ["Tëst", '"T\\u00ebst"'],
      ["X(Test)", '"X(Test)"'],
      ["a\u007fb", '"a\\u007fb"'],
    ];
    for (const [bad, quoted] of cases) {
      await expectRefused(`Header name must be a valid HTTP token [${quoted}]`, "ERR_INVALID_HTTP_TOKEN", (response) =>
        response.header(bad, "value"),
      );
    }
  });

  it("a redirect location containing cr or lf is refused", async () => {
    for (const bad of ["/next\r\nX-Other: 1", "/next\n", "/next\0"]) {
      const result = await expectRefused('Invalid character in header content ["Location"]', "ERR_INVALID_CHAR", (response) =>
        response.redirect(bad),
      );
      expect(result.status, "a refused redirect leaves the status alone").toBe(200);
      expect(result.headers.location).toBeUndefined();
    }
    await expectRefused('Invalid character in header content ["Content-Type"]', "ERR_INVALID_CHAR", (response) =>
      response("x", 200, "text/plain\r\nX-Other: 1"),
    );

    // End to end: the audit's shape - a query value passed to redirect() or
    // header() - never puts a header of its own on the wire.
    for (const route of ["/redirect?to=/next", "/echo-header?v=abc"]) {
      for (const suffix of ["%0D%0AX-Injected:%20yes", "%0AX-Injected:%20yes", "%0DX-Injected:%20yes", "%00X-Injected:%20yes"]) {
        const answer = await exchange(server.port, get(route + suffix));
        expect(answer.status, route + suffix + describeAnswer(answer)).toBe(500);
        expect(answer.headers["x-injected"], route + suffix + describeAnswer(answer)).toBeUndefined();
      }
    }
    await expectServing();
  });

  it("normal headers and redirects still work", async () => {
    const result = await withResponse((response) => {
      response.header("X-Plain", "a value, with; punctuation = fine");
      response.header("X-Tab", "a\tb");
      response.header("X-Latin1", "café");
      response.header("X-Number", 42);
      response.redirect("/login?next=/a%20b&x=%0D%0A", 303);
    });
    expect(result.thrown).toBeNull();
    expect(result.status).toBe(303);
    expect(result.headers["x-plain"]).toBe("a value, with; punctuation = fine");
    expect(result.headers["x-tab"]).toBe("a\tb");
    expect(result.headers["x-number"]).toBe("42");
    expect(result.headers.location, "a percent-encoded CR/LF is inert text").toBe("/login?next=/a%20b&x=%0D%0A");

    const echoed = await exchange(server.port, get("/echo-header?v=plain%20value"));
    expect(echoed.status, describeAnswer(echoed)).toBe(200);
    expect(echoed.headers["x-echo"]).toEqual(["plain value"]);
    const redirected = await exchange(server.port, get("/redirect?to=%2Fnext%3Fa%3D1"));
    expect(redirected.status, describeAnswer(redirected)).toBe(302);
    expect(redirected.headers.location).toEqual(["/next?a=1"]);
  });
});

// ── cookie-refuses-injection ─────────────────────────────────────────────────

describe("cookies refuse injection", () => {
  it("a cookie name value or attribute that could inject is refused", async () => {
    const expected = 'Invalid character in cookie content ["sid"]';
    for (const options of [
      { path: "/; Domain=example.com" },
      { path: "/x\r\nX-Other: 1" },
      { path: "/x\0" },
      { domain: "example.com\nX: 1" },
      { sameSite: "Lax; Domain=example.com" },
      { maxAge: "60; Domain=example.com" },
    ]) {
      const result = await expectRefused(expected, "ERR_INVALID_CHAR", (response) => response.cookie("sid", "v", options as never));
      expect(result.headers["set-cookie"], "a refused cookie is not stored").toBeUndefined();
    }

    // Node percent-encodes the name and the value and keeps doing so (the
    // ADR's exception): encoded, they carry no CR, LF, NUL or ';' to the wire.
    const encoded = await withResponse((response) => response.cookie("a;b\r\n", "v; Domain=example.com\r\nX: 1"));
    expect(encoded.thrown).toBeNull();
    expect(encoded.headers["set-cookie"]).toEqual(["a%3Bb%0D%0A=v%3B%20Domain%3Dexample.com%0D%0AX%3A%201"]);

    // End to end: the measured exploit. Before the fix this answered 200 with
    // `Set-Cookie: pref=v; Path=/a; Domain=evil.com`.
    const attribute = await exchange(server.port, get("/cookie-path?v=/a%3B%20Domain%3Devil.com"));
    expect(attribute.status, describeAnswer(attribute)).toBe(500);
    expect(attribute.raw).not.toContain("Domain=evil.com");
    const crlf = await exchange(server.port, get("/cookie-path?v=/a%0D%0AX-Injected:%20yes"));
    expect(crlf.status, describeAnswer(crlf)).toBe(500);
    expect(crlf.headers["x-injected"]).toBeUndefined();
    const value = await exchange(server.port, get("/cookie-value?v=v%3B%20Domain%3Devil.com%0D%0AX-Injected:%20yes"));
    expect(value.status, describeAnswer(value)).toBe(200);
    expect(value.headers["x-injected"]).toBeUndefined();
    expect(value.headers["set-cookie"]?.some((c) => c.startsWith("pref=v%3B%20Domain%3Devil.com%0D%0AX-Injected%3A%20yes"))).toBe(true);
    await expectServing();
  });

  it("multiple set cookie headers all reach the client", async () => {
    const result = await withResponse((response) => {
      response.cookie("first", "one");
      response.cookie("second", "two", { path: "/app", sameSite: "Strict", httpOnly: true });
    });
    expect(result.headers["set-cookie"]).toEqual(["first=one", "second=two; Path=/app; HttpOnly; SameSite=Strict"]);

    const answer = await exchange(server.port, get("/cookies"));
    expect(answer.status, describeAnswer(answer)).toBe(200);
    expect(answer.headers["set-cookie"]).toContain("first=one");
    expect(answer.headers["set-cookie"]).toContain("second=two; Path=/app");
  });
});

// ── builtin-server-refuses-unsafe-header ─────────────────────────────────────

describe("the server's writer", () => {
  it("the built in server refuses to write an unsafe header", async () => {
    // node:http refuses the header at setHeader(), so it never joins the list
    // the writer sends.
    const answer = await exchange(server.port, get("/direct-append"));
    expect(answer.status, describeAnswer(answer)).toBe(500);
    // Parity (maintainer decision on ADR-0068 section 2): node:http refusing
    // natively is fine only if the client gets the fixture's answer.
    expect(answer.body, describeAnswer(answer)).toBe('{"error":"Invalid response header"}');
    expect(answer.headers.connection).toEqual(["close"]);
    expect(answer.headers["x-direct"], describeAnswer(answer)).toBeUndefined();
    expect(answer.headers["x-injected"], describeAnswer(answer)).toBeUndefined();
    await sleep(200);
    expect(server.log(), "the refusal is logged naming the header").toContain("X-Direct");
    await expectServing();
  });
});

// ── builtin-server-body-cap-before-read ──────────────────────────────────────

const body413 = (bytes: number): string =>
  `{"error":"Request body (${bytes} bytes) exceeds TINA4_MAX_UPLOAD_SIZE (${LIMIT} bytes)"}`;

describe("the body cap", () => {
  it("a declared content length over the cap is refused before the body is read", async () => {
    const declared = 50 * 1_048_576;
    const answer = await exchange(server.port, postHead(`Content-Length: ${declared}\r\n`), 3000);
    expect(answer.status, describeAnswer(answer)).toBe(413);
    expect(answer.body).toBe(body413(declared));
    expect(answer.headers.connection, "a refused upload closes the connection").toEqual(["close"]);
    // Answered at once, without a body byte sent.
    expect(answer.firstByteMs!, `first byte after ${answer.firstByteMs}ms`).toBeLessThan(2000);
    await expectServing();
  }, 15_000);

  it("a chunked body over the cap is refused as it arrives", async () => {
    const piece = Buffer.concat([Buffer.from(`${(65536).toString(16)}\r\n`), Buffer.alloc(65536, 0x61), Buffer.from("\r\n")]);
    const raw = Buffer.concat([Buffer.from(postHead("Transfer-Encoding: chunked\r\n")), ...Array(32).fill(piece), Buffer.from("0\r\n\r\n")]);
    const answer = await exchange(server.port, raw, 3000);
    expect(answer.status, describeAnswer(answer)).toBe(413);
    // The running count is whatever had arrived when it passed the cap - it
    // depends on how the socket delivered the chunks, so it is read back.
    const counted = Number(/Request body \((\d+) bytes\)/.exec(answer.body)?.[1]);
    expect(counted).toBeGreaterThan(LIMIT);
    expect(answer.body).toBe(body413(counted));
    await expectServing();
  }, 15_000);

  it("an oversized declared body does not grow server memory", async () => {
    // Measured in bytes the server let in, not RSS: each client declares 256MB
    // and pushes up to 64MB, counting only the bytes the kernel accepted
    // (a write's callback fires once its data left the process). A server that
    // stops reading after its 413 lets in the 1MB cap plus the socket buffers
    // and then closes; one that keeps reading - to drain the body for
    // keep-alive - lets in all 64MB. Measured before the fix: all of it, for
    // every client, and 44MB of RSS for six of them.
    const pushes = await Promise.all(
      Array.from({ length: 6 }, () => pushUntilStopped(server.port, postHead(`Content-Length: ${256 * 1_048_576}\r\n`), 64 * 1_048_576)),
    );
    for (const push of pushes) console.log(`  refused upload: ${(push.acceptedBytes / 1_048_576).toFixed(1)}MB let in, ended by ${push.how}, ${JSON.stringify(push.response.slice(0, 30))}`);
    for (const push of pushes) {
      expect(push.response, "every client is told why").toMatch(/^HTTP\/1\.1 413 /);
      expect(push.acceptedBytes, `the server let in ${(push.acceptedBytes / 1_048_576).toFixed(1)}MB after refusing`).toBeLessThan(24 * 1_048_576);
      expect(push.closed, "the server closes a refused upload").toBe(true);
    }
    await expectServing();
  }, 60_000);

  it("a refused request is not read any further", async () => {
    // The server-side count the child-process case cannot see: the real
    // transport on a real socket in this process, so socket.bytesRead is the
    // bytes the server actually read. Each client keeps pushing 64MB after the
    // server has answered; the server may read what was already in flight,
    // never the rest. Before the fix node:http read and discarded all of it
    // (after a 413, to keep the connection alive; after a parse error, into a
    // parser that had already failed).
    const saved = { upload: process.env.TINA4_MAX_UPLOAD_SIZE, header: process.env.TINA4_MAX_REQUEST_HEADER };
    process.env.TINA4_MAX_UPLOAD_SIZE = String(LIMIT);
    process.env.TINA4_MAX_REQUEST_HEADER = String(HEADER_LIMIT);
    const transport = createTina4HttpServer(async (req, res) => {
      // Stands in for the router: reads the body under the running count the
      // way req.parseBody() does, via the real request module.
      const { createRequest } = await import("../packages/core/src/request.ts");
      const { sendTransportRejection } = await import("../packages/core/src/transport.ts");
      try {
        await createRequest(req).parseBody();
        res.end("ok");
      } catch (err) {
        sendTransportRejection(res, 413, (err as Error).message);
      }
    });
    const readBySocket: number[] = [];
    transport.on("connection", (socket: net.Socket) => socket.on("close", () => readBySocket.push(socket.bytesRead)));
    await new Promise<void>((r) => transport.listen(0, "127.0.0.1", r));
    const { port } = transport.address() as net.AddressInfo;
    try {
      const cases: Array<[string, string]> = [
        ["declared over the cap", postHead(`Content-Length: ${256 * 1_048_576}\r\n`)],
        ["chunked over the cap", postHead("Transfer-Encoding: chunked\r\n") + `${(64 * 1_048_576).toString(16)}\r\n`],
        ["malformed head", "GET /hello\nX HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"],
        ["invalid Content-Length", postHead("Content-Length: abc\r\n")],
      ];
      for (const [label, head] of cases) {
        readBySocket.length = 0;
        const push = await pushUntilStopped(port, head, 64 * 1_048_576);
        const deadline = Date.now() + 5000;
        while (readBySocket.length === 0 && Date.now() < deadline) await sleep(50);
        expect(push.response, `${label}: answered`).toMatch(/^HTTP\/1\.1 (400|413) /);
        expect(readBySocket[0], `${label}: the server read ${((readBySocket[0] ?? 0) / 1_048_576).toFixed(1)}MB of a refused request`).toBeLessThan(LIMIT + 512 * 1024);
      }
    } finally {
      await new Promise<void>((r) => transport.close(() => r()));
      if (saved.upload === undefined) delete process.env.TINA4_MAX_UPLOAD_SIZE;
      else process.env.TINA4_MAX_UPLOAD_SIZE = saved.upload;
      if (saved.header === undefined) delete process.env.TINA4_MAX_REQUEST_HEADER;
      else process.env.TINA4_MAX_REQUEST_HEADER = saved.header;
    }
  }, 60_000);

  it("the upload cap set in .env is honoured", async () => {
    // request.ts read TINA4_MAX_UPLOAD_SIZE when it was imported, before
    // startServer() loaded .env, so a cap written in .env was silently ignored
    // and the 10MB default applied. The ADR-0068 limits all resolve from the
    // process environment first, then .env.
    const dotenvServer = await bootServer("TINA4_MAX_UPLOAD_SIZE=2048\nTINA4_MAX_REQUEST_HEADER=4096\n");
    try {
      const chunked = await exchange(
        dotenvServer.port,
        postHead("Transfer-Encoding: chunked\r\nConnection: close\r\n") + `1000\r\n${"a".repeat(4096)}\r\n0\r\n\r\n`,
      );
      expect(chunked.status, describeAnswer(chunked)).toBe(413);
      expect(chunked.body).toBe('{"error":"Request body (4096 bytes) exceeds TINA4_MAX_UPLOAD_SIZE (2048 bytes)"}');
      const declared = await exchange(dotenvServer.port, postHead("Content-Length: 3000\r\n"));
      expect(declared.status, describeAnswer(declared)).toBe(413);
      const head = await exchange(dotenvServer.port, "GET /hello HTTP/1.1\r\nX-Big: " + "a".repeat(5000) + "\r\n\r\n");
      expect(head.status, describeAnswer(head)).toBe(431);
      const small = await exchange(dotenvServer.port, postHead("Content-Length: 100\r\nConnection: close\r\n") + "b".repeat(100));
      expect(small.status, describeAnswer(small)).toBe(200);
    } finally {
      stopServer(dotenvServer);
    }
  }, 90_000);

  it("a chunked body under the cap is decoded and served", async () => {
    const answer = await exchange(
      server.port,
      postHead("Transfer-Encoding: chunked\r\nConnection: close\r\n") + "5;name=value\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: t\r\n\r\n",
    );
    expect(answer.status, describeAnswer(answer)).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ size: 11, body: "hello world" });
  });

  it("a body under the cap is still served", async () => {
    for (const size of [0, 1000, LIMIT]) {
      const answer = await exchange(server.port, postHead(`Content-Length: ${size}\r\nConnection: close\r\n`) + "b".repeat(size));
      expect(answer.status, `size ${size}` + describeAnswer(answer)).toBe(200);
      expect(JSON.parse(answer.body).size).toBe(size);
    }
  });
});

/**
 * Push up to `total` body bytes after `head`, counting only what the kernel
 * accepted. Ends when all is sent, the server closes, or nothing is accepted
 * for STALL_MS (the server stopped reading).
 */
const STALL_MS = 3000;
function pushUntilStopped(port: number, head: string, total: number): Promise<{ acceptedBytes: number; response: string; closed: boolean; how: string }> {
  return new Promise((resolvePush) => {
    const socket = net.connect(port, "127.0.0.1");
    const block = Buffer.alloc(256 * 1024, 0x61);
    let acceptedBytes = 0;
    let response = "";
    let closed = false;
    let finished = false;
    let stallTimer: NodeJS.Timeout | null = null;
    let how = "";
    const finish = (why = "stall"): void => {
      if (finished) return;
      how = why;
      finished = true;
      if (stallTimer) clearTimeout(stallTimer);
      socket.destroy();
      resolvePush({ acceptedBytes, response, closed, how });
    };
    socket.on("data", (chunk) => (response += chunk.toString("latin1")));
    // A reset or a broken pipe is the server closing on us, as much as a FIN.
    socket.on("error", () => {
      closed = true;
      finish("error");
    });
    socket.on("close", () => {
      closed = true;
      finish("close");
    });
    const pump = (): void => {
      if (finished) return;
      if (acceptedBytes >= total) return finish("all sent");
      stallTimer = setTimeout(() => finish("stall"), STALL_MS);
      socket.write(block, (err) => {
        if (stallTimer) clearTimeout(stallTimer);
        if (err) {
          closed = true; // EPIPE / ECONNRESET: the server closed the connection
          return finish("write error");
        }
        acceptedBytes += block.length;
        pump();
      });
    };
    socket.write(head, () => pump());
  });
}

// ── builtin-server-malformed-framing + transport-rejection-shape ─────────────

const headerLimitBody = `{"error":"Request header fields exceed TINA4_MAX_REQUEST_HEADER (${HEADER_LIMIT} bytes)"}`;

function expectShape(answer: Answer, status: number, body: string): void {
  expect(answer.status, describeAnswer(answer)).toBe(status);
  expect(answer.body, describeAnswer(answer)).toBe(body);
  expect(answer.headers["content-type"], describeAnswer(answer)).toEqual(["application/json"]);
  expect(answer.headers["content-length"], describeAnswer(answer)).toEqual([String(Buffer.byteLength(body))]);
  expect(answer.headers.connection, describeAnswer(answer)).toEqual(["close"]);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(answer.headers[name], `${name}${describeAnswer(answer)}`).toEqual([value]);
  }
  expect(answer.headers["strict-transport-security"], describeAnswer(answer)).toBeUndefined();
}

describe("malformed framing", () => {
  it("an invalid content length answers 400", async () => {
    for (const header of [
      "Content-Length: abc\r\n", "Content-Length: -1\r\n", "Content-Length: +5\r\n", "Content-Length: 1 2\r\n",
      "Content-Length: 0x10\r\n", "Content-Length: \r\n", "Content-Length: 5\r\nContent-Length: 6\r\n",
    ]) {
      expectShape(await exchange(server.port, postHead(header) + "hello"), 400, '{"error":"Invalid Content-Length"}');
    }
    await expectServing();
  }, 30_000);

  it("two content length headers answer 400 even when they agree", async () => {
    // Maintainer ruling on ADR-0068, the same in all four frameworks. llhttp
    // refuses any pair; the answer must still be the fixture's shape.
    expectShape(
      await exchange(server.port, postHead("Content-Length: 5\r\nContent-Length: 5\r\n") + "hello"),
      400,
      '{"error":"Invalid Content-Length"}',
    );
    await expectServing();
  });

  it("conflicting content length and transfer encoding answer 400", async () => {
    for (const raw of [
      postHead("Content-Length: 5\r\nTransfer-Encoding: chunked\r\n") + "0\r\n\r\n",
      postHead("Transfer-Encoding: gzip\r\n") + "hello",
      postHead("Transfer-Encoding: gzip, chunked\r\n") + "0\r\n\r\n",
      postHead("Transfer-Encoding: chunked\r\n") + "zz\r\nhello\r\n0\r\n\r\n",
      postHead("Transfer-Encoding: chunked\r\n") + "5\r\nhelloXX0\r\n\r\n",
    ]) {
      expectShape(await exchange(server.port, raw), 400, '{"error":"Invalid Transfer-Encoding"}');
    }
    await expectServing();
  }, 30_000);

  it("a request head with a bare line feed answers 400", async () => {
    for (const raw of [
      "GET /hello\nX HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
      "GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nX-A: a\nb\r\n\r\n",
      "GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nX-A: a\rb\r\n\r\n",
      "GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nX-A: a\u0000b\r\n\r\n",
    ]) {
      expectShape(await exchange(server.port, raw), 400, '{"error":"Malformed request head"}');
    }
    await expectServing();
  }, 30_000);

  it("an oversized header block answers 431", async () => {
    for (const raw of [
      "GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: " + "a".repeat(9000) + "\r\n\r\n",
      "GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: " + "a".repeat(200_000),
    ]) {
      expectShape(await exchange(server.port, raw), 431, headerLimitBody);
    }
    // The pair: a large head under the limit is served.
    const legal = await exchange(server.port, "GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Legal: " + "b".repeat(6000) + "\r\nConnection: close\r\n\r\n");
    expect(legal.status, describeAnswer(legal)).toBe(200);
    await expectServing();
  }, 30_000);

  it("a stalled partial request answers 408", async () => {
    for (const partial of [postHead("Content-Length: 10\r\n") + "abc", "GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\n"]) {
      const answer = await exchange(server.port, partial, (IDLE_SECONDS + 5) * 1000);
      expectShape(answer, 408, '{"error":"Request timed out before it was complete"}');
      expect(answer.firstByteMs!, `answered after ${answer.firstByteMs}ms`).toBeGreaterThanOrEqual((IDLE_SECONDS - 0.5) * 1000);
      expect(answer.firstByteMs!, `answered after ${answer.firstByteMs}ms`).toBeLessThan((IDLE_SECONDS + 3) * 1000);
    }
    // A connection that never sent a byte has no request to answer.
    const silent = await exchange(server.port, "", (IDLE_SECONDS + 5) * 1000);
    expect(silent.raw, describeAnswer(silent)).toBe("");
    await expectServing();
  }, 60_000);

  it("the server keeps serving after every rejection", async () => {
    const rejections = [
      postHead("Content-Length: abc\r\n"),
      postHead(`Content-Length: ${LIMIT + 1}\r\n`),
      "GET /hello HTTP/1.1\r\nX-Big: " + "a".repeat(20_000) + "\r\n\r\n",
      "GET /hello\nX HTTP/1.1\r\n\r\n",
      postHead("Transfer-Encoding: gzip\r\n"),
      get("/direct-append"),
    ];
    for (let round = 0; round < 3; round++) {
      for (const raw of rejections) {
        const answer = await exchange(server.port, raw);
        expect([400, 413, 431, 500], describeAnswer(answer)).toContain(answer.status);
      }
    }
    await expectServing();
    expect(server.child.exitCode, "the server process died").toBeNull();
  }, 60_000);

  it("a transport rejection carries the json body and security headers", async () => {
    expectShape(await exchange(server.port, postHead(`Content-Length: ${LIMIT + 1}\r\n`)), 413, body413(LIMIT + 1));
    expectShape(await exchange(server.port, postHead("Content-Length: x\r\n")), 400, '{"error":"Invalid Content-Length"}');
    expectShape(await exchange(server.port, "GET / HTTP/1.1\r\nX-Big: " + "a".repeat(9000) + "\r\n\r\n"), 431, headerLimitBody);
    expectShape(await exchange(server.port, get("/direct-append")), 500, '{"error":"Invalid response header"}');
  }, 30_000);
});

/**
 * The upload limit has to bound MEMORY, not just report a number afterwards.
 *
 * The old check read `content-length` and then, separately, measured the body
 * once it was fully buffered. A chunked request declares no content-length, so
 * the first check saw 0 and let it through, and the second check ran after the
 * whole thing was already in memory. The limit could not prevent the one thing
 * it exists to prevent. Measured against a 1MB limit, before the fix: a 40MB
 * chunked POST answered 500 and grew the server's RSS by 40.0MB.
 *
 * HOW THE PROPERTY IS MEASURED (ADR-0068 section 3: the cap is enforced before
 * the body is buffered).
 *
 * This file used to assert "server RSS grew by less than half of a 24MB body".
 * That is a proxy, and a noisy one: on the same host, in isolation, the growth
 * on the FIXED code ranged 1.5MB to 8.4MB between identical runs (lab, Node 24,
 * 20 runs) and 1.0MB to 3.5MB on macOS (Node 26, 10 runs), and another run
 * measured 15.3MB against the 12MB line. Garbage-collection timing and socket
 * buffers, not the code under test, decided the margin.
 *
 * Now the test measures what the cap is FOR, from the client side of a real
 * socket, where nothing is timing-dependent:
 *
 *   declared length : the client declares 1 GiB and sends NO body at all.
 *                     413 must arrive anyway. Code that reads before it checks
 *                     waits for a body that never comes and never answers.
 *   chunked         : the client streams up to 1 GiB with no content-length
 *                     and records how many body bytes it had written when the
 *                     first response byte arrived. That must be the cap plus
 *                     socket-buffer slack (32MB allowed), nowhere near the 1 GiB
 *                     it planned to send. Code that buffers the body and
 *                     measures it afterwards cannot answer before the end.
 *
 * RSS is deliberately not asserted any more. A client that kept sending 256MB
 * AFTER the 413 grew the FIXED server by 138.8MB (macOS, Node 26): the
 * refused chunks are dropped, but they are still allocated before they are
 * dropped, and when the collector reclaims them is not something a test can
 * pin. A number that moves with the collector is not a gate.
 *
 * Real server, real child process, real loopback socket. No doubles.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { createConnection, type Socket } from "node:net";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");

const LIMIT_BYTES = 1_048_576; // 1MB
const PAYLOAD_MB = 24;
const ONE_GIB = 1024 * 1024 * 1024;
/** Socket buffers on both ends of a loopback connection, with room to spare. */
const SOCKET_SLACK_BYTES = 32 * 1024 * 1024;
/** A client that has sent this much with no answer has proved the bug. */
const GIVE_UP_BYTES = 128 * 1024 * 1024;

const spawned = new Set<ChildProcess>();
const dirs: string[] = [];

afterEach(() => {
  for (const child of spawned) {
    try {
      if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  spawned.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startServer(port: number, tag: string): Promise<{ log: () => string }> {
  const root = mkdtempSync(join(tmpdir(), `tina4-bodycap-${tag}-`));
  dirs.push(root);
  const routes = join(root, "src", "routes");
  mkdirSync(join(routes, "upload"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"bodycap","type":"module","private":true}\n');
  // Writes are secure by default in Tina4. The oversized cases never reach the
  // auth gate (the body is refused first), but the under-limit case does, and
  // a 401 there would say nothing about the body cap.
  writeFileSync(
    join(routes, "upload", "post.ts"),
    "export const noAuth = true;\n" +
      "export default async function (_req: any, res: any) { return res('OK', 200); }\n",
  );
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
      `await startServer({ port: ${port}, routesDir: '${routes}' } as never);\n`,
  );

  const logPath = join(root, "server.log");
  const fd = openSync(logPath, "w");
  const child = spawn(TSX, ["app.ts"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      TINA4_OVERRIDE_CLIENT: "true",
      TINA4_NO_BROWSER: "true",
      TINA4_NO_AI_PORT: "true",
      TINA4_DEBUG: "false",
      TINA4_PORT: String(port),
      TINA4_MAX_UPLOAD_SIZE: String(LIMIT_BYTES),
    },
  });
  spawned.add(child);
  closeSync(fd);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body: "x" });
      if (res.status) return { log: () => readFileSync(logPath, "utf8") };
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  throw new Error(`server never came up on ${port}:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
}

/** POST with Transfer-Encoding: chunked and NO content-length. */
function postChunked(port: number, mb: number): Promise<number | null> {
  return new Promise((resolveOuter) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/upload",
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolveOuter(res.statusCode ?? null));
      },
    );
    // The server answers 413 and may close while we are still writing. That is
    // correct behaviour, so a write-side error is not a test failure.
    req.on("error", () => resolveOuter(null));

    const block = Buffer.alloc(1024 * 1024, 0x61);
    let sent = 0;
    const pump = (): void => {
      while (sent < mb) {
        sent++;
        if (!req.write(block)) {
          req.once("drain", pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

interface RawOutcome {
  /** HTTP status from the first response line, or null if none arrived. */
  status: number | null;
  /** Body bytes the client had written when the first response byte arrived. */
  bodyBytesAtResponse: number | null;
  /** Body bytes written in total. */
  bodyBytesTotal: number;
}

function writeAll(socket: Socket, data: Buffer | string): Promise<boolean> {
  return new Promise((resolveWrite) => {
    if (socket.destroyed || socket.writableEnded) return resolveWrite(false);
    const onError = (): void => resolveWrite(false);
    socket.once("error", onError);
    const flushed = socket.write(data, () => { socket.off("error", onError); });
    if (flushed) { socket.off("error", onError); resolveWrite(true); }
    else socket.once("drain", () => { socket.off("error", onError); resolveWrite(true); });
  });
}

/**
 * A raw HTTP/1.1 POST over a real socket, so the test controls exactly which
 * body bytes are written and knows when the answer started to arrive.
 *
 * `bodyBytes` is what the client PLANS to send (with `chunked`, as 64KiB
 * chunks). It stops at the first response byte, or at GIVE_UP_BYTES with no
 * answer at all.
 */
function rawPost(
  port: number,
  options: { declaredLength?: number; chunked: boolean; bodyBytes: number },
): Promise<RawOutcome> {
  return new Promise((resolveOutcome) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let responseText = "";
    let bodyBytesTotal = 0;
    let bodyBytesAtResponse: number | null = null;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      socket.destroy();
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(responseText);
      resolveOutcome({ status: match ? Number(match[1]) : null, bodyBytesAtResponse, bodyBytesTotal });
    };
    socket.on("data", (data: Buffer) => {
      if (bodyBytesAtResponse === null) bodyBytesAtResponse = bodyBytesTotal;
      responseText += data.toString("latin1");
    });
    socket.on("error", () => { /* the server may close while we write: correct */ });
    socket.on("close", finish);

    const head = [
      "POST /upload HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Content-Type: application/octet-stream",
      options.chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${options.declaredLength ?? options.bodyBytes}`,
      "", "",
    ].join("\r\n");

    const chunkSize = 64 * 1024;
    const payload = Buffer.alloc(chunkSize, 0x61);
    const framed = Buffer.concat([Buffer.from(`${chunkSize.toString(16)}\r\n`), payload, Buffer.from("\r\n")]);

    socket.once("connect", async () => {
      if (!(await writeAll(socket, head))) return finish();
      while (bodyBytesTotal < options.bodyBytes && bodyBytesAtResponse === null) {
        if (bodyBytesTotal >= GIVE_UP_BYTES) break;
        if (!(await writeAll(socket, options.chunked ? framed : payload))) break;
        bodyBytesTotal += chunkSize;
      }
      if (options.bodyBytes === 0) {
        // Nothing to send: wait for the server to answer on the head alone.
        const deadline = Date.now() + 10_000;
        while (bodyBytesAtResponse === null && Date.now() < deadline && !finished) await sleep(50);
      } else {
        await sleep(500); // let the answer land if it is still in flight
      }
      finish();
    });
  });
}

describe("request body cap", () => {
  it("refuses a declared oversized body before reading any of it", async () => {
    await startServer(7875, "declared-huge");
    const outcome = await rawPost(7875, { declaredLength: ONE_GIB, chunked: false, bodyBytes: 0 });
    expect(outcome.status, "no answer to a 1 GiB declaration with no body sent - the server is waiting to read it").toBe(413);
    expect(outcome.bodyBytesAtResponse).toBe(0);
  }, 120_000);

  it("refuses a chunked body at the cap, not at the end", async () => {
    await startServer(7876, "chunked-cap");
    const outcome = await rawPost(7876, { chunked: true, bodyBytes: ONE_GIB });
    expect(
      outcome.bodyBytesAtResponse,
      `no answer after ${(outcome.bodyBytesTotal / 1048576).toFixed(0)}MB of a 1 GiB chunked body with a 1MB cap - the body is being read to the end before it is measured`,
    ).not.toBeNull();
    expect(outcome.status).toBe(413);
    expect(
      outcome.bodyBytesAtResponse!,
      `answered after ${(outcome.bodyBytesAtResponse! / 1048576).toFixed(1)}MB with a 1MB cap`,
    ).toBeLessThanOrEqual(LIMIT_BYTES + SOCKET_SLACK_BYTES);
  }, 120_000);

  it("answers 413, not 500, when the body is too large", async () => {
    await startServer(7872, "status");
    // 500 tells the caller to retry the request that will fail again. 413 tells
    // them what is actually wrong.
    expect(await postChunked(7872, PAYLOAD_MB)).toBe(413);
  }, 120_000);

  it("answers 413 when the client declares an oversized content-length", async () => {
    await startServer(7873, "declared");
    const res = await fetch("http://127.0.0.1:7873/upload", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(LIMIT_BYTES * 2, 0x61),
    });
    expect(res.status).toBe(413);
  }, 120_000);

  it("still accepts a body under the limit", async () => {
    await startServer(7874, "under");
    const res = await fetch("http://127.0.0.1:7874/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "a".repeat(1000) }),
    });
    expect(res.status).toBe(200);
  }, 120_000);
});

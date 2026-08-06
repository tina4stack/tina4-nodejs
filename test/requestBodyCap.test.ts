/**
 * The upload limit has to bound MEMORY, not just report a number afterwards.
 *
 * The old check read `content-length` and then, separately, measured the body
 * once it was fully buffered. A chunked request declares no content-length, so
 * the first check saw 0 and let it through, and the second check ran after the
 * whole thing was already in memory. The limit could not prevent the one thing
 * it exists to prevent.
 *
 * Measured against a 1MB limit, before the fix:
 *
 *     payload         : 40MB, chunked, NO content-length
 *     status          : 500
 *     server RSS grew : 40.0MB
 *
 * After:
 *
 *     status          : 413
 *     server RSS grew : 8.0MB     (socket buffers, not our accumulation)
 *
 * Real server, real child process, real chunked HTTP upload, RSS read from the
 * OS with ps. No doubles.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");

const LIMIT_BYTES = 1_048_576; // 1MB
const PAYLOAD_MB = 24;

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

/**
 * Resident memory of the server's whole process tree, in MB, from the OS.
 *
 * By process GROUP, not by matching the command line: tsx execs node, so the
 * temp-dir name never appears in any argv and a grep for it sums zero. The
 * child is spawned detached, so its pgid equals its pid and the group contains
 * exactly this server.
 */
function serverRssMb(pgid: number): number {
  try {
    const out = execFileSync("bash", [
      "-c",
      `ps -Ao rss,pgid | awk -v g=${pgid} '$2==g {s+=$1} END {print s+0}'`,
    ])
      .toString()
      .trim();
    return Number(out) / 1024;
  } catch {
    return -1;
  }
}

async function startServer(port: number, tag: string): Promise<{ log: () => string; pgid: number }> {
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
      if (res.status) return { log: () => readFileSync(logPath, "utf8"), pgid: child.pid! };
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

describe("request body cap", () => {
  it("does not buffer a chunked body past the limit", async () => {
    const server = await startServer(7871, "grow");
    await sleep(500);
    const before = serverRssMb(server.pgid);
    expect(before, "could not read server RSS").toBeGreaterThan(0);

    await postChunked(7871, PAYLOAD_MB);
    await sleep(750);
    const after = serverRssMb(server.pgid);

    const grew = after - before;
    // Half the payload is a generous line: the old behaviour grew by the FULL
    // payload, the fixed one by the socket buffers alone.
    expect(
      grew,
      `server grew ${grew.toFixed(1)}MB on a ${PAYLOAD_MB}MB body with a ${LIMIT_BYTES / 1048576}MB limit`,
    ).toBeLessThan(PAYLOAD_MB / 2);
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

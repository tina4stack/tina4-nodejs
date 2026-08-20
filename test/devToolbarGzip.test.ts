/**
 * The dev toolbar must not text-edit a body that is already compressed.
 *
 * THE BUG, found 2026-08-20 against 3.13.105 and still present on 3.13.107. In
 * dev mode every static .html file over the 1024-byte compression threshold was
 * served CORRUPT, and Chrome refused the page outright with
 * ERR_CONTENT_DECODING_FAILED - so `tina4 serve` could not serve an ordinary
 * app page at all, which is most of the point of `tina4 serve`.
 *
 * The mechanism is an ordering trap between two layers that are each correct
 * alone. static.ts gzips an eligible file itself and sets Content-Encoding
 * BEFORE calling `res.raw.end()`. But that `end()` is the dev-toolbar wrapper in
 * server.ts, which sees `content-type: text/html`, calls `chunk.toString("utf-8")`
 * on what are now GZIP BYTES, and splices a toolbar into the result. Every byte
 * outside ASCII becomes U+FFFD, so the gzip magic `1f 8b 08` goes out as
 * `1f ef bf bd 08` and no client on earth can inflate it.
 *
 * It hid for a long time because the obvious probe misses it: curl sends no
 * Accept-Encoding by default, gets the uncompressed path, and reports a
 * perfectly healthy page. Only a browser - which always asks for gzip - sees it.
 *
 * dispatchPipeline.ts already guards the sibling half of this (it refuses to
 * gzip a body an earlier stage encoded). This is the other half.
 *
 * No mocks: a real child server over a real loopback socket, and the raw
 * response bytes are inflated here rather than by fetch(), because fetch()
 * decompresses silently and would hide exactly what is being asserted.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");

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

/** A page comfortably over the 1024-byte gzip threshold, and one well under it. */
const MARKER = "<h1>the office front page</h1>";
const BIG_HTML = `<!DOCTYPE html><html><head><title>big</title></head><body>${MARKER}\n${"<p>filler filler filler filler filler</p>\n".repeat(60)}</body></html>\n`;
const SMALL_HTML = `<!DOCTYPE html><html><body>${MARKER}</body></html>\n`;

async function startServer(port: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tina4-gzhtml-"));
  dirs.push(root);
  mkdirSync(join(root, "src", "routes"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"gzprobe","type":"module","private":true}\n');
  writeFileSync(join(root, "public", "big.html"), BIG_HTML);
  writeFileSync(join(root, "public", "small.html"), SMALL_HTML);
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
      `await startServer({ port: ${port}, routesDir: '${join(root, "src", "routes")}' } as never);\n`,
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
      // The whole point: the dev toolbar is ON. With it off there is no wrapper
      // and nothing to corrupt, which is why production never saw this.
      TINA4_DEBUG: "true",
      TINA4_PORT: String(port),
    },
  });
  spawned.add(child);
  closeSync(fd);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status) {
        await res.arrayBuffer();
        return;
      }
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  throw new Error(`server never came up on ${port}:\n${readFileSync(logPath, "utf8").slice(-2000)}`);
}

/** A raw GET whose body is NOT decoded for us — the bytes exactly as the wire carried them. */
function rawGet(port: number, path: string, acceptEncoding: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((res, rej) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { "accept-encoding": acceptEncoding } },
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () =>
          res({
            status: r.statusCode ?? 0,
            headers: r.headers as Record<string, string>,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", rej);
    req.end();
  });
}

describe("dev toolbar vs an already-compressed body", () => {
  it("a gzipped static html page is still valid gzip in dev mode", async () => {
    await startServer(7931);
    const res = await rawGet(7931, "/big.html", "gzip, deflate, br, zstd");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");

    // The header bytes, named explicitly: this is what the corruption looked
    // like, and `1f ef bf bd` is a UTF-8 round trip having eaten 0x8b.
    expect(
      [...res.body.subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
      "the gzip magic is mangled - the body was read as UTF-8 somewhere",
    ).toBe("1f 8b 08");

    const inflated = gunzipSync(res.body).toString("utf-8");
    expect(inflated).toContain(MARKER);
    expect(inflated.length).toBeGreaterThan(1024);
  }, 120_000);

  it("the toolbar is still injected when the body is NOT compressed", async () => {
    // The fix must skip injection ONLY where injection is impossible. If it
    // disabled the toolbar generally it would "pass" the test above while
    // quietly removing the feature.
    await startServer(7932);
    const res = await rawGet(7932, "/big.html", "identity");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"], "asked for identity but got an encoded body").toBeUndefined();
    const html = res.body.toString("utf-8");
    expect(html).toContain(MARKER);
    expect(html, "the dev toolbar was not injected into an injectable page").toContain("tina4-dev-toolbar");
  }, 120_000);

  it("the healthy order - inject, THEN compress - still produces valid gzip", async () => {
    // A page too small for static.ts to compress arrives at the wrapper as
    // plain markup, gets its toolbar, and is only then gzipped by
    // dispatchPipeline - which is the correct order and the one that always
    // worked. Worth pinning: it is the path the broken one is easily confused
    // with, and it also guards against a "fix" that keys off the REQUEST
    // (a browser always offers gzip) rather than the RESPONSE's own encoding.
    await startServer(7933);
    const res = await rawGet(7933, "/small.html", "gzip, deflate, br, zstd");

    expect(res.status).toBe(200);
    // The toolbar's own markup pushes this past the 1024-byte threshold, so it
    // IS compressed here - just at the right point in the chain.
    expect(res.headers["content-encoding"]).toBe("gzip");
    const html = gunzipSync(res.body).toString("utf-8");
    expect(html).toContain(MARKER);
    expect(html, "a small page offered gzip lost its toolbar").toContain("tina4-dev-toolbar");
  }, 120_000);
});

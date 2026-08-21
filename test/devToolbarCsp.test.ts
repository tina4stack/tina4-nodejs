/**
 * The injected dev toolbar must be CSP-clean.
 *
 * The framework serves a strict `default-src 'self'` CSP. Before this port the
 * toolbar carried 22 inline `style=`, 4 `onclick=` and 5 inline `<script>`
 * blocks, so under that CSP it rendered unstyled + non-functional and spewed
 * violations. The fix (parity with tina4-php's DevAdmin) moves the CSS and JS to
 * external assets served from /__dev/toolbar.css and /__dev/toolbar.js, and wires
 * every interaction via addEventListener inside toolbar.js.
 *
 * This test proves, against a REAL dev server over a real loopback socket:
 *   (positive) GET /__dev/toolbar.css is 200 text/css and non-empty;
 *              GET /__dev/toolbar.js  is 200 application/javascript and non-empty;
 *   (negative) the injected toolbar HTML links the external CSS + JS and carries
 *              NO inline style=, NO onclick=, and NO inline <script> (only
 *              <script src=...>).
 *
 * No mocks: a real child server, real HTTP.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
// Invoke tsx via `node <tsx cli>` rather than the .bin/tsx shim so the spawn
// works on Windows too (the shim is a .cmd there and is not directly spawnable).
const TSX_CLI = resolve(REPO, "node_modules", "tsx", "dist", "cli.mjs");

const spawned = new Set<ChildProcess>();
const dirs: string[] = [];

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    /* gone */
  }
}

afterEach(async () => {
  for (const child of spawned) killTree(child);
  spawned.clear();
  // The kill (taskkill on Windows) is async; give the OS a moment to release
  // the file handles before removing the temp dir. Cleanup is best-effort —
  // a leftover temp dir must never fail the test.
  await sleep(300);
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* OS will reap the temp dir */
    }
  }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MARKER = "<h1>the office front page</h1>";
const PAGE_HTML = `<!DOCTYPE html><html><head><title>page</title></head><body>${MARKER}</body></html>\n`;

async function startServer(port: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tina4-csp-"));
  dirs.push(root);
  mkdirSync(join(root, "src", "routes"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"cspprobe","type":"module","private":true}\n');
  writeFileSync(join(root, "public", "page.html"), PAGE_HTML);
  // file:// URL for the import (Windows drive-letter paths are not valid ESM
  // specifiers), and a JSON-encoded routesDir so backslashes survive the string.
  const coreEntry = pathToFileURL(resolve(REPO, "packages", "core", "src", "index.ts")).href;
  const routesDir = join(root, "src", "routes");
  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from ${JSON.stringify(coreEntry)};\n` +
      `await startServer({ port: ${port}, routesDir: ${JSON.stringify(routesDir)} } as never);\n`,
  );

  const logPath = join(root, "server.log");
  const fd = openSync(logPath, "w");
  const child = spawn(process.execPath, [TSX_CLI, "app.ts"], {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      TINA4_OVERRIDE_CLIENT: "true",
      TINA4_NO_BROWSER: "true",
      TINA4_NO_AI_PORT: "true",
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

/** A raw GET returning status, headers and the body as a UTF-8 string. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((res, rej) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () =>
        res({
          status: r.statusCode ?? 0,
          headers: r.headers as Record<string, string>,
          body: Buffer.concat(chunks).toString("utf-8"),
        }),
      );
    });
    req.on("error", rej);
    req.end();
  });
}

describe("CSP-clean dev toolbar (external CSS/JS assets)", () => {
  it("serves /__dev/toolbar.css as 200 text/css and non-empty", async () => {
    await startServer(7941);
    const res = await rawGet(7941, "/__dev/toolbar.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"] ?? "").toContain("text/css");
    expect(res.body.length).toBeGreaterThan(0);
    // A known selector from the extracted stylesheet.
    expect(res.body).toContain("#tina4-dev-toolbar");
  }, 120_000);

  it("serves /__dev/toolbar.js as 200 application/javascript and non-empty", async () => {
    await startServer(7942);
    const res = await rawGet(7942, "/__dev/toolbar.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"] ?? "").toContain("application/javascript");
    expect(res.body.length).toBeGreaterThan(0);
    // Every interaction is wired via addEventListener (no inline handlers).
    expect(res.body).toContain("addEventListener");
  }, 120_000);

  it("injects a CSP-clean toolbar: external CSS+JS links, no inline style/onclick/script", async () => {
    await startServer(7943);
    const res = await rawGet(7943, "/page.html", { "accept-encoding": "identity" });
    expect(res.status).toBe(200);
    const html = res.body;
    expect(html).toContain(MARKER);

    // Positive: the toolbar is present and references the external assets.
    expect(html).toContain('id="tina4-dev-toolbar"');
    expect(html).toContain('<link rel="stylesheet" href="/__dev/toolbar.css">');
    expect(html).toContain('<script src="/__dev/toolbar.js"></script>');
    // On the main port the reloader is enabled.
    expect(html).toContain('data-reload="1"');

    // Negative: no inline style=, no onclick=, and no inline <script> — the ONLY
    // <script> in the toolbar must carry a src attribute.
    expect(html.includes("style=")).toBe(false);
    expect(html.includes("onclick=")).toBe(false);
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      expect(m[1]).toContain(" src=");
    }
  }, 120_000);
});

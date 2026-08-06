/**
 * tina4css_contract.json :: tina4css-is-served-at-one-url-in-all-four
 *
 * tina4css is ONE artefact shipped by four packages. Every framework serves it
 * at /css/tina4.css from its own built-in public directory, and the bytes are
 * identical in all four.
 *
 * MEASURED 2026-08-06 on real servers over real sockets - including a PHP
 * project built by `composer require` whose own src/public/css was empty - all
 * four answered 200 with 35962 bytes for tina4.css and 28472 for
 * tina4.min.css.
 *
 * That parity was true by luck. Nothing asserted it, so a packaging change in
 * one framework would have gone unnoticed in the other three.
 *
 * The companion half - that the committed CSS is a current compile of its
 * .scss source, and that the four sources have not drifted apart - is checked
 * by tina4-documentation/scripts/build-tina4css.py --check. It caught a real
 * one: the shipped tina4.min.css was 15 bytes adrift from the current
 * toolchain because its producer, the per-framework SCSS compiler, had been
 * deleted.
 *
 * No mocks: a real child server over a real loopback socket.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");
const SHIPPED = resolve(REPO, "packages", "core", "public", "css");

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

async function startServer(port: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tina4-css-"));
  dirs.push(root);
  mkdirSync(join(root, "src", "routes"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"cssprobe","type":"module","private":true}\n');
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
      TINA4_DEBUG: "false",
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

describe("tina4css served", () => {
  it("tina4css is served at the canonical url", async () => {
    await startServer(7921);
    const res = await fetch("http://127.0.0.1:7921/css/tina4.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/css");
    const body = await res.text();
    // A real stylesheet, not an error page that happened to return 200.
    expect(body).toContain(".container");
  }, 120_000);

  it("the minified build is served at the canonical url", async () => {
    await startServer(7922);
    const res = await fetch("http://127.0.0.1:7922/css/tina4.min.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/css");
    const minified = Buffer.from(await res.arrayBuffer());
    const full = Buffer.from(
      await fetch("http://127.0.0.1:7922/css/tina4.css").then((r) => r.arrayBuffer()),
    );
    expect(
      minified.length,
      `the minified build (${minified.length}B) is not smaller than the full one (${full.length}B) - it is probably a copy`,
    ).toBeLessThan(full.length);
  }, 120_000);

  it("the served bytes are the shipped file byte for byte", async () => {
    await startServer(7923);
    const served = Buffer.from(
      await fetch("http://127.0.0.1:7923/css/tina4.css").then((r) => r.arrayBuffer()),
    );
    const onDisk = readFileSync(join(SHIPPED, "tina4.css"));
    // Byte equality, not a size check: a truncated or half-written asset still
    // has a plausible length.
    expect(
      served.equals(onDisk),
      `served ${served.length} bytes but ${join(SHIPPED, "tina4.css")} holds ${onDisk.length}`,
    ).toBe(true);
  }, 120_000);
});

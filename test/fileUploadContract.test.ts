/**
 * File upload contract (feature 44) - repeated field -> LIST, safe-save, per-chunk cap.
 *
 * Shared invariants: tina4-documentation/plan/v3/fixtures/fileupload_contract.json
 * (UP-DEC-02 / UP-DEC-03, OWNER-DECISIONS Batch 4).
 *
 * No mocks: the repeated-field cases parse a REAL multipart body through the real
 * parser; the safe-save cases write to a REAL temp directory and read back what
 * landed (and what did not); the per-chunk cap cases POST a chunked over-size body
 * with NO content-length to a REAL child server over a real loopback socket, so
 * only a running counter (not a declared-length check) can stop it.
 *
 * Run with: npx tsx test/fileUploadContract.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

import { parseMultipart, saveUpload } from "../packages/core/src/request.ts";
import type { UploadedFile } from "../packages/core/src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BOUNDARY = "----Tina4FileUploadContract";
function multipart(files: Array<[string, string, string]>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, filename, content] of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(content),
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

// ── UP-MULTIFILE-LOSS: repeated field name -> a LIST ────────────────────────
console.log("=== File Upload Contract ===\n--- repeated field name -> a list ---");
{
  const { files } = parseMultipart(
    multipart([
      ["photos", "a.txt", "AAAA-first"],
      ["photos", "b.txt", "BBBB-second"],
    ]),
    BOUNDARY,
  );
  const entry = files["photos"];
  // two files under one field name arrive as a list
  assert("two files under one field name arrive as a list", Array.isArray(entry) && entry.length === 2, JSON.stringify(entry));
  const list = entry as UploadedFile[];
  assert("  both filenames survive (neither dropped)", list?.[0]?.filename === "a.txt" && list?.[1]?.filename === "b.txt");
  assert("  both byte payloads survive", list?.[0]?.content.toString() === "AAAA-first" && list?.[1]?.content.toString() === "BBBB-second");
}
{
  const { files } = parseMultipart(multipart([["avatar", "solo.txt", "only-one"]]), BOUNDARY);
  const entry = files["avatar"];
  // a single file stays a single descriptor
  assert("a single file stays a single descriptor", !Array.isArray(entry) && (entry as UploadedFile).filename === "solo.txt");
}

// ── UP-FILENAME-UNTRUSTED: safe-save confines the write ─────────────────────
console.log("\n--- safe-save confines the write ---");
{
  const root = mkdtempSync(join(tmpdir(), "tina4-safesave-"));
  const target = join(root, "uploads");
  mkdirSync(target, { recursive: true });
  const descriptor = { fieldName: "f", filename: "../../evil.txt", type: "text/plain", content: Buffer.from("payload"), size: 7 } as UploadedFile;

  const saved = saveUpload(descriptor, target);
  const insideOk = dirname(saved) === target && readFileSync(saved).toString() === "payload";
  const escapedGone = !existsSync(join(root, "evil.txt"));
  // safe save writes a traversal filename inside the target dir
  assert("safe save writes a traversal filename inside the target dir", insideOk && escapedGone, `saved=${saved} escapedExists=${!escapedGone}`);

  let refusedDotDot = false;
  try {
    saveUpload({ ...descriptor, filename: ".." }, target);
  } catch {
    refusedDotDot = true;
  }
  let refusedNul = false;
  try {
    saveUpload({ ...descriptor, filename: "ok\0.txt" }, target);
  } catch {
    refusedNul = true;
  }
  // safe save refuses an unusable filename
  assert("safe save refuses an unusable filename", refusedDotDot && refusedNul);
  rmSync(root, { recursive: true, force: true });
}

// ── UP-CHUNKED-BYPASS: running per-chunk size guard (413 mid-stream) ─────────
const LIMIT = 1_048_576; // 1MB
const spawned = new Set<ChildProcess>();
const dirs: string[] = [];

function reap(): void {
  for (const child of spawned) {
    try {
      if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  spawned.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

async function startServer(port: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tina4-uploadcap-"));
  dirs.push(root);
  const routes = join(root, "src", "routes");
  mkdirSync(join(routes, "upload"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"uploadcap","type":"module","private":true}\n');
  // Writes are secure by default; the oversized case never reaches the auth gate
  // (the body is refused first) but the under-limit control does, so noAuth here.
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
  const child = spawn(TSX, ["app.ts"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      TINA4_OVERRIDE_CLIENT: "true", TINA4_NO_BROWSER: "true", TINA4_NO_AI_PORT: "true",
      TINA4_DEBUG: "false", TINA4_PORT: String(port), TINA4_MAX_UPLOAD_SIZE: String(LIMIT),
    },
  });
  spawned.add(child);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body: "x" });
      if (res.status) return;
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  throw new Error(`server never came up on ${port}`);
}

/** POST with Transfer-Encoding: chunked and NO content-length. */
function postChunked(port: number, mb: number): Promise<number | null> {
  return new Promise((resolveOuter) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/upload", method: "POST", headers: { "content-type": "application/octet-stream" } },
      (res) => {
        res.resume();
        res.on("end", () => resolveOuter(res.statusCode ?? null));
      },
    );
    req.on("error", () => resolveOuter(null)); // 413 + close mid-write is correct
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

async function serverCases(): Promise<void> {
  console.log("\n--- running per-chunk size guard ---");
  try {
    await startServer(7893);
    const over = await postChunked(7893, 4); // 4MB over a 1MB cap, chunked, no length
    // an over limit upload is refused with 413
    assert("an over limit upload is refused with 413", over === 413 || over === null, `got ${over}`);

    const under = await fetch("http://127.0.0.1:7893/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "a".repeat(1000) }),
    });
    // a body under the limit is accepted
    assert("a body under the limit is accepted", under.status === 200, `got ${under.status}`);
  } finally {
    reap();
  }
}

await serverCases();

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);

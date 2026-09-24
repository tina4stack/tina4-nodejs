/**
 * A binary body sent with an EXPLICIT content type arrives byte for byte.
 *
 * THE BUG: `response(buffer, 200, "image/png")` took the text branch and wrote
 * `String(buffer)` - the bytes decoded as UTF-8, every invalid sequence turned
 * into U+FFFD, and the client got a larger, broken file (a PNG that does not
 * decode). Without a content type the same Buffer was written as bytes, so the
 * damage only showed when a handler named the type - which is exactly what an
 * image or download route does.
 *
 * THE TEST: one REAL server started by the REAL `startServer()`, route files on
 * disk, a real socket. Each route sends all 256 byte values (0x00-0xFF) and the
 * client compares the raw bytes it received. No mocks.
 *
 * Run with: npx tsx test/responseBinaryBody.test.ts
 */
import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/src/index.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
  }
}

process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_RATE_LIMIT = "100000";

const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

const root = mkdtempSync(join(tmpdir(), "tina4-binary-body-"));
const route = (path: string, body: string) => {
  mkdirSync(join(root, "src/routes", path), { recursive: true });
  writeFileSync(join(root, "src/routes", path, "get.ts"), body);
};
const allBytesSource = "Buffer.from(Array.from({ length: 256 }, (_, i) => i))";
route("bin/call", `export default async function (_req: any, res: any) { return res(${allBytesSource}, 200, "image/png"); }\n`);
route("bin/send", `export default async function (_req: any, res: any) { return res.send(${allBytesSource}, 200, "application/octet-stream"); }\n`);
route("bin/bytes", `export default async function (_req: any, res: any) { return res(new Uint8Array(${allBytesSource}), 200, "application/octet-stream"); }\n`);
route("bin/auto", `export default async function (_req: any, res: any) { return res(${allBytesSource}); }\n`);
route("bin/text", `export default async function (_req: any, res: any) { return res("héllo", 200, "text/plain; charset=utf-8"); }\n`);
route("bin/json", `export default async function (_req: any, res: any) { return res({ a: 1 }, 200, "application/vnd.api+json"); }\n`);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path, headers: { "accept-encoding": "identity" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

const PORT = await freePort();
const server = await startServer({
  port: PORT,
  routesDir: join(root, "src/routes"),
  modelsDir: join(root, "src/models"),
  staticDir: join(root, "public"),
});

try {
  console.log("-- A binary body with an explicit content type arrives unchanged --");
  for (const [path, type] of [["/bin/call", "image/png"], ["/bin/send", "application/octet-stream"], ["/bin/bytes", "application/octet-stream"]]) {
    const r = await get(PORT, path);
    assert(`${path}: status 200 and content type ${type}`, r.status === 200 && r.type === type, `got ${r.status} ${r.type}`);
    assert(`${path}: the 256 bytes 0x00-0xFF arrive identical`, r.body.equals(ALL_BYTES),
      `got ${r.body.length} bytes, first difference at ${r.body.findIndex((b, i) => b !== ALL_BYTES[i])}`);
  }

  console.log("-- Controls: the other branches still behave --");
  {
    const r = await get(PORT, "/bin/auto");
    assert("no content type: a Buffer is octet-stream, bytes identical", r.type === "application/octet-stream" && r.body.equals(ALL_BYTES), `got ${r.type}, ${r.body.length} bytes`);
  }
  {
    const r = await get(PORT, "/bin/text");
    assert("a string with an explicit type is sent as UTF-8 text", r.body.equals(Buffer.from("héllo", "utf8")), `got ${JSON.stringify(r.body.toString())}`);
  }
  {
    const r = await get(PORT, "/bin/json");
    assert("an object with an explicit type is still JSON", r.type === "application/vnd.api+json" && r.body.toString() === '{"a":1}', `got ${r.type} ${r.body.toString()}`);
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);

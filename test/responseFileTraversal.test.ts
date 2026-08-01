/**
 * Regression: response.file() must not serve a file outside its root.
 * Run with: npx tsx test/responseFileTraversal.test.ts
 *
 * The bug: the natural spelling of a download route,
 *
 *     response.file("downloads/" + name)   // name = "../secret.env"
 *
 * served any file the process could read. Driven here over REAL HTTP, because
 * that is what proves the hole is reachable from the wire rather than only
 * from a direct API call.
 *
 * Two properties are pinned, and BOTH matter:
 *
 *   - the single-hop escape "downloads/../secret.env" is refused. This is the
 *     discriminating case. A deep "../../../.." chain can climb above / and
 *     resolve to nothing, so it can 404 on a VULNERABLE build too - a test
 *     that only checks the deep chain passes against the bug.
 *   - a legitimate file inside the root is still served. Without this negative
 *     control, a "fix" that simply breaks file() would pass.
 *
 * No mocks: a real server, real sockets, real files.
 */
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { realpathSync } from "node:fs";
import { createResponse } from "../packages/core/src/response.ts";

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

const root = realpathSync(mkdtempSync(join(tmpdir(), "tina4-trav-")));
mkdirSync(join(root, "downloads"));
writeFileSync(join(root, "downloads", "report.txt"), "PUBLIC REPORT\n");
writeFileSync(join(root, "secret.env"), "TINA4_SECRET=super-secret-value\n");
const originalCwd = process.cwd();
process.chdir(root);

// The vulnerable spelling: a user-supplied name concatenated onto a directory.
const server = http.createServer((req, res) => {
  const name = new URL(req.url!, "http://x").searchParams.get("name") ?? "";
  createResponse(res).file("downloads/" + name);
});

async function get(name: string): Promise<{ status: number; body: string }> {
  const port = (server.address() as { port: number }).port;
  const r = await fetch(`http://127.0.0.1:${port}/?name=${encodeURIComponent(name)}`);
  return { status: r.status, body: await r.text() };
}

console.log("\nresponse.file() path confinement\n");

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const ok = await get("report.txt");
assert("serves a file inside the root (NEGATIVE CONTROL)", ok.status === 200 && ok.body === "PUBLIC REPORT\n", `got ${ok.status} ${JSON.stringify(ok.body)}`);

const hop = await get("../secret.env");
assert("refuses a single-hop escape to a real file next door", hop.status === 403, `got ${hop.status}`);
assert("single-hop escape leaks no secret bytes", !hop.body.includes("super-secret-value"));

const deep = await get("../../../../../../../etc/passwd");
assert("refuses a deep traversal chain", deep.status === 403, `got ${deep.status}`);

// Absolute path with no ".." at all - containment, not the ".." check, has to
// catch this one. Containment applies ONLY when the caller declared a root, so
// the root is what makes it 403. Served through its own server since the
// handler above always prefixes "downloads/".
const absServer = http.createServer((_req, res) => createResponse(res).file("/etc/passwd", { root }));
await new Promise<void>((resolve) => absServer.listen(0, "127.0.0.1", resolve));
const absPort = (absServer.address() as { port: number }).port;
const abs = await fetch(`http://127.0.0.1:${absPort}/`);
assert("refuses an absolute path outside a DECLARED root (no '..' at all)", abs.status === 403, `got ${abs.status}`);
await abs.text();

// REGRESSION CONTROL. Confinement once defaulted to process.cwd(), so every
// legitimate absolute path outside the project answered 403 - a missing file
// reported Forbidden instead of Not Found. Unrooted, an absolute path is the
// caller's business (Express res.sendFile, Rails send_file, ASP.NET
// PhysicalFile all serve one), so this must NOT be 403.
const outsideFile = join(tmpdir(), `tina4-outside-${process.pid}.txt`);
writeFileSync(outsideFile, "OUTSIDE\n");
const unrootedServer = http.createServer((req, res) => {
  const name = new URL(req.url!, "http://x").searchParams.get("name") ?? "";
  createResponse(res).file(name);
});
await new Promise<void>((resolve) => unrootedServer.listen(0, "127.0.0.1", resolve));
const unrootedPort = (unrootedServer.address() as { port: number }).port;
const unrootedGet = async (name: string) =>
  fetch(`http://127.0.0.1:${unrootedPort}/?name=${encodeURIComponent(name)}`);
const outsideRes = await unrootedGet(outsideFile);
const outsideBody = await outsideRes.text();
assert("serves an absolute path when NO root is declared", outsideRes.status === 200 && outsideBody === "OUTSIDE\n", `got ${outsideRes.status} ${JSON.stringify(outsideBody)}`);
const missingRes = await unrootedGet("/nonexistent/path/to/file.css");
assert("a MISSING absolute path is 404, not 403", missingRes.status === 404, `got ${missingRes.status}`);
await missingRes.text();
unrootedServer.close();
rmSync(outsideFile, { force: true });

// An explicit root wins over the working directory.
const rootServer = http.createServer((req, res) => {
  const name = new URL(req.url!, "http://x").searchParams.get("name") ?? "";
  createResponse(res).file(name, { root: join(root, "downloads") });
});
await new Promise<void>((resolve) => rootServer.listen(0, "127.0.0.1", resolve));
const rootPort = (rootServer.address() as { port: number }).port;
const inRoot = await fetch(`http://127.0.0.1:${rootPort}/?name=report.txt`);
assert("honours an explicit root", inRoot.status === 200 && (await inRoot.text()) === "PUBLIC REPORT\n");
const outRoot = await fetch(`http://127.0.0.1:${rootPort}/?name=${encodeURIComponent("../secret.env")}`);
assert("refuses an escape from an explicit root", outRoot.status === 403, `got ${outRoot.status}`);
await outRoot.text();

server.close();
absServer.close();
rootServer.close();
process.chdir(originalCwd);
rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);

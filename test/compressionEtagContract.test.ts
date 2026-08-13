/**
 * Shared contract suite for feature 40 -- HTTP compression + ETag.
 *
 * Fixture: tina4-documentation/plan/v3/fixtures/compression_etag_contract.json
 * Decisions: CE-DEC-01 (parity -- gzip + dynamic ETag + conditional-GET are a
 * real four-language feature, ported from Python to PHP/Ruby/Node) + CE-DEC-02
 * (one pinned weak static ETag format `W/"<size>-<mtime>"` across the four;
 * Python's 304 now preserves ETag/Last-Modified; If-None-Match matching
 * unified on RFC-7232 weak comparison -- Node's static path was already
 * correct and the new dynamic path reuses the same algorithm).
 *
 * NO MOCKS -- a REAL @tina4/core server is booted with startServer (file-based
 * route discovery, real static-file serving), driven with genuine node:http
 * requests -- real Accept-Encoding / If-None-Match / If-Modified-Since request
 * headers -- and a real zlib.gunzipSync decode of the wire body.
 *
 * Same case names in all four:
 *   tina4-python/tests/test_compression_etag_contract.py
 *   tina4-php/tests/CompressionEtagContractTest.php
 *   tina4-ruby/spec/compression_etag_contract_spec.rb
 *
 * Run with: npx tsx test/compressionEtagContract.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import zlib from "node:zlib";
import { mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./freePort.ts";

const TEST_DIR = "/tmp/tina4-compression-etag-contract-test";
const PORT = await freePort();
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

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A REAL HTTP round trip over node:http -- no in-process shortcut, no auto-decompression. */
function request(path: string, reqHeaders?: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "GET", headers: reqHeaders ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── Fixture project: file-based routes + a real static asset ────────────
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* fresh */ }
mkdirSync(join(TEST_DIR, "src/routes/big"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/small"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/binary"), { recursive: true });
mkdirSync(join(TEST_DIR, "public"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');

// ~2010 bytes serialized, all-'x' repeats -> compresses hard, a strong
// positive gzip signal when the decompressed body is checked byte-exact.
writeFileSync(join(TEST_DIR, "src/routes/big/get.ts"), `
export default async function (req: any, res: any) {
  return res.json({ data: "x".repeat(2000) });
}
`);
writeFileSync(join(TEST_DIR, "src/routes/small/get.ts"), `
export default async function (req: any, res: any) {
  return res.json({ ok: true });
}
`);
// >1KB, highly-compressible BYTES, but a non-compressible declared
// content-type -- proves the content-type gate, not just a size gate.
writeFileSync(join(TEST_DIR, "src/routes/binary/get.ts"), `
export default async function (req: any, res: any) {
  return res.send(Buffer.from("x".repeat(2000)), 200, "application/octet-stream");
}
`);

const STATIC_MTIME = 1_700_000_000; // a round epoch second -- avoids rounding ambiguity
const staticFilePath = join(TEST_DIR, "public", "asset.css");
writeFileSync(staticFilePath, ".contract-etag-fixture { color: red; }\n" + "/* pad */\n".repeat(80));
utimesSync(staticFilePath, new Date(STATIC_MTIME * 1000), new Date(STATIC_MTIME * 1000));
const staticSize = statSync(staticFilePath).size;

console.log("=== Compression + ETag contract (Node) ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

function gunzip(buf: Buffer): Buffer {
  return zlib.gunzipSync(buf);
}

// ── 1. compressible_body_over_1kb_gzips_with_vary ──────────────────────

{
  const r = await request("/big", { "Accept-Encoding": "gzip" });
  assert("compressible_body_over_1kb_gzips_with_vary: 200", r.status === 200);
  assert("compressible_body_over_1kb_gzips_with_vary: content-encoding gzip", r.headers["content-encoding"] === "gzip");
  assert("compressible_body_over_1kb_gzips_with_vary: vary Accept-Encoding", r.headers["vary"] === "Accept-Encoding");
  const decoded = JSON.parse(gunzip(r.body).toString("utf-8"));
  assert("compressible_body_over_1kb_gzips_with_vary: decoded body matches", decoded.data === "x".repeat(2000));

  // Negative: WITHOUT the header -> identity.
  const r2 = await request("/big");
  assert("compressible_body_over_1kb_gzips_with_vary: identity without header", r2.status === 200 && r2.headers["content-encoding"] === undefined);
  const decoded2 = JSON.parse(r2.body.toString("utf-8"));
  assert("compressible_body_over_1kb_gzips_with_vary: identity body matches", decoded2.data === "x".repeat(2000));
}

// ── 2. small_or_incompressible_body_not_gzipped ─────────────────────────

{
  const r = await request("/small", { "Accept-Encoding": "gzip" });
  assert("small_or_incompressible_body_not_gzipped: small body not gzipped", r.status === 200 && r.headers["content-encoding"] === undefined);
  assert("small_or_incompressible_body_not_gzipped: small body matches", JSON.parse(r.body.toString("utf-8")).ok === true);

  const r2 = await request("/binary", { "Accept-Encoding": "gzip" });
  assert("small_or_incompressible_body_not_gzipped: incompressible content-type not gzipped", r2.status === 200 && r2.headers["content-encoding"] === undefined);
  assert("small_or_incompressible_body_not_gzipped: binary body matches", r2.body.toString("utf-8") === "x".repeat(2000));
}

// ── 3. cacheable_response_carries_an_etag ────────────────────────────────

{
  const r = await request("/small");
  assert("cacheable_response_carries_an_etag: 200", r.status === 200);
  assert("cacheable_response_carries_an_etag: etag present", typeof r.headers["etag"] === "string" && r.headers["etag"]!.length > 0);
}

// ── 4. matching_if_none_match_returns_304_preserving_validators ────────

{
  // Dynamic response: strong ETag only.
  const first = await request("/small");
  const etag = first.headers["etag"] as string;
  const r2 = await request("/small", { "If-None-Match": etag });
  assert("matching_if_none_match_returns_304_preserving_validators: dynamic 304", r2.status === 304);
  assert("matching_if_none_match_returns_304_preserving_validators: dynamic empty body", r2.body.length === 0);
  assert("matching_if_none_match_returns_304_preserving_validators: dynamic etag preserved", r2.headers["etag"] === etag);

  // Static response: weak ETag AND Last-Modified -- the 304 must preserve BOTH.
  const sfirst = await request("/asset.css");
  const setag = sfirst.headers["etag"] as string;
  const slastModified = sfirst.headers["last-modified"] as string;
  const r3 = await request("/asset.css", { "If-None-Match": setag });
  assert("matching_if_none_match_returns_304_preserving_validators: static 304", r3.status === 304);
  assert("matching_if_none_match_returns_304_preserving_validators: static empty body", r3.body.length === 0);
  assert("matching_if_none_match_returns_304_preserving_validators: static etag preserved", r3.headers["etag"] === setag);
  assert("matching_if_none_match_returns_304_preserving_validators: static last-modified preserved", r3.headers["last-modified"] === slastModified);
}

// ── 5. rfc7232_weak_list_star_inm_matches ────────────────────────────────

{
  const first = await request("/small");
  const etag = first.headers["etag"] as string; // a STRONG tag, e.g. "a1b2c3d4e5f60718"
  const weakForm = `W/${etag}`;

  const rw = await request("/small", { "If-None-Match": weakForm });
  assert("rfc7232_weak_list_star_inm_matches: weak-prefixed candidate matches", rw.status === 304);

  const rlist = await request("/small", { "If-None-Match": `"not-it", ${weakForm}` });
  assert("rfc7232_weak_list_star_inm_matches: comma-list matches", rlist.status === 304);

  const rstar = await request("/small", { "If-None-Match": "*" });
  assert("rfc7232_weak_list_star_inm_matches: wildcard matches", rstar.status === 304);

  const rmiss = await request("/small", { "If-None-Match": '"totally-different"' });
  assert("rfc7232_weak_list_star_inm_matches: non-matching tag serves 200", rmiss.status === 200);
}

// ── 6. static_etag_format_identical_across_the_four ──────────────────────

{
  const r = await request("/asset.css");
  assert("static_etag_format_identical_across_the_four: 200", r.status === 200);
  const expected = `W/"${staticSize}-${STATIC_MTIME}"`;
  assert("static_etag_format_identical_across_the_four: pinned weak size-mtime format",
    r.headers["etag"] === expected, `got "${String(r.headers["etag"])}" want "${expected}"`);
}

server.close();
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* best-effort cleanup */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

/**
 * Issue #106 parity tests — verifies equivalent bugs from tina4-python issue #106
 * are correct in tina4-nodejs.
 *
 * Run with: npx tsx test/issue106.test.ts
 */
import { Router, RouteGroup } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, UploadedFile } from "../packages/core/src/index.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";
import { DatabaseResult } from "../packages/orm/src/databaseResult.ts";
import { buildQuery, parseQueryString } from "../packages/orm/src/query.ts";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== Issue #106 Parity Tests ===\n");

// -------------------------------------------------------
// 1. Wildcard param key is "*"
// -------------------------------------------------------
console.log("--- 1. Wildcard param key is \"*\" ---");

const router1 = new Router();
const handler = async (req: Tina4Request, res: Tina4Response) => {};

router1.get("/docs/*", handler);

const wildcardMatch = router1.match("GET", "/docs/getting-started/intro");
assert("Wildcard route matches nested path", wildcardMatch !== null);
assert(
  "Wildcard param key is \"*\"",
  wildcardMatch !== null && wildcardMatch.params["*"] === "getting-started/intro",
);

const wildcardSingle = router1.match("GET", "/docs/readme");
assert(
  "Wildcard matches single segment",
  wildcardSingle !== null && wildcardSingle.params["*"] === "readme",
);

const noWildcard = router1.match("GET", "/other/path");
assert("Wildcard does not match unrelated path", noWildcard === null);

// -------------------------------------------------------
// 2. Router group accessible
// -------------------------------------------------------
console.log("\n--- 2. Router group accessible ---");

const router2 = new Router();
router2.group("/api/v1", (group) => {
  group.get("/items", handler);
  group.post("/items", handler);
});

const groupGetMatch = router2.match("GET", "/api/v1/items");
assert("Group GET /api/v1/items matches", groupGetMatch !== null);

const groupPostMatch = router2.match("POST", "/api/v1/items");
assert("Group POST /api/v1/items matches", groupPostMatch !== null);

const groupNoMatch = router2.match("GET", "/items");
assert("Route without group prefix does not match", groupNoMatch === null);

// Nested groups
const router2b = new Router();
router2b.group("/api", (api) => {
  api.group("/v2", (v2) => {
    v2.get("/users", handler);
  });
});
const nestedGroupMatch = router2b.match("GET", "/api/v2/users");
assert("Nested group /api/v2/users matches", nestedGroupMatch !== null);

// -------------------------------------------------------
// 3. request.files for multipart
// -------------------------------------------------------
console.log("\n--- 3. request.files for multipart ---");

// Import the multipart parser directly
const { parseBody } = await import("../packages/core/src/request.ts");

// Simulate a multipart body
const boundary = "----TestBoundary123";
const contentType = `multipart/form-data; boundary=${boundary}`;
const crlf = "\r\n";
const multipartBody =
  `------TestBoundary123${crlf}` +
  `Content-Disposition: form-data; name="title"${crlf}${crlf}` +
  `Hello World${crlf}` +
  `------TestBoundary123${crlf}` +
  `Content-Disposition: form-data; name="avatar"; filename="photo.png"${crlf}` +
  `Content-Type: image/png${crlf}${crlf}` +
  `<binary-data-here>${crlf}` +
  `------TestBoundary123--${crlf}`;

const bodyBuffer = Buffer.from(multipartBody);

// parseBody reads from the stream, so test the parseMultipart function directly.
// parseMultipart is a real export of packages/core/src/request.ts.
const { parseMultipart } = await import("../packages/core/src/request.ts");

const { fields, files } = parseMultipart(bodyBuffer, boundary);
assert("Multipart fields extracted (title)", fields["title"] === "Hello World");
assert("Multipart files separated from body", Object.keys(files).length === 1);

const avatarFile = files["avatar"] as UploadedFile;
assert(
  "Uploaded file has correct filename",
  avatarFile.filename === "photo.png",
);
assert(
  "Uploaded file has correct field name",
  avatarFile.fieldName === "avatar",
);

// The whole point of parseMultipart is to carve the binary payload out of the
// raw body — not just register the field key. Prove the actual bytes, MIME
// type, and size are extracted (replaces the old dead-branch `"files" in mockReq`
// existence smoke check). The part body was `<binary-data-here>`.
const expectedBytes = Buffer.from("<binary-data-here>");
assert(
  "Uploaded file content is a Buffer",
  Buffer.isBuffer(avatarFile.content),
);
assert(
  "Uploaded file content bytes equal the part payload",
  avatarFile.content.equals(expectedBytes),
  `got ${JSON.stringify(avatarFile.content.toString("utf-8"))}`,
);
assert(
  "Uploaded file MIME type is image/png",
  avatarFile.type === "image/png",
  `got ${avatarFile.type}`,
);
assert(
  "Uploaded file size equals the payload byte length",
  avatarFile.size === expectedBytes.length,
  `got ${avatarFile.size}, expected ${expectedBytes.length}`,
);

// -------------------------------------------------------
// 4. toPaginate() describes the fetched page (ADR-0043)
// -------------------------------------------------------
console.log("\n--- 4. toPaginate() describes the fetched page (ADR-0043) ---");

// The old FetchResult.toPaginate(page, perPage) re-sliced rows in memory; ADR-0043
// abolished that. The real DatabaseResult (what db.fetch returns) holds the page's
// rows plus the TRUE total, and toPaginate() takes NO arguments — it derives the
// seven-key envelope from the query that ran, never re-slicing. A page-2 fetch
// (limit 10, offset 10) over a 50-row table:
const pageRecords: Record<string, unknown>[] = [];
for (let i = 11; i <= 20; i++) pageRecords.push({ id: i, name: `Item ${i}` });
const pageResult = new DatabaseResult(pageRecords, undefined, 50, 10, 10);
const env106 = pageResult.toPaginate();

assert("Page 2 carries its 10 rows verbatim", env106.records.length === 10);
assert("First row on page 2 is id 11", (env106.records[0] as { id: number }).id === 11);
assert("Last row on page 2 is id 20", (env106.records[9] as { id: number }).id === 20);
assert("total is the true total (50), not rows returned", env106.total === 50);
assert("total_pages is ceil(50/10) = 5", env106.total_pages === 5);
assert("page is derived from the offset (2)", env106.page === 2);
assert("per_page is the applied limit (10)", env106.per_page === 10);

// -------------------------------------------------------
// 5. columnInfo() types
// -------------------------------------------------------
console.log("\n--- 5. columnInfo() types ---");

const adapter = new SQLiteAdapter(":memory:");
adapter.execute(
  "CREATE TABLE test_cols (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, active BOOLEAN)",
);
adapter.execute(
  "INSERT INTO test_cols (id, name, price, active) VALUES (1, 'Widget', 9.99, 1)",
);

const rows = adapter.fetch("SELECT * FROM test_cols");
const result = new DatabaseResult(
  rows,
  undefined,
  undefined,
  undefined,
  undefined,
  adapter,
  "SELECT * FROM test_cols",
);

const colInfo = result.columnInfo();
assert("columnInfo returns 4 columns", colInfo.length === 4);

const idCol = colInfo.find((c) => c.name === "id");
assert("id column type is INTEGER", idCol?.type === "INTEGER");
assert("id column is primary key", idCol?.primary_key === true);

const nameCol = colInfo.find((c) => c.name === "name");
assert("name column type is TEXT", nameCol?.type === "TEXT");
assert("name column is not nullable", nameCol?.nullable === false);

const priceCol = colInfo.find((c) => c.name === "price");
assert("price column type is REAL", priceCol?.type === "REAL");

const activeCol = colInfo.find((c) => c.name === "active");
assert("active column type is BOOLEAN", activeCol?.type === "BOOLEAN");

// -------------------------------------------------------
// 6. Default fetch limit is 100
// -------------------------------------------------------
console.log("\n--- 6. Default fetch limit is 100 ---");

// buildQuery with no explicit limit should use 100
const { sql, params } = buildQuery("items", parseQueryString({}));
const limitParam = params[params.length - 2]; // second-to-last is LIMIT
assert(
  "Default query limit is 100",
  limitParam === 100,
  `got ${limitParam}`,
);
assert("SQL contains LIMIT placeholder", sql.includes("LIMIT ?"));

// Explicit limit overrides
const { params: customParams } = buildQuery("items", parseQueryString({ limit: "25" }));
const customLimit = customParams[customParams.length - 2];
assert("Explicit limit=25 is respected", customLimit === 25, `got ${customLimit}`);

// -------------------------------------------------------
// 7. CSS served from framework public
// -------------------------------------------------------
console.log("\n--- 7. CSS served from framework public ---");

const rootDir = join(__dirname, "..");
const cssPath = join(rootDir, "packages", "core", "public", "css", "tina4.css");
const cssMinPath = join(rootDir, "packages", "core", "public", "css", "tina4.min.css");

assert("tina4.css exists in packages/core/public/css/", existsSync(cssPath));
assert("tina4.min.css exists in packages/core/public/css/", existsSync(cssMinPath));

// Clean up
adapter.close();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

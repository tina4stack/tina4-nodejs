/**
 * File upload tests — verifies multipart parsing with a real SVG file.
 *
 * Run with: npx tsx test/fileUpload.test.ts
 */
import { readFileSync } from "node:fs";
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

console.log("=== File Upload Tests ===\n");

const { parseMultipart } = await import("../packages/core/src/request.ts");

const logoPath = join(__dirname, "..", "packages", "core", "public", "images", "logo.svg");
const logoBytes = readFileSync(logoPath);

const boundary = "----Tina4UploadBoundary9876";
const crlf = "\r\n";

// -------------------------------------------------------
// 1. Single file upload
// -------------------------------------------------------
console.log("--- 1. Single file upload ---");

const singleBody = Buffer.concat([
  Buffer.from(
    `------Tina4UploadBoundary9876${crlf}` +
    `Content-Disposition: form-data; name="logo"; filename="logo.svg"${crlf}` +
    `Content-Type: image/svg+xml${crlf}${crlf}`,
  ),
  logoBytes,
  Buffer.from(`${crlf}------Tina4UploadBoundary9876--${crlf}`),
]);

const single = parseMultipart(singleBody, boundary);

assert("Single file: files dict has one entry", Object.keys(single.files).length === 1);
assert("Single file: keyed by fieldName 'logo'", "logo" in single.files);

const logoFile = single.files["logo"] as any;
assert("Single file: filename is 'logo.svg'", logoFile.filename === "logo.svg");
assert("Single file: type is 'image/svg+xml'", logoFile.type === "image/svg+xml");
assert("Single file: size matches original", logoFile.size === logoBytes.length, `expected ${logoBytes.length}, got ${logoFile.size}`);

// -------------------------------------------------------
// 2. Content is Buffer (raw bytes, not base64)
// -------------------------------------------------------
console.log("\n--- 2. Content is Buffer ---");

assert("Content is a Buffer instance", Buffer.isBuffer(logoFile.content));
assert("Content bytes match original file", logoFile.content.equals(logoBytes));

// -------------------------------------------------------
// 3. Non-file fields go to body, files go to files dict
// -------------------------------------------------------
console.log("\n--- 3. Fields vs files separation ---");

const mixedBody = Buffer.concat([
  Buffer.from(
    `------Tina4UploadBoundary9876${crlf}` +
    `Content-Disposition: form-data; name="title"${crlf}${crlf}` +
    `My Upload${crlf}` +
    `------Tina4UploadBoundary9876${crlf}` +
    `Content-Disposition: form-data; name="description"${crlf}${crlf}` +
    `A test file${crlf}` +
    `------Tina4UploadBoundary9876${crlf}` +
    `Content-Disposition: form-data; name="attachment"; filename="logo.svg"${crlf}` +
    `Content-Type: image/svg+xml${crlf}${crlf}`,
  ),
  logoBytes,
  Buffer.from(`${crlf}------Tina4UploadBoundary9876--${crlf}`),
]);

const mixed = parseMultipart(mixedBody, boundary);

assert("Fields: 'title' is in fields", mixed.fields["title"] === "My Upload");
assert("Fields: 'description' is in fields", mixed.fields["description"] === "A test file");
assert("Fields: no file keys in fields", !("attachment" in mixed.fields));
assert("Files: 'attachment' is in files", "attachment" in mixed.files);
assert("Files: no field keys in files", !("title" in mixed.files) && !("description" in mixed.files));

// -------------------------------------------------------
// 4. Multiple files under different field names
// -------------------------------------------------------
console.log("\n--- 4. Multiple files, different field names ---");

const multiBody = Buffer.concat([
  Buffer.from(
    `------Tina4UploadBoundary9876${crlf}` +
    `Content-Disposition: form-data; name="avatar"; filename="avatar.svg"${crlf}` +
    `Content-Type: image/svg+xml${crlf}${crlf}`,
  ),
  logoBytes,
  Buffer.from(
    `${crlf}------Tina4UploadBoundary9876${crlf}` +
    `Content-Disposition: form-data; name="banner"; filename="banner.svg"${crlf}` +
    `Content-Type: image/svg+xml${crlf}${crlf}`,
  ),
  logoBytes,
  Buffer.from(`${crlf}------Tina4UploadBoundary9876--${crlf}`),
]);

const multi = parseMultipart(multiBody, boundary);

assert("Multiple files: two entries in files dict", Object.keys(multi.files).length === 2);
assert("Multiple files: 'avatar' key exists", "avatar" in multi.files);
assert("Multiple files: 'banner' key exists", "banner" in multi.files);

const avatarFile = multi.files["avatar"] as any;
const bannerFile = multi.files["banner"] as any;
assert("Multiple files: avatar filename correct", avatarFile.filename === "avatar.svg");
assert("Multiple files: banner filename correct", bannerFile.filename === "banner.svg");
assert("Multiple files: avatar fieldName is 'avatar'", avatarFile.fieldName === "avatar");
assert("Multiple files: banner fieldName is 'banner'", bannerFile.fieldName === "banner");

// -------------------------------------------------------
// 5. Content contains valid SVG
// -------------------------------------------------------
console.log("\n--- 5. Content contains valid SVG ---");

const svgText = logoFile.content.toString("utf-8");
assert("SVG content starts with '<'", svgText.trimStart().startsWith("<"));
assert("SVG content contains '<svg'", svgText.includes("<svg"));
assert("SVG content contains '</svg>'", svgText.includes("</svg>"));

// -------------------------------------------------------
// 6. Files are keyed by fieldName (dict, not array)
// -------------------------------------------------------
console.log("\n--- 6. Files keyed by fieldName (dict, not array) ---");

assert("files is a plain object (not an array)", !Array.isArray(single.files));
assert("files is a plain object (typeof)", typeof single.files === "object" && single.files !== null);
assert("File entry accessed by fieldName key", single.files["logo"] !== undefined);
assert("File entry fieldName matches its key", (single.files["logo"] as any).fieldName === "logo");

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

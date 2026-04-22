/**
 * Unit tests for the ProjectIndex module.
 * Run with: npx tsx test/projectIndex.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-idx-"));
const originalCwd = process.cwd();
process.chdir(tmpRoot);

// Seed a small project.
fs.mkdirSync(path.join(tmpRoot, "src", "routes"), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, "src", "orm"), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, "migrations"), { recursive: true });

fs.writeFileSync(
  path.join(tmpRoot, "src", "routes", "users.ts"),
  `import { get, post } from "@tina4/core";\nexport const meta = {};\nget("/api/users", async (req, res) => res.json([]));\npost("/api/users", async (req, res) => res.json({}));\n`,
);
fs.writeFileSync(
  path.join(tmpRoot, "src", "orm", "User.ts"),
  `export class User {\n  static tableName = "users";\n  static fields = {};\n}\n`,
);
fs.writeFileSync(
  path.join(tmpRoot, "migrations", "001_create_users.sql"),
  `CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE INDEX idx_users_id ON users(id);\n`,
);
fs.writeFileSync(
  path.join(tmpRoot, "README.md"),
  `# My Project\n\n## Overview\n\nA test project.\n\n## Usage\n\nRun it.\n`,
);

const { ProjectIndex } = await import("../packages/core/src/projectIndex.ts");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

console.log("=== ProjectIndex Tests ===\n");

// --- refresh ---
const r1 = ProjectIndex.refresh();
assert("refresh added files", r1.added >= 4);
assert("refresh total >= 4", r1.total >= 4);
assert("refresh index path", r1.path === path.join(".tina4", "project_index.json"));

// --- second refresh is a no-op ---
const r2 = ProjectIndex.refresh();
assert("second refresh adds 0", r2.added === 0);

// --- search ---
const hits = ProjectIndex.search("users");
assert("search finds results", hits.length >= 2);
assert("top hit has path", typeof hits[0].path === "string");

// --- fileEntry ---
const entry = ProjectIndex.fileEntry("src/routes/users.ts");
assert("fileEntry has routes", (entry.routes || []).length >= 2);
const routePaths = (entry.routes || []).map((r) => `${r.method} ${r.path}`);
assert("GET /api/users detected", routePaths.includes("GET /api/users"));
assert("POST /api/users detected", routePaths.includes("POST /api/users"));

const sqlEntry = ProjectIndex.fileEntry("migrations/001_create_users.sql");
assert("SQL create detected", (sqlEntry.creates || []).some((c) => c.startsWith("TABLE")));

const mdEntry = ProjectIndex.fileEntry("README.md");
assert("MD title extracted", mdEntry.title === "My Project");
assert("MD sections extracted", (mdEntry.sections || []).includes("Overview"));

// --- overview ---
const ov = ProjectIndex.overview();
assert("overview total_files", (ov.total_files as number) >= 4);
assert("overview by_language includes typescript", Object.keys(ov.by_language as any).includes("typescript"));
assert("overview routes_declared >= 2", (ov.routes_declared as number) >= 2);
assert("overview orm_models >= 1", (ov.orm_models as number) >= 1);

// --- update after edit ---
fs.writeFileSync(
  path.join(tmpRoot, "src", "routes", "new.ts"),
  `import { get } from "@tina4/core";\nget("/api/new", async () => {});\n`,
);
const r3 = ProjectIndex.refresh();
assert("refresh adds new file", r3.added === 1);

// --- deletion ---
fs.unlinkSync(path.join(tmpRoot, "src", "routes", "new.ts"));
const r4 = ProjectIndex.refresh();
assert("refresh removes deleted file", r4.removed === 1);

// Cleanup
process.chdir(originalCwd);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

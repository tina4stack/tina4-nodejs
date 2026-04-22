/**
 * Unit tests for the Plan module (ported from Python tina4_python.dev_admin.plan).
 * Run with: npx tsx test/plan.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Use a temp project root so we don't pollute the repo's real plan/ dir.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-plan-"));
const originalCwd = process.cwd();
process.chdir(tmpRoot);

// Import AFTER chdir so plan.ts captures the temp root on first call.
const { Plan } = await import("../packages/core/src/plan.ts");

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

console.log("=== Plan Tests ===\n");

// --- create ---
console.log("--- create ---");
const created = Plan.create("Add user authentication", "JWT login/registration", ["Create User model", "Add /api/login route"]);
assert("create returns ok", created.ok === true);
assert("create sets name", !!created.name);
assert("create makes it current", created.is_current === true);
assert("plan file exists", fs.existsSync(path.join(tmpRoot, "plan", created.name!)));

// --- listPlans ---
const list = Plan.listPlans();
assert("listPlans returns one entry", list.length === 1);
assert("listPlans marks current", list[0].is_current === true);
assert("listPlans has step counts", list[0].steps_total === 2 && list[0].steps_done === 0);

// --- current ---
const cur = Plan.current();
assert("current has name", cur.current === created.name);
assert("current has title", cur.title === "Add user authentication");
assert("current has steps", (cur.steps || []).length === 2);
assert("current.next_step is first", cur.next_step?.text === "Create User model");
assert("current.progress", cur.progress?.total === 2 && cur.progress?.done === 0);

// --- completeStep ---
const done1 = Plan.completeStep(0);
assert("completeStep ok", done1.ok === true);
assert("completeStep has remaining", done1.remaining === 1);
assert("completeStep next", done1.next_step === "Add /api/login route");
const cur2 = Plan.current();
assert("after complete progress done=1", cur2.progress?.done === 1);

// --- addStep ---
const add = Plan.addStep("Add /api/register route");
assert("addStep ok", add.ok === true);
assert("addStep returns index", add.index === 2);
assert("current has 3 steps now", (Plan.current().steps || []).length === 3);

// --- appendNote ---
const note = Plan.appendNote("Use 60-minute tokens");
assert("appendNote ok", note.ok === true);
const cur3 = Plan.current();
assert("notes contain text", (cur3.notes || "").includes("Use 60-minute tokens"));

// --- read ---
const readBack = Plan.read(created.name!);
assert("read returns parsed", readBack.title === "Add user authentication");
assert("read.steps length", readBack.steps.length === 3);

// --- setCurrent / clearCurrent ---
const second = Plan.create("Second plan", "", ["Do a thing"]);
assert("second plan created", second.ok === true);
assert("currentName is second", Plan.currentName() === second.name);
const switched = Plan.setCurrent(created.name!);
assert("setCurrent ok", switched.ok === true);
assert("currentName switched", Plan.currentName() === created.name);
Plan.clearCurrent();
assert("clearCurrent resets", Plan.currentName() === "");
Plan.setCurrent(created.name!);

// --- recordAction + summariseExecution ---
Plan.recordAction("created", "src/orm/User.ts");
Plan.recordAction("patched", "src/app/middleware.ts");
Plan.recordAction("migration", "migrations/001_create_users.sql");
const summary = Plan.summariseExecution();
assert("summariseExecution total", summary.total === 3);
assert("summariseExecution created", summary.created.includes("src/orm/User.ts"));
assert("summariseExecution patched", summary.patched.includes("src/app/middleware.ts"));
assert("summariseExecution migrations", summary.migrations.includes("migrations/001_create_users.sql"));

// --- archive ---
const arch = Plan.archive(created.name!);
assert("archive ok", arch.ok === true);
assert("archive clears current", Plan.currentName() === "");
assert("plan moved to done/", fs.existsSync(path.join(tmpRoot, "plan", "done", created.name!)));

// --- uncompleteStep ---
Plan.setCurrent(second.name!);
Plan.completeStep(0);
assert("step done", Plan.current().steps![0].done === true);
Plan.uncompleteStep(0);
assert("step un-done", Plan.current().steps![0].done === false);

// --- create error path ---
const dup = Plan.create("Second plan");
assert("duplicate title rejected", dup.ok === false);
const empty = Plan.create("");
assert("empty title rejected", empty.ok === false);

// --- byte-for-byte round-trip with Python shape ---
const planFile = path.join(tmpRoot, "plan", second.name!);
const content = fs.readFileSync(planFile, "utf-8");
assert("file starts with title", content.startsWith("# Second plan\n"));
assert("file has ## Steps", content.includes("## Steps"));
assert("file has step checkbox", /- \[ \] Do a thing/.test(content));

// Cleanup
process.chdir(originalCwd);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

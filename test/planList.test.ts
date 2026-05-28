/**
 * Tests for Plan.listPlans() — Feature B (Tier 5).
 *
 * Verifies the merge between user-curated `plan/` and the Rust agent's
 * `.tina4/plans/` directory: plan/ wins on filename collision, sort is
 * newest-first by filename, and each entry exposes a `path` field
 * relative to the project root.
 *
 * Run with: npx tsx test/planList.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// chdir to a fresh temp project BEFORE importing plan.ts, so the module's
// project-root resolver picks up our sandbox.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tina4-planlist-"));
const originalCwd = process.cwd();
process.chdir(tmpRoot);

const { Plan } = await import("../packages/core/src/plan.ts");

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

console.log("=== Plan.listPlans merge tests ===\n");

const planDir = path.join(tmpRoot, "plan");
const rustDir = path.join(tmpRoot, ".tina4", "plans");
fs.mkdirSync(planDir, { recursive: true });
fs.mkdirSync(rustDir, { recursive: true });

function writePlan(dir: string, name: string, title: string, steps: Array<[string, boolean]>): void {
  const lines: string[] = [`# ${title}`, "", "## Steps", ""];
  for (const [text, done] of steps) {
    lines.push(`- [${done ? "x" : " "}] ${text}`);
  }
  fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n", "utf-8");
}

// --- merges plans from both dirs ---
console.log("--- merges plans from both dirs ---");
writePlan(planDir, "1700000001-foo.md", "Foo plan", [["A", true], ["B", false]]);
writePlan(rustDir, "1700000002-bar.md", "Bar plan", [["X", false]]);

const merged = Plan.listPlans();
const names = merged.map((p) => p.name);
assert("listPlans includes plan/ entry", names.includes("1700000001-foo.md"));
assert("listPlans includes .tina4/plans entry", names.includes("1700000002-bar.md"));
assert("listPlans returns 2 entries", merged.length === 2);

const fooEntry = merged.find((p) => p.name === "1700000001-foo.md")!;
const barEntry = merged.find((p) => p.name === "1700000002-bar.md")!;
assert("foo step counts", fooEntry.steps_total === 2 && fooEntry.steps_done === 1);
assert("bar step counts", barEntry.steps_total === 1 && barEntry.steps_done === 0);
assert("foo path is under plan/", fooEntry.path === path.join("plan", "1700000001-foo.md"));
assert("bar path is under .tina4/plans/",
  barEntry.path === path.join(".tina4", "plans", "1700000002-bar.md"));

// --- dedups by filename, plan/ wins ---
console.log("\n--- dedups by filename, plan/ wins ---");
// Write the SAME filename in both dirs with different titles.
writePlan(planDir, "1700000003-shared.md", "From plan dir (canonical)", [["a", false]]);
writePlan(rustDir, "1700000003-shared.md", "From rust dir (loses)", [["b", false], ["c", false]]);

const deduped = Plan.listPlans();
const sharedEntries = deduped.filter((p) => p.name === "1700000003-shared.md");
assert("only one entry for clashing filename", sharedEntries.length === 1);
assert("plan/ wins on collision (title)",
  sharedEntries[0].title === "From plan dir (canonical)");
assert("plan/ wins on collision (path)",
  sharedEntries[0].path === path.join("plan", "1700000003-shared.md"));
assert("plan/ wins on collision (steps_total from plan/)",
  sharedEntries[0].steps_total === 1);

// --- sorts newest-first by filename ---
console.log("\n--- sorts newest-first by filename ---");
// Filenames already use unix-timestamp prefixes. Newest is "1700000003-...".
const sortedNames = deduped.map((p) => p.name);
assert("newest filename first", sortedNames[0] === "1700000003-shared.md");
assert("oldest filename last", sortedNames[sortedNames.length - 1] === "1700000001-foo.md");
// Strict descending check across all entries.
const isDescending = sortedNames.every((n, i) => i === 0 || sortedNames[i - 1] >= n);
assert("entries sorted descending by name", isDescending);

// --- includes path relative to project root ---
console.log("\n--- includes path relative to project root ---");
for (const entry of deduped) {
  assert(`entry ${entry.name} has a path`, typeof entry.path === "string" && entry.path.length > 0);
  assert(`entry ${entry.name} path is relative`, !path.isAbsolute(entry.path));
  assert(`entry ${entry.name} resolves to actual file`,
    fs.existsSync(path.join(tmpRoot, entry.path)));
}

// --- only one dir exists (no failure) ---
console.log("\n--- only one dir exists ---");
// Blow away .tina4 so only plan/ remains; should still work.
fs.rmSync(path.join(tmpRoot, ".tina4"), { recursive: true, force: true });
const onlyPlan = Plan.listPlans();
assert("works when .tina4/plans absent", Array.isArray(onlyPlan) && onlyPlan.length === 2);
assert("all surviving entries come from plan/",
  onlyPlan.every((p) => p.path.startsWith("plan" + path.sep) || p.path.startsWith("plan/")));

// Cleanup
process.chdir(originalCwd);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

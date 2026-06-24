/**
 * Unit tests for the AI module (menu-driven installer).
 * Run with: npx tsx test/ai.test.ts
 */
import {
  AI_TOOLS, isInstalled, generateContext,
  installSelected, installAll,
} from "../packages/core/src/index.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

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

const TEST_DIR = join("/tmp", "tina4-ai-test-" + Date.now());

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

cleanup();

console.log("=== AI Tests ===\n");

// --- AI_TOOLS is an ordered array ---
console.log("--- AI_TOOLS basics ---");

assert("AI_TOOLS is an array", Array.isArray(AI_TOOLS));
assert("AI_TOOLS has 7 entries", AI_TOOLS.length === 7);
assert("first tool is claude-code", AI_TOOLS[0].name === "claude-code");

// Behavioural: every AI_TOOLS entry must map to a real, installable tool.
// Install each one individually via installSelected(dir, String(i+1)) and prove
// the file named by AI_TOOLS[i].contextFile is actually written to disk and
// carries the Tina4 context. This exercises the array as the installer's source
// of truth rather than just checking it is an array.
{
  let allEntriesInstall = true;
  let installDetail = "";
  for (let i = 0; i < AI_TOOLS.length; i++) {
    const tool = AI_TOOLS[i];
    const dir = join(TEST_DIR, "by-index", String(i));
    mkdirSync(dir, { recursive: true });
    const created = installSelected(dir, String(i + 1));
    const contextPath = join(dir, tool.contextFile);
    const onDisk = existsSync(contextPath);
    // The created list (relative paths) must reference this tool's contextFile.
    const reported = created.includes(tool.contextFile);
    // The written file must actually contain the Tina4 skill/context content.
    const hasContent = onDisk && readFileSync(contextPath, "utf-8").includes("Tina4");
    if (!onDisk || !reported || !hasContent) {
      allEntriesInstall = false;
      installDetail = `tool[${i}] ${tool.name} contextFile=${tool.contextFile} onDisk=${onDisk} reported=${reported} hasContent=${hasContent}`;
      break;
    }
  }
  assert(
    "every AI_TOOLS entry installs its contextFile via installSelected(i+1)",
    allEntriesInstall,
    installDetail,
  );
}

// Behavioural: each tool's `name`/`contextFile` are wired to real detection.
// On a fresh empty dir isInstalled() must be false; after the tool's contextFile
// is written it must report true. This proves the fields drive isInstalled(),
// not just that name is a non-empty string.
{
  let detectionWired = true;
  let detectionDetail = "";
  for (let i = 0; i < AI_TOOLS.length; i++) {
    const tool = AI_TOOLS[i];
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      detectionWired = false;
      detectionDetail = `tool[${i}] has empty name`;
      break;
    }
    const dir = join(TEST_DIR, "detect", String(i));
    mkdirSync(dir, { recursive: true });
    if (isInstalled(dir, tool)) {
      detectionWired = false;
      detectionDetail = `tool[${i}] ${tool.name} reported installed on empty dir`;
      break;
    }
    const contextPath = join(dir, tool.contextFile);
    mkdirSync(dirname(contextPath), { recursive: true });
    writeFileSync(contextPath, "# context");
    if (!isInstalled(dir, tool)) {
      detectionWired = false;
      detectionDetail = `tool[${i}] ${tool.name} not detected after writing ${tool.contextFile}`;
      break;
    }
  }
  assert(
    "tool name/contextFile drive real isInstalled() detection",
    detectionWired,
    detectionDetail,
  );
}

// Behavioural: every declared contextFile is actually produced by installAll().
// Run installAll() once and assert existsSync(join(dir, tool.contextFile)) holds
// for every tool in AI_TOOLS, confirming each declared contextFile is a real
// artifact rather than merely a string field.
{
  const dir = join(TEST_DIR, "install-all");
  mkdirSync(dir, { recursive: true });
  installAll(dir);
  let allProduced = true;
  let produceDetail = "";
  for (const tool of AI_TOOLS) {
    if (typeof tool.contextFile !== "string" || tool.contextFile.length === 0) {
      allProduced = false;
      produceDetail = `tool ${tool.name} has invalid contextFile`;
      break;
    }
    if (!existsSync(join(dir, tool.contextFile))) {
      allProduced = false;
      produceDetail = `installAll did not create ${tool.contextFile} for ${tool.name}`;
      break;
    }
  }
  assert(
    "installAll produces every declared contextFile in AI_TOOLS",
    allProduced,
    produceDetail,
  );
}

// --- isInstalled ---
console.log("\n--- isInstalled ---");

mkdirSync(TEST_DIR, { recursive: true });

assert("isInstalled returns false for empty dir", !isInstalled(TEST_DIR, AI_TOOLS[0]));

writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Claude Code context");
assert("isInstalled returns true when context file exists", isInstalled(TEST_DIR, AI_TOOLS[0]));

// --- generateContext ---
console.log("\n--- generateContext ---");

const context = generateContext();
assert("generateContext returns a string", typeof context === "string");
assert("context contains Tina4", context.includes("Tina4"));
assert("context contains route info", context.includes("src/routes/"));
assert("context contains model info", context.includes("src/models/"));
assert("context contains npx tina4nodejs", context.includes("npx tina4nodejs"));
assert("context contains skills table", context.includes("Swagger") || context.includes("swagger"));
assert("context contains TypeScript examples", context.includes("Tina4Request"));

// --- installSelected ---
console.log("\n--- installSelected ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });

// Install claude-code and cursor (items 1,2)
const created = installSelected(TEST_DIR, "1,2");
assert("installSelected creates files", created.length >= 2);
assert("CLAUDE.md created", existsSync(join(TEST_DIR, "CLAUDE.md")));
assert(".cursorules created", existsSync(join(TEST_DIR, ".cursorules")));

const claudeContent = readFileSync(join(TEST_DIR, "CLAUDE.md"), "utf-8");
assert("CLAUDE.md contains Tina4", claudeContent.includes("Tina4"));

// --- installSelected overwrites existing ---
console.log("\n--- installSelected overwrites ---");

writeFileSync(join(TEST_DIR, "CLAUDE.md"), "old content");
const updated = installSelected(TEST_DIR, "1");
const newContent = readFileSync(join(TEST_DIR, "CLAUDE.md"), "utf-8");
assert("installSelected overwrites existing", newContent.includes("Tina4"));
assert("installSelected returns created files", updated.includes("CLAUDE.md"));

// --- installSelected with copilot creates subdirectory ---
console.log("\n--- installSelected copilot subdir ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });

const copilotFiles = installSelected(TEST_DIR, "3");
assert(".github dir created", existsSync(join(TEST_DIR, ".github")));
assert("copilot-instructions.md created", existsSync(join(TEST_DIR, ".github", "copilot-instructions.md")));

// --- installSelected ignores invalid numbers ---
console.log("\n--- installSelected edge cases ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });

const noFiles = installSelected(TEST_DIR, "99,0,-1,abc");
assert("invalid numbers produce no files", noFiles.length === 0);

// --- installAll ---
console.log("\n--- installAll ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });

const allFiles = installAll(TEST_DIR);
assert("installAll creates files for all tools", allFiles.length >= 7);
assert("CLAUDE.md exists after installAll", existsSync(join(TEST_DIR, "CLAUDE.md")));
assert(".cursorules exists after installAll", existsSync(join(TEST_DIR, ".cursorules")));
assert(".windsurfrules exists after installAll", existsSync(join(TEST_DIR, ".windsurfrules")));
assert("CONVENTIONS.md exists after installAll", existsSync(join(TEST_DIR, "CONVENTIONS.md")));
assert("AGENTS.md exists after installAll", existsSync(join(TEST_DIR, "AGENTS.md")));

// --- installSelected with "all" string ---
console.log("\n--- installSelected all string ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });

const allViaString = installSelected(TEST_DIR, "all");
assert("'all' string installs for all tools", allViaString.length >= 7);

// Cleanup
cleanup();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

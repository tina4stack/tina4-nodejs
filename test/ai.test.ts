/**
 * Unit tests for the AI module (detection and context scaffolding).
 * Run with: npx tsx test/ai.test.ts
 */
import {
  detectAi, detectAiNames, generateContext,
  installAiContext, installAllAiContext, aiStatusReport,
} from "../packages/core/src/index.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

// --- detectAi returns results for all known tools ---
console.log("--- detectAi basics ---");

mkdirSync(TEST_DIR, { recursive: true });

const results = detectAi(TEST_DIR);
assert("detectAi returns an array", Array.isArray(results));
assert("detectAi returns entries for all known tools", results.length >= 7);
assert("all entries have name", results.every((r) => typeof r.name === "string" && r.name.length > 0));
assert("all entries have status", results.every((r) => r.status === "detected" || r.status === "not-detected"));

// Empty dir — nothing detected
const detected = results.filter((r) => r.status === "detected");
assert("empty dir detects no AI tools", detected.length === 0);

const names = detectAiNames(TEST_DIR);
assert("detectAiNames returns empty array for empty dir", names.length === 0);

// --- detectAi finds Claude Code when CLAUDE.md exists ---
console.log("\n--- Claude Code detection ---");

writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Claude Code context");

const withClaude = detectAi(TEST_DIR);
const claudeEntry = withClaude.find((t) => t.name === "claude-code");
assert("claude-code entry exists", claudeEntry !== undefined);
assert("claude-code detected when CLAUDE.md exists", claudeEntry?.status === "detected");

const namesWithClaude = detectAiNames(TEST_DIR);
assert("detectAiNames includes claude-code", namesWithClaude.includes("claude-code"));

// --- detectAi finds Cursor when .cursorules exists ---
console.log("\n--- Cursor detection ---");

writeFileSync(join(TEST_DIR, ".cursorules"), "cursor rules");

const withCursor = detectAi(TEST_DIR);
const cursorEntry = withCursor.find((t) => t.name === "cursor");
assert("cursor detected when .cursorules exists", cursorEntry?.status === "detected");

// --- detectAi finds Cursor via .cursor directory ---
console.log("\n--- Cursor dir detection ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });
mkdirSync(join(TEST_DIR, ".cursor"), { recursive: true });

const withCursorDir = detectAi(TEST_DIR);
const cursorDirEntry = withCursorDir.find((t) => t.name === "cursor");
assert("cursor detected when .cursor/ dir exists", cursorDirEntry?.status === "detected");

// --- detectAi finds Copilot when .github exists ---
console.log("\n--- Copilot detection ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });
mkdirSync(join(TEST_DIR, ".github"), { recursive: true });

const withCopilot = detectAi(TEST_DIR);
const copilotEntry = withCopilot.find((t) => t.name === "copilot");
assert("copilot detected when .github/ exists", copilotEntry?.status === "detected");

// --- detectAi finds Windsurf ---
console.log("\n--- Windsurf detection ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });
writeFileSync(join(TEST_DIR, ".windsurfrules"), "windsurf rules");

const withWindsurf = detectAi(TEST_DIR);
const windsurfEntry = withWindsurf.find((t) => t.name === "windsurf");
assert("windsurf detected when .windsurfrules exists", windsurfEntry?.status === "detected");

// --- generateContext ---
console.log("\n--- generateContext ---");

const context = generateContext();
assert("generateContext returns a string", typeof context === "string");
assert("context contains Tina4", context.includes("Tina4"));
assert("context contains route info", context.includes("src/routes/"));
assert("context contains model info", context.includes("src/models/"));

// --- installAiContext ---
console.log("\n--- installAiContext ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });
writeFileSync(join(TEST_DIR, "CLAUDE.md"), "existing");

// Install for claude-code only
const created = installAiContext(TEST_DIR, { tools: ["claude-code"] });
assert("installAiContext does not overwrite existing file", created.length === 0);

// Force overwrite
const forced = installAiContext(TEST_DIR, { tools: ["claude-code"], force: true });
assert("installAiContext with force overwrites", forced.length === 1);
assert("installAiContext created CLAUDE.md", forced.includes("CLAUDE.md"));

const content = readFileSync(join(TEST_DIR, "CLAUDE.md"), "utf-8");
assert("installed context contains Tina4", content.includes("Tina4"));

// --- installAiContext creates new files ---
console.log("\n--- installAiContext new files ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });

const newFiles = installAiContext(TEST_DIR, { tools: ["cursor", "windsurf"] });
assert("installAiContext creates files for specified tools", newFiles.length === 2);
assert(".cursorules created", existsSync(join(TEST_DIR, ".cursorules")));
assert(".windsurfrules created", existsSync(join(TEST_DIR, ".windsurfrules")));

// --- installAllAiContext ---
console.log("\n--- installAllAiContext ---");

cleanup();
mkdirSync(TEST_DIR, { recursive: true });

const allFiles = installAllAiContext(TEST_DIR);
assert("installAllAiContext creates files for all tools", allFiles.length >= 5);
assert("CLAUDE.md exists after installAll", existsSync(join(TEST_DIR, "CLAUDE.md")));
assert(".cursorules exists after installAll", existsSync(join(TEST_DIR, ".cursorules")));

// --- aiStatusReport ---
console.log("\n--- aiStatusReport ---");

const report = aiStatusReport(TEST_DIR);
assert("aiStatusReport returns a string", typeof report === "string");
assert("report mentions detected tools", report.includes("Detected AI tools"));

// --- Invalid tool name ---
console.log("\n--- Edge cases ---");

const noTools = installAiContext(TEST_DIR, { tools: ["nonexistent-tool"] });
assert("unknown tool name returns no files", noTools.length === 0);

// Cleanup
cleanup();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

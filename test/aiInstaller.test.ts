/**
 * Tina4 Node.js — v3.13.9 non-destructive AI installer.
 *
 * Pre-v3.13.9 the installer clobbered the user's CLAUDE.md (and the
 * equivalent context files for Cursor / Copilot / Windsurf / etc.) on
 * every install. v3.13.9 switches to a marker-bracketed skill block
 * that preserves whatever the user had in the file.
 *
 * Four branches covered:
 *
 *   1. Fresh install — file doesn't exist, full framework guide + block.
 *   2. Refresh — file exists with markers, just the block gets replaced.
 *   3. Migration — file starts with a pre-v3.13.9 framework header,
 *      the old dump gets replaced.
 *   4. Preserve — file exists with user content, block appended at end.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasMarkers,
  looksLikeOldFrameworkInstall,
  markersFor,
  replaceMarkerBlock,
  skillBlock,
  writeOrMerge,
} from "../packages/core/src/ai.ts";

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

console.log("=== AI installer (v3.13.9) ===\n");

const FRAMEWORK_GUIDE = "# CLAUDE.md — AI Developer Guide for tina4-nodejs (v3.13.9)\n\nFramework boilerplate here.";

// ── markersFor / skillBlock ──────────────────────────────────────────
console.log("--- Marker / block helpers ---");
{
  const [start, end] = markersFor("CLAUDE.md");
  assert("markdown files get HTML comment markers", start === "<!-- tina4-skills:start -->" && end === "<!-- tina4-skills:end -->");
}
{
  const [start, end] = markersFor(".cursorules");
  assert("rule files get hash comment markers", start === "# tina4-skills:start" && end === "# tina4-skills:end");
}
{
  const block = skillBlock("CLAUDE.md");
  assert("markdown block has heading", block.includes("## Tina4 Skills"));
  assert("markdown block mentions all three skills",
    block.includes("tina4-developer") && block.includes("tina4-js") && block.includes("tina4-maintainer"));
  assert("markdown block references tina4.com", block.includes("tina4.com"));
  assert("markdown block tells how to report a bad skill", block.includes("report-a-skill"));
}
{
  const block = skillBlock(".cursorules");
  assert("rule block has no markdown heading", !block.includes("##"));
  assert("rule block has no bold markers", !block.includes("**"));
  assert("rule block still mentions all three skills",
    block.includes("tina4-developer") && block.includes("tina4-js") && block.includes("tina4-maintainer"));
}

// ── hasMarkers ───────────────────────────────────────────────────────
console.log("\n--- Marker detection ---");
{
  const [start, end] = ["<!-- tina4-skills:start -->", "<!-- tina4-skills:end -->"];
  assert("both markers in order → true", hasMarkers(`pre\n${start}\nbody\n${end}\npost`, start, end));
  assert("only start marker → false", !hasMarkers(`pre\n${start}\nincomplete`, start, end));
  assert("end before start → false", !hasMarkers(`${end}\nstray\n${start}`, start, end));
}

// ── replaceMarkerBlock ───────────────────────────────────────────────
console.log("\n--- Block replacement ---");
{
  const [start, end] = ["<!-- tina4-skills:start -->", "<!-- tina4-skills:end -->"];
  const existing = `# Project\n\n${start}\nOLD\n${end}\n\nUser notes`;
  const newBlock = `${start}\nNEW\n${end}`;
  const result = replaceMarkerBlock(existing, newBlock, start, end);
  assert("new content present", result.includes("NEW"));
  assert("old content gone", !result.includes("OLD"));
  assert("preamble preserved", result.includes("# Project"));
  assert("trailing content preserved", result.includes("User notes"));
  assert("no triple newlines", !result.includes("\n\n\n"));
}

// ── looksLikeOldFrameworkInstall ─────────────────────────────────────
console.log("\n--- Old-framework header detection ---");
[
  "# Tina4 Python — Developer Guidelines\n\nOld dump...",
  "# Tina4 PHP\n\nContent...",
  "# Tina4 Ruby\n\nContent...",
  "# CLAUDE.md — AI Developer Guide for tina4-nodejs (v3.13.5)",
].forEach((text) => {
  assert(`recognises: ${text.split("\n")[0]}`, looksLikeOldFrameworkInstall(text));
});
assert("user CLAUDE.md is not old", !looksLikeOldFrameworkInstall("# My Project Notes\n\nDeploy info..."));
assert("empty file is not old", !looksLikeOldFrameworkInstall(""));

// ── writeOrMerge end-to-end ──────────────────────────────────────────
console.log("\n--- writeOrMerge end-to-end ---");
const tmpDir = mkdtempSync(join(tmpdir(), "tina4-ai-installer-"));
try {
  // Fresh install
  {
    const path = join(tmpDir, "fresh.md");
    const action = writeOrMerge(path, "CLAUDE.md", FRAMEWORK_GUIDE);
    assert("fresh install action = 'Installed'", action === "Installed", `got: ${action}`);
    const body = readFileSync(path, "utf-8");
    assert("fresh install body has framework guide", body.includes("Framework boilerplate"));
    assert("fresh install body has skill block", body.includes("<!-- tina4-skills:start -->"));
  }

  // Existing with markers → refresh only the block
  {
    const path = join(tmpDir, "marker.md");
    writeFileSync(path,
      "# My Project Notes\n\n" +
      "Deploy to staging via `make deploy`.\n\n" +
      "<!-- tina4-skills:start -->\nOLD BLOCK CONTENT\n<!-- tina4-skills:end -->\n\n" +
      "Don't forget to bump the version before tagging.", "utf-8");
    const action = writeOrMerge(path, "CLAUDE.md", FRAMEWORK_GUIDE);
    assert("refresh action = 'Refreshed skill block in'", action === "Refreshed skill block in", `got: ${action}`);
    const body = readFileSync(path, "utf-8");
    assert("refresh removed old block", !body.includes("OLD BLOCK CONTENT"));
    assert("refresh added new skills", body.includes("tina4-developer"));
    assert("refresh preserved heading", body.includes("# My Project Notes"));
    assert("refresh preserved trailing notes", body.includes("Don't forget to bump the version"));
    assert("refresh did NOT inject framework guide", !body.includes("Framework boilerplate"));
  }

  // Idempotency
  {
    const path = join(tmpDir, "idem.md");
    writeFileSync(path, "# My Notes\n", "utf-8");
    writeOrMerge(path, "CLAUDE.md", FRAMEWORK_GUIDE);
    const first = readFileSync(path, "utf-8");
    writeOrMerge(path, "CLAUDE.md", FRAMEWORK_GUIDE);
    const second = readFileSync(path, "utf-8");
    assert("second run is a no-op", first === second);
  }

  // Old framework header → migrate
  {
    const path = join(tmpDir, "old.md");
    writeFileSync(path,
      "# CLAUDE.md — AI Developer Guide for tina4-nodejs (v3.13.5)\n\n" +
      "Old framework guide content (should be replaced)...\n", "utf-8");
    const action = writeOrMerge(path, "CLAUDE.md", FRAMEWORK_GUIDE);
    assert("migrate action = 'Migrated (replaced old framework dump in)'",
      action === "Migrated (replaced old framework dump in)", `got: ${action}`);
    const body = readFileSync(path, "utf-8");
    assert("migration removed old content", !body.includes("Old framework guide content"));
    assert("migration wrote new framework guide", body.includes("Framework boilerplate"));
    assert("migration added skill block", body.includes("<!-- tina4-skills:start -->"));
  }

  // User content → append
  {
    const path = join(tmpDir, "user.md");
    const original = "# 24rent App\n\n" +
      "## Conventions\n\n" +
      "- Branch naming: `feature/<jira>-<slug>`\n" +
      "- Deploy: `make deploy ENV=staging`\n";
    writeFileSync(path, original, "utf-8");
    const action = writeOrMerge(path, "CLAUDE.md", FRAMEWORK_GUIDE);
    assert("append action = 'Appended skill block to'", action === "Appended skill block to", `got: ${action}`);
    const body = readFileSync(path, "utf-8");
    for (const line of original.split("\n")) {
      if (line.trim()) {
        assert(`preserved user line: ${line}`, body.includes(line));
      }
    }
    assert("append added skill block", body.includes("<!-- tina4-skills:start -->"));
  }

  // Rule file uses hash markers
  {
    const path = join(tmpDir, ".cursorules");
    writeFileSync(path, "Rule: keep handlers under 50 lines\n", "utf-8");
    writeOrMerge(path, ".cursorules", "# Cursor framework guide");
    const body = readFileSync(path, "utf-8");
    assert("rule file has hash start marker", body.includes("# tina4-skills:start"));
    assert("rule file has hash end marker", body.includes("# tina4-skills:end"));
    assert("rule file has NO HTML markers", !body.includes("<!--"));
    assert("rule file preserved user rule", body.includes("Rule: keep handlers under 50 lines"));
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

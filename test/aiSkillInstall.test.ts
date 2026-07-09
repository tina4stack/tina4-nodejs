/**
 * `tina4 ai` must install the ACTUAL SKILL files (project + global), not just a
 * CLAUDE.md pointer to skills that aren't shipped in the npm package.
 *
 * REAL network fetch from the release tag — NO mocks. Pins TINA4_SKILLS_REF to a
 * tag known to carry the split skills so the test is deterministic, then asserts
 * SKILL.md + a reference file for all three skills land in BOTH a temp project
 * dir and a temp home dir.
 *
 * Run with: npx tsx test/aiSkillInstall.test.ts
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin BEFORE importing/using installSkills — skillsRef() reads this at call time.
process.env.TINA4_SKILLS_REF = "3.13.59";

import { installSkills, DEV_SKILL } from "../packages/core/src/ai.ts";

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

console.log("=== AI skill install (real network, ref=3.13.59) ===\n");

const SKILLS = [DEV_SKILL, "tina4-js", "tina4-maintainer"];
// One reference file per skill — proves the references/ payload came down too.
const A_REF: Record<string, string> = {
  [DEV_SKILL]: "data-and-orm.md",
  "tina4-js": "signals-and-reactivity.md",
  "tina4-maintainer": "subsystems.md",
};

const tmp = mkdtempSync(join(tmpdir(), "tina4-skill-install-"));
try {
  const projSkills = join(tmp, "proj", ".claude", "skills");
  const homeSkills = join(tmp, "home", ".claude", "skills");

  const installed = installSkills(join(tmp, "proj"), [projSkills, homeSkills]);

  assert(
    "all three skills report installed",
    installed.length === 3 && SKILLS.every((s) => installed.includes(s)),
    `got: [${installed.join(", ")}]`,
  );

  for (const dest of [projSkills, homeSkills]) {
    const where = dest === projSkills ? "project" : "home";
    for (const skill of SKILLS) {
      const skillMd = join(dest, skill, "SKILL.md");
      assert(`[${where}] ${skill}/SKILL.md exists`, existsSync(skillMd), skillMd);
      const refFile = join(dest, skill, "references", A_REF[skill]);
      assert(`[${where}] ${skill}/references/${A_REF[skill]} exists`, existsSync(refFile), refFile);
    }
  }

  // Real content check — the dev SKILL.md must carry the split skill name, not
  // be an empty/placeholder file.
  const devMd = readFileSync(join(projSkills, DEV_SKILL, "SKILL.md"), "utf-8");
  assert("dev SKILL.md carries the split skill name", devMd.includes(DEV_SKILL), `head: ${devMd.slice(0, 60)}`);
  assert("dev SKILL.md is non-trivial", devMd.length > 200, `len=${devMd.length}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

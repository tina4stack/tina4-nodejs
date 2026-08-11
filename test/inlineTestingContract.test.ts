/**
 * Feature 132 — inline testing conformance (INLINE-DEC-01 / INLINE-DEC-02).
 *
 * Shared contract: tina4-documentation/plan/v3/fixtures/inlinetesting_contract.json.
 *
 * Fully REAL (no mocks): each case writes a real temp project, SPAWNS the real
 * `tina4nodejs test` CLI (packages/cli/src/bin.ts) as a child process (cwd = the
 * temp project), and asserts the child's REAL exit code and REAL filesystem side
 * effects. The temp project lives INSIDE the repo tree so `@tina4/core` and tsx
 * resolve to this workspace (mirrors test/cliTestExitCode.test.ts).
 *
 * Invariants proven here:
 *   A inline-cli-real-exit-code            — the CLI runs a decorated inline test and
 *                                            exits 0 on pass / non-zero on fail.
 *   B inline-discovery-no-arbitrary-code   — only files that call tests() are imported, so a
 *                                            src file without one never runs during discovery.
 *   C inline-assert-surfaces-do-not-collide — the surface exports expect* and NOT the
 *                                            colliding assertEqual (the xUnit Tina4Test has that).
 *
 * Run with: npx tsx test/inlineTestingContract.test.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../packages/core/src/index.ts";
import { Tina4Test } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`); }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");
const cliBin = join(repoRoot, "packages/cli/src/bin.ts");
const baseDir = join(repoRoot, `.tmp_inlinecontract_${process.pid}`);

const PASSING_INLINE =
  `import { tests, expectEqual } from "@tina4/core";\n` +
  `tests(expectEqual([5, 3], 8), expectEqual([0, 0], 0))(` +
  `function add(a: number, b: number): number { return a + b; });\n`;

const FAILING_INLINE =
  `import { tests, expectEqual } from "@tina4/core";\n` +
  `tests(expectEqual([5, 3], 999))(` +
  `function add(a: number, b: number): number { return a + b; });\n`;

// A src file with NO tests() call and an observable side effect on import.
const SIDE_EFFECT =
  `import { writeFileSync } from "node:fs";\n` +
  `writeFileSync(new URL("../side_effect_ran.txt", import.meta.url), "ran");\n`;

/** Spawn the REAL `tina4nodejs test` in cwd; return its real exit code. */
function runTestCli(cwd: string): number {
  const res = spawnSync(tsxBin, [cliBin, "test"], {
    cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000,
  });
  if (res.error) throw res.error;
  return res.status ?? -1;
}

function makeProject(name: string, files: Record<string, string>): string {
  const dir = join(baseDir, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

console.log("=== Inline testing conformance (132, real subprocess) ===\n");

rmSync(baseDir, { recursive: true, force: true });
mkdirSync(baseDir, { recursive: true });

try {
  // ── A: real exit code ──────────────────────────────────────────────
  {
    const dir = makeProject("pass", { "src/inlineMath.ts": PASSING_INLINE });
    assert("tina4 test exits zero when the inline test passes", runTestCli(dir) === 0);
  }
  {
    const dir = makeProject("fail", { "src/inlineMath.ts": FAILING_INLINE });
    assert("tina4 test exits non zero when the inline test fails", runTestCli(dir) !== 0);
  }

  // ── B: discovery does not run arbitrary scanned code ───────────────
  {
    const dir = makeProject("sideeffect", {
      "src/inlineMath.ts": PASSING_INLINE,
      "src/sideEffect.ts": SIDE_EFFECT,
    });
    const code = runTestCli(dir);
    const ran = existsSync(join(dir, "side_effect_ran.txt"));
    assert(
      "inline discovery does not run a non test file side effect",
      code === 0 && !ran,
      `exit=${code} sideEffectRan=${ran}`,
    );
  }

  // ── C: the two assertion surfaces do not collide ───────────────────
  {
    // The descriptor surface builds a spec; it does not assert.
    const spec = core.expectEqual([1], 1) as { type: string };
    const descriptorOk = spec.type === "equal";
    // The colliding name is GONE from the descriptor surface — the point of the rename.
    const noCollidingName = typeof (core as Record<string, unknown>).assertEqual === "undefined";
    // The xUnit immediate assertion lives on Tina4Test (a different surface).
    const xunitHasAssert = typeof (Tina4Test.prototype as { assertEqual?: unknown }).assertEqual === "function";
    assert(
      "the descriptor expect builders and xunit assert are distinct",
      descriptorOk && noCollidingName && xunitHasAssert,
      `descriptor=${descriptorOk} noColliding=${noCollidingName} xunit=${xunitHasAssert}`,
    );
  }
} finally {
  rmSync(baseDir, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

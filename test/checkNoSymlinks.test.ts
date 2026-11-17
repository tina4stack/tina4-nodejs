/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Guard test for scripts/check-no-symlinks.sh — the CI gate that keeps
 * committed symlinks out of the tree. A committed symlink breaks extraction on
 * Windows and Composer-style unpackers and is a supply-chain hazard, so the
 * gate must fail the moment one is staged. tina4-php shipped 134 absolute
 * symlinks that broke Windows installs; this is the parity guard for Node.
 *
 * The negative case is MUTATION-PROOF: it builds a throwaway git repo, stages a
 * real symlink (git records mode 120000), runs the SAME script against it, and
 * asserts the script exits non-zero and names the offending path. A guard never
 * seen to fail is not known to work.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = join(import.meta.dirname, "..", "scripts", "check-no-symlinks.sh");
const repoRoot = join(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS ${name}`);
    passed++;
  } else {
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

// Run the guard in a chosen working directory; return its exit code + output.
function runGuard(cwd: string): { status: number; output: string } {
  const result = spawnSync("sh", [script], { cwd, encoding: "utf-8" });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// A disposable git repo we fully own — staged files only, never committed.
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tina4-symlink-guard-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

// ── Positive: the real repo has zero committed symlinks ──────────────────────
const clean = runGuard(repoRoot);
assert("real repo passes the guard", clean.status === 0, `exit ${clean.status}: ${clean.output.trim()}`);
assert("passing run says OK", clean.output.includes("OK: no committed symlinks"));

// ── Positive: a temp repo with only a regular file passes ────────────────────
const okRepo = makeTempRepo();
try {
  writeFileSync(join(okRepo, "regular.txt"), "not a symlink\n");
  execFileSync("git", ["add", "regular.txt"], { cwd: okRepo });
  const ok = runGuard(okRepo);
  assert("regular file passes", ok.status === 0, `exit ${ok.status}: ${ok.output.trim()}`);
} finally {
  rmSync(okRepo, { recursive: true, force: true });
}

// ── Negative (mutation): a staged symlink must fail the guard ────────────────
const badRepo = makeTempRepo();
try {
  writeFileSync(join(badRepo, "target.txt"), "target\n");
  execFileSync("git", ["add", "target.txt"], { cwd: badRepo });
  // Stage the symlink in the INDEX - the only thing the guard reads - exactly
  // as `git add` records one: mode 120000 over a blob holding the link target.
  // No filesystem link is needed, so this runs where creating one is refused
  // (Windows without Developer Mode, or core.symlinks=false).
  const linkBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: badRepo, input: "target.txt", encoding: "utf-8",
  }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `120000,${linkBlob},evil-link`], { cwd: badRepo });
  // Confirm git actually recorded the symlink as mode 120000 — the mutation
  // must be real, or the negative case proves nothing.
  const staged = execFileSync("git", ["ls-files", "-s"], { cwd: badRepo, encoding: "utf-8" });
  assert("git staged the symlink as mode 120000", /^120000 /m.test(staged), staged.trim());
  const bad = runGuard(badRepo);
  assert("staged symlink fails the guard", bad.status !== 0, `exit ${bad.status}`);
  assert("failing run names the offending path", bad.output.includes("evil-link"), bad.output.trim());
  assert("failing run explains why", bad.output.includes("committed symlinks are not allowed"));
} finally {
  rmSync(badRepo, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

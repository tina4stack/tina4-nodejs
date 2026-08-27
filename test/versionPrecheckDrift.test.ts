/**
 * Regression: the pre-tag version-consistency guard must catch a partial bump
 * BEFORE the tag is cut, and its expected-version must be parameterized (arg /
 * RELEASE_VERSION), never a literal edited by hand.
 *
 * This reproduces the 3.13.120 incident for real: that release bumped the five
 * workspace package.jsons but MISSED root package.json, the root lockfile
 * (root + workspace entries) and the guard's own hardcoded literal — and the
 * guard only fired on the CI publish gate, AFTER the tag was pushed, forcing a
 * tag delete + re-push.
 *
 * No mocks: every case runs the REAL guard (test/versionConsistency.test.ts) in
 * a child process and asserts on its real exit code and real stdout. The drift
 * cases run against a copied-and-corrupted skeleton via TINA4_VERSION_CHECK_ROOT
 * so the guard's own assertions (not a re-implementation) do the checking.
 *
 * Run with: npx tsx test/versionPrecheckDrift.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`); }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");
const guardScript = join(repoRoot, "test/versionConsistency.test.ts");
const currentVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version as string;

// The COMPLETE set of files the guard checks — copied verbatim to build a valid
// skeleton we then corrupt one file at a time.
const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "CLAUDE.md",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/frond/package.json",
  "packages/orm/package.json",
  "packages/swagger/package.json",
];

const tempDirs: string[] = [];
function cleanup(): void {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
process.on("exit", cleanup);

/** Run the REAL guard in a child process; return its real exit code + output. */
function runGuard(args: string[], checkRoot?: string): { status: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Hermetic: the guard reads these two, so strip any ambient value and set the
  // root only when this case wants the guard pointed at a skeleton.
  delete env.TINA4_VERSION_CHECK_ROOT;
  delete env.RELEASE_VERSION;
  if (checkRoot) env.TINA4_VERSION_CHECK_ROOT = checkRoot;
  const res = spawnSync(tsxBin, [guardScript, ...args], {
    cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, env,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, out: (res.stdout || "") + (res.stderr || "") };
}

/** Copy the guard's files into a fresh tmp skeleton (same relative layout). */
function makeSkeleton(): string {
  const dir = mkdtempSync(join(tmpdir(), "tina4-vprecheck-"));
  tempDirs.push(dir);
  for (const rel of VERSION_FILES) {
    const dst = join(dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(join(repoRoot, rel)));
  }
  return dir;
}

function setJsonVersion(file: string, version: string): void {
  const obj = JSON.parse(readFileSync(file, "utf-8"));
  obj.version = version;
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function setLockInnerVersion(file: string, version: string): void {
  const lock = JSON.parse(readFileSync(file, "utf-8"));
  lock.packages[""].version = version;
  writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
}

console.log("=== version-consistency pre-tag guard (real subprocess, no mocks) ===\n");

// ── 1. All-match PASSES at HEAD ──────────────────────────────────────────────
// The real repo is self-consistent, so the guard exits 0 both with the intended
// version passed explicitly and in bare self-consistency mode.
{
  const withArg = runGuard([currentVersion]);
  assert(
    `all-match: guard exits 0 with the current version arg (${currentVersion})`,
    withArg.status === 0,
    `status ${withArg.status}\n${withArg.out}`,
  );
  assert(
    "all-match: guard actually ran its cases (0 failed)",
    /Results:.*0 failed/.test(withArg.out),
    withArg.out,
  );

  const noArg = runGuard([]);
  assert(
    "all-match: guard exits 0 in bare self-consistency mode (no arg)",
    noArg.status === 0,
    `status ${noArg.status}\n${noArg.out}`,
  );
}

// ── 2. DRIFT fails, naming the drifted file ──────────────────────────────────
// A workspace package.json bumped out of step with root.
{
  const tree = makeSkeleton();
  setJsonVersion(join(tree, "packages/cli/package.json"), "9.9.9");
  const r = runGuard([], tree);
  assert("drift(workspace): guard exits non-zero", r.status !== 0, `status ${r.status}`);
  // "got 9.9.9" is a failure-ONLY detail string (the guard prints detail only on a
  // FAIL); pairing it with the named check proves the drifted file was flagged.
  assert(
    "drift(workspace): output names the packages/cli check as failed",
    r.out.includes("packages/cli matches root") && r.out.includes("got 9.9.9"),
    r.out,
  );
}

// Root package.json missed — the exact 3.13.120 miss — caught here PRE-tag when
// the intended version is supplied as the release arg.
{
  const tree = makeSkeleton();
  setJsonVersion(join(tree, "package.json"), "9.9.9");
  const r = runGuard([currentVersion], tree);
  assert("drift(root): guard exits non-zero", r.status !== 0, `status ${r.status}`);
  // Failure-only detail from the parameterized root check: it fires ONLY because
  // root drifted from the intended arg — the exact 3.13.120 root miss, pre-tag.
  assert(
    "drift(root): output flags root package.json as the drifted file",
    r.out.includes("root package.json is 9.9.9"),
    r.out,
  );
}

// Root lockfile entry missed — the other half of the 3.13.120 miss.
{
  const tree = makeSkeleton();
  setLockInnerVersion(join(tree, "package-lock.json"), "9.9.9");
  const r = runGuard([], tree);
  assert("drift(lockfile): guard exits non-zero", r.status !== 0, `status ${r.status}`);
  assert(
    "drift(lockfile): output names the package-lock check as failed",
    r.out.includes("package-lock root package matches") && r.out.includes("got 9.9.9"),
    r.out,
  );
}

// ── 3. ARG mismatch fails (proves Part A wiring — the arg is consulted) ───────
// The real tree is consistent, so an intended-version arg that does not match
// root can ONLY fail via the parameterized check — no other assertion trips.
{
  const r = runGuard(["9.9.9"]);
  assert("arg-mismatch: guard exits non-zero", r.status !== 0, `status ${r.status}`);
  // The ONLY failing check here is the parameterized one, and its failure-only
  // detail reports root's REAL version against the mismatched arg — proof the arg
  // is actually consulted (Part A wiring), not ignored.
  assert(
    "arg-mismatch: output reports root's real version against the bad arg",
    r.out.includes(`intended 9.9.9, root package.json is ${currentVersion}`),
    r.out,
  );
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

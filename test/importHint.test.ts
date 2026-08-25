/**
 * Real tests for the import-hint fallback on `@tina4/core`.
 * Run with: npx tsx test/importHint.test.ts
 *
 * No mocks. Every assertion drives a REAL Node subprocess so the exact ESM
 * resolver + exports-map behaviour is exercised — the same code path a user's
 * app sees.
 *
 * Feature: `packages/core/package.json` declares specific subpath exports for
 * every well-known module (router, api, auth, cache, …) AND a trailing wildcard
 * `"./*": "./dist/_missing.js"`. The wildcard's target throws a helpful Error
 * at import time naming the real subpaths, so a typo (`@tina4/core/route`) or a
 * guess (`@tina4/core/zzzzz`) fails LOUD with a browsable list rather than the
 * bare `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * NODE PARITY GAP (accepted, documented in ADR-0062 + _missing.ts).
 *
 * Node's wildcard resolver invokes the fallback target with the RESOLVED file
 * path, not the ORIGINAL requested subpath — so `_missing.ts` cannot know what
 * the caller typed. The message therefore lists ALL real subpaths, generic and
 * browsable, where Python/PHP/Ruby's last-resort finders receive the raw
 * request and add a targeted "did you mean X?". For an AI-agent consumer, the
 * browsable set is enough. Tests 2 and 3 will see the SAME message — that is
 * the accepted asymmetry.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const coreDir = join(repoRoot, "packages", "core");
const corePkgPath = join(coreDir, "package.json");

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

/**
 * Run a small ESM snippet in a fresh `node` subprocess from the repo root so
 * `@tina4/core` resolves via the workspace symlink under node_modules/. Returns
 * the captured stdout + stderr + exit code — no throwing on non-zero.
 */
function runInSubprocess(code: string): { stdout: string; stderr: string; exitCode: number } {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    exitCode: res.status ?? -1,
  };
}

console.log("=== @tina4/core import-hint fallback tests ===\n");

// ── 1. Positive-happy: real subpath returns the real binding ──────────────
console.log("--- 1. positive-happy: @tina4/core/router exports `get` as function ---");
{
  const code = `
    const m = await import("@tina4/core/router");
    if (typeof m.get !== "function") {
      console.error("FAIL: get is " + typeof m.get);
      process.exit(2);
    }
    if (typeof m.post !== "function") {
      console.error("FAIL: post is " + typeof m.post);
      process.exit(3);
    }
    console.log("OK");
  `;
  const r = runInSubprocess(code);
  assert("subprocess exited 0", r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 200)}`);
  assert("stdout contains OK", r.stdout.includes("OK"), `stdout=${r.stdout.slice(0, 200)}`);
}

// ── 2. Negative-hint: typo lands on the wildcard fallback ──────────────────
console.log("\n--- 2. negative-hint: @tina4/core/route (typo) — helpful error ---");
{
  const code = `
    try {
      await import("@tina4/core/route");
      console.error("UNEXPECTED SUCCESS");
      process.exit(0);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  `;
  const r = runInSubprocess(code);
  assert("subprocess exited non-zero (helpful throw)", r.exitCode !== 0, `exit=${r.exitCode}`);
  assert("stderr contains 'no such subpath'", r.stderr.includes("no such subpath"),
    `stderr=${r.stderr.slice(0, 400)}`);
  // At least 3 real subpath names surfaced in the message
  const realNames = ["router", "api", "auth", "cache", "queue", "validator"];
  const hits = realNames.filter((n) => new RegExp(`\\b${n}\\b`).test(r.stderr));
  assert(`stderr names at least 3 real subpaths (found: ${hits.join(",") || "none"})`,
    hits.length >= 3, `stderr=${r.stderr.slice(0, 400)}`);
  // The message names the offending package so an AI-agent knows which pkg misspelled
  assert("stderr names the package '@tina4/core'", r.stderr.includes("@tina4/core"),
    `stderr=${r.stderr.slice(0, 400)}`);
}

// ── 3. Negative-no-match: pure gibberish lands on the same fallback ──────
console.log("\n--- 3. negative-no-match: @tina4/core/zzzzz — same browsable list ---");
{
  const code = `
    try {
      await import("@tina4/core/zzzzz");
      console.error("UNEXPECTED SUCCESS");
      process.exit(0);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  `;
  const r = runInSubprocess(code);
  assert("subprocess exited non-zero", r.exitCode !== 0);
  assert("stderr contains 'no such subpath'", r.stderr.includes("no such subpath"));
  const hits = ["router", "api", "auth", "cache"].filter((n) => r.stderr.includes(n));
  assert(`stderr still browsable (found: ${hits.join(",") || "none"})`, hits.length >= 3);
}

// ── 4. Masking gate: a real subpath's OWN load failure is NOT masked ─────
// The wildcard fallback catches only requests that MATCH the `./*` pattern
// AFTER all specific subpaths were tried. When a specific subpath IS declared
// but its module body throws (because ITS OWN import chain can't resolve),
// Node's original error must reach the caller unmodified — otherwise the
// wildcard would swallow every real load failure and blame the caller for a
// typo they did not make.
console.log("\n--- 4. masking gate: a real subpath's own load failure reaches the caller ---");
{
  // Ephemeral fixture: add a temporary subpath entry to core's exports map,
  // pointed at a fresh TypeScript file that imports a missing package. Run the
  // probe via `npx tsx` so the .ts file is loadable, then RESTORE the exports
  // map + delete the fixture in `finally` — the repo tree stays clean.
  const originalPkg = readFileSync(corePkgPath, "utf-8");
  const fixturePath = join(coreDir, "src", "_broken_fixture.ts");
  try {
    const pkg = JSON.parse(originalPkg);
    // The wildcard must stay LAST — Node matches specific entries first, then
    // the wildcard. Slot the fixture in immediately before "./*".
    const exportsObj = pkg.exports as Record<string, unknown>;
    const rebuilt: Record<string, unknown> = {};
    for (const key of Object.keys(exportsObj)) {
      if (key === "./*") {
        rebuilt["./_broken_fixture"] = {
          import: "./src/_broken_fixture.ts",
        };
      }
      rebuilt[key] = exportsObj[key];
    }
    pkg.exports = rebuilt;
    writeFileSync(corePkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

    // Fixture body: at load time, imports a package that categorically does
    // not exist. That import must fail with Node's own ERR_MODULE_NOT_FOUND
    // referencing the missing package name — NOT the wildcard's hint message.
    writeFileSync(
      fixturePath,
      `// eslint-disable-next-line import/no-unresolved
import { neverExisted } from "tina4-nonexistent-package-xyz";
export const _fixture = neverExisted;
`,
      "utf-8",
    );

    const code = `
      try {
        await import("@tina4/core/_broken_fixture");
        console.error("UNEXPECTED SUCCESS");
        process.exit(0);
      } catch (e) {
        console.error("CODE=" + (e.code ?? "<none>"));
        console.error("MSG=" + e.message);
        process.exit(1);
      }
    `;
    const r = spawnSync("npx", ["tsx", "--input-type=module", "-e", code], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const stderr = r.stderr ?? "";
    const stdout = r.stdout ?? "";
    assert("subprocess exited non-zero", (r.status ?? -1) !== 0,
      `exit=${r.status} stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 400)}`);
    // The KEY assertion: the error is the ORIGINAL, not the wildcard hint.
    assert("stderr names the ORIGINAL missing package ('tina4-nonexistent-package-xyz')",
      stderr.includes("tina4-nonexistent-package-xyz"),
      `stderr=${stderr.slice(0, 500)}`);
    assert("stderr does NOT contain the wildcard hint 'no such subpath'",
      !stderr.includes("no such subpath"),
      `stderr=${stderr.slice(0, 500)}`);
  } finally {
    writeFileSync(corePkgPath, originalPkg, "utf-8");
    if (existsSync(fixturePath)) rmSync(fixturePath, { force: true });
  }
}

// ── 5. TS compile safety: typecheck still passes with the new exports ────
console.log("\n--- 5. tsc safety: `npm run typecheck` exits 0 ---");
{
  const r = spawnSync("npm", ["run", "--silent", "typecheck"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 300_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert(`npm run typecheck exited 0 (got ${r.status})`, r.status === 0,
    `stdout=${(r.stdout ?? "").slice(0, 400)}\n    stderr=${(r.stderr ?? "").slice(0, 400)}`);
}

// ── 6. Mutation gate: remove the wildcard, prove test 2 becomes the BARE ─
// ERR_PACKAGE_PATH_NOT_EXPORTED (without our helpful hint). Restore, re-verify.
console.log("\n--- 6. mutation gate: revert wildcard => bare ERR_PACKAGE_PATH_NOT_EXPORTED ---");
{
  const originalPkg = readFileSync(corePkgPath, "utf-8");
  try {
    const pkg = JSON.parse(originalPkg);
    const exportsObj = pkg.exports as Record<string, unknown>;
    delete exportsObj["./*"];
    writeFileSync(corePkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

    const r = runInSubprocess(`
      try {
        await import("@tina4/core/route");
        process.exit(0);
      } catch (e) {
        console.error("CODE=" + (e.code ?? "<none>"));
        console.error("MSG=" + e.message);
        process.exit(1);
      }
    `);
    assert("without wildcard: subprocess exits non-zero", r.exitCode !== 0);
    assert("without wildcard: error code is ERR_PACKAGE_PATH_NOT_EXPORTED",
      r.stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED"),
      `stderr=${r.stderr.slice(0, 400)}`);
    assert("without wildcard: NO 'no such subpath' hint",
      !r.stderr.includes("no such subpath"),
      `stderr=${r.stderr.slice(0, 400)}`);
  } finally {
    writeFileSync(corePkgPath, originalPkg, "utf-8");
  }

  // Restore + re-verify the hint IS back.
  const rBack = runInSubprocess(`
    try {
      await import("@tina4/core/route");
      process.exit(0);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  `);
  assert("after restore: 'no such subpath' hint is BACK",
    rBack.stderr.includes("no such subpath"),
    `stderr=${rBack.stderr.slice(0, 400)}`);
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

// silence unused-import lint warnings from the guardrail helpers
void execFileSync;
void mkdtempSync;
void tmpdir;

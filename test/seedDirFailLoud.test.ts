/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * ADR-0108: a failing seed file fails loud. Real seed files on disk, the real
 * FakeData.seedDir and the real CLI in a subprocess; no doubles.
 *
 * Run with: npx tsx test/seedDirFailLoud.test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { FakeData, SeedError } from "../packages/core/src/index.ts";
import { TSX_CLI } from "./_portableSpawn.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const repoRoot = resolve(import.meta.dirname, "..");
const cliBin = join(repoRoot, "packages/cli/src/bin.ts");

function project(): { root: string; seeds: string; tracker: string } {
  const root = mkdtempSync(join(tmpdir(), "tina4-seed-fail-loud-"));
  const seeds = join(root, "src", "seeds");
  mkdirSync(seeds, { recursive: true });
  return { root, seeds, tracker: join(root, "ran.txt") };
}

function record(tracker: string, name: string): string {
  return `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(tracker)}, ${JSON.stringify(name + "\n")});\n`;
}

function ran(tracker: string): string[] {
  return existsSync(tracker) ? readFileSync(tracker, "utf8").split(/\s+/).filter(Boolean) : [];
}

function threeFiles(p: ReturnType<typeof project>): Record<string, string> {
  const files = {
    okFirst: join(p.seeds, "001_ok.ts"),
    raises: join(p.seeds, "002_raises.ts"),
    okLast: join(p.seeds, "003_ok.ts"),
  };
  writeFileSync(files.okFirst, record(p.tracker, "001_ok"));
  writeFileSync(files.raises, `throw new Error("seed exploded");\nexport {};\n`);
  writeFileSync(files.okLast, record(p.tracker, "003_ok"));
  return files;
}

console.log("\n--- FakeData.seedDir fails loud ---");
{
  const p = project();
  const files = threeFiles(p);
  let error: unknown = null;
  try {
    await new FakeData().seedDir(p.seeds);
  } catch (e) {
    error = e;
  }
  ok("a failing seed file throws SeedError", error instanceof SeedError, String(error));
  if (error instanceof SeedError) {
    ok("SeedError.seedFile names the failing file", error.seedFile === files.raises, error.seedFile);
    ok("SeedError.completed lists the files that ran before it",
      JSON.stringify(error.completed) === JSON.stringify([files.okFirst]), JSON.stringify(error.completed));
    ok("SeedError carries the original error as cause",
      error.cause instanceof Error && (error.cause as Error).message === "seed exploded");
    ok("the message names the file and the cause",
      error.message.includes("002_raises.ts") && error.message.includes("seed exploded"), error.message);
  }
  ok("the run stopped at the failing file (001 ran, 003 never did)",
    JSON.stringify(ran(p.tracker)) === JSON.stringify(["001_ok"]), JSON.stringify(ran(p.tracker)));
  rmSync(p.root, { recursive: true, force: true });
}

{
  const p = project();
  const second = join(p.seeds, "002_second.ts");
  const first = join(p.seeds, "001_first.ts");
  writeFileSync(second, record(p.tracker, "002_second"));
  writeFileSync(first, record(p.tracker, "001_first"));
  writeFileSync(join(p.seeds, "_helper.ts"), `throw new Error("a helper must never run");\nexport {};\n`);
  const executed = await new FakeData().seedDir(p.seeds);
  ok("a clean folder returns the executed files in order",
    JSON.stringify(executed) === JSON.stringify([first, second]), JSON.stringify(executed));
  ok("underscore files are skipped",
    JSON.stringify(ran(p.tracker)) === JSON.stringify(["001_first", "002_second"]), JSON.stringify(ran(p.tracker)));
  rmSync(p.root, { recursive: true, force: true });
}

{
  const p = project();
  // The shape `tina4nodejs generate seeder` writes: a named run(), no default export.
  writeFileSync(join(p.seeds, "001_generated.ts"),
    `import { appendFileSync } from "node:fs";\nexport async function run(): Promise<void> {\n  appendFileSync(${JSON.stringify(p.tracker)}, "run\\n");\n}\n`);
  await new FakeData().seedDir(p.seeds);
  ok("the runner calls the run() a generated seeder exports",
    JSON.stringify(ran(p.tracker)) === JSON.stringify(["run"]), JSON.stringify(ran(p.tracker)));
  rmSync(p.root, { recursive: true, force: true });
}

{
  const p = project();
  const missing = await new FakeData().seedDir(join(p.root, "missing"));
  ok("a missing folder returns an empty list", Array.isArray(missing) && missing.length === 0);
  rmSync(p.root, { recursive: true, force: true });
}

console.log("\n--- tina4nodejs seed ---");
function runCliSeed(root: string): { code: number | null; output: string } {
  // The CLI runs each seed with `npx tsx`; give the scratch project the repo's
  // node_modules so npx resolves the installed tsx instead of the network.
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");
  const res = spawnSync(process.execPath, [TSX_CLI, cliBin, "seed"], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, TINA4_NO_BROWSER: "true" },
  });
  return { code: res.status, output: (res.stdout ?? "") + (res.stderr ?? "") };
}

{
  const p = project();
  threeFiles(p);
  const { code, output } = runCliSeed(p.root);
  ok("CLI seed exits 1 on a failing seed file", code === 1, `code=${code} ${output.slice(-400)}`);
  ok("CLI seed names the failing file", output.includes("002_raises.ts"), output.slice(-400));
  ok("CLI seed stops at the failing file",
    JSON.stringify(ran(p.tracker)) === JSON.stringify(["001_ok"]), JSON.stringify(ran(p.tracker)));
  rmSync(p.root, { recursive: true, force: true });
}

{
  const p = project();
  writeFileSync(join(p.seeds, "001_ok.ts"), record(p.tracker, "001_ok"));
  writeFileSync(join(p.seeds, "_helper.ts"), `throw new Error("a helper must never run");\nexport {};\n`);
  const { code, output } = runCliSeed(p.root);
  ok("CLI seed exits 0 when every file runs and skips underscore files",
    code === 0 && JSON.stringify(ran(p.tracker)) === JSON.stringify(["001_ok"]),
    `code=${code} ran=${JSON.stringify(ran(p.tracker))} ${output.slice(-300)}`);
  rmSync(p.root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

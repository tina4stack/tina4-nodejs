/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * batchSpawn.ts: find a program the way Windows would, and run a `.cmd` / `.bat`
 * with its arguments arriving verbatim and never executed.
 *
 * No mocks: real files on disk, a real PATH, real child processes. The resolver
 * runs on every platform (it takes the platform as an argument). The batch-file
 * round trip needs cmd.exe, so off Windows it reports a [needs:os=win32] skip.
 *
 * Mutation proof:
 *  - findExecutable(): drop the isFile check -> "a directory named tool.cmd is
 *    passed over" fails; swap the PATH and PATHEXT loops -> "an earlier PATH
 *    directory wins" fails; drop the .toLowerCase() -> nothing on Linux finds
 *    tool.cmd, so every resolve check fails.
 *  - escapeBatchArgument(): caret-escape once instead of twice -> on Windows the
 *    batch file's %* re-parse runs the `&` argument and the marker file appears.
 *
 * Run with: npx tsx test/batchSpawn.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  execFileSyncAllowingBatch,
  findExecutable,
  isBatchFile,
  spawnSyncAllowingBatch,
} from "../packages/core/src/batchSpawn.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

type SpawnFailure = Error & { status?: number | null; stdout?: string; stderr?: string; code?: string };

/** What `fn` threw, or null when it returned. */
function thrown(fn: () => unknown): SpawnFailure | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as SpawnFailure;
  }
}

const root = mkdtempSync(join(tmpdir(), "tina4 batch&spawn "));
const savedPath = process.env.PATH;
const savedPathext = process.env.PATHEXT;

function dir(name: string): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function touch(path: string): string {
  writeFileSync(path, "");
  return path;
}

/** findExecutable(name, "win32") against exactly these PATH dirs and PATHEXT. */
function resolveOn(name: string, dirs: string[], pathext = ".COM;.EXE;.BAT;.CMD"): string {
  process.env.PATH = dirs.join(delimiter);
  process.env.PATHEXT = pathext;
  try {
    return findExecutable(name, "win32");
  } finally {
    process.env.PATH = savedPath;
    process.env.PATHEXT = savedPathext;
    if (savedPathext === undefined) delete process.env.PATHEXT;
  }
}

// The cmd.exe metacharacters, a quote, a trailing backslash, %VAR% expansion,
// and delayed-expansion bangs. Any of them obeyed would create the marker.
function hostileArgs(marker: string): string[] {
  return [
    "with space", `a&echo pwned>"${marker}"`, `a|echo pwned>"${marker}"`, "100%", "%PATH%",
    'quote"inside', "trailing\\", "caret^x", "<lt>", "(paren)", "!bang!", "", "semi;colon,comma",
  ];
}

const PRINT_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

console.log("\n  batchSpawn: resolve like Windows, run batch files safely\n");
try {
  // -- findExecutable --
  {
    const empty = dir("empty");
    const shims = dir("shims");
    const tool = touch(join(shims, "tool.cmd"));
    assert("a bare name resolves to the .cmd on PATH", resolveOn("tool", [empty, shims]) === tool,
      resolveOn("tool", [empty, shims]));

    const first = dir("first");
    const second = dir("second");
    const firstBat = touch(join(first, "both.bat"));
    touch(join(second, "both.exe"));
    assert("an earlier PATH directory wins over a preferred extension later on PATH",
      resolveOn("both", [first, second]) === firstBat, resolveOn("both", [first, second]));

    const mixed = dir("mixed");
    const mixedExe = touch(join(mixed, "pick.exe"));
    touch(join(mixed, "pick.cmd"));
    assert("within one directory PATHEXT order decides", resolveOn("pick", [mixed]) === mixedExe,
      resolveOn("pick", [mixed]));

    const decoy = dir("decoy");
    mkdirSync(join(decoy, "tool.cmd"));
    assert("a directory named tool.cmd is passed over", resolveOn("tool", [decoy, shims]) === tool,
      resolveOn("tool", [decoy, shims]));

    assert("an empty PATH entry is ignored", resolveOn("tool", ["", shims]) === tool);
    assert("a name not on PATH comes back unchanged", resolveOn("nothere", [empty, shims]) === "nothere");
    assert("a name with an extension is not searched", resolveOn("tool.cmd", [shims]) === "tool.cmd");
    assert("a name with a directory is not searched",
      resolveOn(join("x", "tool"), [shims]) === join("x", "tool"));
    assert("other platforms get the name back unchanged", findExecutable("tool", "linux") === "tool");
  }

  // -- isBatchFile --
  assert("a .cmd and a .BAT are batch files on Windows",
    isBatchFile("C:\\x\\npm.cmd", "win32") && isBatchFile("RUN.BAT", "win32"));
  assert("an .exe, and a .cmd off Windows, are not",
    !isBatchFile("node.exe", "win32") && !isBatchFile("npm.cmd", "linux"));

  // -- a program that is not a batch file: spawned exactly as given --
  {
    const marker = join(root, "INJECTED-direct.txt");
    const args = hostileArgs(marker);
    const result = spawnSyncAllowingBatch(process.execPath, ["-e", PRINT_ARGV, ...args], { encoding: "utf-8" });
    assert("a non-batch program gets every argument verbatim",
      result.status === 0 && String(result.stdout) === JSON.stringify(args), String(result.stdout));
    assert("and none of them is executed", !existsSync(marker));
  }

  // -- execFileSyncAllowingBatch: execFileSync's contract --
  assert("success returns stdout",
    execFileSyncAllowingBatch(process.execPath, ["-e", "process.stdout.write('out')"]) === "out");
  {
    const err = thrown(() => execFileSyncAllowingBatch(process.execPath,
      ["-e", "process.stdout.write('o'); process.stderr.write('e'); process.exit(3)"]));
    assert("a non-zero exit throws with status, stdout and stderr",
      err?.status === 3 && err.stdout === "o" && err.stderr === "e",
      JSON.stringify(err && { status: err.status, stdout: err.stdout, stderr: err.stderr }));
  }
  {
    const err = thrown(() => execFileSyncAllowingBatch(join(root, "no-such-program"), []));
    assert("a program that cannot start throws its spawn error", err?.code === "ENOENT", String(err?.code));
  }

  // -- a real batch file, through cmd.exe --
  if (process.platform !== "win32") {
    console.log("  \x1b[33mSKIP\x1b[0m [needs:os=win32] batch-file round trip needs cmd.exe");
  } else {
    // The batch file lives in a directory whose name has a space and an `&`
    // (root above), so the command head is escaped too, not just the arguments.
    const bin = dir("bin dir");
    const script = join(root, "print-argv.js");
    writeFileSync(script, PRINT_ARGV.replace("slice(1)", "slice(2)"));
    const echo = join(bin, "echo-args.cmd");
    writeFileSync(echo, `@"${process.execPath}" "${script}" %*\r\n`);

    const marker = join(root, "INJECTED-batch.txt");
    const args = hostileArgs(marker);
    const result = spawnSyncAllowingBatch(echo, args, { encoding: "utf-8" });
    assert("a .cmd gets every hostile argument verbatim",
      result.status === 0 && String(result.stdout) === JSON.stringify(args),
      `status=${result.status} error=${result.error} stdout=${result.stdout} stderr=${result.stderr}`);
    assert("and none of them is executed", !existsSync(marker));

    process.env.PATH = `${bin}${delimiter}${savedPath}`;
    try {
      const out = execFileSyncAllowingBatch("echo-args", ["x y", "a&b"]);
      assert("a bare name resolves to the .cmd and runs it", out === JSON.stringify(["x y", "a&b"]), out);
    } finally {
      process.env.PATH = savedPath;
    }
  }
} finally {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);

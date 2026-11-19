/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Run a program that may be a Windows batch file (`.cmd` / `.bat`).
 *
 * Since the 2024 BatBadBut fix (CVE-2024-27980) Node refuses to spawn a batch
 * file without a shell: `spawnSync("C:\\...\\npm.cmd", args)` fails with EINVAL.
 * The other three Tina4 frameworks start batch files directly, so `npm.cmd`
 * and a `tina4.cmd` client have to work here too.
 *
 * Handing the arguments to `shell: true` is not the fix: Node joins them with
 * spaces and no escaping, so an argument such as `a&calc` would run `calc`.
 * Instead the command line is built here the way cross-spawn builds it
 * (https://qntm.org/cmd): each argument is quoted, embedded quotes and the
 * backslashes before them are escaped, and every cmd.exe metacharacter is
 * caret-escaped TWICE - once for the `cmd /c` line, once more because a batch
 * file re-parses the `%*` it forwards. The line goes to cmd.exe verbatim
 * (`windowsVerbatimArguments`) so libuv adds no quoting of its own.
 *
 * Anything that is not a batch file, and every non-Windows platform, is spawned
 * exactly as before.
 */
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

/** cmd.exe metacharacters, the same set cross-spawn escapes. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** True when `file` is a batch file that Node will not spawn without a shell. */
export function isBatchFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/** One argument, quoted and escaped for a batch file run through `cmd /d /s /c`. */
export function escapeBatchArgument(arg: string): string {
  let quoted = String(arg)
    // backslashes before a quote double, and the quote is backslash-escaped
    .replace(/(\\*)"/g, '$1$1\\"')
    // backslashes before the closing quote we are about to add double too
    .replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** The batch file's own path, escaped for the head of the `cmd /c` line. */
function escapeBatchCommand(file: string): string {
  return file.replace(CMD_META, "^$1");
}

/**
 * Resolve a bare program name such as `npm` to the file Windows would run.
 *
 * Without a shell, Windows' CreateProcess only adds `.exe`, so `npm` (which is
 * `npm.cmd`) is never found and the spawn fails with ENOENT. This walks PATH
 * with PATHEXT the way cmd.exe does. A name that already has a directory or an
 * extension, every other platform, and a name that is not found are returned
 * unchanged, so the spawn reports its own error exactly as before.
 */
export function findExecutable(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || /[\\/]/.test(name) || extname(name) !== "") return name;
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return name;
}

/**
 * `spawnSync`, except that a batch file on Windows runs through cmd.exe with
 * every argument escaped. Returns what spawnSync returns either way.
 */
export function spawnSyncAllowingBatch(
  file: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer | string> {
  if (!isBatchFile(file)) return spawnSync(file, args, options);
  const line = [escapeBatchCommand(file), ...args.map(escapeBatchArgument)].join(" ");
  const shell = process.env.comspec || "cmd.exe";
  return spawnSync(shell, ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

/**
 * `execFileSync` for a bare program name (`npm`, `npx`) that may be a batch
 * file: resolves it with {@link findExecutable}, runs it with
 * {@link spawnSyncAllowingBatch}, and like execFileSync returns stdout and
 * throws on a spawn error or a non-zero exit (the error carries `status`,
 * `stdout` and `stderr`).
 */
export function execFileSyncAllowingBatch(
  name: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): string {
  const result = spawnSyncAllowingBatch(findExecutable(name), args, { encoding: "utf-8", ...options });
  if (result.error) throw result.error;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (result.status !== 0) {
    const err = new Error(
      `Command failed: ${name} ${args.join(" ")} (exit ${result.status ?? result.signal})\n${stderr}`.trim(),
    ) as Error & { status: number | null; stdout: string; stderr: string };
    err.status = result.status;
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  return stdout;
}

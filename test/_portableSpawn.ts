/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Child-process targets that start the same way on Windows and POSIX.
 *
 * Helper, not a suite: the leading underscore keeps run-all.ts from collecting it.
 *
 * Two Windows facts break the obvious spellings:
 *
 *  1. `node_modules/.bin/tsx`, `npx` and `npm` are `.cmd` shims on Windows.
 *     spawn()/execFile() without a shell cannot start a `.cmd` (ENOENT, or EINVAL
 *     since the CVE-2024-27980 fix), and turning the shell on changes argument
 *     quoting for every caller. So run each tool's real JavaScript entry point
 *     under THIS node instead - which is exactly what the POSIX shim does.
 *  2. `--import` and an ESM `import` take a URL. "D:\repo\x.ts" parses as a URL
 *     with scheme "d:" and the loader refuses it (ERR_UNSUPPORTED_ESM_URL_SCHEME).
 *     A file:// URL is right on every platform.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = join(import.meta.dirname, "..");

/** tsx's CLI entry point (what `node_modules/.bin/tsx` runs on POSIX). */
export const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

/** tsx's ESM loader as a URL, ready for `node --import`. */
export const TSX_LOADER_URL = pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;

/** A filesystem path as an ESM import specifier (a file:// URL). */
export function moduleUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** TypeScript's compiler entry point (what `npx tsc` runs). */
export const TSC_CLI = join(REPO, "node_modules", "typescript", "bin", "tsc");

/** Vitest's CLI entry point (what `npx vitest` runs). */
export const VITEST_CLI = join(REPO, "node_modules", "vitest", "vitest.mjs");

/**
 * `[command, args]` that run `npm ...args`.
 *
 * POSIX keeps the plain `npm` on PATH, unchanged. Windows runs npm-cli.js under
 * this node: the installer puts it beside node.exe, and npm_execpath names it
 * whenever the process tree was started by npm.
 */
export function npmCommand(...args: string[]): [string, string[]] {
  if (process.platform !== "win32") return ["npm", args];
  const candidates = [
    process.env.npm_execpath ?? "",
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find((path) => /npm-cli\.js$/.test(path) && existsSync(path));
  if (!cli) {
    throw new Error(
      `npm-cli.js not found (looked in: ${candidates.filter(Boolean).join(", ")}); `
      + "set npm_execpath to its path",
    );
  }
  return [process.execPath, [cli, ...args]];
}

/**
 * Force-kill a detached child AND everything it started.
 *
 * POSIX: the child was spawned `detached`, so it leads its own process group and
 * `kill(-pid)` reaches the tsx wrapper and the node it re-spawns. Windows has no
 * process groups - a negative pid kills nothing, so the server leaks and keeps
 * its working directory locked - and `taskkill /T` walks the parent/child tree
 * instead. Throws like process.kill() when the POSIX group is already gone.
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  process.kill(-pid, "SIGKILL");
}

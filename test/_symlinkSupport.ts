/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Whether this host can create a symbolic link at all.
 *
 * Helper, not a suite: the leading underscore keeps run-all.ts from collecting it.
 *
 * Windows refuses symlinkSync() with EPERM unless Developer Mode is on or the
 * shell is elevated. A test whose whole point is "the framework refuses to
 * follow a planted symlink" cannot plant one there, so it has nothing to prove.
 * It must not pass silently either: it prints a SKIP line, which run-all.ts
 * counts and TINA4_REQUIRE_SERVICES=1 fails.
 *
 * Probed, not assumed from the platform: a Windows host that CAN create links
 * runs every symlink case, and Linux/macOS always do.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function probe(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "tina4-symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when symlinkSync() works on this host. */
export const SYMLINKS_PERMITTED: boolean = probe();

/** The machine-readable SKIP line for a case that needs a symlink. */
export function symlinkSkip(caseName: string): string {
  return `  SKIP ${caseName} - this host cannot create symlinks `
    + "(EPERM; on Windows enable Developer Mode or run elevated)";
}

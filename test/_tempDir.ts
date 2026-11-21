/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Remove a test's temp directory.
 *
 * Helper, not a suite: the leading underscore keeps run-all.ts from collecting it.
 *
 * POSIX unlinks a file another handle still has open, so there this is exactly
 * rmSync and still throws on any failure. Windows refuses (EPERM/EBUSY) while
 * THIS process holds a file inside open - and DatabaseSessionHandler opens a
 * SQLite file it gives no way to close, so a test using it cannot release the
 * file before it exits. There, and only for those two codes, the directory is
 * left in the OS temp dir with a NOTE line, instead of failing a file whose
 * every case passed.
 */
import { rmSync } from "node:fs";

export function removeTempDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY")) throw error;
    console.log(`  NOTE left ${path}: a file in it is still open in this process (${code})`);
  }
}

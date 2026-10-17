/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Shared CLI helpers — argument parsing, PATH lookup, and database bootstrap.
 * Kept zero-dependency (node stdlib only) so the CLI entry path stays light.
 */
import { delimiter, join } from "node:path";
import { statSync } from "node:fs";

/** Flags and positional arguments split out of a command's argv slice. */
export interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positional: string[];
}

/**
 * Parse `--key value`, `--key=value` and bare `--flag` arguments into flags
 * plus positionals.
 *
 * A name listed in `booleanFlags` never consumes the next token; every other
 * `--key` takes the following token as its value unless that token is itself a
 * `--flag` (or the argv ends), in which case the key is a bare boolean.
 */
export function parseFlags(args: string[], booleanFlags?: ReadonlySet<string>): ParsedFlags {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      i += readFlag(args, i, flags, booleanFlags);
    } else {
      positional.push(args[i]);
      i += 1;
    }
  }
  return { flags, positional };
}

/** Store the `--flag` at `i` into `flags`; returns how many arguments it used. */
function readFlag(
  args: string[], i: number, flags: Record<string, string | boolean>, booleanFlags?: ReadonlySet<string>,
): number {
  const arg = args[i];
  const eq = arg.indexOf("=");
  if (eq !== -1) {
    flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    return 1;
  }
  const key = arg.slice(2);
  const next = args[i + 1];
  if (!booleanFlags?.has(key) && next !== undefined && !next.startsWith("--")) {
    flags[key] = next;
    return 2;
  }
  flags[key] = true;
  return 1;
}

/**
 * Absolute path of the first of `names` found on PATH, or null.
 *
 * Scans PATH directories directly (no `which` shell-out) so it behaves the same
 * on every platform and honours a deliberately emptied PATH. Callers pass the
 * platform-specific candidate names (e.g. `["npm.cmd", "npm.exe", "npm"]`).
 */
export function findOnPath(names: string[]): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not there — keep looking
      }
    }
  }
  return null;
}

/**
 * Await the ORM's async `initDatabase()` and exit(1) with a clear message on
 * failure. The await matters: initDatabase() calls setAdapter() inside the
 * promise, so without it the next getAdapter() throws "No database adapter
 * configured." Shared by the migrate, rollback, and status commands.
 */
export async function initDatabaseOrExit(initDatabase: () => Promise<unknown>): Promise<void> {
  try {
    await initDatabase();
  } catch (err) {
    console.error(`  Error initialising database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

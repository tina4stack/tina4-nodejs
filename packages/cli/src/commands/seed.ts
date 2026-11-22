/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * CLI command: seed — Run database seed files.
 *
 * Scans src/seeds/ for .ts files and executes them with tsx in alphabetical order.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";
import { execSync } from "node:child_process";

export async function runSeeds(seedPath?: string): Promise<void> {
  const cwd = process.cwd();
  const seedDir = resolve(cwd, "src/seeds");

  // If a specific seed file is provided, run it directly
  if (seedPath) {
    const file = resolve(seedPath);
    if (!existsSync(file)) {
      console.error(`  Error: Seed file not found: ${seedPath}`);
      process.exit(1);
    }
    console.log(`  Running seed: ${seedPath}\n`);
    try {
      execSync(`npx tsx "${file}"`, { cwd, stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    return;
  }

  // Auto-discover seed files in src/seeds/
  if (!existsSync(seedDir)) {
    console.log("  No seeds directory found.");
    console.log("  Create seed files in src/seeds/ (e.g. src/seeds/001-users.ts)");
    return;
  }

  let seedFiles: string[];
  try {
    // Same selection as FakeData.seedDir (ADR-0108): .ts/.js in name order,
    // skipping files whose name starts with "_".
    seedFiles = readdirSync(seedDir)
      .filter((f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.startsWith("_"))
      .sort()
      .map((f) => join(seedDir, f));
  } catch {
    console.log("  Could not read src/seeds/ directory.");
    return;
  }

  if (seedFiles.length === 0) {
    console.log("  No seed files found in src/seeds/");
    return;
  }

  console.log(`  Found ${seedFiles.length} seed file(s)\n`);

  // ADR-0108: the first seed file that fails stops the run and exits 1, so a
  // failed seeder fails `tina4 seed` (the client propagates the code). Later
  // files are not run: they usually build on the rows the failed one owed.
  for (const file of seedFiles) {
    console.log(`  Seeding: ${relative(cwd, file)}`);
    try {
      execSync(`npx tsx "${file}"`, { cwd, stdio: "inherit" });
    } catch {
      console.error(`\n  Seed file failed: ${basename(file)} - seeding stopped.`);
      process.exit(1);
    }
  }

  console.log("\n  All seeds completed.");
}

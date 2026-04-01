/**
 * CLI command: seed — Run database seed files.
 *
 * Scans src/seeds/ for .ts files and executes them with tsx in alphabetical order.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
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
    seedFiles = readdirSync(seedDir)
      .filter((f) => f.endsWith(".ts"))
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

  let failed = false;
  for (const file of seedFiles) {
    const relative = file.replace(cwd + "/", "");
    console.log(`  Seeding: ${relative}`);
    try {
      execSync(`npx tsx "${file}"`, { cwd, stdio: "inherit" });
    } catch {
      failed = true;
    }
  }

  if (failed) {
    console.error("\n  Some seeds failed.");
    process.exit(1);
  }

  console.log("\n  All seeds completed.");
}

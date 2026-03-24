/**
 * CLI command: migrate:create — Create a new SQL migration file pair.
 *
 * Usage:
 *   tina4 migrate:create "create users table"
 *   tina4 migrate:create add_email_to_users
 *
 * Creates both:
 *   migrations/YYYYMMDDHHMMSS_description.sql       (up migration)
 *   migrations/YYYYMMDDHHMMSS_description.down.sql   (rollback)
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function createMigration(description?: string): Promise<void> {
  if (!description) {
    console.error("  Usage: tina4 migrate:create <description>");
    console.error('  Example: tina4 migrate:create "create users table"');
    process.exit(1);
  }

  const dir = resolve("migrations");

  // Ensure migrations/ exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Sanitise description for filename
  const safeName = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  // Use YYYYMMDDHHMMSS timestamp prefix
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  const upFileName = `${timestamp}_${safeName}.sql`;
  const downFileName = `${timestamp}_${safeName}.down.sql`;
  const upPath = join(dir, upFileName);
  const downPath = join(dir, downFileName);

  const upTemplate = `-- Migration: ${description}\n-- Created: ${now.toISOString()}\n\n`;
  const downTemplate = `-- Rollback: ${description}\n-- Created: ${now.toISOString()}\n\n`;

  writeFileSync(upPath, upTemplate, "utf-8");
  writeFileSync(downPath, downTemplate, "utf-8");

  console.log(`  Created migration:  ${upFileName}`);
  console.log(`  Created rollback:   ${downFileName}`);
  console.log(`  Path: ${dir}`);
}

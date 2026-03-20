/**
 * CLI command: migrate:create — Create a new SQL migration file.
 *
 * Usage:
 *   tina4 migrate:create "create users table"
 *   tina4 migrate:create add_email_to_users
 *
 * Creates migrations/000001_description.sql (next sequence number).
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

  // Determine the next sequence number
  const existing = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    : [];

  let nextSeq = 1;
  if (existing.length > 0) {
    const last = existing[existing.length - 1];
    const match = last.match(/^(\d+)/);
    if (match) {
      nextSeq = parseInt(match[1], 10) + 1;
    }
  }

  // Sanitise description for filename
  const safeName = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  const seqStr = String(nextSeq).padStart(6, "0");
  const fileName = `${seqStr}_${safeName}.sql`;
  const filePath = join(dir, fileName);

  const template = `-- Migration: ${description}
-- Created: ${new Date().toISOString()}

`;

  writeFileSync(filePath, template, "utf-8");
  console.log(`  Created migration: ${fileName}`);
  console.log(`  Path: ${filePath}`);
}

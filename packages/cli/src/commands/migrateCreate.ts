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
 *
 * 3.13.121 (ADR-0063): this is a thin delegation to `generate migration` so a
 * scaffolded migration has ONE shape and ONE envelope regardless of whether
 * the developer typed `tina4 migrate:create` or `tina4 generate migration`.
 * The two file paths emitted here (`_desc.sql` + `_desc.down.sql`) and the
 * schema-awareness on `create_X` names are unchanged; the delegation adds the
 * ADR-0063 `generate_v1_1` envelope, `--json` / `--dry-run` support, and the
 * `edit_hints[]` / `next[]` machinery for free. `--no-test` preserves the
 * pre-3.13.121 UX (just a migration, no co-emitted test).
 */
import { generate } from "./generate.js";

export async function createMigration(args: string[] = []): Promise<void> {
  // Split flags from the description so `tina4 migrate:create "add users"
  // --json --dry-run` reaches the same envelope machinery as its
  // `tina4 generate migration` twin (see test/migrateCreateEnvelopeParity.test.ts).
  const positionals: string[] = [];
  const flags: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) flags.push(arg);
    else positionals.push(arg);
  }
  const description = positionals.join(" ").trim();

  if (!description) {
    console.error("  Usage: tina4 migrate:create <description>");
    console.error('  Example: tina4 migrate:create "create users table"');
    process.exit(1);
  }

  // Sanitise the description into a filename-safe slug BEFORE delegation.
  // Preserves migrate:create's pre-3.13.121 UX: `migrate:create "add users"`
  // still yields `${ts}_add_users.sql` (space -> underscore, lowercased),
  // never a filename with a bare space. `generate migration` takes its name
  // verbatim by design; migrate:create is the human-friendly front door.
  const safeDescription = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  // Delegate to `generate migration` with --no-test so migrate:create stays
  // "just a migration, no test" — its pre-3.13.121 semantics — while getting
  // the ADR-0063 envelope, edit_hints[], next[] and --json/--dry-run for free.
  await generate("migration", safeDescription, ["--no-test", ...flags]);
}

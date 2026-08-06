/**
 * migration_contract :: createMigration validates its `kind`
 *
 * MEASURED 2026-08-06 across all four frameworks: the accepted value for a CODE
 * migration differed in every one, and NOT ONE validated it.
 *
 *   python "python"   php "php"   ruby "ruby" or "python"   node "class"
 *
 * So createMigration("add users", { kind: "python" }) produced a code migration
 * in Python and Ruby and a SILENT .sql file in PHP and Node - the same call,
 * four artefacts, no error anywhere. The caller finds out when the migration
 * does nothing they wrote.
 *
 * "code" is now canonical in all four; each keeps its own language name as a
 * legacy alias; anything else throws.
 *
 * Pure filesystem work - no service, no double.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { createMigration } from "../packages/orm/src/migration.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "tina4-migkind-"));
  dirs.push(d);
  return d;
}

/** createMigration returns a path for sql, or {upPath,downPath} for code. */
function extOf(result: string | { upPath: string; downPath: string }): string {
  return extname(typeof result === "string" ? result : result.upPath);
}

describe("migration kind contract", () => {
  it("accepts code as the canonical kind", async () => {
    expect(extOf(await createMigration("add users", { migrationsDir: scratch(), kind: "code" }))).toBe(".ts");
  });

  it("still accepts the legacy alias", async () => {
    expect(extOf(await createMigration("add users", { migrationsDir: scratch(), kind: "class" }))).toBe(".ts");
  });

  it("defaults to sql and leaves it unchanged", async () => {
    const d = scratch();
    expect(extOf(await createMigration("a", { migrationsDir: d }))).toBe(".sql");
    expect(extOf(await createMigration("b", { migrationsDir: d, kind: "sql" }))).toBe(".sql");
  });

  it("throws on an unknown kind instead of silently writing sql", async () => {
    // Another framework's spelling is the most likely typo, and it used to
    // produce a .sql file with no complaint.
    for (const bogus of ["python", "php", "ruby", "typo"]) {
      await expect(
        createMigration("add users", { migrationsDir: scratch(), kind: bogus as never }),
        `kind "${bogus}" did not throw - it silently produced a file`,
      ).rejects.toThrow(/Unknown migration kind/);
    }
  });
});

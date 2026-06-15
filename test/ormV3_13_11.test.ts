/**
 * Tina4 Node.js — v3.13.11 ORM correctness pass.
 *
 * Mirrors tests/test_orm_v3_13_11.py:
 *
 *   * Natural-key INSERT: save() must decide INSERT/UPDATE on row
 *     existence for non-auto-increment PKs (issue #50.2).
 *   * BooleanField DDL is already engine-aware in Node (each adapter
 *     has its own fieldTypeTo*() function with the right native type).
 *     Pin that with a regression test.
 *
 * Callable defaults (#50.1) are N/A for Node because BaseModel doesn't
 * auto-apply defaults at construction — that's a different design from
 * Python/Ruby. Users must explicitly set values. Documented in the
 * v3.13.11 release notes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase, getAdapter, BaseModel } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== ORM correctness (v3.13.11) ===\n");

const tmp = mkdtempSync(join(tmpdir(), "tina4-v31311-"));
const dbPath = join(tmp, "test.db");

try {
  await initDatabase({ url: `sqlite:///${dbPath}` });

  // ── Issue #50.2 — natural-key INSERT ────────────────────────────
  console.log("--- #50.2: natural-key INSERT ---");

  class GiftCard extends BaseModel {
    static tableName = "gift_cards";
    static fields = {
      gift_card_number: { type: "string" as const, primaryKey: true, maxLength: 50 },
      owner: { type: "string" as const, maxLength: 120 },
    };
    declare gift_card_number?: string;
    declare owner?: string;
  }
  await GiftCard.createTable();

  {
    const gc = new GiftCard();
    gc.gift_card_number = "GC-100";
    gc.owner = "alice@example.com";
    const result = await gc.save();
    assert("first save inserts a natural-key row", result !== false);
    const found = (await GiftCard.find<GiftCard>({ gift_card_number: "GC-100" }))[0];
    assert("row is retrievable after natural-key INSERT", found != null && found.owner === "alice@example.com");
  }

  {
    const gc = new GiftCard();
    gc.gift_card_number = "GC-200";
    gc.owner = "first@example.com";
    await gc.save();
    // Second save with the same PK must UPDATE, not duplicate-INSERT.
    gc.owner = "second@example.com";
    const result = await gc.save();
    assert("second save on same PK does not duplicate", result !== false);
    const rows = await GiftCard.find<GiftCard>({ gift_card_number: "GC-200" });
    assert("only one row exists after two saves", rows.length === 1);
    assert("UPDATE applied the new owner", rows[0]?.owner === "second@example.com");
  }

  // ── Auto-increment behaviour unchanged ──────────────────────────
  console.log("\n--- regression: auto-increment PK unchanged ---");

  class User extends BaseModel {
    static tableName = "users";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const, maxLength: 80 },
    };
    declare id?: number;
    declare name?: string;
  }
  await User.createTable();

  {
    const u = new User();
    u.name = "Alice";
    await u.save();
    const firstId = u.id;
    assert("auto-increment PK set after save", typeof firstId === "number" && firstId > 0);

    u.name = "Alice Wonder";
    await u.save();
    assert("auto-increment PK unchanged on update", u.id === firstId);

    const rows = await User.find<User>();
    assert("only one row after re-save", rows.length === 1);
    assert("UPDATE applied", rows[0]?.name === "Alice Wonder");
  }

  // ── BooleanField regression — engine-aware DDL was already in Node ─
  console.log("\n--- regression: BooleanField DDL per engine ---");

  // Confirm SQLite produces "INTEGER" for boolean (the per-adapter
  // fieldTypeToSQLite is internal). The other adapters are spot-checked
  // in their own existing tests.
  class Flag extends BaseModel {
    static tableName = "flag";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      active: { type: "boolean" as const, default: true },
    };
    declare id?: number;
    declare active?: boolean;
  }
  await Flag.createTable();
  const adapter = getAdapter();
  const row = adapter.fetchOne(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='flag'",
  ) as { sql?: string } | null;
  assert(
    "SQLite BooleanField → INTEGER",
    row != null && /["`']?active["`']?\s+INTEGER/i.test(row.sql ?? ""),
    `DDL: ${row?.sql}`,
  );
} finally {
  try { await closeDatabase(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

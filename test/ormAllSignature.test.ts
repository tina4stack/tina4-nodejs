/**
 * Lock-in: Model.all() positional contract — all(limit, offset, include?, orderBy?).
 *
 * Node was the sole outlier of the four frameworks. The master and the other two
 * never accepted a filter on all():
 *   Python  all(limit=100, offset=0, include=None, order_by=None)
 *   PHP     all(int $limit = 100, int $offset = 0, ?array $include, ?string $orderBy)
 *   Ruby    all(limit: 100, offset: nil, order_by: nil, include: nil)
 * Node's extra leading where/params shifted every following argument, so the same
 * positional call meant different things per language.
 *
 * These assertions read POSITION, not just behaviour: passing 2 first must mean
 * limit 2, and passing 1 second must mean offset 1. If anyone re-inserts a leading
 * parameter, the first argument stops being the limit and these go red.
 *
 * NO MOCKS — real SQLite via node:sqlite, real rows.
 */
import { initDatabase } from "../packages/orm/src/database.ts";
import { BaseModel } from "../packages/orm/src/baseModel.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== ORM all() signature (parity) ===\n");

class Thing extends BaseModel {
  static tableName = "all_sig_things";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    label: { type: "string" as const },
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tina4-allsig-"));
  try {
    const db = await initDatabase({ url: `sqlite:///${join(dir, "t.db")}` });
    await db.execute(
      `CREATE TABLE all_sig_things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)`,
    );
    for (const l of ["a", "b", "c", "d", "e"]) {
      await db.execute(`INSERT INTO all_sig_things (label) VALUES (?)`, [l]);
    }

    const everything = await Thing.all();
    assert("all() with no args returns every row", everything.length === 5,
      `got ${everything.length}`);

    // POSITION 1 is limit.
    const two = await Thing.all(2);
    assert("first positional arg is LIMIT", two.length === 2, `got ${two.length}`);

    // POSITION 2 is offset.
    const skipped = await Thing.all(100, 1);
    assert("second positional arg is OFFSET", skipped.length === 4,
      `got ${skipped.length}`);

    // limit + offset together, and the window is the expected slice.
    const window = await Thing.all(2, 1);
    assert("limit + offset select the right window",
      window.length === 2 && (window[0] as any).label === "b",
      `got ${window.length} starting at ${(window[0] as any)?.label}`);

    // POSITION 4 is orderBy (position 3 is include, left undefined).
    const desc = await Thing.all(100, 0, undefined, "label DESC");
    assert("fourth positional arg is ORDER BY",
      (desc[0] as any).label === "e", `got ${(desc[0] as any)?.label}`);

    // The default cap is the shared cross-framework 100.
    const capped = await Thing.all();
    assert("default limit is the shared 100 cap", capped.length <= 100);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();

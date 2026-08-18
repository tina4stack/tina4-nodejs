/**
 * The migration ledger has to work on Firebird — create, write, and key rows.
 *
 * Three defects made `migrate()` impossible on Firebird in EVERY configuration,
 * and each hides the next, so they are pinned together here:
 *
 * 1. CREATE. The ledger DDL wrote `batch INTEGER NOT NULL DEFAULT 1`. Firebird
 *    wants DEFAULT before NOT NULL and rejects the other order outright with
 *    "Token unknown ... DEFAULT" (SQL -104), so tina4_migration was never
 *    created and no migration could run against a fresh database.
 *
 * 2. WRITE. `mt()` quoted the table as "tina4_migration" on every engine but
 *    MySQL. On Firebird a quoted lower-case identifier is a DIFFERENT, case
 *    sensitive table from the unquoted TINA4_MIGRATION that the PHP and Python
 *    masters create. tableExists() matched case-insensitively and reported the
 *    ledger present, then the INSERT asked for the quoted spelling and got
 *    "Table unknown" — so pointing a Node app at a database migrated by
 *    tina4-php or tina4-python could not record a single migration. That
 *    cross-language case is explicitly supported (see recordMigration's note on
 *    tina4-python#93), and it is the ONLY case that mattered: defect 1 meant
 *    Node could never have created a Firebird ledger of its own.
 *
 * 3. KEY. recordMigration() supplies the primary key itself, since Firebird has
 *    no AUTOINCREMENT, by reading GEN_TINA4_MIGRATION_ID. It asked for
 *    `rows[0]?.NEXT_ID`, but firebirdColumnName() folds an unquoted upper-case
 *    alias to lower case — the behaviour firebirdColumnCase.test.ts pins — so
 *    the key is `next_id`, the `?? 1` fallback fired, and EVERY row was stamped
 *    id 1. The first migration applied and the second died on the ledger's own
 *    primary key.
 *
 * Two migrations is the smallest chain that can catch defect 3: the first row
 * is inserted whatever id it is handed, so a one-file chain stays green even
 * when every row carries the same value.
 *
 * That the adapter folds column names is already covered. What was not covered
 * is whether the migration runner READS what the adapter returns — a fold is
 * only half a contract, and the other half is each consumer of it.
 *
 * Real Firebird only — no mocks. A fake adapter would have to be told what the
 * generator read returns and whether the engine accepts the DDL, which is
 * exactly what is in question.
 */
import {
  FirebirdAdapter,
  setAdapter,
  adapterExecute,
  adapterQuery,
  ensureMigrationTable,
  recordMigration,
} from "../packages/orm/src/index.ts";

const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, why: string) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${why}`);
}

const CASES = [
  "ledger DDL is accepted by Firebird",
  "two migrations record with distinct ids",
  "records into a ledger created by the PHP/Python masters",
];

console.log("\n--- Firebird migration ledger ---");

/** Swallow "it was not there anyway" — Firebird has no DROP ... IF EXISTS. */
async function quiet(db: any, sql: string): Promise<void> {
  try {
    await adapterExecute(db, sql);
  } catch {
    /* absent already */
  }
}

async function reset(db: any): Promise<void> {
  await quiet(db, `DROP TABLE "tina4_migration"`);
  await quiet(db, "DROP TABLE tina4_migration");
  await quiet(db, "DROP SEQUENCE GEN_TINA4_MIGRATION_ID");
}

async function ledgerIds(db: any): Promise<number[]> {
  const rows = (await adapterQuery(
    db,
    "SELECT id FROM tina4_migration ORDER BY id",
  )) as any[];

  return rows.map((r) => Number(Object.values(r)[0]));
}

if (!FIREBIRD_URL) {
  for (const name of CASES) {
    skip(name, "TINA4_TEST_FIREBIRD_URL not set (needs a live Firebird)");
  }
} else {
  const db = new FirebirdAdapter(FIREBIRD_URL) as any;

  try {
    await db.connect();
    await adapterQuery(db, "SELECT 1 AS N FROM RDB$DATABASE");
    setAdapter(db);

    // 1 + 2 — build the ledger from scratch, then key two rows through it.
    await reset(db);

    let built = "";

    try {
      await ensureMigrationTable();
    } catch (err) {
      built = (err as Error).message.split("\n")[0];
    }

    ok(CASES[0], built === "", built);

    let wrote = "";

    try {
      await recordMigration("20260101000001_ledger_a.sql", 1);
      await recordMigration("20260101000002_ledger_b.sql", 1);
    } catch (err) {
      wrote = (err as Error).message.split("\n")[0];
    }

    const ids = wrote === "" ? await ledgerIds(db) : [];

    ok(
      CASES[1],
      wrote === "" && ids.length === 2 && new Set(ids).size === 2,
      wrote || `ids ${JSON.stringify(ids)}`,
    );

    // 3 — the cross-language case: a ledger created the way the PHP and Python
    // masters create it, i.e. UNQUOTED, which Firebird folds to upper case.
    await reset(db);
    await adapterExecute(db, "CREATE GENERATOR GEN_TINA4_MIGRATION_ID");
    await adapterExecute(
      db,
      `CREATE TABLE tina4_migration (
        id INTEGER NOT NULL PRIMARY KEY,
        migration_name VARCHAR(500) NOT NULL UNIQUE,
        description VARCHAR(500),
        batch INTEGER DEFAULT 1 NOT NULL,
        executed_at VARCHAR(50) NOT NULL,
        passed INTEGER DEFAULT 1 NOT NULL
      )`,
    );

    let foreign = "";

    try {
      await ensureMigrationTable();
      await recordMigration("20260101000003_ledger_c.sql", 1);
    } catch (err) {
      foreign = (err as Error).message.split("\n")[0];
    }

    ok(CASES[2], foreign === "", foreign);

    await reset(db);
  } catch (err) {
    for (const name of CASES.slice(passed + failed)) {
      skip(name, `Firebird unusable here: ${(err as Error).message}`);
    }
  } finally {
    try {
      db.close();
    } catch {
      /* already gone */
    }
  }
}

console.log(
  `\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`,
);

// Exit explicitly. node-firebird leaves a handle open after close(), so without
// this the process sits at 100% pass with nothing left to do and is eventually
// killed by the runner's timeout — a green that reports as a failure.
process.exit(failed > 0 ? 1 : 0);

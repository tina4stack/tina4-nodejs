/**
 * The RAW read-path row-cap contract, ported into Node so the bug that hid in
 * tina4-php cannot hide here.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * In tina4-php this exact contract was written as a SECOND PHPUnit TestCase
 * class inside tests/DevAdminTest.php. PHPUnit discovers test FILES and runs
 * the class the file is named for, so the second class was never collected and
 * the test NEVER RAN. It sat in the repo for months reading like coverage.
 *
 * When it was finally executed it FAILED — it asserted a default cap of 10.
 * Ten was the V2 documented number; it survived into v3 in two places and was
 * never reconciled with the settled v3 value. The number for the whole family
 * is 100 (plan/v3/DECISIONS-PENDING-REVIEW.md: "ORM row cap = 100 — DONE in all
 * four"; tina4-python/tests/test_orm_row_cap.py: "One number, everywhere: 100.").
 * So the buried test was not merely dead, it was dead AND wrong, and being dead
 * is what let it stay wrong.
 *
 * The PHP fixture was also too weak to matter: it created 30 rows and asserted
 * 30 came back. Thirty rows cannot distinguish "the cap is 100" from "there is
 * no cap at all" — every assertion passes either way. THE FIXTURE HERE HOLDS
 * 150 ROWS, MORE THAN THE CAP. That is the entire point. A fixture smaller than
 * the cap proves nothing.
 *
 * Node's runner (test/run-all.ts) discovers every `*.test.ts` in this directory
 * and spawns it, and charges a file that prints no "N passed, M failed" summary
 * line as a failure — so the PHP burial mode is structurally impossible here.
 * This file still prints its summary and exits non-zero on failure, which is
 * what makes it visible to that runner.
 *
 * THE CONTRACT (settled — this file does not renegotiate it)
 * ---------------------------------------------------------
 *   1. A raw fetch() with NO limit argument caps at 100 rows.
 *   2. An explicit limit overrides the default IN BOTH DIRECTIONS:
 *      limit 25 -> 25 rows, and limit 120 -> 120 rows even though 120 > 100.
 *      Direction two is the assertion that catches a `Math.min(limit, 100)`
 *      ceiling, which every "cap" test that only checks the default would miss.
 *   3. SQL that already carries its own LIMIT must NOT get a second one
 *      appended (`... LIMIT 5 LIMIT 100` is a syntax error on most engines and
 *      a silently wrong answer where it parses).
 *
 * WHERE NODE APPLIES IT
 * ---------------------
 * Node applies the cap at the WRAPPER only — Database.fetch() in
 * packages/orm/src/database.ts substitutes DEFAULT_ROW_CAP when `limit` is
 * undefined. The SQLite ADAPTER appends a LIMIT only when one is handed to it
 * and caps NOTHING on its own. That differs from PHP, where the adapter caps at
 * 100 too. Both layers are measured below; the adapter's uncapped behaviour is
 * asserted AS the divergence it is rather than bent to match PHP. Anyone
 * calling an adapter directly is below the cap and gets every row.
 *
 * Real SQLite on disk, no mocks. Companion to test/ormRowCap.test.ts, which
 * covers the ORM model paths (all/find/select/where/...); this file covers the
 * raw Database.fetch() wrapper, the adapter beneath it, and the LIMIT-dedup
 * clause that neither of those exercise.
 *
 * Run with: npx tsx test/rowCapContract.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.ts";
// DEFAULT_ROW_CAP is NOT re-exported from packages/orm/src/index.ts, so it is
// imported from the module that declares it. Noted, not fixed here.
import { DEFAULT_ROW_CAP } from "../packages/orm/src/database.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";

/** More than the cap. A fixture at or below the cap proves nothing. */
const ROWS = 150;
/** The one number the family shares. NOT 10 — that was the v2 docs value. */
const CAP = 100;
/** The stale value the buried PHP test asserted. Pinned so it cannot return. */
const STALE_V2_CAP = 10;

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

console.log("=== raw read-path row cap contract (fixture 150 > cap 100) ===\n");

const tmp = mkdtempSync(join(tmpdir(), "tina4-row-cap-contract-"));
const dbFile = join(tmp, "row_cap_contract.db");
const TABLE = "rowcap_rows";
const SELECT_ALL = `SELECT * FROM ${TABLE} ORDER BY id`;

async function run() {
  const db = await initDatabase({ url: `sqlite:///${dbFile}` });
  await db.execute(
    `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)`,
  );
  for (let i = 0; i < ROWS; i++) {
    await db.execute(`INSERT INTO ${TABLE} (label) VALUES (?)`, [`row-${i}`]);
  }

  console.log("--- the fixture itself ---");
  // If this fails, every assertion below is meaningless: a fixture that does
  // not exceed the cap passes whether the cap exists or not. This is the
  // guard the 30-row PHP fixture lacked.
  const seeded = Number((await db.fetchOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ${TABLE}`,
  ))?.c);
  assert(`fixture holds ${ROWS} rows, MORE than the cap of ${CAP}`,
    seeded === ROWS && seeded > CAP, `got ${seeded}`);

  console.log("\n--- 1. no limit argument caps at 100 (the WRAPPER) ---");
  {
    const bare = await db.fetch(SELECT_ALL);
    assert(`db.fetch() with no limit returns ${CAP} of ${ROWS} rows`,
      bare.records.length === CAP, `got ${bare.records.length}`);

    // The buried PHP test asserted 10. Naming it here means a regression to
    // the v2 number fails with the reason on the line, not just a count.
    assert(`the default is NOT the stale v2 value ${STALE_V2_CAP}`,
      bare.records.length !== STALE_V2_CAP,
      `got ${bare.records.length} — that is the V2 docs number, not the v3 contract`);

    // Truncation must be real, not the table being short. Row 100 is present
    // and row 101 is absent, by primary key.
    const ids = bare.records.map((r) => Number((r as any).id));
    assert("the capped page is the FIRST 100 rows, ids 1..100",
      ids.length === CAP && ids[0] === 1 && ids[CAP - 1] === CAP && !ids.includes(CAP + 1),
      `first=${ids[0]} last=${ids[ids.length - 1]}`);

    assert(`the exported DEFAULT_ROW_CAP constant is ${CAP}`,
      DEFAULT_ROW_CAP === CAP, `got ${DEFAULT_ROW_CAP}`);
  }

  console.log("\n--- 2. an explicit limit overrides the default IN BOTH DIRECTIONS ---");
  {
    const small = await db.fetch(SELECT_ALL, [], 25);
    assert("limit 25 returns 25 (below the default)",
      small.records.length === 25, `got ${small.records.length}`);

    // The direction a "cap" implemented as Math.min(limit, 100) gets wrong.
    const past = await db.fetch(SELECT_ALL, [], 120);
    assert("limit 120 returns 120 — the cap is a DEFAULT, not a ceiling",
      past.records.length === 120, `got ${past.records.length}`);

    const everything = await db.fetch(SELECT_ALL, [], ROWS);
    assert(`limit ${ROWS} returns all ${ROWS}`,
      everything.records.length === ROWS, `got ${everything.records.length}`);

    const one = await db.fetch(SELECT_ALL, [], 1);
    assert("limit 1 returns 1", one.records.length === 1, `got ${one.records.length}`);

    // Offset composes with an explicit limit rather than being swallowed by
    // the cap: page two of 25 starts at id 26.
    const page2 = await db.fetch(SELECT_ALL, [], 25, 25);
    assert("limit 25 offset 25 returns rows 26..50",
      page2.records.length === 25 && Number((page2.records[0] as any).id) === 26,
      `got ${page2.records.length} rows starting at id ${(page2.records[0] as any)?.id}`);
  }

  console.log("\n--- 3. SQL that already carries LIMIT gets no second one ---");
  {
    // A second appended LIMIT is `... LIMIT 5 LIMIT 100` — a syntax error on
    // SQLite, so a regression here THROWS rather than miscounting.
    const own = await db.fetch(`${SELECT_ALL} LIMIT 5`);
    assert("caller's own LIMIT 5 survives a no-limit fetch (no second LIMIT appended)",
      own.records.length === 5, `got ${own.records.length}`);

    const ownVsExplicit = await db.fetch(`${SELECT_ALL} LIMIT 5`, [], 120);
    assert("caller's own LIMIT 5 wins over an explicit limit of 120",
      ownVsExplicit.records.length === 5, `got ${ownVsExplicit.records.length}`);

    // Lower-case, because the dedup check upper-cases the SQL before looking.
    const lower = await db.fetch(`select * from ${TABLE} order by id limit 5`);
    assert("lower-case `limit` is recognised as the caller's own",
      lower.records.length === 5, `got ${lower.records.length}`);

    // v3.13.12: a trailing semicolon must be stripped before the wrapper
    // appends anything, or the SQL becomes `SELECT ...; LIMIT 100`.
    const semi = await db.fetch(`${SELECT_ALL};`);
    assert("a trailing semicolon still caps at 100 instead of erroring",
      semi.records.length === CAP, `got ${semi.records.length}`);
  }

  console.log("\n--- 4. what the ADAPTER does (measured, not forced to match PHP) ---");
  {
    // Same database file, opened directly. Below the wrapper there is no cap.
    const adapter = new SQLiteAdapter(dbFile);

    const bare = adapter.fetch(SELECT_ALL);
    assert(`adapter.fetch() with no limit returns ALL ${ROWS} rows — Node caps at the WRAPPER only`,
      bare.length === ROWS, `got ${bare.length}`);

    // Stated as its own assertion so the divergence from PHP (whose adapter
    // caps at 100 too) is on the record rather than implied by the count.
    assert("the adapter therefore does NOT apply the 100 cap (PHP's does)",
      bare.length !== CAP, `got ${bare.length}`);

    assert("adapter honours an explicit limit of 25",
      adapter.fetch(SELECT_ALL, [], 25).length === 25);
    assert("adapter honours an explicit limit of 120 (no ceiling either)",
      adapter.fetch(SELECT_ALL, [], 120).length === 120);
    assert("adapter appends no second LIMIT when the SQL has one",
      adapter.fetch(`${SELECT_ALL} LIMIT 5`, [], 120).length === 5);

    adapter.close?.();
  }

  console.log("\n--- observations (not assertions) ---");
  const capped = await db.fetch(SELECT_ALL);
  console.log(
    `  DatabaseResult.count on a capped fetch = ${capped.count} ` +
      `(records=${capped.records.length}, table holds ${ROWS}); limit=${capped.limit}`,
  );

  // OPEN DEFECT, measured here and reported rather than asserted.
  //
  // Clause 3's dedup (packages/orm/src/adapters/sqlite.ts, SQLiteAdapter.fetch)
  // is a substring search for "LIMIT" in the upper-cased SQL taken up to the
  // first `--`. Two no-limit fetches therefore return EVERY row, silently
  // defeating clause 1:
  //
  //   a) the word LIMIT appearing in a string literal or identifier reads as
  //      "the caller supplied their own", so nothing is appended;
  //   b) a trailing `-- comment` is stripped for DETECTION but the clause is
  //      appended to the ORIGINAL SQL, so ` LIMIT 100` lands INSIDE the comment.
  //
  // These are NOT asserted, deliberately: this file is the ported cross-family
  // contract test and must stay a live gate for the three settled clauses. A
  // permanently-red file is a file someone disables, and the buried-PHP-class
  // story is precisely about losing a test. The defect is printed loud here and
  // reported upward so it gets its own fix plus its own regression test.
  const litCap = await db.fetch(`SELECT * FROM ${TABLE} WHERE label != 'LIMIT' ORDER BY id`);
  const cmtCap = await db.fetch(`${SELECT_ALL} -- LIMIT 5`);
  console.log(
    `  \x1b[33mOPEN DEFECT\x1b[0m dedup is a naive substring match, so the cap is silently lost:\n` +
      `    "LIMIT" inside a string literal -> ${litCap.records.length} rows (contract says ${CAP})\n` +
      `    LIMIT only in a trailing -- comment -> ${cmtCap.records.length} rows (contract says ${CAP});\n` +
      `    there the appended clause is swallowed by the comment.`,
  );

  await closeDatabase();
}

run()
  .catch((e) => {
    console.error("UNEXPECTED ERROR:", e);
    fail++;
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    console.log(`${"=".repeat(60)}\n`);
    process.exit(fail > 0 ? 1 : 0);
  });

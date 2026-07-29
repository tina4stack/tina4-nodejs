/**
 * Firebird transaction rollback / commit lock-in tests (real Firebird, NO mocks).
 *
 * Regression guard for the silent rollback no-op: the adapter used to run every
 * statement on the auto-committing connection (`this.db`), so the transaction
 * created by startTransactionAsync() never saw a statement — rollbackAsync()
 * rolled back an EMPTY transaction and the already auto-committed write survived.
 * Twin of the PHP pdo_firebird bug fixed in 3.13.86. The fix routes statements
 * through the active transaction object while one is open (matching the Python
 * master's single-connection autocommit-suppression contract).
 *
 * This suite hits a REAL Firebird — it is env-gated on TINA4_TEST_FIREBIRD_URL
 * (a full firebird:// connection URL). Firebird is NOT a CI-provisioned service,
 * so when the URL is unset the suite SKIPs cleanly (the run-all service gate
 * excludes "firebird"). Point it at a live server and it RUNS.
 *
 *   TINA4_TEST_FIREBIRD_URL=firebird://SYSDBA:masterkey@localhost:3053/var/lib/firebird/data/test.fdb \
 *     npx tsx test/firebirdRollback.test.ts
 *
 * Cases:
 *   - read-after-write inside a txn sees the uncommitted row (contract intact)
 *   - ROLLBACK undoes the insert -> row GONE          (negative — FAILS on old code)
 *   - COMMIT persists the insert  -> row PRESENT       (positive)
 *   - a standalone insert (no txn) auto-commits        (positive — fix didn't break it)
 */
import { FirebirdAdapter } from "../packages/orm/src/index.ts";
import { createConnection } from "node:net";
import { createRequire } from "node:module";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string): void {
  // Reason MUST mention "firebird" so the run-all service gate treats this as a
  // non-provisioned (green) skip rather than a hard failure.
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${reason}`);
  skipped++;
}

console.log("=== Firebird Rollback / Commit Tests ===\n");

const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL;

function parseHostPort(url: string): { host: string; port: number } {
  // firebird://[user:pass@]host[:port]/path
  const m = url.match(/firebird:\/\/(?:[^@]+@)?([^:/]+)(?::(\d+))?\//);
  return { host: m?.[1] ?? "localhost", port: m?.[2] ? parseInt(m[2], 10) : 3050 };
}

function nodeFirebirdInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve("node-firebird");
    return true;
  } catch {
    return false;
  }
}

async function firebirdReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1000 });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const CASES = [
  "read-after-write inside txn sees the row",
  "ROLLBACK undoes the insert (row gone)",
  "COMMIT persists the insert (row present)",
  "standalone insert auto-commits (no txn)",
  "updateAsync changes the row (identifier folding)",
  "deleteAsync removes the row (identifier folding)",
];

async function main(): Promise<void> {
  if (!FIREBIRD_URL) {
    for (const c of CASES) skip(c, "TINA4_TEST_FIREBIRD_URL not set (firebird)");
    return summarise();
  }

  const { host, port } = parseHostPort(FIREBIRD_URL);
  if (!nodeFirebirdInstalled()) {
    for (const c of CASES) skip(c, "node-firebird package not installed (firebird)");
    return summarise();
  }
  if (!(await firebirdReachable(host, port))) {
    for (const c of CASES) skip(c, `firebird not reachable at ${host}:${port}`);
    return summarise();
  }

  const db = new FirebirdAdapter(FIREBIRD_URL);
  const TABLE = "RB_LOCKIN";

  // node-firebird can throw uncaught wire errors that escape promise wrappers;
  // guard so a driver/server hiccup skips rather than tearing down the process.
  let settled = false;
  const onUncaught = (err: Error) => {
    if (settled) return;
    settled = true;
    for (const c of CASES) skip(c, `firebird wire error: ${err.message}`);
  };
  process.on("uncaughtException", onUncaught);

  // Identifiers are UNQUOTED throughout, which is the conventional shape a Tina4
  // model produces: Firebird folds them to uppercase, so the stored names are
  // RB_LOCKIN/ID/NAME and fbQuote's upper-casing matches. Creating the table with
  // lowercase-QUOTED columns instead (as this test used to) makes "id" a distinct
  // case-sensitive column that no adapter write can ever address.
  const countByName = async (name: string): Promise<number> => {
    const rows = await db.queryAsync<Record<string, unknown>>(
      `SELECT COUNT(*) AS C FROM ${TABLE} WHERE name = ?`, [name],
    );
    const r = rows[0] as Record<string, unknown>;
    return Number(r["C"] ?? r["c"]);
  };

  try {
    await db.connect();
    try { await db.executeAsync(`DROP TABLE ${TABLE}`); } catch { /* first run */ }
    await db.executeAsync(
      `CREATE TABLE ${TABLE} (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(64))`,
    );

    // --- NEGATIVE: rollback must undo the insert (fails on the old code) ---
    await db.startTransactionAsync();
    await db.insertAsync(TABLE, { id: 1, name: "ROLLBACK_ME" });
    const seenInTxn = await countByName("ROLLBACK_ME");
    assert(CASES[0], seenInTxn === 1, `expected 1 inside txn, got ${seenInTxn}`);
    await db.rollbackAsync();
    const afterRollback = await countByName("ROLLBACK_ME");
    // Requires the row to have EXISTED first. Asserting only "gone afterwards"
    // passes vacuously when the insert never landed at all — which is exactly how
    // a wholly broken write path reported a green rollback test.
    assert(
      CASES[1], seenInTxn === 1 && afterRollback === 0,
      `expected present-then-absent, got ${seenInTxn} in txn and ${afterRollback} after rollback`
        + (seenInTxn !== 1 ? " (VACUOUS: the insert never landed)" : " (row SURVIVED — rollback was a no-op)"),
    );

    // --- POSITIVE: commit must persist the insert ---
    await db.startTransactionAsync();
    await db.insertAsync(TABLE, { id: 2, name: "COMMIT_ME" });
    await db.commitAsync();
    const afterCommit = await countByName("COMMIT_ME");
    assert(CASES[2], afterCommit === 1, `expected 1 after commit, got ${afterCommit}`);

    // --- POSITIVE: standalone write (no txn) still auto-commits ---
    await db.insertAsync(TABLE, { id: 3, name: "STANDALONE" });
    const standalone = await countByName("STANDALONE");
    assert(CASES[3], standalone === 1, `expected 1 for standalone insert, got ${standalone}`);

    // --- POSITIVE: update/delete must address the same folded identifiers as insert.
    // These hand-rolled `"${k}"` instead of fbQuote(k), so they emitted lowercase-
    // quoted "id"/"name" and could not touch a single row on a conventional table.
    await db.updateAsync(TABLE, { name: "RENAMED" }, { id: 3 });
    const renamed = await countByName("RENAMED");
    assert(CASES[4], renamed === 1, `expected 1 renamed row, got ${renamed}`);

    await db.deleteAsync(TABLE, { id: 3 });
    const afterDelete = await countByName("RENAMED");
    assert(CASES[5], afterDelete === 0, `expected 0 after delete, got ${afterDelete}`);

    try { await db.executeAsync(`DROP TABLE ${TABLE}`); } catch { /* ignore */ }
  } catch (e) {
    if (!settled) {
      assert(CASES[1], false, `unexpected error: ${(e as Error).message}`);
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
    process.removeListener("uncaughtException", onUncaught);
  }

  summarise();
}

function summarise(): void {
  console.log(`\n${"=".repeat(50)}`);
  console.log(
    `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`,
  );
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();

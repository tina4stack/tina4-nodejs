/**
 * ONE worker in the concurrent first-use race driven by
 * test/sessionDatabaseEngines.test.ts (case 4).
 *
 * A separate PROCESS on purpose: the property under test is what happens when
 * several processes of one app use the database session backend for the first
 * time at the same instant. Nothing here is a double - the real handler, the
 * real driver behind the sync bridge, the real engine.
 *
 * The handler resolves TINA4_DATABASE_URL (+ _USERNAME / _PASSWORD) itself, the
 * way an app does. It opens its connection BEFORE the barrier (the race is in
 * ensureTable, not in connection setup) and then spins to a shared instant.
 *
 * argv[2] number  the instant every worker starts at (seconds since the epoch)
 * argv[3] string  the session id this worker writes
 *
 * T4_RACE_HOLD_NAMED_LOCK (MySQL only): hold a GET_LOCK across the first use.
 *
 * Exit codes: 0 success, 1 the first use failed, 2 could not connect.
 */
import { DatabaseSessionHandler } from "../../packages/core/src/sessionHandlers/databaseHandler.js";
import { sqlCommandSync } from "../../packages/core/src/sessionHandlers/sqlClient.js";
import type { SqlTarget } from "../../packages/core/src/sessionHandlers/sqlClient.js";

const startAt = Number(process.argv[2]);
const sessionId = process.argv[3];

let handler: DatabaseSessionHandler;
try {
  handler = new DatabaseSessionHandler();
  const target = (handler as unknown as { target: SqlTarget | null }).target;
  if (target !== null) {
    // Open the bridge connection now, so connection setup is not in the race.
    // (Firebird has no FROM-less SELECT, so it asks its one-row system table.)
    sqlCommandSync(target, target.engine === "firebird" ? "SELECT 1 AS ready FROM RDB$DATABASE" : "SELECT 1 AS ready", []);
    // MySQL backs the loser of the metadata-lock deadlock inside CREATE TABLE
    // off silently ONLY when the session holds no other metadata lock. Holding a
    // named lock (the way apps serialise work) on the SAME connection takes that
    // away, so the loser gets 1213 "Deadlock found" every time, not by luck.
    if (process.env.T4_RACE_HOLD_NAMED_LOCK) {
      sqlCommandSync(target, "SELECT GET_LOCK(?, 0) AS held", [`tina4-race-${sessionId}`]);
    }
  }
} catch (error) {
  process.stderr.write(`connect: ${String((error as Error).message)}`);
  process.exit(2);
}

while (Date.now() / 1000 < startAt) { /* spin to the barrier */ }

try {
  // write() runs ensureTable() on its way in - this IS the first use.
  handler.write(sessionId, { worker: sessionId }, 60);
} catch (error) {
  process.stderr.write(String((error as Error).message));
  process.exit(1);
}
process.exit(0);

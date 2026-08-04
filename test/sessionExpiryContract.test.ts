/**
 * Session expiry contract — regression gates for the session-backend defect
 * batch measured on v3 (2026-08-01).
 * Run with: npx tsx test/sessionExpiryContract.test.ts
 *
 * THE CONTRACT, settled against real mainstream implementations rather than
 * internal precedent. PHP's own native files handler, express-session 1.19.0,
 * Django 6.0.7 (file and db), Laravel illuminate/session 13.23.0, connect-redis
 * 10.0.0 and connect-mongo 6.0.0 were each measured with real runs. ZERO of the
 * seven delete a record that carries no expiry: six return it, and Django's db
 * backend declines to load it but still keeps it. connect-mongo whitelists the
 * case deliberately with `$or: [{expires: {$exists: false}}, {expires: {$gt: now}}]`.
 *
 *   1. An ABSENT or ZERO expiry stamp means "never expires". It is guarded OUT of
 *      the comparison, never fed INTO it, and the record is returned and kept.
 *   2. A stamp genuinely PRESENT and in the PAST still expires the record, and
 *      the record is still reaped. THE DANGEROUS FIX IS THE OBVIOUS ONE — making
 *      a round-trip pass by weakening expiry turns data loss into a
 *      sessions-never-expire security bug. Every positive gate here is paired
 *      with a negative control.
 *   3. The ttl is consumed at WRITE time; nothing at read time needs it.
 *   4. A backend NEVER silently demotes to local disk.
 *
 * NO MOCKS. Real temp directories, a real SQLite engine, and a real MongoDB.
 * Every "did the record survive?" assertion is made OUT OF BAND — a directory
 * listing, a separate `node:sqlite` connection, a separate Mongo find — never
 * through the code under test.
 *
 * A missing service SKIPS LOUDLY naming host and port, unless
 * TINA4_REQUIRE_SERVICES is set — then it is a FAILURE, because a suite that
 * silently skips its only real verification is not verification.
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionHandler } from "../packages/core/src/session.ts";
import { DatabaseSessionHandler } from "../packages/core/src/sessionHandlers/databaseHandler.ts";
import { MongoSessionHandler } from "../packages/core/src/sessionHandlers/mongoHandler.ts";

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

function skipLoudly(name: string, reason: string): void {
  if (process.env.TINA4_REQUIRE_SERVICES) {
    assert(name, false, `TINA4_REQUIRE_SERVICES is set but ${reason}`);
    return;
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${reason}`);
  skipped++;
}

/** Real blocking sleep — wall clock, no clock mocking. */
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const MONGO_HOST = process.env.TINA4_TEST_MONGO_HOST ?? "127.0.0.1";
const MONGO_PORT = Number(process.env.TINA4_TEST_MONGO_PORT ?? 27017);

async function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

const workDir = mkdtempSync(join(tmpdir(), "tina4-sess-contract-"));
/** Out-of-band existence check — a directory listing, not the code under test. */
const storedFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

/**
 * On-disk path of a session record, mirroring `FileSessionHandler.filePath()`.
 *
 * ADR-0021 made the session id OPAQUE: the file is named for the SHA-256 hex
 * digest of the id, never the id itself (a `tina4_session=../../OUTSIDE/
 * appconfig` cookie used to steer the path right out of the session directory).
 *
 * These gates seed and inspect records BEHIND the handler, so they have to name
 * the file the handler will actually open. Seeding `naked.json` for the id
 * `naked` plants a record no read can ever find, and — worse — globbing the
 * directory for `naked.json` is VACUOUS: it can never match whether or not the
 * code works. The assertions therefore follow the derivation instead of pinning
 * the pre-ADR-0021 raw-id filename.
 */
const sessionFile = (dir: string, id: string): string =>
  join(dir, `${createHash("sha256").update(id).digest("hex")}.json`);

console.log("\n── File backend: an absent or zero stamp means never expires ──\n");
{
  const dir = join(workDir, "file-absent");
  mkdirSync(dir, { recursive: true });
  const handler = new FileSessionHandler(dir);

  // A record carrying NO expiry stamp at all — exactly what a legacy version,
  // another framework, or a direct write produces.
  writeFileSync(sessionFile(dir, "naked"), JSON.stringify({ _data: { seeded: true } }), "utf-8");
  const naked = handler.read("naked");
  assert(
    "session_missing_expiry_stamp_survives_read",
    JSON.stringify(naked) === JSON.stringify({ seeded: true }) && existsSync(sessionFile(dir, "naked")),
    `returned=${JSON.stringify(naked)} files=${storedFiles(dir).join(",")}`,
  );

  writeFileSync(sessionFile(dir, "zeroed"), JSON.stringify({ _data: { seeded: true }, _expires: 0 }), "utf-8");
  const zeroed = handler.read("zeroed");
  assert(
    "session_zero_expiry_stamp_survives_read",
    JSON.stringify(zeroed) === JSON.stringify({ seeded: true }) && existsSync(sessionFile(dir, "zeroed")),
    `returned=${JSON.stringify(zeroed)}`,
  );

  // A legacy BARE payload (no envelope at all) must still be readable.
  writeFileSync(sessionFile(dir, "legacy"), JSON.stringify({ seeded: true }), "utf-8");
  assert(
    "session_legacy_unwrapped_payload_survives_read",
    JSON.stringify(handler.read("legacy")) === JSON.stringify({ seeded: true })
      && existsSync(sessionFile(dir, "legacy")),
  );
}

console.log("\n── File backend: the NEGATIVE control, genuine expiry still reaps ──\n");
{
  const dir = join(workDir, "file-expiry");
  mkdirSync(dir, { recursive: true });
  const handler = new FileSessionHandler(dir);

  // A stamp genuinely in the past.
  writeFileSync(
    sessionFile(dir, "stale"),
    JSON.stringify({ _data: { seeded: true }, _expires: Math.floor(Date.now() / 1000) - 99999 }),
    "utf-8",
  );
  const stale = handler.read("stale");
  assert(
    "session_past_expiry_stamp_is_reaped",
    stale === null && !existsSync(sessionFile(dir, "stale")),
    `returned=${JSON.stringify(stale)} files=${storedFiles(dir).join(",")}`,
  );

  // Real wall-clock expiry, no clock mocking.
  handler.write("expiring", { seeded: true } as never, 1);
  const writtenOk = existsSync(sessionFile(dir, "expiring"));
  sleep(2200);
  const expired = handler.read("expiring");
  assert(
    "session_genuinely_expired_record_is_reaped",
    writtenOk && expired === null && !existsSync(sessionFile(dir, "expiring")),
    `written=${writtenOk} returned=${JSON.stringify(expired)}`,
  );
}

console.log("\n── File backend: the boundary sweep, every stamp state on one path ──\n");
{
  const dir = join(workDir, "file-sweep");
  mkdirSync(dir, { recursive: true });
  const handler = new FileSessionHandler(dir);
  const now = Math.floor(Date.now() / 1000);
  const cases: Array<[string, unknown, boolean]> = [
    ["absent", { _data: { v: 1 } }, true],
    ["zero", { _data: { v: 1 }, _expires: 0 }, true],
    ["future", { _data: { v: 1 }, _expires: now + 3600 }, true],
    ["past", { _data: { v: 1 }, _expires: now - 3600 }, false],
    ["legacy", { v: 1 }, true],
  ];
  for (const [name, payload] of cases) {
    writeFileSync(sessionFile(dir, name), JSON.stringify(payload), "utf-8");
  }
  let sweepOk = true;
  const detail: string[] = [];
  for (const [name, , shouldSurvive] of cases) {
    const returned = handler.read(name);
    const survived = existsSync(sessionFile(dir, name));
    const returnedPayload = JSON.stringify(returned) === JSON.stringify({ v: 1 });
    if (survived !== shouldSurvive || returnedPayload !== shouldSurvive) sweepOk = false;
    detail.push(`${name}:survived=${survived},payload=${returnedPayload},expected=${shouldSurvive}`);
  }
  assert("session_boundary_sweep", sweepOk, detail.join(" "));
}

console.log("\n── The database backend never silently demotes to a local SQLite file ──\n");
{
  // The defect: resolveDbPath() only stripped a sqlite:// prefix and otherwise
  // returned the literal "data/tina4_sessions.db", so a postgres URL round-tripped
  // happily while writing SQLite files into the process cwd. Every instance then
  // had its own private session store.
  const cwd = mkdtempSync(join(tmpdir(), "tina4-demote-"));
  const originalCwd = process.cwd();
  const originalUrl = process.env.TINA4_DATABASE_URL;
  process.chdir(cwd);
  mkdirSync(join(cwd, "data"), { recursive: true }); // Tina4 auto-creates data/ on startup

  // UPDATED 2026-08-04. These two assertions used to pin a THROW on any
  // non-sqlite URL. That throw was a LIMITATION, not the contract: the backend
  // is now multi-engine (ADR-0028), so postgres is HONOURED rather than
  // refused. The defect they were really protecting against - a silent demotion
  // to a local SQLite file in the process cwd - is unchanged and is still
  // asserted here, because that is the failure that looks exactly like success.
  // `message` is still read by the sqlite/default assertions further down; the
  // rewrite above replaced the declaration those were relying on.
  let message = "";
  let postgresWorked = false;
  let postgresError = "";
  process.env.TINA4_DATABASE_URL = "postgres://tina4:tina4@127.0.0.1:55432/tina4_node";
  try {
    const pgHandler = new DatabaseSessionHandler();
    pgHandler.write("demote-probe", { seeded: true }, 60);
    postgresWorked = JSON.stringify(pgHandler.read("demote-probe")) === JSON.stringify({ seeded: true });
    pgHandler.destroy("demote-probe");
  } catch (err) {
    postgresError = (err as Error).message;
  }
  const leaked = existsSync(join(cwd, "data", "tina4_sessions.db"));
  assert(
    "session_backend_never_silently_demotes_to_sqlite",
    postgresWorked && !leaked,
    `postgresWorked=${postgresWorked} leakedSqliteFile=${leaked} error=${postgresError}`,
  );

  // The loud-refusal half survives, aimed at what is genuinely unsupported
  // rather than at postgres. An unknown scheme must still name itself and the
  // supported set instead of quietly writing to disk.
  let unknownThrew = false;
  let unknownMessage = "";
  process.env.TINA4_DATABASE_URL = "notareal://user:pass@127.0.0.1:1234/db";
  try {
    new DatabaseSessionHandler();
  } catch (err) {
    unknownThrew = true;
    unknownMessage = (err as Error).message;
  }
  assert(
    "session_demotion_error_names_the_offending_scheme",
    unknownThrew && unknownMessage.includes("notareal") && !existsSync(join(cwd, "data", "tina4_sessions.db")),
    `threw=${unknownThrew} message=${unknownMessage}`,
  );

  // A genuine sqlite:// URL still works — the guard must not break the supported case.
  process.env.TINA4_DATABASE_URL = `sqlite://${join(cwd, "data", "ok.db")}`;
  let sqliteOk = false;
  try {
    const handler = new DatabaseSessionHandler();
    handler.write("sid", { seeded: true } as never, 3600);
    sqliteOk = JSON.stringify(handler.read("sid")) === JSON.stringify({ seeded: true });
  } catch (err) {
    message = (err as Error).message;
  }
  assert("session_sqlite_url_still_resolves", sqliteOk, `message=${message}`);

  // Unset URL keeps the documented default — the guard must not break that either.
  delete process.env.TINA4_DATABASE_URL;
  let defaultOk = false;
  try {
    const handler = new DatabaseSessionHandler();
    handler.write("sid2", { seeded: true } as never, 3600);
    defaultOk = JSON.stringify(handler.read("sid2")) === JSON.stringify({ seeded: true });
  } catch (err) {
    message = (err as Error).message;
  }
  assert("session_unset_database_url_uses_the_default_path", defaultOk, `message=${message}`);

  process.chdir(originalCwd);
  if (originalUrl === undefined) delete process.env.TINA4_DATABASE_URL;
  else process.env.TINA4_DATABASE_URL = originalUrl;
  rmSync(cwd, { recursive: true, force: true });
}

console.log("\n── The database backend: unstamped row kept, expired row reaped (real SQLite) ──\n");
{
  const dbFile = join(workDir, "sessions.db");
  const handler = new DatabaseSessionHandler({ dbPath: dbFile });
  handler.write("seed", { seeded: true } as never, 3600); // creates the table

  // OUT OF BAND — a SEPARATE connection, not the handler.
  const probe = new DatabaseSync(dbFile);
  probe
    .prepare("INSERT INTO tina4_session (session_id, data, expires_at) VALUES (?, ?, 0)")
    .run("unstamped", JSON.stringify({ seeded: true }));
  const unstampedRead = handler.read("unstamped");
  const unstampedRows = (probe
    .prepare("SELECT count(*) AS c FROM tina4_session WHERE session_id = ?")
    .get("unstamped") as { c: number }).c;
  assert(
    "session_unstamped_database_row_survives_read",
    JSON.stringify(unstampedRead) === JSON.stringify({ seeded: true }) && unstampedRows === 1,
    `returned=${JSON.stringify(unstampedRead)} rows=${unstampedRows}`,
  );

  probe
    .prepare("INSERT INTO tina4_session (session_id, data, expires_at) VALUES (?, ?, 1)")
    .run("expired", JSON.stringify({ seeded: true }));
  const expiredRead = handler.read("expired");
  const expiredRows = (probe
    .prepare("SELECT count(*) AS c FROM tina4_session WHERE session_id = ?")
    .get("expired") as { c: number }).c;
  assert(
    "session_expired_database_row_is_reaped",
    expiredRead === null && expiredRows === 0,
    `returned=${JSON.stringify(expiredRead)} rows=${expiredRows}`,
  );
  probe.close();
}

console.log("\n── MongoDB: sessions must actually expire (real MongoDB) ──\n");
if (!(await reachable(MONGO_HOST, MONGO_PORT))) {
  skipLoudly("session_mongo_expiry_gates", `MongoDB is not reachable at ${MONGO_HOST}:${MONGO_PORT}`);
} else {
  const config = {
    uri: `mongodb://${MONGO_HOST}:${MONGO_PORT}`,
    database: "tina4_test",
    collection: "node_session_contract",
  };
  const handler = new MongoSessionHandler(config);

  // THE HEADLINE DEFECT: write() took the ttl as `_ttl` and discarded it, read()
  // consulted nothing, and no TTL index existed — so a mongodb session never
  // expired at all. Measured before the fix: write ttl=1, sleep 3s, read still
  // returned the data while every other backend returned null.
  // ttl=2, not 1. write() stamps `Math.floor(Date.now() / 1000) + ttl`, so a ttl
  // of 1 gives an effective lifetime anywhere in (0, 1] seconds: a write at
  // X.999 expires at X+1, and an "immediate" read 2ms later has already crossed
  // the boundary and correctly reports null. That made this gate itself flaky —
  // reproduced 2 failures in 6 back-to-back runs, `before=null after=null`. A
  // 2-second ttl puts the immediate read comfortably inside the window, so the
  // gate measures expiry rather than second-boundary truncation.
  handler.write("ttl1", { seeded: true } as never, 2);
  const beforeSleep = handler.read("ttl1");
  sleep(4000);
  const afterSleep = handler.read("ttl1");
  assert(
    "session_mongo_write_ttl_argument_is_honoured",
    JSON.stringify(beforeSleep) === JSON.stringify({ seeded: true }) && afterSleep === null,
    `before=${JSON.stringify(beforeSleep)} after=${JSON.stringify(afterSleep)}`,
  );

  // POSITIVE: a long ttl is NOT expired — proving the gate above is expiry, not
  // a blanket failure to read.
  handler.write("longttl", { seeded: true } as never, 3600);
  assert(
    "session_mongo_unexpired_session_is_returned",
    JSON.stringify(handler.read("longttl")) === JSON.stringify({ seeded: true }),
  );
  handler.destroy("longttl");

  // A ttl of 0 means never expires.
  handler.write("immortal", { seeded: true } as never, 0);
  sleep(1200);
  assert(
    "session_mongo_zero_ttl_never_expires",
    JSON.stringify(handler.read("immortal")) === JSON.stringify({ seeded: true }),
  );
  handler.destroy("immortal");

  // A miss is still a miss, not an error.
  assert("session_mongo_miss_still_returns_null", handler.read("no-such-session") === null);
}

rmSync(workDir, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`
  + (skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : ""),
);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

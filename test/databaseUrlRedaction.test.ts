/**
 * A database password must never reach a log, an exception, or a dump.
 *
 * Five measured defects, all verified on this code before the fix (Node 24.9.0,
 * macOS 15 / darwin 25.5.0):
 *
 *   C2  a malformed TINA4_DATABASE_URL wrote the password into the exception
 *       DatabaseUrl: invalid URL format 'postgres://user:SuperSecret123@host:notaport/db'
 *   C3  the redaction helper had ZERO call sites on any real path - its own
 *       docblock called it "the ONLY form allowed in a log line"
 *   C5  toSafeString() returned the ODBC connection string VERBATIM, PWD= and all
 *   C6  JSON.stringify(url) emitted "password":"<the real password>"
 *   C7  postgres://user:@host/db parsed to null, so the TINA4_DATABASE_PASSWORD
 *       fallback fired and the app authenticated with a DIFFERENT password than
 *       the .env asked for
 *
 * Every case has BOTH halves. The negative half asserts the secret is ABSENT;
 * the positive half asserts the message/dump still says enough to DIAGNOSE the
 * fault - scheme, host, driver, database. A redaction that blanks everything
 * would pass a naive "secret not present" test and be useless in an outage.
 *
 * The sentinel contains a SPACE deliberately. A redaction that stops at the
 * first whitespace (the shape of the tina4-php PostgresAdapter bug, where a
 * `\bpassword=\S` + star pattern left the tail in the log) leaks " word" and
 * every negative half here goes red.
 *
 * NO MOCKS: pure parsing plus one real PostgreSQL round trip.
 *
 * Run with: npx tsx test/databaseUrlRedaction.test.ts
 *
 * Identical case names in all four frameworks:
 *   tina4-python/tests/test_database_url_redaction.py
 *   tina4-php/tests/DatabaseUrlRedactionTest.php
 *   tina4-ruby/spec/database_url_redaction_spec.rb
 */
import { inspect } from "node:util";
import { DatabaseUrl, redactCredentials } from "../packages/orm/src/databaseUrl.ts";
import { initDatabase } from "../packages/orm/src/database.ts";

/**
 * Contains a SPACE on purpose - see the header.
 *
 * The tail is `w0rd7`, not `word`: a redacted message legitimately contains the
 * literal string "password" (in `password=***`, in the expected-shape hint, in
 * PostgreSQL's own "password authentication failed"), so a `word` tail makes
 * every negative half a false positive. The tail must be a token that can only
 * have come FROM the sentinel.
 */
const SENTINEL = "s3ntinel-Pa55 w0rd7";
/** The half a whitespace-terminated redaction leaves behind. */
const SENTINEL_TAIL = SENTINEL.split(" ")[1];

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

/** Both halves of a redaction claim, in one place so neither can be forgotten. */
function assertRedacted(name: string, produced: string, mustContain: string[]): void {
  assert(`${name} [negative: the password is absent]`,
    !produced.includes(SENTINEL) && !produced.includes(SENTINEL_TAIL),
    `LEAKED into: ${produced}`);
  const missing = mustContain.filter((needle) => !produced.includes(needle));
  assert(`${name} [positive: still diagnosable]`,
    missing.length === 0,
    `missing ${JSON.stringify(missing)} from: ${produced}`);
}

console.log("=== DatabaseUrl credential redaction ===\n");

// ---------------------------------------------------------------------------
// C2 - a malformed URL never reaches the exception message
// ---------------------------------------------------------------------------
console.log("--- a_malformed_database_url_never_reaches_the_exception_message ---");

function messageFor(url: string): string {
  try {
    new DatabaseUrl(url);
    return "<no exception raised>";
  } catch (err: any) {
    return String(err.message);
  }
}

// The parser has three distinct throw sites and the password reached ALL of
// them: the URL-class path (postgres/mysql/mongodb) and the two regex paths.
assertRedacted(
  "postgres url with a bad port",
  messageFor(`postgres://user:${SENTINEL}@db.internal:notaport/mydb`),
  ["DatabaseUrl", "postgres", "db.internal:notaport"],
);
assertRedacted(
  "mssql url the regex form rejects",
  messageFor(`mssql://sa:${SENTINEL}@`),
  ["DatabaseUrl", "mssql"],
);
assertRedacted(
  "firebird url the regex form rejects",
  messageFor(`firebird://sysdba:${SENTINEL}@`),
  ["DatabaseUrl", "firebird"],
);
// The worst shape: a string with no URL structure at all, so there is nothing
// to key a redaction off. The ONLY safe answer is not to echo the input - which
// is why this message names the failure, never the value.
assertRedacted(
  "a string with no scheme at all",
  messageFor(`notaurl-with-${SENTINEL}`),
  ["DatabaseUrl", "no scheme"],
);

// ---------------------------------------------------------------------------
// C5 - the ODBC connection string is redacted, not echoed
// ---------------------------------------------------------------------------
console.log("\n--- to_safe_string_never_contains_the_password_for_odbc ---");

const odbcUrl = new DatabaseUrl(
  `odbc:///DRIVER={PostgreSQL};SERVER=db.internal;DATABASE=tina4;UID=tina4;PWD=${SENTINEL}`
);
assertRedacted(
  "odbc toSafeString",
  odbcUrl.toSafeString(),
  ["DRIVER={PostgreSQL}", "SERVER=db.internal", "DATABASE=tina4", "UID=tina4", "PWD=***"],
);

// ---------------------------------------------------------------------------
// C3 - the real paths go through the ONE primitive, not a private copy
// ---------------------------------------------------------------------------
console.log("\n--- the_redaction_primitive_is_the_one_on_the_real_paths ---");

// If toSafeString ever grows its own second rule, these diverge and this fails.
assert("odbc toSafeString is redactCredentials applied to the DSN",
  odbcUrl.toSafeString() === `odbc:///${redactCredentials(odbcUrl.connectionString ?? "")}`,
  odbcUrl.toSafeString());

// The C1/C4 bug shape, pinned on the primitive itself: a value ends at the
// FIELD SEPARATOR, never at a space. `\S`-style redaction leaves the tail.
assertRedacted(
  "redactCredentials stops at the field separator not the first space",
  redactCredentials(`DRIVER={PostgreSQL};PWD=${SENTINEL};DATABASE=tina4`),
  ["DRIVER={PostgreSQL}", "PWD=***", "DATABASE=tina4"],
);
// A brace-quoted value legally contains the separator itself.
assertRedacted(
  "redactCredentials consumes a brace quoted value whole",
  redactCredentials(`UID=tina4;PWD={${SENTINEL};still-secret};DATABASE=tina4`),
  ["UID=tina4", "PWD=***", "DATABASE=tina4"],
);
assert("redactCredentials leaves a secret-free string untouched",
  redactCredentials("DRIVER={PostgreSQL};SERVER=h;DATABASE=d") ===
    "DRIVER={PostgreSQL};SERVER=h;DATABASE=d");
// A driver query string is the other place a password travels as a keyword.
assertRedacted(
  "redactCredentials redacts a query string password",
  redactCredentials(`postgres://h:5432/db?sslmode=require&password=${SENTINEL}`),
  ["postgres://h:5432/db", "sslmode=require", "password=***"],
);

// ---------------------------------------------------------------------------
// C6 - a dump never contains the password
// ---------------------------------------------------------------------------
console.log("\n--- a_dump_never_contains_the_password ---");

const pgUrl = new DatabaseUrl(
  `postgres://tina4:${encodeURIComponent(SENTINEL)}@db.internal:5432/tina4_py`
);
assert("the parsed password is the real one (the dump has something to hide)",
  pgUrl.password === SENTINEL, JSON.stringify(pgUrl.password));

assertRedacted(
  "JSON.stringify",
  JSON.stringify(pgUrl),
  [`"host":"db.internal"`, `"port":5432`, `"database":"tina4_py"`, `"username":"tina4"`, `"password":"***"`],
);
assertRedacted(
  "util.inspect",
  inspect(pgUrl),
  ["DatabaseUrl(", "db.internal:5432/tina4_py", "tina4:***"],
);
// The realistic leak is not the value alone - it is the value nested in the
// config object somebody logged.
assertRedacted(
  "JSON.stringify of an enclosing config object",
  JSON.stringify({ service: "api", db: pgUrl }),
  [`"service":"api"`, `"database":"tina4_py"`],
);
// An ODBC dump has to redact the connection string too, or C5 comes back
// through the JSON door.
assertRedacted(
  "JSON.stringify of an odbc url",
  JSON.stringify(odbcUrl),
  [`"engine":"odbc"`, "SERVER=db.internal", "PWD=***"],
);

// ---------------------------------------------------------------------------
// C7 - an empty password is explicitly empty, not absent
// ---------------------------------------------------------------------------
console.log("\n--- an_empty_password_is_explicitly_empty_not_absent ---");

const savedEnvPassword = process.env.TINA4_DATABASE_PASSWORD;
const savedEnvUrl = process.env.TINA4_DATABASE_URL;
try {
  process.env.TINA4_DATABASE_PASSWORD = SENTINEL;

  // POSITIVE: written-and-blank parses to the empty string, and because that is
  // not "absent" the separate-credential fallback must NOT overwrite it.
  process.env.TINA4_DATABASE_URL = "postgres://user:@db.internal:5432/mydb";
  const blank = DatabaseUrl.fromEnv();
  assert("a written but blank password parses to the empty string",
    blank!.password === "", JSON.stringify(blank!.password));
  assert("the env fallback does NOT fire for a blank password",
    blank!.password !== SENTINEL, "TINA4_DATABASE_PASSWORD overwrote a blank password");

  // NEGATIVE half of the same contract: if the fix had simply killed the
  // fallback, this would fail. An ABSENT password still takes the env value.
  process.env.TINA4_DATABASE_URL = "postgres://user@db.internal:5432/mydb";
  const absent = DatabaseUrl.fromEnv();
  assert("an absent password is still null before the fallback",
    new DatabaseUrl("postgres://user@db.internal:5432/mydb").password === null);
  assert("the env fallback DOES still fire for an absent password",
    absent!.password === SENTINEL, JSON.stringify(absent!.password));
} finally {
  if (savedEnvPassword === undefined) delete process.env.TINA4_DATABASE_PASSWORD;
  else process.env.TINA4_DATABASE_PASSWORD = savedEnvPassword;
  if (savedEnvUrl === undefined) delete process.env.TINA4_DATABASE_URL;
  else process.env.TINA4_DATABASE_URL = savedEnvUrl;
}

// ---------------------------------------------------------------------------
// The real driver: a live PostgreSQL connect failure must not echo the password
// ---------------------------------------------------------------------------
console.log("\n--- a_live_connect_failure_never_echoes_the_password ---");

const liveUrl = (process.env.TINA4_TEST_PG_URL || "").trim();
if (!liveUrl) {
  console.log("  SKIP a live connect failure never echoes the password (PostgreSQL not set: TINA4_TEST_PG_URL)");
} else {
  const tail = liveUrl.split("://")[1].split("@").pop();
  const user = (process.env.TINA4_TEST_PG_USERNAME || "tina4").trim();
  const realPassword = (process.env.TINA4_TEST_PG_PASSWORD || "tina4").trim();

  // POSITIVE: the good credentials really do connect, so the negative half
  // below is a genuine AUTH failure and not an unreachable host.
  try {
    const db = await initDatabase({ url: `postgres://${user}:${encodeURIComponent(realPassword)}@${tail}` });
    const row = await db.fetchOne<{ db: string }>("select current_database() as db");
    assert("the live database really is reachable with the real password",
      row !== null && typeof row.db === "string", JSON.stringify(row));
    db.close();
  } catch (err: any) {
    assert("the live database really is reachable with the real password", false,
      String(err.message).slice(0, 90));
  }

  // NEGATIVE: a wrong password containing a space must not survive into the
  // raised error - message, stack, or an own-property dump of it.
  try {
    const db = await initDatabase({ url: `postgres://${user}:${encodeURIComponent(SENTINEL)}@${tail}` });
    await db.fetchOne("select 1");
    db.close();
    assert("a wrong password is rejected by the live server", false, "the bad password connected");
  } catch (err: any) {
    const surfaces = [
      String(err?.message ?? ""),
      String(err?.stack ?? ""),
      JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})),
    ].join("\n");
    assertRedacted("live postgres connect failure", surfaces, ["password authentication failed"]);
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

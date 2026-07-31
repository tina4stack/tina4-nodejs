/**
 * A percent-encoded password in a DATABASE_URL must reach the driver DECODED.
 *
 * Node was already correct here - credentials come from DatabaseUrl, which
 * decodes. Python was the framework that did NOT (its adapters read
 * urlparse().password, which returns the RAW userinfo), and this file exists so
 * Node cannot ACQUIRE the bug in a later refactor.
 *
 * The failure mode is why it matters: the driver reports a plain "login
 * failed", nothing mentions the URL, the password looks right in the config,
 * and the same credentials work when passed as separate arguments.
 *
 * NO MOCKS: pure parsing, plus a live PostgreSQL round trip when one is set.
 *
 * Identical case names in all four frameworks:
 *   tina4-python/tests/test_database_url_credentials.py
 *   tina4-php/tests/DatabaseUrlCredentialsTest.php
 *   tina4-ruby/spec/database_url_credentials_spec.rb
 */
import { DatabaseUrl } from "../packages/orm/src/databaseUrl.ts";
import { initDatabase } from "../packages/orm/src/database.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

console.log("=== DatabaseUrl credentials ===\n");

assert("a percent encoded password is decoded",
  new DatabaseUrl("mssql://sa:TinaSQL123%21Secure@h:1433/db").password === "TinaSQL123!Secure");

// Exactly the characters that FORCE encoding in a URL - the only ones that can
// expose the bug. A password without them works either way.
{
  const u = new DatabaseUrl("postgres://us%3Aer:p%40ss%21w%3Ard%2Fx%23y@h:5432/db");
  assert("every reserved character survives a round trip",
    u.username === "us:er" && u.password === "p@ss!w:rd/x#y",
    `${u.username} / ${u.password}`);
}

assert("an unencoded password is unchanged",
  new DatabaseUrl("postgres://tina4:tina4@h:5432/db").password === "tina4");

// A real '%' encodes to '%25'. Decoding once yields '%'; twice would corrupt it.
assert("a literal percent in a password survives",
  new DatabaseUrl("postgres://u:100%25sure@h:5432/db").password === "100%sure");

// The end-to-end proof: '%61' decodes to 'a', so the encoded form spells the
// SAME password. It connects only if the credential path decodes.
const liveUrl = (process.env.TINA4_TEST_PG_URL || "").trim();
const rawPass = (process.env.TINA4_TEST_PG_PASSWORD || "tina4").trim();
if (!liveUrl || !rawPass.includes("a")) {
  console.log("  SKIP an encoded password connects to a live database (not configured)");
} else {
  const user = (process.env.TINA4_TEST_PG_USERNAME || "tina4").trim();
  const [scheme, rest] = liveUrl.split("://");
  const tail = rest.split("@").pop();
  const encoded = rawPass.replace("a", "%61");
  try {
    const db = await initDatabase({ url: `${scheme}://${user}:${encoded}@${tail}` });
    await db.tableExists("tina4_write_contract");
    assert("an encoded password connects to a live database", true);
    db.close();
  } catch (e) {
    assert("an encoded password connects to a live database", false, String(e).slice(0, 70));
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

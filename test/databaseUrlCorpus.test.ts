/**
 * The shared DATABASE_URL corpus (feature 5 of the feature audit).
 *
 * `test/fixtures/database_url_corpus.json` is byte-identical in all four
 * frameworks. One answer key, four suites: a case that passes here and fails in
 * Ruby is a parity bug with a name, not a difference somebody has to notice.
 *
 * Core Principle 6 says a connection string means literally the same thing in
 * every framework. Nothing could check that before this fixture, because two of
 * the four parse URLs inside the Database constructor and cannot be asked what a
 * URL means without opening a connection.
 *
 * Pure string-to-struct. No database, no socket, no driver import.
 *
 * Run with: npx tsx test/databaseUrlCorpus.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseUrl } from "../packages/orm/src/databaseUrl.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "fixtures", "database_url_corpus.json"), "utf-8")
);

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

console.log("=== DATABASE_URL corpus ===\n");

console.log("--- every case parses to the agreed struct ---");
for (const c of corpus.cases) {
  const url = new DatabaseUrl(c.url);
  const diffs: string[] = [];
  for (const field of ["engine", "host", "port", "database", "username", "password"]) {
    const got = (url as any)[field] ?? null;
    const want = c[field] ?? null;
    if (got !== want) diffs.push(`${field} got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
  assert(c.name, diffs.length === 0, diffs.join("; "));
}

// A connection URL in a log is a credential leak, so the redacted form is the
// only shape allowed in a log line or an error message. Node had NO such method
// before this row, so every call site that wanted to log a connection target had
// to redact it by hand.
console.log("\n--- toSafeString round-trips without the password ---");
for (const c of corpus.cases) {
  const safe = new DatabaseUrl(c.url).toSafeString();
  assert(`safe: ${c.name}`, safe === c.safe, `got ${safe} want ${c.safe}`);
  if (c.password !== null) {
    assert(`no leak: ${c.name}`, !safe.includes(c.password), `LEAKED into ${safe}`);
  }
}

console.log("\n--- an unparseable URL raises instead of guessing ---");
for (const c of corpus.errors) {
  let raised = false;
  try {
    new DatabaseUrl(c.url);
  } catch (err: any) {
    // A silent fallback to sqlite would be the dangerous outcome: the app boots,
    // writes to a local file, and nobody learns the real database was never hit.
    raised = String(err.message).includes("DatabaseUrl");
  }
  assert(c.name, raised);
}

console.log("\n--- aliases resolve once, at parse ---");
for (const [alias, canonical] of Object.entries(corpus.aliases)) {
  const sample = alias === "sqlite3" ? `${alias}:///app.db` : `${alias}://localhost/db`;
  const engine = new DatabaseUrl(sample).engine;
  assert(`${alias} -> ${canonical}`, engine === canonical, `got ${engine}`);
}

// The port is part of our contract, not the driver's business. Node used to leave
// it unset and let the third-party driver fill in its own default, so the parsed
// struct differed from PHP's while the connection still worked.
console.log("\n--- a URL without a port gets the engine default ---");
for (const [engine, port] of Object.entries(corpus.default_ports)) {
  if (engine === "firebird") continue; // firebird needs a path segment; covered above
  const url = new DatabaseUrl(`${engine}://localhost/db`);
  assert(`${engine} defaults to ${port}`, url.port === port, `got ${url.port}`);
}

// The D4 leak cannot come back: `engine` is a canonical name, never a class.
console.log("\n--- engine never holds an adapter class name ---");
const canonical = ["sqlite", "postgres", "mysql", "mssql", "firebird", "mongodb", "odbc"];
for (const c of corpus.cases) {
  const engine = new DatabaseUrl(c.url).engine;
  assert(`canonical engine: ${c.name}`, canonical.includes(engine), `got ${engine}`);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

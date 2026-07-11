/**
 * #160 — the Firebird adapter must honour a charset override.
 *
 * The adapter used to pass NO charset, deferring to the driver's implicit
 * default, which double-encodes UTF-8 bytes stored under a legacy `NONE`
 * database. The charset is now resolved from, in precedence order:
 *
 *   1. the connection URL query   firebird://host:port/path?charset=NONE
 *   2. an explicit charset on the FirebirdConfig object
 *   3. the TINA4_DATABASE_CHARSET environment variable
 *   4. the UTF8 default (parity with the Python master)
 *
 * These exercise the PURE resolver `resolveFirebirdCharset` and the identifier
 * normaliser `normalizeFirebirdDbIdentifier` directly. They open NO connection
 * (only parse a URL, an explicit charset, and an env var), so this is
 * pure-logic — NOT a mocked DB. The live double-encode fix is verified in the
 * PHP mirror where #160 was reported (real Firebird / node-firebird are not
 * available on this runner).
 *
 * Run with: npx tsx test/firebirdCharset.test.ts
 */
import { resolveFirebirdCharset, normalizeFirebirdDbIdentifier } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

// Isolate the env var — save/restore around each assertion group.
const savedEnv = process.env.TINA4_DATABASE_CHARSET;
function withEnv(value: string | undefined, fn: () => void): void {
  if (value === undefined) delete process.env.TINA4_DATABASE_CHARSET;
  else process.env.TINA4_DATABASE_CHARSET = value;
  try { fn(); } finally {
    if (savedEnv === undefined) delete process.env.TINA4_DATABASE_CHARSET;
    else process.env.TINA4_DATABASE_CHARSET = savedEnv;
  }
}

console.log("=== Firebird charset override (#160) ===\n");

// 4. Default is UTF8 (no env, no query, no explicit charset).
withEnv(undefined, () => {
  assert("default is UTF8",
    resolveFirebirdCharset("firebird://localhost:3050/employee") === "UTF8");
});

// 1. URL query charset wins.
withEnv(undefined, () => {
  assert("URL ?charset= wins",
    resolveFirebirdCharset("firebird://localhost:3050/employee?charset=NONE") === "NONE");
});

// 1 > 3: URL query overrides the env var.
withEnv("WIN1252", () => {
  assert("URL ?charset= overrides env",
    resolveFirebirdCharset("firebird://localhost:3050/employee?charset=NONE") === "NONE");
});

// 3. Env var used when no URL param and no explicit charset.
withEnv("ISO8859_1", () => {
  assert("env used when no URL param",
    resolveFirebirdCharset("firebird://localhost:3050/employee") === "ISO8859_1");
});

// 2. Explicit charset (FirebirdConfig.charset) beats env/default, yields to URL.
withEnv(undefined, () => {
  assert("explicit charset used when no URL param",
    resolveFirebirdCharset("", "WIN1251") === "WIN1251");
});

// 1 > 2: URL param beats explicit charset.
withEnv(undefined, () => {
  assert("URL param beats explicit charset",
    resolveFirebirdCharset("firebird://localhost:3050/employee?charset=NONE", "UTF8") === "NONE");
});

// The ?charset= query must NOT pollute the resolved DB identifier — the
// double-slash absolute-path form still resolves cleanly alongside it.
withEnv(undefined, () => {
  assert("charset query does not pollute the DB identifier",
    normalizeFirebirdDbIdentifier("//data/app.fdb?charset=NONE") === "/data/app.fdb",
    `got ${normalizeFirebirdDbIdentifier("//data/app.fdb?charset=NONE")}`);
  assert("charset still resolved from a URL with a double-slash absolute path",
    resolveFirebirdCharset("firebird://localhost:3050//data/app.fdb?charset=NONE") === "NONE");
  // An alias with a query also stays clean.
  assert("alias identifier is not polluted by a query",
    normalizeFirebirdDbIdentifier("/employee?charset=NONE") === "employee",
    `got ${normalizeFirebirdDbIdentifier("/employee?charset=NONE")}`);
});

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

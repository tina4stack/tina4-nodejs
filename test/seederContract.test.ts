/**
 * Seeder + fake-data cross-engine contract — feature 28 (seeder_contract.json),
 * parity with tina4-python/tests/test_seeder_contract.py.
 *
 * SEED-DEC-01 (OWNER-DECISIONS.md Batch 4, feature 028-seeder-fake-data.md):
 *   - SEED-PHP-BACKTICK is PHP-specific (Node's seedTable already routes
 *     every INSERT through adapterExecute() with double-quoted identifiers,
 *     which PostgreSQL/Firebird/MSSQL all accept — Node was never
 *     backtick-quoted). Node's part of this contract is the SAME
 *     engine-portability property PHP's fix targets, proven below on the
 *     real engines.
 *   - SEED-TABLE-SEED-INERT: seedTable's `opts.seed` was a silent no-op (it
 *     has no generators of its own — fieldMap callables are opaque).
 *     OWNER-DECISIONS.md ratified REMOVAL (same principle as the no-op
 *     ForeignKeyField on_delete): seedTable now THROWS if `opts.seed` is
 *     defined, and determinism is achieved by the caller building their own
 *     seeded FakeData and closing over it in fieldMap — exactly the pattern
 *     seedOrm/seedModels already use internally.
 *
 * SEED-DEC-02 (low, Node-specific): FakeData.forField() always returned a
 * field's declared default (a dead "sometimes" comment) so every seeded row
 * got an IDENTICAL value for a defaulted field — fixed to use the default
 * only PROBABILISTICALLY. SEED-DETERMINISM-PERLANG and SEED-SECRETS-DOC are
 * documented on the core FakeData class docblock. SEED-VOCAB-PARITY pins one
 * generator vocabulary (idiomatic spelling per language) present in all
 * four, gated below.
 *
 * seed_table_inserts_on_every_engine is the case that must run on all three
 * non-SQLite engines — the direct regression guard for engine portability.
 * The other cases are seeder-LOGIC properties (RNG determinism, FK
 * topo-order, failure counting) that are engine-agnostic once routed through
 * the already adapter-contract-proven insert()/BaseModel#save paths, so they
 * run on SQLite + PostgreSQL for a real-engine sanity check without
 * re-proving the adapter contracts a second time.
 *
 * Run with: npx tsx test/seederContract.test.ts
 */
import net from "node:net";
import {
  seedTable, seedOrm, seedModels, FakeData, BaseModel, bindDatabase, createAdapterFromUrl,
  adapterExecute, adapterFetch,
} from "../packages/orm/src/index.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";

// PostgreSQL/MSSQL/Firebird adapters require the ASYNC method (executeAsync/
// fetchAsync) -- calling the sync execute()/fetch() directly throws "Use
// executeAsync() ...". adapterExecute()/adapterFetch() (the same helpers
// seedTable()/seedOrm() use internally) dispatch to whichever the adapter
// actually has, so ONE code path below works for SQLite AND the three real
// engines without an if/else per call site.
async function rawExecute(db: any, sql: string): Promise<void> {
  await adapterExecute(db, sql);
}
async function rawFetch<T = Record<string, unknown>>(db: any, sql: string): Promise<T[]> {
  return adapterFetch<T>(db, sql);
}

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");
/** A provisioned service (PG/MySQL/MSSQL) that is missing is a hard FAILURE. */
function skip(msg: string): void {
  // "a run with skips is NOT verification" — under the gate a provisioned
  // service that is missing is a hard FAILURE, not a green skip.
  if (requireServices) {
    console.error(`  \x1b[31mSKIP-AS-FAIL\x1b[0m ${msg}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
}

/**
 * Firebird is NOT in the require-services gate (test/_serviceGate.ts's
 * EXCLUDED_KEYWORDS=["firebird"] -- the main CI job does not provision it, by
 * design, in favour of the dedicated `firebird:` job + the lab): an unset URL
 * stays a green skip here too, exactly like every other Firebird-gated
 * fixture in this suite (see ormFieldsContract.test.ts's skipGated). Before
 * this, skip() above made ANY missing service fatal under
 * TINA4_REQUIRE_SERVICES, including Firebird -- contradicting the exclusion
 * the rest of the framework already honours and failing the main job on a gap
 * it was never meant to cover.
 */
function skipGated(msg: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

// ── real-service coordinates (the canonical TINA4_TEST_* convention) ──────
const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";
const pgUrl = (): string => `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;

const MSSQL_HOST = process.env.TINA4_TEST_MSSQL_HOST ?? "127.0.0.1";
const MSSQL_PORT = parseInt(process.env.TINA4_TEST_MSSQL_PORT ?? "1433", 10);
const MSSQL_USER = process.env.TINA4_TEST_MSSQL_USERNAME ?? "sa";
const MSSQL_PASS = process.env.TINA4_TEST_MSSQL_PASSWORD ?? "TinaSQL123!Secure";
const MSSQL_DB = process.env.TINA4_TEST_MSSQL_DB ?? "tina4_test";
const mssqlUrl = (): string => `mssql://${MSSQL_USER}:${MSSQL_PASS}@${MSSQL_HOST}:${MSSQL_PORT}/${MSSQL_DB}`;

const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL;

async function dropAll(db: any, ...statements: string[]): Promise<void> {
  for (const sql of statements) {
    try { await rawExecute(db, sql); } catch { /* best effort */ }
  }
}

console.log("=== Seeder Contract Tests (feature 28) ===\n");

// ── seed_table_inserts_on_every_engine ─────────────────────────────────────
console.log("--- seed_table_inserts_on_every_engine ---");

async function seedTableRoundtrip(db: any, table: string, setup: string[], drop: string[]): Promise<void> {
  await dropAll(db, ...drop);
  try {
    for (const sql of setup) await rawExecute(db, sql);
    const fake = new FakeData(1);
    const summary = await seedTable(db, table, 5, {
      name: () => fake.name(),
      score: () => fake.integer(1, 100),
    });
    assert(`${table}: seeded 5`, summary.seeded === 5, `seeded=${summary.seeded} errors=${JSON.stringify(summary.errors)}`);
    assert(`${table}: 0 failed`, summary.failed === 0);
    const rows = await rawFetch(db, `SELECT name, score FROM ${table}`);
    assert(`${table}: 5 rows read back`, rows.length === 5);
    assert(
      `${table}: every row has a name and an in-range score`,
      rows.every((r: any) => r.name && Number(r.score) >= 1 && Number(r.score) <= 100),
    );
  } finally {
    await dropAll(db, ...drop);
    try { await db.close(); } catch { /* ignore */ }
  }
}

{
  const db = new SQLiteAdapter(":memory:");
  await seedTableRoundtrip(
    db, "contract_sqlite",
    ["CREATE TABLE contract_sqlite (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, score INTEGER)"],
    ["DROP TABLE contract_sqlite"],
  );
}

if (await tcpReachable(PG_HOST, PG_PORT)) {
  const db = await createAdapterFromUrl(pgUrl());
  await seedTableRoundtrip(
    db, "contract_pg",
    ["CREATE TABLE contract_pg (id SERIAL PRIMARY KEY, name VARCHAR(100), score INTEGER)"],
    ["DROP TABLE contract_pg"],
  );
} else {
  skip(`no reachable postgres at ${PG_HOST}:${PG_PORT} (set TINA4_TEST_PG_*)`);
}

if (await tcpReachable(MSSQL_HOST, MSSQL_PORT)) {
  const db = await createAdapterFromUrl(mssqlUrl());
  await seedTableRoundtrip(
    db, "contract_mssql",
    ["CREATE TABLE contract_mssql (id INTEGER IDENTITY(1,1) PRIMARY KEY, name VARCHAR(100), score INTEGER)"],
    ["DROP TABLE contract_mssql"],
  );
} else {
  skip(`MSSQL not reachable at ${MSSQL_HOST}:${MSSQL_PORT} (set TINA4_TEST_MSSQL_*)`);
}

if (FIREBIRD_URL) {
  const db = await createAdapterFromUrl(FIREBIRD_URL);
  // Firebird has no AUTOINCREMENT — the real idiom is a generator + a BEFORE
  // INSERT trigger, so `id` is assigned without seedTable needing to know it.
  await seedTableRoundtrip(
    db, "contract_fb",
    [
      "CREATE TABLE contract_fb (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR(100), score INTEGER)",
      "CREATE GENERATOR gen_contract_fb_id",
      "CREATE TRIGGER contract_fb_bi FOR contract_fb ACTIVE BEFORE INSERT POSITION 0 " +
        "AS BEGIN IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_contract_fb_id, 1); END",
    ],
    ["DROP TRIGGER contract_fb_bi", "DROP TABLE contract_fb", "DROP GENERATOR gen_contract_fb_id"],
  );
} else {
  skipGated("TINA4_TEST_FIREBIRD_URL not set (needs a live Firebird)");
}

// ── seeded_run_reproduces_identical_rows ───────────────────────────────────
console.log("\n--- seeded_run_reproduces_identical_rows ---");

{
  // seedOrm: its OWN seed is deterministic (unchanged).
  async function runOrm(): Promise<Array<[unknown, unknown, unknown]>> {
    const db = new SQLiteAdapter(":memory:");
    db.execute(
      "CREATE TABLE contract_seedorm_person (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "name TEXT, email TEXT, age INTEGER)",
    );
    class ContractSeedOrmPerson extends BaseModel {
      static tableName = "contract_seedorm_person";
      static fields = {
        id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
        name: { type: "string" as const },
        email: { type: "string" as const },
        age: { type: "integer" as const },
      };
      static getDb() { return db; }
    }
    await seedOrm(ContractSeedOrmPerson as any, 6, undefined, 4242);
    const rows = db.fetch<{ name: unknown; email: unknown; age: unknown }>(
      "SELECT name, email, age FROM contract_seedorm_person ORDER BY id",
    );
    db.close();
    return rows.map((r) => [r.name, r.email, r.age]);
  }
  const a = await runOrm();
  const b = await runOrm();
  assert("seedOrm: same seed -> identical rows", JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert("seedOrm: 6 rows generated", a.length === 6);
}

{
  // seedTable: seed is REMOVED — the documented replacement is a
  // caller-seeded FakeData closed over in fieldMap, proven here.
  async function runSeedTable(): Promise<Array<[unknown, unknown]>> {
    const db = new SQLiteAdapter(":memory:");
    db.execute(
      "CREATE TABLE contract_seedtable_raw (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, score INTEGER)",
    );
    const fake = new FakeData(777);
    await seedTable(db, "contract_seedtable_raw", 6, {
      name: () => fake.name(),
      score: () => fake.integer(1, 1000),
    });
    const rows = db.fetch<{ name: unknown; score: unknown }>(
      "SELECT name, score FROM contract_seedtable_raw ORDER BY id",
    );
    db.close();
    return rows.map((r) => [r.name, r.score]);
  }
  const a = await runSeedTable();
  const b = await runSeedTable();
  assert("seedTable: caller-seeded FakeData -> identical rows", JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert("seedTable: 6 rows generated", a.length === 6);
}

{
  // SEED-TABLE-SEED-INERT fix, mutation witness: seedTable's opts.seed is
  // gone — passing it now THROWS instead of silently doing nothing.
  const db = new SQLiteAdapter(":memory:");
  db.execute("CREATE TABLE contract_seedtable_throws (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  let threw = false;
  let message = "";
  try {
    await seedTable(db, "contract_seedtable_throws", 1, { name: () => "x" }, undefined, { seed: 99 });
  } catch (e) {
    threw = true;
    message = (e as Error).message;
  }
  assert("seedTable(opts.seed) throws", threw && /seed/i.test(message), message);
  db.close();
}

if (await tcpReachable(PG_HOST, PG_PORT)) {
  async function runPg(table: string): Promise<Array<[unknown, unknown]>> {
    const db = await createAdapterFromUrl(pgUrl());
    await dropAll(db, `DROP TABLE ${table}`);
    await rawExecute(db, `CREATE TABLE ${table} (id SERIAL PRIMARY KEY, name VARCHAR(100), score INTEGER)`);
    const fake = new FakeData(555);
    await seedTable(db, table, 5, { name: () => fake.name(), score: () => fake.integer(1, 100) });
    const rows = await rawFetch<{ name: unknown; score: unknown }>(db, `SELECT name, score FROM ${table} ORDER BY id`);
    await dropAll(db, `DROP TABLE ${table}`);
    await db.close();
    return rows.map((r) => [r.name, r.score]);
  }
  const a = await runPg("contract_repro_pg_a");
  const b = await runPg("contract_repro_pg_b");
  assert("seedTable (postgresql): same caller seed -> identical rows", JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert("seedTable (postgresql): 5 rows generated", a.length === 5);
} else {
  skip(`no reachable postgres at ${PG_HOST}:${PG_PORT} (set TINA4_TEST_PG_*)`);
}

// ── seed_models_orders_parents_before_children ─────────────────────────────
console.log("\n--- seed_models_orders_parents_before_children ---");

{
  const db = new SQLiteAdapter(":memory:");
  bindDatabase(db);
  db.execute("CREATE TABLE seedercontract_author (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  db.execute(
    "CREATE TABLE seedercontract_book (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, " +
      "author_id INTEGER NOT NULL REFERENCES seedercontract_author(id))",
  );

  class SeederContractAuthor extends BaseModel {
    static tableName = "seedercontract_author";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const },
    };
  }
  class SeederContractBook extends BaseModel {
    static tableName = "seedercontract_book";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      title: { type: "string" as const },
      author_id: { type: "foreignKey" as const, references: "SeederContractAuthor" },
    };
  }
  BaseModel.registerModel("SeederContractAuthor", SeederContractAuthor as any);
  BaseModel.registerModel("SeederContractBook", SeederContractBook as any);

  // Children declared BEFORE parents on purpose — topo-sort must fix it.
  const results = await seedModels([SeederContractBook, SeederContractAuthor] as any, 5, { seed: 3 });

  assert("SeederContractAuthor seeded 5", results["SeederContractAuthor"].seeded === 5);
  assert("SeederContractAuthor 0 failed", results["SeederContractAuthor"].failed === 0);
  assert("SeederContractBook seeded 5", results["SeederContractBook"].seeded === 5);
  assert("SeederContractBook 0 failed (real parent PKs, no FK violation)", results["SeederContractBook"].failed === 0);

  const orphans = db.fetch(
    "SELECT * FROM seedercontract_book b LEFT JOIN seedercontract_author a ON b.author_id = a.id " +
      "WHERE a.id IS NULL",
  );
  assert("no orphan books", orphans.length === 0);
  db.close();
}

if (await tcpReachable(PG_HOST, PG_PORT)) {
  const db = await createAdapterFromUrl(pgUrl());
  bindDatabase(db);
  await dropAll(db, "DROP TABLE seedercontract_pg_book", "DROP TABLE seedercontract_pg_author");
  await rawExecute(db, "CREATE TABLE seedercontract_pg_author (id SERIAL PRIMARY KEY, name VARCHAR(100))");
  await rawExecute(
    db,
    "CREATE TABLE seedercontract_pg_book (id SERIAL PRIMARY KEY, title VARCHAR(100), " +
      "author_id INTEGER NOT NULL REFERENCES seedercontract_pg_author(id))",
  );

  class SeederContractPgAuthor extends BaseModel {
    static tableName = "seedercontract_pg_author";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const },
    };
  }
  class SeederContractPgBook extends BaseModel {
    static tableName = "seedercontract_pg_book";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      title: { type: "string" as const },
      author_id: { type: "foreignKey" as const, references: "SeederContractPgAuthor" },
    };
  }
  BaseModel.registerModel("SeederContractPgAuthor", SeederContractPgAuthor as any);
  BaseModel.registerModel("SeederContractPgBook", SeederContractPgBook as any);

  try {
    const results = await seedModels([SeederContractPgBook, SeederContractPgAuthor] as any, 5, { seed: 9 });

    assert("SeederContractPgAuthor seeded 5 (postgresql)", results["SeederContractPgAuthor"].seeded === 5);
    assert("SeederContractPgAuthor 0 failed (postgresql)", results["SeederContractPgAuthor"].failed === 0);
    assert("SeederContractPgBook seeded 5 (postgresql)", results["SeederContractPgBook"].seeded === 5);
    assert("SeederContractPgBook 0 failed (postgresql)", results["SeederContractPgBook"].failed === 0);

    const orphans = await rawFetch(
      db,
      "SELECT * FROM seedercontract_pg_book b LEFT JOIN seedercontract_pg_author a ON b.author_id = a.id " +
        "WHERE a.id IS NULL",
    );
    assert("no orphan books (postgresql)", orphans.length === 0);
  } finally {
    await dropAll(db, "DROP TABLE seedercontract_pg_book", "DROP TABLE seedercontract_pg_author");
    await db.close();
  }
} else {
  skip(`no reachable postgres at ${PG_HOST}:${PG_PORT} (set TINA4_TEST_PG_*)`);
}

// ── failures_are_counted_not_silent ─────────────────────────────────────────
console.log("\n--- failures_are_counted_not_silent ---");

{
  const db = new SQLiteAdapter(":memory:");
  db.execute("CREATE TABLE contract_fail (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT NOT NULL)");

  // email is NOT NULL but every generated value is null -> every INSERT
  // violates the constraint — never silent, never a crash.
  const summary = await seedTable(db, "contract_fail", 4, {
    name: () => "someone",
    email: () => null,
  });

  assert("failures: seeded 0", summary.seeded === 0);
  assert("failures: 4 failed", summary.failed === 4);
  assert("failures: 4 errors recorded", summary.errors.length === 4);
  const remaining = db.fetch("SELECT * FROM contract_fail");
  assert("failures: no rows landed", remaining.length === 0);
  db.close();
}

{
  const db = new SQLiteAdapter(":memory:");
  db.execute("CREATE TABLE contract_fail_strict (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)");
  let threw = false;
  try {
    await seedTable(db, "contract_fail_strict", 3, { email: () => null }, undefined, { strict: true });
  } catch {
    threw = true;
  }
  assert("failures: strict re-raises on first failure", threw);
  db.close();
}

if (await tcpReachable(PG_HOST, PG_PORT)) {
  const db = await createAdapterFromUrl(pgUrl());
  const table = "contract_fail_pg";
  await dropAll(db, `DROP TABLE ${table}`);
  await rawExecute(db, `CREATE TABLE ${table} (id SERIAL PRIMARY KEY, email VARCHAR(100) NOT NULL)`);
  try {
    const summary = await seedTable(db, table, 4, { email: () => null });
    assert("failures (postgresql): seeded 0", summary.seeded === 0);
    assert("failures (postgresql): 4 failed", summary.failed === 4);
    const remaining = await rawFetch(db, `SELECT * FROM ${table}`);
    assert("failures (postgresql): no rows landed", remaining.length === 0);
  } finally {
    await dropAll(db, `DROP TABLE ${table}`);
    await db.close();
  }
} else {
  skip(`no reachable postgres at ${PG_HOST}:${PG_PORT} (set TINA4_TEST_PG_*)`);
}

// ── generator_vocabulary_present ────────────────────────────────────────────
// SEED-VOCAB-PARITY: this exact generator set (idiomatic spelling per
// language) exists in all four — Python/PHP/Ruby/Node.
console.log("\n--- generator_vocabulary_present ---");

{
  const GENERATOR_VOCABULARY = [
    "name", "firstName", "lastName", "email", "phone", "address", "city",
    "country", "zipCode", "company", "jobTitle", "sentence", "paragraph",
    "text", "word", "integer", "numeric", "boolean", "date", "datetime",
    "uuid", "url", "colorHex", "currency", "ipAddress", "creditCard",
    "choice", "forField",
  ];
  const fake = new FakeData(1);
  for (const generatorName of GENERATOR_VOCABULARY) {
    assert(`FakeData has generator: ${generatorName}`, typeof (fake as any)[generatorName] === "function");
  }

  assert("name() returns a non-empty string", typeof fake.name() === "string" && fake.name().length > 0);
  assert("firstName() returns a non-empty string", typeof fake.firstName() === "string" && fake.firstName().length > 0);
  assert("lastName() returns a non-empty string", typeof fake.lastName() === "string" && fake.lastName().length > 0);
  assert("email() contains @", fake.email().includes("@"));
  assert("phone() is non-empty", fake.phone().length > 0);
  assert("address() is non-empty", fake.address().length > 0);
  assert("city() is non-empty", fake.city().length > 0);
  assert("country() is non-empty", fake.country().length > 0);
  assert("zipCode() is non-empty", fake.zipCode().length > 0);
  assert("company() is non-empty", fake.company().length > 0);
  assert("jobTitle() is non-empty", fake.jobTitle().length > 0);
  assert("sentence() is non-empty", fake.sentence().length > 0);
  assert("paragraph() is non-empty", fake.paragraph().length > 0);
  assert("text() is non-empty", fake.text().length > 0);
  assert("word() is non-empty", fake.word().length > 0);
  assert("integer(1,10) is an integer", Number.isInteger(fake.integer(1, 10)));
  assert("numeric(0,10) is a number", typeof fake.numeric(0, 10) === "number");
  assert("boolean() is a boolean", typeof fake.boolean() === "boolean");
  assert("date() is non-empty", fake.date().length > 0);
  assert("datetime() returns a Date", fake.datetime() instanceof Date);
  assert("uuid() is non-empty", fake.uuid().length > 0);
  assert("url() starts with https://", fake.url().startsWith("https://"));
  assert("colorHex() starts with #", fake.colorHex().startsWith("#"));
  assert("currency() is 3 chars", fake.currency().length === 3);
  assert("ipAddress() has 3 dots", (fake.ipAddress().match(/\./g) ?? []).length === 3);
  assert("creditCard() is non-empty", fake.creditCard().length > 0);
  assert("choice() picks a member", [1, 2, 3].includes(fake.choice([1, 2, 3])));
  assert("forField() returns a value", fake.forField({ type: "string" }, "x") !== undefined);
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

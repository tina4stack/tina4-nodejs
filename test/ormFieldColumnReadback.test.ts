/**
 * ORM field column read-back: a property whose DB column has another name
 * round-trips on every read path.
 *
 * Parity with tina4-python/tests/test_orm_field_column_readback.py. Python's
 * bug was a `Field(column=)` written to its column but hydrated onto a stray
 * attribute. Node has no per-field column option: `static fieldMapping`
 * ({ property: column }) is the one resolver, read through getDbColumn() and
 * reversed in the constructor. These cases pin that it round-trips on find(pk),
 * all, where, find(filter), ORDER BY, count, load, update, delete, toDict, a
 * mapped primary key, and relationship foreign keys.
 *
 * Real databases, no mocks: SQLite, PostgreSQL, MySQL, MSSQL and Firebird
 * (Firebird folds unquoted identifiers to upper case). Under
 * TINA4_REQUIRE_SERVICES an unreachable engine is a hard failure.
 *
 * Imports the ORM from src so tsx runs the checked-out source directly.
 */
import process from "node:process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import {
  BaseModel,
  Database,
  bindDatabase,
  createAdapterFromUrl,
} from "../packages/orm/src/index.js";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");

function skip(message: string): void {
  if (requireServices) {
    console.error(`  \x1b[31mSKIP-AS-FAIL\x1b[0m ${message}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${message}`);
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

const env = (key: string, fallback: string) => process.env[key] ?? fallback;
const SERVERS: Record<string, { host: string; port: number; user: string; pass: string; db: string }> = {
  postgres: {
    host: env("TINA4_TEST_PG_HOST", "127.0.0.1"), port: Number(env("TINA4_TEST_PG_PORT", "55432")),
    user: env("TINA4_TEST_PG_USERNAME", "tina4"), pass: env("TINA4_TEST_PG_PASSWORD", "tina4"),
    db: env("TINA4_TEST_PG_DB", "tina4_node"),
  },
  mysql: {
    host: env("TINA4_TEST_MYSQL_HOST", "127.0.0.1"), port: Number(env("TINA4_TEST_MYSQL_PORT", "3306")),
    user: env("TINA4_TEST_MYSQL_USERNAME", "tina4"), pass: env("TINA4_TEST_MYSQL_PASSWORD", "tina4"),
    db: env("TINA4_TEST_MYSQL_DB", "tina4_test"),
  },
  mssql: {
    host: env("TINA4_TEST_MSSQL_HOST", "127.0.0.1"), port: Number(env("TINA4_TEST_MSSQL_PORT", "1433")),
    user: env("TINA4_TEST_MSSQL_USERNAME", "sa"), pass: env("TINA4_TEST_MSSQL_PASSWORD", "TinaSQL123!Secure"),
    db: env("TINA4_TEST_MSSQL_DB", "tina4_test"),
  },
};
const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL ?? "";
const ENGINES = ["sqlite", "postgres", "mysql", "mssql", "firebird"];

const tmpDir = path.join(os.tmpdir(), `colrn_${process.pid}`);
mkdirSync(tmpDir, { recursive: true });

async function openEngine(engine: string): Promise<Database | null> {
  let url: string;
  let user = "";
  let pass = "";
  if (engine === "sqlite") {
    url = `sqlite:///${path.join(tmpDir, "colrn.db")}`;
  } else if (engine === "firebird") {
    if (!FIREBIRD_URL) {
      skip("firebird not set: TINA4_TEST_FIREBIRD_URL (needs a live Firebird)");
      return null;
    }
    url = FIREBIRD_URL;
  } else {
    const server = SERVERS[engine];
    if (!(await tcpReachable(server.host, server.port))) {
      skip(`${engine} unreachable at ${server.host}:${server.port}`);
      return null;
    }
    url = `${engine}://${server.user}:${server.pass}@${server.host}:${server.port}/${server.db}`;
    user = server.user;
    pass = server.pass;
  }
  const adapter: any = await createAdapterFromUrl(url, user, pass);
  const db = new Database(adapter);
  db.setDbType(engine);
  bindDatabase(adapter);
  return db;
}

// ── models ──────────────────────────────────────────────────────────────────

class ColRnPerson extends BaseModel {
  static tableName = "colrn_person";
  static fieldMapping = { name: "full_name" };
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}

class ColRnMixed extends BaseModel {
  static tableName = "colrn_mixed";
  static fieldMapping = { name: "full_name", email: "email_address" };
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    email: { type: "string" },
  } as const;
}

class ColRnPlain extends BaseModel {
  static tableName = "colrn_plain";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}

class ColRnKeyed extends BaseModel {
  static tableName = "colrn_keyed";
  static fieldMapping = { id: "person_id", name: "full_name" };
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}

class ColRnNamedKey extends BaseModel {
  static tableName = "colrn_named_key";
  static fields = {
    person_id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}

class ColRnOwner extends BaseModel {
  static tableName = "colrn_owner";
  static fieldMapping = { name: "owner_name" };
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}

class ColRnPet extends BaseModel {
  static tableName = "colrn_pet";
  static fieldMapping = { id: "pet_id", name: "pet_name", ownerId: "owner_ref" };
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    ownerId: { type: "integer" },
  } as const;
}

const TABLES: Record<string, [string, string]> = {
  colrn_person: ["id", "full_name VARCHAR(100)"],
  colrn_mixed: ["id", "full_name VARCHAR(100), email_address VARCHAR(100)"],
  colrn_plain: ["id", "name VARCHAR(100)"],
  colrn_keyed: ["person_id", "full_name VARCHAR(100)"],
  colrn_named_key: ["person_id", "name VARCHAR(100)"],
  colrn_owner: ["id", "owner_name VARCHAR(100)"],
  colrn_pet: ["pet_id", "pet_name VARCHAR(100), owner_ref INTEGER"],
};

function keyColumn(engine: string, key: string): string {
  return {
    sqlite: `${key} INTEGER PRIMARY KEY AUTOINCREMENT`,
    postgres: `${key} SERIAL PRIMARY KEY`,
    mysql: `${key} INT AUTO_INCREMENT PRIMARY KEY`,
    mssql: `${key} INT IDENTITY(1,1) PRIMARY KEY`,
    firebird: `${key} INTEGER NOT NULL PRIMARY KEY`,
  }[engine] as string;
}

async function tryExecute(db: Database, sql: string): Promise<void> {
  try { await db.execute(sql); } catch { /* best effort: object may not exist */ }
}

async function dropTables(db: Database, engine: string): Promise<void> {
  for (const table of Object.keys(TABLES)) {
    if (engine === "firebird") await tryExecute(db, `DROP TRIGGER ${table}_bi`);
    await tryExecute(db, `DROP TABLE ${table}`);
    if (engine === "firebird") await tryExecute(db, `DROP GENERATOR gen_${table}_id`);
  }
}

async function createTables(db: Database, engine: string, ...tables: string[]): Promise<void> {
  await dropTables(db, engine);
  for (const table of tables) {
    const [key, columns] = TABLES[table];
    await db.execute(`CREATE TABLE ${table} (${keyColumn(engine, key)}, ${columns})`);
    if (engine === "firebird") {
      // Firebird's auto-key idiom: a GEN_<TABLE>_ID generator fed by a BEFORE
      // INSERT trigger -- the generator the adapter reads the new key from.
      await db.execute(`CREATE GENERATOR gen_${table}_id`);
      await db.execute(
        `CREATE TRIGGER ${table}_bi FOR ${table} ACTIVE BEFORE INSERT POSITION 0 ` +
        `AS BEGIN IF (NEW.${key} IS NULL) THEN NEW.${key} = GEN_ID(gen_${table}_id, 1); END`,
      );
    }
  }
}

/** Raw row with lower-cased keys: asserts WHERE a value landed, not the driver's key casing. */
async function rawRow(db: Database, sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  const result = await db.fetch(sql, params);
  const row = (result.records[0] ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
}

const names = (models: Iterable<any>): string[] => Array.from(models, (model) => model.name as string);
const hasStray = (model: any, column: string): boolean => Object.prototype.hasOwnProperty.call(model.toDict(), column);
const sameList = (actual: unknown[], expected: unknown[]) => JSON.stringify(actual) === JSON.stringify(expected);

async function runEngine(engine: string): Promise<void> {
  console.log(`\n[${engine}]`);
  const db = await openEngine(engine);
  if (db === null) return;
  const label = (name: string) => `[${engine}] ${name}`;
  const run = async (name: string, tables: string[], body: () => Promise<void>) => {
    await createTables(db, engine, ...tables);
    try {
      await body();
    } catch (error) {
      check(label(name), false, `threw: ${(error as Error).message}`);
    }
  };

  await run("field column write lands in the declared column", ["colrn_person"], async () => {
    await ColRnPerson.create({ name: "Ada" });
    check(label("field column write lands in the declared column"),
      (await rawRow(db, "SELECT full_name FROM colrn_person")).full_name === "Ada");
  });

  await run("field column reads back through find by primary key", ["colrn_person"], async () => {
    const saved: any = await ColRnPerson.create({ name: "Ada" });
    const found: any = await ColRnPerson.find(saved.id);
    check(label("field column reads back through find by primary key"),
      found?.name === "Ada" && !hasStray(found, "full_name"), JSON.stringify(found?.toDict()));
  });

  await run("field column reads back through all", ["colrn_person"], async () => {
    await ColRnPerson.create({ name: "Ada" });
    await ColRnPerson.create({ name: "Grace" });
    const people = await ColRnPerson.all();
    check(label("field column reads back through all"),
      sameList(names(people).sort(), ["Ada", "Grace"]) && people.every((p: any) => !hasStray(p, "full_name")),
      JSON.stringify(names(people)));
  });

  await run("field column reads back through where", ["colrn_person"], async () => {
    await ColRnPerson.create({ name: "Ada" });
    await ColRnPerson.create({ name: "Grace" });
    const rows = await ColRnPerson.where("full_name = ?", ["Grace"]);
    check(label("field column reads back through where"),
      sameList(names(rows), ["Grace"]) && !hasStray(rows[0], "full_name"), JSON.stringify(names(rows)));
  });

  await run("field column filters through find by attribute name", ["colrn_person"], async () => {
    await ColRnPerson.create({ name: "Ada" });
    await ColRnPerson.create({ name: "Grace" });
    const rows = await ColRnPerson.find({ name: "Ada" });
    check(label("field column filters through find by attribute name"), sameList(names(rows), ["Ada"]), JSON.stringify(names(rows)));
  });

  await run("field column sorts and reads back in order", ["colrn_person"], async () => {
    for (const name of ["Grace", "Ada", "Linus"]) await ColRnPerson.create({ name });
    // orderBy is SQL (SQL-first ORM), so it names the column; every row it
    // returns must still hydrate onto the property, in the database's order.
    const descending = names(await ColRnPerson.all(100, 0, undefined, "full_name DESC"));
    const ascending = names(await ColRnPerson.find({}, 100, 0, "full_name ASC"));
    check(label("field column sorts and reads back in order"),
      sameList(descending, ["Linus", "Grace", "Ada"]) && sameList(ascending, ["Ada", "Grace", "Linus"]),
      JSON.stringify([descending, ascending]));
  });

  await run("field column counts and loads", ["colrn_person"], async () => {
    const saved: any = await ColRnPerson.create({ name: "Ada" });
    const counted = await ColRnPerson.count("full_name = ?", ["Ada"]);
    const fresh: any = new ColRnPerson();
    fresh.id = saved.id;
    const loaded = await fresh.load();
    check(label("field column counts and loads"), counted === 1 && loaded === true && fresh.name === "Ada",
      JSON.stringify({ counted, loaded, name: fresh.name }));
  });

  await run("field column updates the declared column", ["colrn_person"], async () => {
    const person: any = await ColRnPerson.create({ name: "Ada" });
    person.name = "Ada Lovelace";
    const saved = await person.save();
    const raw = (await rawRow(db, "SELECT full_name FROM colrn_person")).full_name;
    const reread: any = await ColRnPerson.find(person.id);
    check(label("field column updates the declared column"),
      saved !== false && raw === "Ada Lovelace" && reread?.name === "Ada Lovelace", JSON.stringify({ raw, name: reread?.name }));
  });

  await run("field column toDict uses the attribute name", ["colrn_person"], async () => {
    const saved: any = await ColRnPerson.create({ name: "Ada" });
    const found: any = await ColRnPerson.find(saved.id);
    const dict = found.toDict();
    check(label("field column toDict uses the attribute name"),
      sameList(Object.keys(dict).sort(), ["id", "name"]) && dict.name === "Ada", JSON.stringify(dict));
  });

  check(label("getDbColumn resolves field column"),
    ColRnPerson.getDbColumn("name") === "full_name" && ColRnMixed.getDbColumn("email") === "email_address"
      && ColRnPlain.getDbColumn("name") === "name");

  await run("field mapping and field column round trip together", ["colrn_mixed"], async () => {
    const saved: any = await ColRnMixed.create({ name: "Ada", email: "ada@example.com" });
    const raw = await rawRow(db, "SELECT full_name, email_address FROM colrn_mixed");
    const found: any = await ColRnMixed.find(saved.id);
    const byName = await ColRnMixed.find({ name: "Ada" });
    const byEmail = await ColRnMixed.find({ email: "ada@example.com" });
    const everyone = await ColRnMixed.all();
    check(label("field mapping and field column round trip together"),
      raw.full_name === "Ada" && raw.email_address === "ada@example.com"
        && found?.name === "Ada" && found?.email === "ada@example.com"
        && !hasStray(found, "full_name") && !hasStray(found, "email_address")
        && byName.length === 1 && byEmail.length === 1 && sameList(names(everyone), ["Ada"]),
      JSON.stringify({ raw, found: found?.toDict(), byName: byName.length, byEmail: byEmail.length }));
  });

  await run("plain field round trips unchanged", ["colrn_plain"], async () => {
    const saved: any = await ColRnPlain.create({ name: "Ada" });
    const raw = (await rawRow(db, "SELECT name FROM colrn_plain")).name;
    const found: any = await ColRnPlain.find(saved.id);
    check(label("plain field round trips unchanged"),
      raw === "Ada" && found?.name === "Ada" && sameList(names(await ColRnPlain.find({ name: "Ada" })), ["Ada"])
        && sameList(names(await ColRnPlain.all()), ["Ada"]));
  });

  await run("undeclared select column still lands as an extra attribute", ["colrn_person"], async () => {
    await ColRnPerson.create({ name: "Ada" });
    const rows = await ColRnPerson.select("SELECT id, full_name, 7 AS extra_value FROM colrn_person");
    const person: any = rows[0];
    const extra = person?.extra_value ?? person?.EXTRA_VALUE ?? person?.extraValue;
    check(label("undeclared select column still lands as an extra attribute"),
      person?.name === "Ada" && Number(extra) === 7, JSON.stringify({ name: person?.name, extra }));
  });

  await run("foreign key field column loads lazy and eager", ["colrn_owner", "colrn_pet"], async () => {
    const owner: any = await ColRnOwner.create({ name: "Ada" });
    await ColRnPet.create({ name: "Rex", ownerId: owner.id });
    await ColRnPet.create({ name: "Tom", ownerId: owner.id });
    const raw = await rawRow(db, "SELECT owner_ref FROM colrn_pet WHERE pet_name = ?", ["Rex"]);
    // Node relationship foreign keys name the COLUMN.
    const found: any = await ColRnOwner.find(owner.id);
    const pets = names(await found.hasMany(ColRnPet, "owner_ref")).sort();
    const one: any = await found.hasOne(ColRnPet, "owner_ref");
    const pet: any = (await ColRnPet.find({ name: "Rex" }))[0];
    const parent: any = await pet.belongsTo(ColRnOwner, "owner_ref");
    check(label("foreign key field column loads lazy and eager"),
      Number(raw.owner_ref) === Number(owner.id) && sameList(pets, ["Rex", "Tom"])
        && ["Rex", "Tom"].includes(one?.name) && Number(pet.ownerId) === Number(owner.id) && parent?.name === "Ada",
      JSON.stringify({ raw, pets, one: one?.name, parent: parent?.name }));
  });

  await run("primary key field column round trips", ["colrn_keyed"], async () => {
    const first: any = await ColRnKeyed.create({ name: "Ada" });
    const second: any = await ColRnKeyed.create({ name: "Grace" });
    const raw = await rawRow(db, "SELECT person_id, full_name FROM colrn_keyed WHERE person_id = ?", [first.id]);
    const found: any = await ColRnKeyed.find(first.id);
    found.name = "Ada Lovelace";
    const saved = await found.save();
    const firstAfter: any = await ColRnKeyed.find(first.id);
    const secondAfter: any = await ColRnKeyed.find(second.id);
    const deleted = await secondAfter.delete();
    const gone = await ColRnKeyed.find(second.id);
    const left = names(await ColRnKeyed.all());
    check(label("primary key field column round trips"),
      first.id != null && second.id != null && first.id !== second.id
        && Number(raw.person_id) === Number(first.id) && raw.full_name === "Ada"
        && !hasStray(found, "person_id") && saved !== false
        && firstAfter?.name === "Ada Lovelace" && secondAfter?.name === "Grace"
        && deleted === true && gone === null && sameList(left, ["Ada Lovelace"]),
      JSON.stringify({ first: first.id, second: second.id, raw, firstAfter: firstAfter?.name, left }));
  });

  await run("non id auto increment key is set after save", ["colrn_named_key"], async () => {
    const first: any = await ColRnNamedKey.create({ name: "Ada" });
    const second: any = await ColRnNamedKey.create({ name: "Grace" });
    const found: any = second.person_id != null ? await ColRnNamedKey.find(second.person_id) : null;
    check(label("non id auto increment key is set after save"),
      first.person_id != null && second.person_id != null && first.person_id !== second.person_id && found?.name === "Grace",
      JSON.stringify({ first: first.person_id, second: second.person_id }));
  });

  await run("all-defaults insert sets the generated key", ["colrn_plain"], async () => {
    const empty: any = await ColRnPlain.create({});
    const found: any = empty && empty.id != null ? await ColRnPlain.find(empty.id) : null;
    check(label("all-defaults insert sets the generated key"),
      empty !== false && empty.id != null && found !== null && found.name == null,
      JSON.stringify({ id: empty?.id, error: empty === false ? "save failed" : null }));
  });

  await dropTables(db, engine);
  try { await (db as any).close?.(); } catch { /* best effort */ }
}

for (const engine of ENGINES) {
  await runEngine(engine);
}
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nORM field column read-back: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

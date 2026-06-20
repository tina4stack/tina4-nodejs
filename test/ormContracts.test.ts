/**
 * Lock-in regression tests for the ORM "fail loud, never silent" pass
 * (mirrors the Python master tests/test_orm_contracts.py).
 *
 * These contracts guard against silent-drift in the ORM/QueryBuilder failure
 * paths. The principle (the same db.execute() already follows by raising): a
 * failure must never vanish silently — it returns the documented false / throws
 * loudly AND the real cause stays recoverable. If any of these behaviours
 * regresses to the old silent form, one of these named tests goes red.
 *
 * Canonical behaviours (1-5):
 *   1. save() loud-but-non-breaking on a DB error (false + recoverable cause + logged + rolled back).
 *   2. save() ENFORCES validate() (false + writes nothing on a validation error).
 *   3. create() propagates save() failure (returns false, never an unsaved instance).
 *   4. QueryBuilder.get() returns ALL rows when >100 and no .limit() (no silent LIMIT 100).
 *   5. toMongo() THROWS on an unparseable WHERE (no silent {$where: <raw JS>}).
 *
 * Plus a test per outlier bug fixed in this pass (A-F).
 *
 * Engine-agnostic (SQLite is fine). Run with: npx tsx test/ormContracts.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseModel, QueryBuilder, initDatabase, closeDatabase, getAdapter,
} from "../packages/orm/src/index.ts";
import { validate as validateFields } from "../packages/orm/src/validation.ts";

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

/** Await `fn`, returning the thrown error (or null if it didn't throw). */
async function captureThrow(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

// ── Test Models ────────────────────────────────────────────────
class CUser extends BaseModel {
  static tableName = "cusers";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true }, // NOT NULL at DB + required in model
    email: { type: "string" as const },
  };
}

class CWidget extends BaseModel {
  static tableName = "cwidgets";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    label: { type: "string" as const },
  };
}

class CGhost extends BaseModel {
  // Points at a table that is never created — every save() hits a driver error
  // ("no such table"), exercising create()'s failure propagation through the
  // DB-error path (construction + validate both succeed).
  static tableName = "cghost_missing";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    label: { type: "string" as const },
  };
}

console.log("=== ORM Contracts (fail loud, never silent) ===\n");

const tmp = mkdtempSync(join(tmpdir(), "tina4-orm-contracts-"));

async function freshDb(file: string) {
  const db = await initDatabase({ url: `sqlite:///${join(tmp, file)}` });
  await db.execute("CREATE TABLE cusers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT)");
  await db.execute("CREATE TABLE cwidgets (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)");
  return db;
}

/** Capture Log.error output so we can assert the failure was logged. */
function captureStderrAndStdout(fn: () => Promise<void>): Promise<string> {
  return (async () => {
    const chunks: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as any) = (s: any, ...rest: any[]) => { chunks.push(String(s)); return origOut(s, ...rest); };
    (process.stderr.write as any) = (s: any, ...rest: any[]) => { chunks.push(String(s)); return origErr(s, ...rest); };
    try {
      await fn();
    } finally {
      process.stdout.write = origOut as any;
      process.stderr.write = origErr as any;
    }
    return chunks.join("");
  })();
}

async function run() {
  // ── 1. save() on a DB error: false + retrievable cause + logged + rolled back ──
  console.log("--- 1. save() loud-but-non-breaking on a DB error ---");
  {
    const db = await freshDb("c1.db");

    // Baseline: a valid save() returns the fluent self and clears any error.
    const ok = new CUser({ name: "Alice" });
    const okResult = await ok.save();
    assert("valid save() returns the fluent self", okResult === ok);
    assert("valid save() clears getError()", ok.getError() === null);
    assert("valid save() clears lastError", ok.lastError === null);

    const countBeforeBad = await CUser.count(); // Alice already landed above.

    // A genuine driver error (NOT NULL violation that validation can't catch):
    // pass validation (name = "ok"), then null the NOT NULL column right after
    // validate() runs, so the DRIVER — not the validator — rejects the write.
    const bad = new CUser({ name: "ok" });
    const originalValidate = bad.validate.bind(bad);
    (bad as any).validate = () => {
      const errs = originalValidate();   // validation passes (name is "ok")...
      bad.name = null;                    // ...then null the NOT NULL column
      return errs;
    };

    let result: unknown;
    const logged = await captureStderrAndStdout(async () => { result = await bad.save(); });

    assert("DB-error save() returns false (loud, documented)", result === false);
    assert("DB-error save() cause recoverable via getError()", !!bad.getError());
    assert("DB-error save() cause recoverable via lastError", !!bad.lastError);
    assert("getError() === lastError", bad.getError() === bad.lastError);
    assert("DB-error save() logged with model context",
      logged.includes("CUser.save() failed"), `log was: ${logged.slice(0, 200)}`);
    assert("DB-error save() rolled back — the bad row never landed",
      (await CUser.count()) === countBeforeBad, `count changed from ${countBeforeBad}`);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 2. save() with validation errors: false, no row written, validate() ran ──
  console.log("\n--- 2. save() ENFORCES validate() (false + writes nothing) ---");
  {
    const db = await freshDb("c2.db");
    const before = await CUser.count();

    // Build a valid instance, then null the required field by direct assignment
    // (bypasses constructor validation) — the kind of state a setter or partial
    // update can produce. save() must catch this via validate() before any write.
    const invalid = new CUser({ name: "temp" });
    invalid.name = null;

    assert("validate() reports the missing required field", invalid.validate().length > 0);

    let result: unknown;
    const logged = await captureStderrAndStdout(async () => { result = await invalid.save(); });

    assert("validation-failure save() returns false", result === false);
    assert("validation-failure cause recoverable", !!invalid.getError());
    assert("validation-failure cause mentions 'required'",
      (invalid.getError() ?? "").toLowerCase().includes("required"));
    assert("validation failure was logged",
      logged.toLowerCase().includes("validation failed"), `log was: ${logged.slice(0, 200)}`);
    assert("validation-failure save() wrote NOTHING", (await CUser.count()) === before);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 3. create() returns false when the underlying save fails ──
  console.log("\n--- 3. create() propagates save() failure ---");
  {
    const db = await freshDb("c3.db");

    // CGhost points at a non-existent table → its save() always hits a driver
    // error and returns false → create() must propagate that false.
    let ghostResult: unknown;
    await captureStderrAndStdout(async () => { ghostResult = await CGhost.create({ label: "x" }); });
    assert("create() returns false when save() fails (driver error)", ghostResult === false);

    // create() with a validation failure also returns false.
    let invalidCreate: unknown;
    await captureStderrAndStdout(async () => { invalidCreate = await CUser.create({ email: "no-name@example.com" }); });
    assert("create() returns false when save() fails (validation)", invalidCreate === false);

    // Happy path unchanged: a valid create() returns the saved instance with its PK.
    const user = await CUser.create({ name: "Valid" });
    assert("create() returns the instance on success", user instanceof CUser);
    assert("create() success assigned the PK", user !== false && (user as CUser).id != null);
    assert("create() success persisted exactly one row", (await CUser.count()) === 1);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 4. QueryBuilder.get() with no .limit() returns ALL rows (>100) ──
  console.log("\n--- 4. QueryBuilder.get() returns ALL rows (no silent LIMIT 100) ---");
  {
    const db = await freshDb("c4.db");
    for (let i = 0; i < 150; i++) {
      await db.execute("INSERT INTO cwidgets (label) VALUES (?)", [`w${i}`]);
    }

    const all = await QueryBuilder.fromTable("cwidgets", getAdapter()).get();
    assert("get() with no .limit() returns all 150 rows (not 100)", all.length === 150, `got ${all.length}`);

    const limited = await QueryBuilder.fromTable("cwidgets", getAdapter()).limit(10).get();
    assert("explicit .limit(10) is still honoured", limited.length === 10, `got ${limited.length}`);

    const sql = QueryBuilder.fromTable("cwidgets", getAdapter()).toSql().toUpperCase();
    assert("toSql() injects no default LIMIT", !sql.includes("LIMIT"), `sql: ${sql}`);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 5. toMongo() throws (not a silent $where) on an unparseable WHERE ──
  console.log("\n--- 5. toMongo() throws on unparseable WHERE (no $where sink) ---");
  {
    const qb = QueryBuilder.fromTable("cwidgets").where("label = label OR 1=1");
    let err: Error | null = null;
    try {
      qb.toMongo();
    } catch (e) {
      err = e as Error;
    }
    assert("toMongo() throws on an unparseable WHERE", err !== null);
    assert("the thrown error names the offending clause",
      !!err && err.message.includes("label = label OR 1=1"), err ? err.message : "no error");
    assert("the error explicitly refuses a raw $where",
      !!err && /\$where/.test(err.message));

    // Supported forms still translate — only the silent fallback was removed.
    const mongo = QueryBuilder.fromTable("cwidgets").where("label = ?", ["x"]).toMongo();
    assert("parseable conditions still translate", JSON.stringify(mongo.filter) === JSON.stringify({ label: "x" }));
  }

  // ── Outlier A: callable field defaults resolved per instance ──
  console.log("\n--- A. callable field defaults resolved per instance ---");
  {
    class CDefaults extends BaseModel {
      static tableName = "cdefaults";
      static fields = {
        id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
        token: { type: "string" as const, default: () => `tok-${Math.random()}` },
        status: { type: "string" as const, default: "new" },
      };
    }
    const a = new CDefaults();
    const b = new CDefaults();
    assert("callable default is resolved (not the function itself)", typeof a.token === "string");
    assert("callable default starts with the expected prefix", String(a.token).startsWith("tok-"));
    assert("callable default differs per instance", a.token !== b.token);
    assert("static default assigned verbatim", a.status === "new");
  }

  // ── Outlier B: load() with no argument uses the real resolved PK ──
  console.log("\n--- B. load() no-arg uses the real PK (getPkField/getPkColumn) ---");
  {
    const db = await freshDb("cB.db");
    const created = await CUser.create({ name: "Loadable", email: "load@example.com" });
    assert("setup: create() returned an instance", created instanceof CUser);
    const pkVal = (created as CUser).id;

    // load() with NO arguments must resolve via the real PK and populate self.
    const fresh = new CUser();
    fresh.id = pkVal;
    const found = await fresh.load();
    assert("load() with no arg returns true when the PK row exists", found === true);
    assert("load() with no arg populated the row", fresh.name === "Loadable");
    assert("load() with no arg populated all columns", fresh.email === "load@example.com");

    // A no-arg load() with no PK set returns false (not a crash).
    const empty = new CUser();
    assert("load() with no PK set returns false", (await empty.load()) === false);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── Outlier C: find() overload — scalar PK → instance|null, object → list ──
  console.log("\n--- C. find() scalar PK returns instance|null; object returns list ---");
  {
    const db = await freshDb("cC.db");
    const a = await CUser.create({ name: "Ann" });
    await CUser.create({ name: "Bea" });
    const aId = (a as CUser).id as number;

    const single = await CUser.find(aId);
    assert("find(scalar PK) returns a single instance", single instanceof CUser);
    assert("find(scalar PK) returns the right row", !Array.isArray(single) && (single as CUser)?.name === "Ann");

    const missing = await CUser.find(999999);
    assert("find(scalar PK) returns null when not found", missing === null);

    const list = await CUser.find({ name: "Ann" });
    assert("find(object) returns an array (not broken by the overload)", Array.isArray(list));
    assert("find(object) filters correctly", Array.isArray(list) && list.length === 1 && list[0].name === "Ann");

    const all = await CUser.find();
    assert("find() with no args returns all as an array", Array.isArray(all) && all.length === 2);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── Outlier D: validation.ts has a foreignKey case ──
  console.log("\n--- D. validation has a foreignKey case (integer-typed) ---");
  {
    const fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      author_id: { type: "foreignKey" as const, references: "Author" },
    };
    // A valid integer FK passes.
    assert("foreignKey accepts an integer",
      validateFields({ author_id: 7 }, fields).length === 0);
    // A numeric string coerces and passes.
    assert("foreignKey accepts a numeric string",
      validateFields({ author_id: "7" }, fields).length === 0);
    // A non-numeric string / object is rejected (previously ANY value passed silently).
    assert("foreignKey rejects a non-numeric string",
      validateFields({ author_id: "not-an-id" }, fields).length > 0);
    assert("foreignKey rejects an object",
      validateFields({ author_id: { nested: true } as any }, fields).length > 0);
    assert("foreignKey rejects a non-integer float",
      validateFields({ author_id: 1.5 }, fields).length > 0);

    // And it is wired into save(): assigning a bad FK fails validation loudly.
    const dbf = await initDatabase({ url: `sqlite:///${join(tmp, "cD.db")}` });
    await dbf.execute("CREATE TABLE cfk (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER)");
    class CFk extends BaseModel {
      static tableName = "cfk";
      static fields = fields;
    }
    const bad = new CFk({ author_id: "nope" });
    let r: unknown;
    await captureStderrAndStdout(async () => { r = await bad.save(); });
    assert("save() refuses a bad foreignKey via validate()", r === false);
    assert("the bad-FK cause is recoverable", !!bad.getError());
    dbf.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── Outlier F: FK-default hasMany key = declaring class lowercased + "s" ──
  console.log("\n--- F. FK has-many key = declaring class lowercased + 's' ---");
  {
    class AuthorF extends BaseModel {
      static tableName = "authors_f";
      static fields = { id: { type: "integer" as const, primaryKey: true, autoIncrement: true } };
    }
    class PostF extends BaseModel {
      static tableName = "blog_posts"; // table name deliberately != class name
      static fields = {
        id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
        author_id: { type: "foreignKey" as const, references: "AuthorF" },
      };
    }
    BaseModel.registerModel("AuthorF", AuthorF);
    BaseModel.registerModel("PostF", PostF);
    PostF._processForeignKeys();
    AuthorF._applyFkRegistry();

    // The has-many registered on AuthorF must use the DECLARING class name
    // (PostF) lowercased + "s" = "postf"+"s" -> "postfs" — NOT the table name
    // "blog_posts". This is the documented Python rule.
    const hm = (AuthorF.hasMany ?? []).find((r) => r.model === "PostF");
    assert("has-many wired onto the referenced model", !!hm);
    // The derived has-many key must be the DECLARING class name (PostF)
    // lowercased + "s" = "postfs" — NOT the table name "blog_posts".
    assert("has-many relatedName = declaring class lowercased + 's'", hm?.relatedName === "postfs",
      `relatedName was ${hm?.relatedName}`);
    assert("derived key is NOT the related table name", hm?.relatedName !== PostF.tableName);

    // A relatedName override wins over the class+s default.
    class AuthorG extends BaseModel {
      static tableName = "authors_g";
      static fields = { id: { type: "integer" as const, primaryKey: true, autoIncrement: true } };
    }
    class PostG extends BaseModel {
      static tableName = "posts_g";
      static fields = {
        id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
        author_id: { type: "foreignKey" as const, references: "AuthorG", relatedName: "articles" },
      };
    }
    BaseModel.registerModel("AuthorG", AuthorG);
    BaseModel.registerModel("PostG", PostG);
    PostG._processForeignKeys();
    AuthorG._applyFkRegistry();
    const hmG = (AuthorG.hasMany ?? []).find((r) => r.model === "PostG");
    assert("relatedName override wins over the class+s default", hmG?.relatedName === "articles",
      `relatedName was ${hmG?.relatedName}`);
  }
}

run()
  .catch((e) => {
    console.error("UNEXPECTED ERROR:", e);
    fail++;
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(fail > 0 ? 1 : 0);
  });

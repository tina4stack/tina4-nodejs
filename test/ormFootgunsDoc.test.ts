/**
 * Doc lock-in tests for the ORM lifecycle footguns documented in
 * `.claude/skills/tina4-developer-nodejs/references/data-and-orm.md`
 * (§ "ORM Lifecycle & Footguns") and the Auth footguns section.
 *
 * Mirrors the Python master's tests/test_orm_footguns_doc.py. Every claim the
 * skill makes about the write path, read path, ordering, DatabaseResult, and
 * soft-delete provisioning is pinned here with a REAL SQLite database (node:sqlite,
 * no mocks). Positive + negative for the boot-gate cases. If a documented
 * behaviour regresses, the matching named assertion goes red.
 *
 * Engine-agnostic (SQLite is fine). Run with: npx tsx test/ormFootgunsDoc.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseModel, initDatabase, closeDatabase, getAdapter, Database, DatabaseResult, syncModels,
} from "../packages/orm/src/index.ts";

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

/** Swallow the expected Log.error noise on paths we deliberately fail. */
function quiet(fn: () => Promise<void>): Promise<void> {
  return (async () => {
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    (process.stderr.write as any) = () => true;
    (process.stdout.write as any) = () => true;
    try { await fn(); } finally {
      process.stderr.write = origErr as any;
      process.stdout.write = origOut as any;
    }
  })();
}

// ── Models ─────────────────────────────────────────────────────
class FUser extends BaseModel {
  static tableName = "fusers";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 10 },
    email: { type: "string" as const },
  };
}

// Points at a table that is never created — every save() hits "no such table".
class FGhost extends BaseModel {
  static tableName = "fghost_missing";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    label: { type: "string" as const },
  };
}

// softDelete WITHOUT an is_deleted field — createTable() must NOT provision it.
class FSoftBare extends BaseModel {
  static tableName = "fsoft_bare";
  static softDelete = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
  };
}

// softDelete WITH an explicit is_deleted field — the documented createTable() fix.
class FSoftDeclared extends BaseModel {
  static tableName = "fsoft_declared";
  static softDelete = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
    is_deleted: { type: "integer" as const, default: 0 },
  };
}

// softDelete provisioned via syncModels() (no explicit is_deleted) — boot path.
class FSoftSynced extends BaseModel {
  static tableName = "fsoft_synced";
  static softDelete = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "tina4-orm-footguns-"));

async function freshDb(file: string): Promise<Database> {
  const db = await initDatabase({ url: `sqlite:///${join(tmp, file)}` });
  await db.execute("CREATE TABLE fusers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)");
  return db;
}

async function run() {
  console.log("=== ORM Lifecycle Footguns (doc lock-in) ===\n");

  // ── 1. save()/create() fail soft; missing-table save carries the DX hint ──
  console.log("--- 1. write path fails soft (false, never rejects) + missing-table hint ---");
  {
    const db = await freshDb("f1.db");

    const ok = new FUser({ name: "Alice" });
    assert("valid save() resolves to the fluent self", (await ok.save()) === ok);
    assert("valid save() clears getError()", ok.getError() === null);

    // save() into a missing table returns false — never rejects — with a hint.
    let ghostResult: unknown;
    const threwGhost = await captureThrow(async () => {
      await quiet(async () => { ghostResult = await FGhost.create({ label: "x" }); });
    });
    assert("save()/create() into a missing table does NOT reject", threwGhost === null);
    assert("create() into a missing table resolves to false", ghostResult === false);

    const bareGhost = new FGhost({ label: "y" });
    await quiet(async () => { await bareGhost.save(); });
    assert("missing-table getError() is recoverable", !!bareGhost.getError());
    assert("missing-table getError() carries the createTable() DX hint",
      /createTable\(\)/.test(bareGhost.getError() ?? ""), `error was: ${bareGhost.getError()}`);
    assert("missing-table hint names the table", (bareGhost.getError() ?? "").includes("fghost_missing"));

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 2. Constructor: bad VALUES don't throw; array / bad-JSON DO throw ──
  console.log("\n--- 2. constructor validates nothing; array / bad JSON throw ---");
  {
    // A missing required field does NOT throw from the constructor (unlike Python).
    const built = (() => { try { return new FUser({ email: "no-name@x.com" }); } catch { return null; } })();
    assert("new Model({missing required}) does NOT throw", built instanceof FUser);
    // The error only surfaces at save() as false.
    const db = await freshDb("f2.db");
    let r: unknown;
    await quiet(async () => { r = await (built as FUser).save(); });
    assert("the missing field surfaces as save() -> false, not a constructor throw", r === false);
    assert("save() cause mentions the required field",
      (((built as FUser).getError()) ?? "").toLowerCase().includes("required"));

    // An array throws TypeError.
    let arrErr: unknown = null;
    try { new FUser([{ name: "a" }] as any); } catch (e) { arrErr = e; }
    assert("new Model([...]) throws TypeError", arrErr instanceof TypeError);

    // A non-JSON string throws (JSON.parse).
    let strErr: unknown = null;
    try { new FUser("not json" as any); } catch (e) { strErr = e; }
    assert("new Model('not json') throws", strErr instanceof Error);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 3. Read path does NOT validate — a constraint-violating row hydrates ──
  console.log("\n--- 3. hydration does not validate (no read-path validation trap) ---");
  {
    const db = await freshDb("f3.db");
    // Insert a name longer than the model's maxLength:10 via raw SQL, bypassing validate().
    await db.execute("INSERT INTO fusers (name, email) VALUES (?, ?)", ["this-name-is-way-too-long", "x@y.com"]);

    let rows: FUser[] = [];
    const threw = await captureThrow(async () => { rows = await FUser.all(); });
    assert("find/all() does NOT throw when hydrating a constraint-violating row", threw === null);
    assert("the over-length value is hydrated as-is", rows.length === 1 && rows[0].name === "this-name-is-way-too-long");

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 4. delete()/restore() throw (the asymmetry) ──
  console.log("\n--- 4. delete()/restore() throw (loud), unlike save() ---");
  {
    const db = await freshDb("f4.db");
    // delete() on an unsaved instance (no PK) throws.
    const unsaved = new FUser({ name: "Nope" });
    const delErr = await captureThrow(async () => { await unsaved.delete(); });
    assert("delete() on an unsaved instance throws (no PK)", delErr !== null);
    assert("delete() throw mentions the primary key",
      !!delErr && /primary key/i.test(delErr.message), delErr ? delErr.message : "no error");

    // restore() on a non-softDelete model throws.
    const saved = await FUser.create({ name: "Real" });
    const resErr = await captureThrow(async () => { await (saved as FUser).restore(); });
    assert("restore() on a non-softDelete model throws", resErr !== null);
    assert("restore() throw mentions softDelete",
      !!resErr && /softDelete/i.test(resErr.message), resErr ? resErr.message : "no error");

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 5. db.execute() throws on a driver error (not false) ──
  console.log("\n--- 5. db.execute() throws, does not return false ---");
  {
    const db = await freshDb("f5.db");
    const execErr = await captureThrow(async () => {
      await db.execute("INSERT INTO nonexistent_table (a) VALUES (?)", [1]);
    });
    assert("db.execute() on a bad statement throws", execErr !== null);
    assert("the cause is recoverable via db.getError()", !!db.getError());

    // A successful execute resolves truthy (never false-for-success).
    const okExec = await db.execute("INSERT INTO fusers (name) VALUES (?)", ["ok"]);
    assert("a successful db.execute() does not resolve to false", okExec !== false);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 6. No default ordering; where() caps at LIMIT 100 and takes no orderBy ──
  console.log("\n--- 6. ordering: find/all take orderBy; where() defaults to LIMIT 100 ---");
  {
    const db = await freshDb("f6.db");
    for (let i = 1; i <= 25; i++) {
      await db.execute("INSERT INTO fusers (name) VALUES (?)", [`u${i}`]);
    }

    // where() with no limit arg caps at 100 rows -- the one row cap the whole
    // family shares. It was 20 until 3.13.95; the footgun is unchanged in KIND
    // (the cap is a default, so a caller who wants more must ask), only in
    // number. 25 rows is now under the cap, so the cap is demonstrated with a
    // fixture that exceeds it.
    const w = await FUser.where("1 = 1");
    assert("where() returns all 25 rows when the table is under the 100 cap",
      w.length === 25, `got ${w.length}`);

    // find({}, n) is the way to lift the cap.
    const everyone = await FUser.find({}, 100);
    assert("find({}, 100) returns all 25 rows", everyone.length === 25, `got ${everyone.length}`);

    // find() takes an orderBy string; all() applies none by default.
    const desc = await FUser.find({}, 3, 0, "id DESC");
    assert("find() honours the orderBy arg (id DESC)",
      desc.length === 3 && Number(desc[0].id) > Number(desc[2].id), `ids: ${desc.map((d) => d.id)}`);

    // LAST in this block on purpose: it grows the table past the cap, which
    // would break the 25-row assertions above if it ran earlier.
    for (let i = 26; i <= 130; i++) {
      await db.execute("INSERT INTO fusers (name) VALUES (?)", [`u${i}`]);
    }
    const capped = await FUser.where("1 = 1");
    assert("where() caps at 100 once the table exceeds it (105 of 130 dropped silently)",
      capped.length === 100, `got ${capped.length}`);
    assert("an explicit limit still reaches past the cap",
      (await FUser.where("1 = 1", [], 130)).length === 130);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 7. DatabaseResult is not a list; ORM list methods return a plain array ──
  console.log("\n--- 7. db.fetch() -> DatabaseResult (.records); ORM list -> plain array ---");
  {
    const db = await freshDb("f7.db");
    await db.execute("INSERT INTO fusers (name) VALUES (?)", ["Zoe"]);

    const result = await db.fetch("SELECT * FROM fusers");
    assert("db.fetch() returns a DatabaseResult", result instanceof DatabaseResult);
    assert("rows live on .records", Array.isArray(result.records) && result.records.length === 1);
    assert("records are keyed dicts (result.records[0].name)", result.records[0].name === "Zoe");
    assert("DatabaseResult has .toJson()", typeof (result as any).toJson === "function");

    const list = await FUser.all();
    assert("ORM all() returns a plain Array", Array.isArray(list));
    assert("the plain array has NO .toJson() (that's a DatabaseResult method)",
      typeof (list as any).toJson === "undefined");

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── 8. softDelete provisioning: createTable() INJECTS is_deleted (SOFTDEL-DEC-02); syncModels() adds it too ──
  console.log("\n--- 8. softDelete needs is_deleted; createTable() injects it (SOFTDEL-DEC-02), syncModels() adds it too ---");
  {
    const db = await initDatabase({ url: `sqlite:///${join(tmp, "f8.db")}` });

    // (SOFTDEL-DEC-02) createTable() on a bare softDelete model now INJECTS
    // is_deleted, so the soft-delete path works with no manual column.
    await FSoftBare.createTable();
    const bare = await FSoftBare.create({ name: "bare" });
    assert("setup: bare softDelete row created", bare instanceof FSoftBare);
    const bareDelErr = await captureThrow(async () => { await (bare as FSoftBare).delete(); });
    assert("createTable() injects is_deleted → delete() does NOT throw", bareDelErr === null,
      bareDelErr ? bareDelErr.message : "no error");
    assert("bare softDelete row is filtered from reads after delete",
      (await FSoftBare.all()).length === 0);
    assert("the row still physically exists (soft, not hard, delete)",
      (await db.fetch("SELECT * FROM fsoft_bare")).records.length === 1);

    // (positive fix A) declaring is_deleted yourself + createTable() → soft delete works.
    await FSoftDeclared.createTable();
    const dec = await FSoftDeclared.create({ name: "dec" });
    let decDelThrew = await captureThrow(async () => { await (dec as FSoftDeclared).delete(); });
    assert("declared is_deleted + createTable() → delete() does NOT throw", decDelThrew === null);
    const remaining = await FSoftDeclared.all();
    assert("soft-deleted row is filtered from reads", remaining.length === 0, `got ${remaining.length}`);
    assert("the row still physically exists (soft, not hard, delete)",
      (await db.fetch("SELECT * FROM fsoft_declared")).records.length === 1);

    // (positive fix B) syncModels() provisions is_deleted for a bare softDelete model.
    await syncModels([{ definition: { tableName: FSoftSynced.tableName, fields: FSoftSynced.fields, softDelete: true } } as any]);
    const synced = await FSoftSynced.create({ name: "synced" });
    const syncDelThrew = await captureThrow(async () => { await (synced as FSoftSynced).delete(); });
    assert("syncModels() injects is_deleted → delete() does NOT throw", syncDelThrew === null);
    assert("syncModels()-provisioned soft delete filters the row from reads",
      (await FSoftSynced.all()).length === 0);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
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

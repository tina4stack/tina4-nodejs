/**
 * Regression: a route path param extracted by the REAL router must bind through
 * a REAL SQLite database and match an INTEGER primary-key column.
 *
 * Background (cross-framework parity, all 4 frameworks): in tina4-ruby a path
 * capture like `{id}`, extracted from a real HTTP request path, arrived as an
 * ASCII-8BIT (binary) string and bound to SQLite as a BLOB, so
 * `WHERE id = ?` never matched an INTEGER PK row — `GET /api/users/{id}`
 * returned 404 for a row that exists. Python master is correct: an untyped
 * string path param matches an INTEGER PK because SQLite coerces the TEXT
 * operand to the column's INTEGER affinity.
 *
 * Node.js strings are UTF-16 internally (no byte-encoding), so the untyped
 * param binds as TEXT and matches — Node does NOT have the Ruby bug. This test
 * LOCKS that in: if a future change ever made a path capture bind as a
 * BLOB/Buffer (or otherwise broke numeric-affinity matching), it would fail.
 *
 * No mocks: real `Router.match()` extraction + a real `node:sqlite` database
 * via the framework's own `initDatabase()` / SQLiteAdapter.
 *
 * Run with: npx vitest run test/routerPathParamPk.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Router } from "../packages/core/src/index.ts";
import { initDatabase, closeDatabase, type Database } from "../packages/orm/src/index.ts";

/** Fresh in-memory SQLite DB seeded with an INTEGER-PK `users` table. */
async function makeUsersDb(): Promise<Database> {
  const db = await initDatabase({ url: "sqlite:///:memory:" });
  await db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  await db.execute("INSERT INTO users (id, name) VALUES (1, 'Alice')");
  await db.execute("INSERT INTO users (id, name) VALUES (2, 'Bob')");
  await db.execute("INSERT INTO users (id, name) VALUES (3, 'Carol')");
  return db;
}

describe("router path param → INTEGER PK bind", () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeUsersDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { closeDatabase(); } catch { /* ignore */ }
  });

  it("router extracts untyped {id} from /users/2 as a plain JS string", () => {
    const router = new Router();
    router.get("/users/{id}", async () => {});

    const match = router.match("GET", "/users/2");
    expect(match).not.toBeNull();

    const id = match!.params["id"];
    // The Ruby bug was a binary (ASCII-8BIT) string; in Node it must be a plain
    // UTF-16 JS string, never a Buffer/typed array.
    expect(typeof id).toBe("string");
    expect(id).toBe("2");
    expect(Buffer.isBuffer(id)).toBe(false);
    expect(ArrayBuffer.isView(id as unknown as ArrayBufferView)).toBe(false);
  });

  it("untyped {id} string param matches an INTEGER PK row (numeric affinity)", async () => {
    const router = new Router();
    router.get("/users/{id}", async () => {});

    const id = router.match("GET", "/users/2")!.params["id"];
    // Bind the raw router-extracted (string) value through the real DB.
    const row = await db.fetchOne<{ id: number; name: string }>(
      "SELECT id, name FROM users WHERE id = ?",
      [id],
    );
    // This is the exact failure the Ruby bug produced: null / 404 for an
    // existing row. It must return the row.
    expect(row).not.toBeNull();
    expect(row!.id).toBe(2);
    expect(row!.name).toBe("Bob");
  });

  it("typed {id:int} param is a JS number and matches the INTEGER PK row", async () => {
    const router = new Router();
    router.get("/users/{id:int}", async () => {});

    const match = router.match("GET", "/users/2");
    expect(match).not.toBeNull();

    const id = match!.params["id"];
    expect(typeof id).toBe("number");
    expect(id).toBe(2);

    const row = await db.fetchOne<{ id: number; name: string }>(
      "SELECT id, name FROM users WHERE id = ?",
      [id],
    );
    expect(row).not.toBeNull();
    expect(row!.id).toBe(2);
    expect(row!.name).toBe("Bob");
  });

  it("a non-existent id (both forms) correctly returns no row (not a false match)", async () => {
    const rUntyped = new Router();
    rUntyped.get("/users/{id}", async () => {});
    const rInt = new Router();
    rInt.get("/users/{id:int}", async () => {});

    const missingStr = rUntyped.match("GET", "/users/999")!.params["id"];
    const missingInt = rInt.match("GET", "/users/999")!.params["id"];

    const rowStr = await db.fetchOne("SELECT id FROM users WHERE id = ?", [missingStr]);
    const rowInt = await db.fetchOne("SELECT id FROM users WHERE id = ?", [missingInt]);
    expect(rowStr).toBeNull();
    expect(rowInt).toBeNull();
  });
});

/**
 * v3.13.1 P1 parity tests for Node.js — three cross-framework convenience
 * additions the docs already assumed existed:
 *
 *   1. db.fetchAll(sql, params)            returns rows[] directly
 *   2. Database.getConnection(url, ...)    static factory
 *   3. new Api(url, { bearerToken, ... })  ergonomic options bag
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "@tina4/core";
import { Database, initDatabase } from "@tina4/orm";

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
    failed++;
  }
}

async function run(): Promise<void> {
  // ─── db.fetchAll ────────────────────────────────────────────────
  await it("fetchAll returns records array directly", async () => {
    const db = await initDatabase({ url: "sqlite::memory:" });
    await db.execute("CREATE TABLE u (id INTEGER, name TEXT)");
    await db.insert("u", { id: 1, name: "Alice" });
    await db.insert("u", { id: 2, name: "Bob" });
    const rows = await db.fetchAll<{ id: number; name: string }>("SELECT * FROM u ORDER BY id");
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, "Alice");
  });

  await it("fetchAll returns empty array when no rows", async () => {
    const db = await initDatabase({ url: "sqlite::memory:" });
    await db.execute("CREATE TABLE u (id INTEGER)");
    assert.deepEqual(await db.fetchAll("SELECT * FROM u"), []);
  });

  await it("fetchAll supports params and pagination", async () => {
    const db = await initDatabase({ url: "sqlite::memory:" });
    await db.execute("CREATE TABLE p (id INTEGER, active INTEGER)");
    for (let i = 0; i < 10; i++) await db.insert("p", { id: i, active: i % 2 });
    const active = await db.fetchAll<{ id: number }>("SELECT id FROM p WHERE active = ? ORDER BY id", [1], 3);
    assert.deepEqual(active.map((r) => r.id), [1, 3, 5]);
  });

  // ─── Database.getConnection ─────────────────────────────────────
  await it("Database.getConnection accepts explicit URL and returns a usable adapter", async () => {
    const db = await Database.getConnection("sqlite::memory:");
    assert.ok(db instanceof Database);
    // Exercise the connection end to end: the returned object must be a real,
    // queryable adapter, not just a constructed shell.
    await db.execute("CREATE TABLE g (id INTEGER)");
    await db.insert("g", { id: 7 });
    const row = await db.fetchOne<{ id: number }>("SELECT id FROM g");
    assert.equal(row?.id, 7);
    db.close();
  });

  await it("Database.getConnection falls back to a real in-memory SQLite when no URL", async () => {
    const prev = process.env.TINA4_DATABASE_URL;
    delete process.env.TINA4_DATABASE_URL;
    try {
      const db = await Database.getConnection();
      assert.ok(db instanceof Database);
      // The fallback must be a real, working in-memory SQLite — write and read
      // a row back through it, not merely assert the object exists.
      await db.execute("CREATE TABLE f (n INTEGER)");
      await db.insert("f", { n: 1 });
      const row = await db.fetchOne<{ c: number }>("SELECT COUNT(*) AS c FROM f");
      assert.equal(row?.c, 1);
      db.close();
    } finally {
      if (prev !== undefined) process.env.TINA4_DATABASE_URL = prev;
    }
  });

  await it("Database.getConnection reads TINA4_DATABASE_URL and connects to the env-sourced file DB", async () => {
    const prev = process.env.TINA4_DATABASE_URL;
    const tmp = mkdtempSync(join(tmpdir(), "tina4-getconn-"));
    const dbFile = join(tmp, "env.db");
    // Point the env var at a real file URL — getConnection() with no arg must
    // honour it (not fall back to the in-memory default).
    process.env.TINA4_DATABASE_URL = `sqlite:///${dbFile}`;
    try {
      const db = await Database.getConnection();
      assert.ok(db instanceof Database);
      await db.execute("CREATE TABLE e (id INTEGER, label TEXT)");
      await db.insert("e", { id: 42, label: "from-env" });
      const row = await db.fetchOne<{ id: number; label: string }>("SELECT id, label FROM e WHERE id = ?", [42]);
      assert.equal(row?.id, 42);
      assert.equal(row?.label, "from-env");
      db.close();
      // The env-sourced file URL drove a real file connection — the file exists
      // on disk, proving the env var (not a default) was honoured.
      assert.ok(existsSync(dbFile), `expected SQLite file at ${dbFile} to be created`);
    } finally {
      if (prev === undefined) delete process.env.TINA4_DATABASE_URL;
      else process.env.TINA4_DATABASE_URL = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ─── Api options-bag form ────────────────────────────────────────
  await it("Api options.bearerToken sets Authorization: Bearer", () => {
    const api = new Api("https://x.example", { bearerToken: "sk-test123" });
    // Access via reflection — auth header is private but stored as authHeader
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((api as any).authHeader, "Bearer sk-test123");
  });

  await it("Api options.username+password sets Basic auth", () => {
    const api = new Api("https://x.example", { username: "u", password: "p" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auth = (api as any).authHeader as string;
    assert.ok(auth.startsWith("Basic "));
  });

  await it("Api options.headers merges into request headers", () => {
    const api = new Api("https://x.example", { headers: { "X-Tenant": "acme" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((api as any).headers["X-Tenant"], "acme");
  });

  await it("Api options.verifySsl:false disables verification", () => {
    const api = new Api("https://x.example", { verifySsl: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((api as any).ignoreSsl, true);
  });

  await it("Api bearer wins over username/password when both passed", () => {
    const api = new Api("https://x.example", { bearerToken: "tok", username: "u", password: "p" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auth = (api as any).authHeader as string;
    assert.ok(auth.startsWith("Bearer "));
  });

  await it("Api legacy positional signature still works", () => {
    const api = new Api("https://x.example", "Bearer legacy", 30);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((api as any).authHeader, "Bearer legacy");
  });

  // eslint-disable-next-line no-console
  console.log(`\nParity P1 tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

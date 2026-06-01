/**
 * v3.13.1 P1 parity tests for Node.js — three cross-framework convenience
 * additions the docs already assumed existed:
 *
 *   1. db.fetchAll(sql, params)            returns rows[] directly
 *   2. Database.getConnection(url, ...)    static factory
 *   3. new Api(url, { bearerToken, ... })  ergonomic options bag
 */

import { strict as assert } from "node:assert";
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
    db.execute("CREATE TABLE u (id INTEGER, name TEXT)");
    db.insert("u", { id: 1, name: "Alice" });
    db.insert("u", { id: 2, name: "Bob" });
    const rows = db.fetchAll<{ id: number; name: string }>("SELECT * FROM u ORDER BY id");
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, "Alice");
  });

  await it("fetchAll returns empty array when no rows", async () => {
    const db = await initDatabase({ url: "sqlite::memory:" });
    db.execute("CREATE TABLE u (id INTEGER)");
    assert.deepEqual(db.fetchAll("SELECT * FROM u"), []);
  });

  await it("fetchAll supports params and pagination", async () => {
    const db = await initDatabase({ url: "sqlite::memory:" });
    db.execute("CREATE TABLE p (id INTEGER, active INTEGER)");
    for (let i = 0; i < 10; i++) db.insert("p", { id: i, active: i % 2 });
    const active = db.fetchAll<{ id: number }>("SELECT id FROM p WHERE active = ? ORDER BY id", [1], 3);
    assert.deepEqual(active.map((r) => r.id), [1, 3, 5]);
  });

  // ─── Database.getConnection ─────────────────────────────────────
  await it("Database.getConnection accepts explicit URL", async () => {
    const db = await Database.getConnection("sqlite::memory:");
    assert.ok(db instanceof Database);
  });

  await it("Database.getConnection falls back to in-memory SQLite when no URL", async () => {
    const prev = process.env.TINA4_DATABASE_URL;
    delete process.env.TINA4_DATABASE_URL;
    try {
      const db = await Database.getConnection();
      assert.ok(db instanceof Database);
    } finally {
      if (prev !== undefined) process.env.TINA4_DATABASE_URL = prev;
    }
  });

  await it("Database.getConnection reads TINA4_DATABASE_URL", async () => {
    const prev = process.env.TINA4_DATABASE_URL;
    process.env.TINA4_DATABASE_URL = "sqlite::memory:";
    try {
      const db = await Database.getConnection();
      assert.ok(db instanceof Database);
    } finally {
      if (prev === undefined) delete process.env.TINA4_DATABASE_URL;
      else process.env.TINA4_DATABASE_URL = prev;
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

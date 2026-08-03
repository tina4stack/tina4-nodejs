/**
 * DocStore - pymongo-style SQLite document store (JSON1 fallback).
 *
 * Locks the everyday CRUD + filter subset, the built-in ObjectId, value
 * round-trip (ObjectId/Date), cursor semantics, and the serverless selection
 * (SQLite when no Mongo configured). Mirrors tina4-python/tests/test_docstore.py.
 *
 * Run with: npx tsx test/docstore.test.ts
 */
import {
  ObjectId, InvalidId, SqliteDatabase, SqliteCollection,
  getCollection, isServerless, resetDefaultStore, compileFilter,
} from "../packages/orm/src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function freshOrders(): { db: SqliteDatabase; orders: SqliteCollection } {
  const db = new SqliteDatabase(":memory:");
  return { db, orders: db.getCollection("orders") };
}

// ── ObjectId ──────────────────────────────────────────────────────────────
console.log("\n--- ObjectId ---");
{
  const a = new ObjectId();
  const b = new ObjectId();
  assert("generates unique 24-hex", !a.equals(b) && /^[0-9a-f]{24}$/.test(a.toString()));

  const a2 = new ObjectId();
  assert("roundtrip from hex", new ObjectId(a2.toString()).equals(a2));

  assert("isValid true for real id", ObjectId.isValid(new ObjectId().toString()));
  assert("isValid false for 'nope'", !ObjectId.isValid("nope"));
  assert("isValid false for non-hex 24 chars", !ObjectId.isValid("zz".repeat(12)));

  let threw = false;
  try { new ObjectId("too-short"); } catch (e) { threw = e instanceof InvalidId; }
  assert("invalid raises InvalidId", threw);

  const gt = new ObjectId().generationTime;
  assert("generationTime is a Date", gt instanceof Date && !Number.isNaN(gt.getTime()));
}

// ── insert + find ───────────────────────────────────────────────────────────
console.log("\n--- insert + find ---");
{
  const { db, orders } = freshOrders();
  const res = await orders.insertOne({ customer_id: 1, total: 9.99 });
  assert("insertOne returns ObjectId", res.insertedId instanceof ObjectId);
  const got = await orders.findOne({ _id: res.insertedId });
  assert("inserted doc readable", got!.customer_id === 1 && got!.total === 9.99);
  assert("_id rehydrated to ObjectId", (got!._id as ObjectId).equals(res.insertedId as ObjectId));
  db.close();
}
{
  const { db, orders } = freshOrders();
  const ids = (await orders.insertMany(Array.from({ length: 5 }, (_, i) => ({ n: i })))).insertedIds;
  assert("insertMany returns 5 ids", ids.length === 5);
  assert("count after insertMany is 5", await orders.countDocuments({}) === 5);
  db.close();
}
{
  const { db, orders } = freshOrders();
  await orders.insertOne({ _id: "ORD-1", x: 1 });
  assert("custom _id preserved", (await orders.findOne({ _id: "ORD-1" }))!.x === 1);
  db.close();
}

// ── filter operators (pushed to SQL via json_extract) ───────────────────────
console.log("\n--- filter operators ---");
async function seeded(): Promise<{ db: SqliteDatabase; orders: SqliteCollection }> {
  const { db, orders } = freshOrders();
  await orders.insertMany([
    { customer_id: 1, status: "new", total: 10, tags: ["a"] },
    { customer_id: 2, status: "shipped", total: 50 },
    { customer_id: 3, status: "shipped", total: 99, vip: true },
  ]);
  return { db, orders };
}
{
  const { db, orders } = await seeded();
  assert("equality", await orders.countDocuments({ status: "shipped" }) === 2);

  const inGot = await orders.find({ customer_id: { $in: [1, 3] } }).toArray();
  assert("$in", new Set(inGot.map((d) => d.customer_id)).size === 2 &&
    inGot.every((d) => [1, 3].includes(d.customer_id as number)));

  assert("$gt", await orders.countDocuments({ total: { $gt: 10 } }) === 2);
  assert("$gte+$lt", await orders.countDocuments({ total: { $gte: 10, $lt: 99 } }) === 2);
  assert("$lte", await orders.countDocuments({ total: { $lte: 10 } }) === 1);
  assert("$ne", await orders.countDocuments({ status: { $ne: "shipped" } }) === 1);
  assert("$exists true", await orders.countDocuments({ vip: { $exists: true } }) === 1);
  assert("$exists false", await orders.countDocuments({ vip: { $exists: false } }) === 2);
  assert("$nin", await orders.countDocuments({ customer_id: { $nin: [1, 2] } }) === 1);
  assert("$regex", await orders.countDocuments({ status: { $regex: "^ship" } }) === 2);

  const orGot = await orders.find({ $or: [{ customer_id: 1 }, { total: { $gt: 90 } }] }).toArray();
  assert("$or", new Set(orGot.map((d) => d.customer_id)).size === 2 &&
    orGot.every((d) => [1, 3].includes(d.customer_id as number)));

  db.close();
}
{
  // pushdown-uses-json_extract assertion
  const { where, params } = compileFilter({ customer_id: { $in: [1, 2] } });
  assert("pushdown uses json_extract + IN placeholders",
    where.includes("json_extract(doc") && where.includes("IN (?,?)"),
    `(where=${where})`);
  // The operands are bound ONCE PER BRANCH - the scalar-field branch and the
  // array-element branch each carry their own placeholders. This doubled when
  // Mongo's array rule landed; the intent the test protects is that the filter
  // is pushed into SQL, never scanned in memory.
  assert("pushdown params bound", JSON.stringify(params) === JSON.stringify([1, 2, 1, 2]),
    JSON.stringify(params));

  // The array rule is pushed down too, rather than applied after the fact.
  const arr = compileFilter({ tags: "x" });
  assert("pushdown covers array elements", arr.where.includes("json_each(doc"), arr.where);
  assert("pushdown array params bound", JSON.stringify(arr.params) === JSON.stringify(["x", "x"]));
}

// ── cursor: sort / limit / skip / projection ────────────────────────────────
console.log("\n--- cursor ---");
async function tenDocs(): Promise<{ db: SqliteDatabase; orders: SqliteCollection }> {
  const { db, orders } = freshOrders();
  await orders.insertMany(Array.from({ length: 10 }, (_, i) => ({ n: i, grp: "g" })));
  return { db, orders };
}
{
  const { db, orders } = await tenDocs();
  const desc = await orders.find({ grp: "g" }).sort("n", -1).toArray();
  assert("sort desc", JSON.stringify(desc.map((d) => d.n)) ===
    JSON.stringify(Array.from({ length: 10 }, (_, i) => 9 - i)));

  const sl = await orders.find({ grp: "g" }).sort("n", 1).skip(2).limit(3).toArray();
  assert("limit+skip", JSON.stringify(sl.map((d) => d.n)) === JSON.stringify([2, 3, 4]));

  const inc = await orders.findOne({ n: 5 }, { n: 1, _id: 0 });
  assert("projection include", JSON.stringify(inc) === JSON.stringify({ n: 5 }));

  const exc = await orders.findOne({ n: 5 }, { grp: 0 });
  assert("projection exclude", !("grp" in exc!) && exc!.n === 5 && "_id" in exc!);

  db.close();
}

// ── Date round-trip + sortability ───────────────────────────────────────────
console.log("\n--- Date round-trip + sort ---");
{
  const { db, orders } = freshOrders();
  const base = new Date("2024-01-01T00:00:00Z");
  await orders.insertMany([
    { k: "b", created_at: new Date("2024-03-01T00:00:00Z") },
    { k: "a", created_at: new Date("2024-01-01T00:00:00Z") },
    { k: "c", created_at: new Date("2024-06-01T00:00:00Z") },
  ]);
  const got = await orders.find({}).sort("created_at", -1).toArray();
  assert("date sort desc", JSON.stringify(got.map((d) => d.k)) === JSON.stringify(["c", "b", "a"]));
  assert("date rehydrated to Date", got[0].created_at instanceof Date);
  assert("date range query ($gte base)", await orders.countDocuments({ created_at: { $gte: base } }) === 3);
  db.close();
}

// ── ObjectId round-trip in a field ──────────────────────────────────────────
console.log("\n--- ObjectId field round-trip ---");
{
  const { db, orders } = freshOrders();
  const ref = new ObjectId();
  await orders.insertOne({ ref });
  const got = await orders.findOne({});
  assert("ObjectId field rehydrated", got!.ref instanceof ObjectId && (got!.ref as ObjectId).equals(ref));
  assert("ObjectId field queryable by value", await orders.countDocuments({ ref }) === 1);
  db.close();
}

// ── updates ──────────────────────────────────────────────────────────────────
console.log("\n--- updates ---");
{
  const { db, orders } = freshOrders();
  const oid = (await orders.insertOne({ status: "new", count: 1, tmp: "x" })).insertedId;
  await orders.updateOne({ _id: oid }, { $set: { status: "shipped" } });
  await orders.updateOne({ _id: oid }, { $inc: { count: 5 } });
  await orders.updateOne({ _id: oid }, { $unset: { tmp: "" } });
  const d = await orders.findOne({ _id: oid })!;
  assert("$set/$inc/$unset", d.status === "shipped" && d.count === 6 && !("tmp" in d));
  db.close();
}
{
  const { db, orders } = freshOrders();
  await orders.insertMany([{ s: "a" }, { s: "a" }, { s: "b" }]);
  const res = await orders.updateMany({ s: "a" }, { $set: { s: "z" } });
  assert("updateMany counts", res.matchedCount === 2 && res.modifiedCount === 2);
  assert("updateMany applied", await orders.countDocuments({ s: "z" }) === 2);
  db.close();
}
{
  const { db, orders } = freshOrders();
  const oid = (await orders.insertOne({ a: 1 })).insertedId;
  await orders.replaceOne({ _id: oid }, { b: 2 });
  const d = await orders.findOne({ _id: oid })!;
  assert("replaceOne keeps _id, drops old fields", d.b === 2 && !("a" in d) && (d._id as ObjectId).equals(oid as ObjectId));
  db.close();
}
{
  const { db, orders } = freshOrders();
  const res = await orders.updateOne({ sku: "X1" }, { $set: { qty: 3 } }, { upsert: true });
  assert("upsert returns upsertedId", res.upsertedId !== null);
  assert("upsert created doc", (await orders.findOne({ sku: "X1" }))!.qty === 3);
  db.close();
}
{
  const { db, orders } = freshOrders();
  const oid = (await orders.insertOne({ a: { b: 1 } })).insertedId;
  await orders.updateOne({ _id: oid }, { $set: { "a.c": 2 } });
  const d = await orders.findOne({ _id: oid })!;
  assert("nested $set", JSON.stringify(d.a) === JSON.stringify({ b: 1, c: 2 }));
  db.close();
}

// ── deletes + nested filter ──────────────────────────────────────────────────
console.log("\n--- deletes + nested filter ---");
{
  const { db, orders } = freshOrders();
  await orders.insertMany([{ s: "a" }, { s: "a" }, { s: "b" }]);
  assert("deleteOne count 1", (await orders.deleteOne({ s: "a" })).deletedCount === 1);
  assert("deleteMany count 1", (await orders.deleteMany({ s: "a" })).deletedCount === 1);
  assert("count after deletes", await orders.countDocuments({}) === 1);
  db.close();
}
{
  const { db, orders } = freshOrders();
  await orders.insertOne({ addr: { city: "Cape Town" } });
  await orders.insertOne({ addr: { city: "Joburg" } });
  assert("nested dotted filter", await orders.countDocuments({ "addr.city": "Cape Town" }) === 1);
  db.close();
}

// ── db attribute/item-style access ───────────────────────────────────────────
console.log("\n--- database collection access ---");
{
  const db = new SqliteDatabase(":memory:");
  await db.getCollection("a").insertOne({ x: 1 });
  assert("getCollection count", await db.getCollection("a").countDocuments({}) === 1);
  assert("listCollectionNames includes 'a'", db.listCollectionNames().includes("a"));
  db.close();
}

// ── serverless selection ─────────────────────────────────────────────────────
console.log("\n--- serverless selection ---");
{
  const prevUri = process.env.TINA4_MONGO_URI;
  const prevSess = process.env.TINA4_SESSION_MONGO_URI;
  delete process.env.TINA4_MONGO_URI;
  delete process.env.TINA4_SESSION_MONGO_URI;
  assert("isServerless true when no Mongo configured", isServerless() === true);

  const tmp = mkdtempSync(join(tmpdir(), "tina4-ds-"));
  const prevPath = process.env.TINA4_DOC_STORE_PATH;
  process.env.TINA4_DOC_STORE_PATH = join(tmp, "ds.db");
  resetDefaultStore();
  const col = await getCollection("widgets");
  assert("getCollection returns SqliteCollection when serverless", col instanceof SqliteCollection);
  if (col instanceof SqliteCollection) {
    await col.insertOne({ name: "bolt" });
    assert("serverless collection persists + reads", (await col.findOne({ name: "bolt" }))!.name === "bolt");
  }
  resetDefaultStore();

  // Mongo configured => not serverless.
  process.env.TINA4_MONGO_URI = "mongodb://localhost:27017/tina4";
  assert("isServerless false when Mongo URI set", isServerless() === false);

  // restore
  if (prevUri === undefined) delete process.env.TINA4_MONGO_URI; else process.env.TINA4_MONGO_URI = prevUri;
  if (prevSess === undefined) delete process.env.TINA4_SESSION_MONGO_URI; else process.env.TINA4_SESSION_MONGO_URI = prevSess;
  if (prevPath === undefined) delete process.env.TINA4_DOC_STORE_PATH; else process.env.TINA4_DOC_STORE_PATH = prevPath;
  rmSync(tmp, { recursive: true, force: true });
}

// ── session-Mongo env-var parity (canonical _URI, legacy _URL alias) ─────────
console.log("\n--- session-Mongo env parity ---");
{
  const prevUri = process.env.TINA4_MONGO_URI;
  const prevSess = process.env.TINA4_SESSION_MONGO_URI;
  const prevSessUrl = process.env.TINA4_SESSION_MONGO_URL;
  delete process.env.TINA4_MONGO_URI;
  delete process.env.TINA4_SESSION_MONGO_URI;
  delete process.env.TINA4_SESSION_MONGO_URL;

  // Canonical TINA4_SESSION_MONGO_URI resolves.
  process.env.TINA4_SESSION_MONGO_URI = "mongodb://uri-host/db";
  assert("session _URI is read (not serverless)", isServerless() === false);

  // Legacy TINA4_SESSION_MONGO_URL still resolves (back-compat alias).
  delete process.env.TINA4_SESSION_MONGO_URI;
  process.env.TINA4_SESSION_MONGO_URL = "mongodb://url-host/db";
  assert("legacy session _URL still resolves (not serverless)", isServerless() === false);

  // restore
  if (prevUri === undefined) delete process.env.TINA4_MONGO_URI; else process.env.TINA4_MONGO_URI = prevUri;
  if (prevSess === undefined) delete process.env.TINA4_SESSION_MONGO_URI; else process.env.TINA4_SESSION_MONGO_URI = prevSess;
  if (prevSessUrl === undefined) delete process.env.TINA4_SESSION_MONGO_URL; else process.env.TINA4_SESSION_MONGO_URL = prevSessUrl;
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

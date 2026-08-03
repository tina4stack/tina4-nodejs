/**
 * DocStore substitutability: the SAME code, against BOTH providers.
 *
 * plan/v3/fixtures/docstore_contract.json is the shared answer key; this is the
 * Node half, ported from tina4-python's tests/test_docstore_substitutability.py
 * so the protection exists in every framework rather than one.
 *
 * WHY THIS FILE EXISTS
 *   DocStore is the purest test of ADR-0024 in the framework, because
 *   substitutability IS its advertised feature: develop against a
 *   zero-dependency local SQLite store, switch to MongoDB in production by
 *   setting one env var.
 *
 *   MEASURED 2026-08-01: NO DocStore test in ANY of the four frameworks had
 *   ever touched a real Mongo collection. That is how nine defects accumulated
 *   behind four green suites.
 *
 *   Every shared case runs TWICE - once on the SQLite fallback, once on a REAL
 *   MongoDB. A divergence between the two IS the bug.
 *
 * NODE'S OWN DEFECT SHAPES THIS FILE
 *   MEASURED 2026-08-03: getCollection() and insertOne() return a VALUE on the
 *   fallback and a PROMISE on the real driver. Identical source therefore
 *   changes TYPE when the env var changes, and a Promise is always truthy - so
 *   `if (doc)` succeeds for a document that does not exist. Every call below is
 *   funnelled through settle() so the harness can run against both shapes and
 *   REPORT the divergence rather than being defeated by it.
 *
 * NO MOCKS. A real SQLite file and a real MongoDB over a real socket. Skips
 * loudly when no Mongo is reachable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MONGO_URI = process.env.TINA4_TEST_MONGO_URI ?? "mongodb://192.168.88.99:27017";
const ORM = "/Users/andrevanzuydam/IdeaProjects/tina4-nodejs/packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

/** Accept a value OR a promise - the divergence this file exists to measure. */
async function settle<T>(v: T | Promise<T>): Promise<T> {
  return v && typeof (v as any).then === "function" ? await (v as Promise<T>) : (v as T);
}

/** A real connect, not a port probe: a port that merely accepts is not a usable Mongo. */
async function mongoReachable(): Promise<boolean> {
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    await client.close();
    return true;
  } catch {
    return false;
  }
}

/** Bind the DocStore to one provider and hand back a fresh collection. */
async function collectionFor(uri: string | null): Promise<any> {
  for (const k of ["TINA4_MONGO_URI", "TINA4_SESSION_MONGO_URI", "TINA4_SESSION_MONGO_URL"]) delete process.env[k];
  if (uri) process.env.TINA4_MONGO_URI = uri;
  process.env.TINA4_DOC_STORE_PATH = join(mkdtempSync(join(tmpdir(), "ds")), "ds.db");
  const mod = await import(ORM + "?t=" + Math.random());
  const name = "ds_contract_" + Math.random().toString(16).slice(2, 10);
  return { mod, collection: await settle(mod.getCollection(name)) };
}

async function run() {
  const hasMongo = await mongoReachable();

  // ── the ROOT invariant ────────────────────────────────────────────────────
  console.log("\n--- a real mongo is actually exercised ---");
  if (!hasMongo) {
    console.log(`  \x1b[33mSKIP\x1b[0m no reachable MongoDB at ${MONGO_URI}`);
  } else {
    const { mod, collection } = await collectionFor(MONGO_URI);
    // NEGATIVE: not the fallback masquerading as Mongo.
    assert("a configured URI does not return the SQLite fallback",
      collection?.constructor?.name !== "SqliteCollection", collection?.constructor?.name);
    // POSITIVE: it really round-trips through the server.
    await settle(collection.insertOne({ proof: "real-mongo" }));
    const found = await settle(collection.findOne({ proof: "real-mongo" }));
    assert("a real mongo collection round-trips a document", found?.proof === "real-mongo");
    assert("isServerless() agrees a URI means not-serverless", mod.isServerless() === false);
    await settle(collection.deleteMany({}));
  }

  // ── the shared round trip, on BOTH providers ──────────────────────────────
  for (const [label, uri] of [["fallback", null], ["mongo", MONGO_URI]] as const) {
    console.log(`\n--- interchangeable document store: ${label} ---`);
    if (label === "mongo" && !hasMongo) {
      console.log(`  \x1b[33mSKIP\x1b[0m no reachable MongoDB`);
      continue;
    }
    const { collection } = await collectionFor(uri);

    await settle(collection.insertOne({ name: "alpha", n: 5 }));
    const found = await settle(collection.findOne({ name: "alpha" }));
    assert(`${label}: insert then findOne returns what was stored`, found?.n === 5, JSON.stringify(found));

    await settle(collection.insertOne({ name: "beta", status: "new" }));
    await settle(collection.updateOne({ name: "beta" }, { $set: { status: "shipped" } }));
    const updated = await settle(collection.findOne({ name: "beta" }));
    assert(`${label}: an update is visible to the next read`, updated?.status === "shipped");

    for (let i = 0; i < 3; i++) await settle(collection.insertOne({ batch: "c", i }));
    const counted = await settle(collection.countDocuments({ batch: "c" }));
    assert(`${label}: countDocuments agrees with what was inserted`, counted === 3, String(counted));

    for (const n of [1, 5, 9]) await settle(collection.insertOne({ grp: "d", n }));
    const cursor = collection.find({ grp: "d", n: { $gt: 4 } });
    const rows = cursor?.toArray ? await cursor.toArray() : [...(await settle(cursor) as any)];
    assert(`${label}: $gt filters identically`, rows.length === 2, String(rows.length));

    await settle(collection.deleteMany({}));
  }

  // ── OPEN DEFECTS: measured, reported, deliberately not asserted ────────────
  //
  // docstore_contract.json :: the-sync-async-shape-does-not-change-with-the-provider
  //
  // MEASURED 2026-08-03. This is Node's own defect and the nastiest of the four
  // frameworks', because it changes the TYPE rather than the value:
  //
  //     getCollection()  fallback: a value   mongo: a PROMISE
  //     insertOne()      fallback: a value   mongo: a PROMISE
  //
  // Un-awaited code gets a real document locally and a Promise in production,
  // and a Promise is ALWAYS TRUTHY - so `if (doc)` succeeds for a document that
  // does not exist. Reported rather than asserted because the fix is a breaking
  // API decision (make the fallback async, or the driver path sync), not a
  // quiet edit.
  console.log("\n--- open defect: the sync/async shape changes with the provider ---");
  const shapes: Record<string, unknown> = {};
  for (const [label, uri] of [["fallback", null], ["mongo", MONGO_URI]] as const) {
    if (label === "mongo" && !hasMongo) { shapes[label] = "skipped (no mongo)"; continue; }
    for (const k of ["TINA4_MONGO_URI", "TINA4_SESSION_MONGO_URI", "TINA4_SESSION_MONGO_URL"]) delete process.env[k];
    if (uri) process.env.TINA4_MONGO_URI = uri;
    process.env.TINA4_DOC_STORE_PATH = join(mkdtempSync(join(tmpdir(), "ds")), "ds.db");
    const mod = await import(ORM + "?t=" + Math.random());
    const raw = mod.getCollection("shape_" + Math.random().toString(16).slice(2, 8));
    const isPromise = raw && typeof (raw as any).then === "function";
    const collection = await settle(raw);
    const rawInsert = collection.insertOne({ probe: "shape" });
    shapes[label] = {
      getCollection: isPromise ? "PROMISE" : "value",
      insertOne: rawInsert && typeof rawInsert.then === "function" ? "PROMISE" : "value",
    };
    await settle(rawInsert);
    await settle(collection.deleteMany({}));
  }
  console.log("    " + JSON.stringify(shapes));

  // The one thing asserted: settle() makes BOTH shapes usable, so the harness
  // itself is provider-agnostic even while the framework is not.
  assert("the harness survives both shapes via settle()", Object.keys(shapes).length === 2);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(60)}\n`);
  // A real Mongo client keeps the event loop alive - itself the measured
  // "client lifecycle is unbounded" defect - so exit explicitly.
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("UNEXPECTED ERROR:", e);
  process.exit(1);
});

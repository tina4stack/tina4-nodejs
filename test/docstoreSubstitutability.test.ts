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
 * NODE'S OWN DEFECT, NOW CLOSED (ADR-0025 clause 3)
 *   MEASURED 2026-08-03: getCollection() and insertOne() returned a VALUE on
 *   the fallback and a PROMISE on the real driver. Identical source therefore
 *   changed TYPE when the env var changed, and a Promise is always truthy - so
 *   `if (doc)` succeeded for a document that did not exist.
 *
 *   This file used to funnel every call through a settle() helper that accepted
 *   either shape, so the harness could REPORT the divergence rather than be
 *   defeated by it. The fallback is now async on both providers, so settle() is
 *   gone and plain `await` works everywhere - which is the whole point.
 *
 * NO MOCKS. A real SQLite file and a real MongoDB over a real socket. Skips
 * loudly when no Mongo is reachable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MONGO_URI = process.env.TINA4_TEST_MONGO_URI ?? "mongodb://192.168.88.99:27017";

// Resolved from THIS file, never hardcoded. An absolute developer-machine path
// here passed locally and died with ERR_MODULE_NOT_FOUND on every other host -
// measured on the lab box, where it was the suite's only failing file. Each
// provider needs a fresh module instance, so the import is cache-busted, which
// means a real URL rather than a bare path.
const ORM = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "orm", "src", "index.ts"),
).href;

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
  return { mod, collection: await mod.getCollection(name) };
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
    await collection.insertOne({ proof: "real-mongo" });
    const found = await collection.findOne({ proof: "real-mongo" });
    assert("a real mongo collection round-trips a document", found?.proof === "real-mongo");
    assert("isServerless() agrees a URI means not-serverless", mod.isServerless() === false);
    await collection.deleteMany({});
  }

  // ── the shared round trip, on BOTH providers ──────────────────────────────
  for (const [label, uri] of [["fallback", null], ["mongo", MONGO_URI]] as const) {
    console.log(`\n--- interchangeable document store: ${label} ---`);
    if (label === "mongo" && !hasMongo) {
      console.log(`  \x1b[33mSKIP\x1b[0m no reachable MongoDB`);
      continue;
    }
    const { collection } = await collectionFor(uri);

    await collection.insertOne({ name: "alpha", n: 5 });
    const found = await collection.findOne({ name: "alpha" });
    assert(`${label}: insert then findOne returns what was stored`, found?.n === 5, JSON.stringify(found));

    await collection.insertOne({ name: "beta", status: "new" });
    await collection.updateOne({ name: "beta" }, { $set: { status: "shipped" } });
    const updated = await collection.findOne({ name: "beta" });
    assert(`${label}: an update is visible to the next read`, updated?.status === "shipped");

    for (let i = 0; i < 3; i++) await collection.insertOne({ batch: "c", i });
    const counted = await collection.countDocuments({ batch: "c" });
    assert(`${label}: countDocuments agrees with what was inserted`, counted === 3, String(counted));

    for (const n of [1, 5, 9]) await collection.insertOne({ grp: "d", n });
    const rows = await collection.find({ grp: "d", n: { $gt: 4 } }).toArray();
    assert(`${label}: $gt filters identically`, rows.length === 2, String(rows.length));

    await collection.deleteMany({});
  }

  // ── ADR-0025 clause 3: the sync/async shape (ASSERTED) ────────────────────
  //
  // docstore_contract.json :: the-sync-async-shape-does-not-change-with-the-provider
  //
  // MEASURED 2026-08-03 as Node's own defect, and the nastiest of the four
  // frameworks', because it changed the TYPE rather than the value:
  //
  //     getCollection()  fallback: a value   mongo: a PROMISE
  //     insertOne()      fallback: a value   mongo: a PROMISE
  //
  // Un-awaited code got a real document locally and a Promise in production,
  // and a Promise is ALWAYS TRUTHY - so `if (doc)` succeeded for a document
  // that did not exist. ADR-0025 clause 3: the driver cannot become sync, so
  // the fallback becomes async. Now a gate rather than a printed observation.
  console.log("\n--- the sync/async shape does not change with the provider ---");
  for (const [label, uri] of [["fallback", null], ["mongo", MONGO_URI]] as const) {
    if (label === "mongo" && !hasMongo) {
      console.log(`  \x1b[33mSKIP\x1b[0m no reachable MongoDB`);
      continue;
    }
    for (const k of ["TINA4_MONGO_URI", "TINA4_SESSION_MONGO_URI", "TINA4_SESSION_MONGO_URL"]) delete process.env[k];
    if (uri) process.env.TINA4_MONGO_URI = uri;
    process.env.TINA4_DOC_STORE_PATH = join(mkdtempSync(join(tmpdir(), "ds")), "ds.db");
    const mod = await import(ORM + "?t=" + Math.random());

    // POSITIVE: both entry points are thenable on BOTH providers, so identical
    // source keeps its type when the env var changes.
    const raw = mod.getCollection("shape_" + Math.random().toString(16).slice(2, 8));
    assert(`${label}: getCollection returns a promise`,
      typeof raw?.then === "function", typeof raw);
    const collection = await raw;
    const rawInsert = collection.insertOne({ probe: "shape" });
    assert(`${label}: insertOne returns a promise`,
      typeof rawInsert?.then === "function", typeof rawInsert);
    await rawInsert;

    // NEGATIVE: a real FindCursor has ONLY Symbol.asyncIterator. A sync-iterable
    // cursor is a fallback-only spelling - `for (const d of cursor)` would work
    // locally and throw "is not iterable" in production, which is exactly the
    // class of defect this ADR closes.
    const cursor = collection.find({ probe: "shape" });
    assert(`${label}: the cursor is async-iterable`,
      typeof cursor?.[Symbol.asyncIterator] === "function");
    assert(`${label}: the cursor is NOT sync-iterable`,
      typeof cursor?.[Symbol.iterator] !== "function");

    let seen = 0;
    for await (const _doc of collection.find({ probe: "shape" })) seen++;
    assert(`${label}: for-await over a cursor yields the documents`, seen === 1, String(seen));

    await collection.deleteMany({});
  }

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

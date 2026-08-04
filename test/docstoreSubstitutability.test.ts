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
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MONGO_URI = process.env.TINA4_TEST_MONGO_URI ?? "mongodb://192.168.88.99:27017";

// Resolved from THIS file, never hardcoded. An absolute developer-machine path
// here passed locally and died with ERR_MODULE_NOT_FOUND on every other host -
// measured on the lab box, where it was the suite's only failing file. Each
// provider needs a fresh module instance, so the import is cache-busted, which
// means a real URL rather than a bare path.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORM = pathToFileURL(
  join(REPO_ROOT, "packages", "orm", "src", "index.ts"),
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

  // ── the driverless environment (ADR-0033) ─────────────────────────────────
  //
  // NO MOCKS, and this is the case where that rule bites hardest: stubbing the
  // module loader is exactly the forbidden thing, because the bug being pinned
  // IS how the resolution failure is handled. A stub would test the stub.
  //
  // So `mongodb` is made GENUINELY unresolvable. docstore.ts imports only
  // node: builtins, so esbuild can emit it into a directory OUTSIDE the repo,
  // where Node's resolution walks up through /tmp and never reaches the repo's
  // node_modules. `import("mongodb")` really fails there with a real
  // ERR_MODULE_NOT_FOUND. That is precisely what a consumer gets from
  // `npm install --omit=optional`, since mongodb is an optionalDependency.
  //
  // The child reports whether it really was driverless, so a leaky environment
  // FAILS instead of quietly proving nothing.
  console.log("\n--- a missing driver has one outcome in all four ---");
  {
    const scratch = mkdtempSync(join(tmpdir(), "tina4-driverless-"));
    const bundled = join(scratch, "docstore.mjs");
    const storePath = join(scratch, "must_not_be_created.db");
    // A password in the URI, so the credential-leak assertion has something
    // real to catch.
    const uriWithCredentials = "mongodb://docstore_user:s3cr3t-p4ssw0rd@192.0.2.1:27017";

    const esbuild = join(REPO_ROOT, "node_modules", ".bin", "esbuild");
    execFileSync(esbuild, [
      join(REPO_ROOT, "packages", "orm", "src", "docstore.ts"),
      "--format=esm", "--platform=node", "--target=node20", `--outfile=${bundled}`,
    ], { stdio: "pipe" });

    const probe = join(scratch, "probe.mjs");
    writeFileSync(probe, `
      import { existsSync } from "node:fs";
      const report = {};
      try { await import("mongodb"); report.driverless = false; }
      catch (e) { report.driverless = e?.code === "ERR_MODULE_NOT_FOUND"; }
      const ds = await import("./docstore.mjs");
      report.isServerless = ds.isServerless();
      try {
        const collection = await ds.getCollection("driver_absence_probe");
        report.outcome = "returned";
        report.returnedType = collection?.constructor?.name;
      } catch (e) {
        report.outcome = "threw";
        report.errorName = e?.name;
        report.message = String(e?.message ?? "");
      }
      report.storeFileExists = existsSync(process.env.TINA4_DOC_STORE_PATH);
      process.stdout.write("__PROBE__" + JSON.stringify(report));
    `);

    const raw = execFileSync(process.execPath, [probe], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        TINA4_MONGO_URI: uriWithCredentials,
        TINA4_DOC_STORE_PATH: storePath,
      },
    });
    const report = JSON.parse(raw.split("__PROBE__")[1]);

    // The environment must really be driverless, or nothing below means
    // anything. This FAILS rather than skipping, on purpose.
    assert("the probe environment really has no mongodb driver",
      report.driverless === true, "the driver resolved, so this would have proved nothing");

    assert("a configured URI still means not-serverless with no driver",
      report.isServerless === false, String(report.isServerless));
    assert("a missing driver raises instead of using the local file",
      report.outcome === "threw", `got ${report.returnedType}`);
    assert("the throw is the documented DocStoreDriverMissing",
      report.errorName === "DocStoreDriverMissing", String(report.errorName));
    assert("the message names the missing package",
      String(report.message).includes("mongodb"), report.message);
    assert("the message names how to install it",
      String(report.message).includes("npm install mongodb"), report.message);
    assert("the message names the env var to unset",
      String(report.message).includes("TINA4_MONGO_URI"), report.message);
    // NEGATIVE: naming the variable must not mean printing its value. A Mongo
    // URI routinely carries credentials and an error string is the most-logged
    // text a framework emits.
    assert("the message does not leak the uri credentials",
      !String(report.message).includes("s3cr3t-p4ssw0rd"), report.message);
    // NEGATIVE, and the one that matters most: nothing was written locally.
    assert("no local SQLite store was created",
      report.storeFileExists === false, "the fallback was reached anyway");

    rmSync(scratch, { recursive: true, force: true });
  }

  // POSITIVE half: the throw must be about the DRIVER, not the URI. Without
  // this, deleting the whole real-Mongo path would satisfy the case above.
  if (!hasMongo) {
    console.log(`  \x1b[33mSKIP\x1b[0m no reachable MongoDB at ${MONGO_URI}`);
  } else {
    const { mod, collection } = await collectionFor(MONGO_URI);
    assert("the same uri with the driver present still selects mongo",
      mod.isServerless() === false && collection?.constructor?.name !== "SqliteCollection",
      collection?.constructor?.name);
    await collection.insertOne({ proof: "driver-present" });
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

  // -- ADR-0036 / the-call-site-surface-is-identical (ASSERTED) ---------------
  //
  // docstore_contract.json :: the-call-site-surface-is-identical
  //
  // ADR-0036. The chain the framework DOCUMENTS must run on both providers.
  //
  // Node's chain already worked - a real FindCursor is lazy and chainable, and
  // so is the fallback Cursor. What did NOT work, measured 2026-08-04 against a
  // real MongoDB, was the OBJECT sort spelling: `sort({ total: -1 })` threw
  // `TypeError: keyOrList is not iterable` on the fallback while working on the
  // driver. Same defect class, one layer down, and present in three of the four
  // frameworks - so all three spellings are asserted rather than only the
  // documented one.
  console.log("\n--- the cursor chain works on both providers ---");
  for (const [label, uri] of [["fallback", null], ["mongo", MONGO_URI]] as [string, string | null][]) {
    if (uri && !hasMongo) {
      console.log(`  \x1b[33mSKIP\x1b[0m no reachable MongoDB`);
      continue;
    }
    const { collection } = await collectionFor(uri);
    for (const total of [9, 7, 3]) await collection.insertOne({ total, grp: "chain" });

    const spellings: [string, () => any][] = [
      ["sort(field, direction)", () => collection.find({ grp: "chain" }).sort("total", -1).limit(2)],
      ["sort(object)", () => collection.find({ grp: "chain" }).sort({ total: -1 }).limit(2)],
      ["sort(pairs)", () => collection.find({ grp: "chain" }).sort([["total", -1]]).limit(2)],
    ];
    for (const [spelling, chain] of spellings) {
      const viaToArray = (await chain().toArray()).map((d: any) => d.total);
      assert(`${label} ${spelling}: toArray over the chain orders and caps`,
        JSON.stringify(viaToArray) === "[9,7]", JSON.stringify(viaToArray));

      const viaForAwait: number[] = [];
      for await (const doc of chain()) viaForAwait.push((doc as any).total);
      assert(`${label} ${spelling}: for-await over the chain orders and caps`,
        JSON.stringify(viaForAwait) === "[9,7]", JSON.stringify(viaForAwait));
    }

    // skip composes, and ascending is not merely the absence of descending - a
    // direction that is ignored would pass a descending-only test.
    const skipped = (await collection.find({ grp: "chain" }).sort("total", -1).skip(1).limit(1).toArray())
      .map((d: any) => d.total);
    assert(`${label}: skip composes with sort and limit`,
      JSON.stringify(skipped) === "[7]", JSON.stringify(skipped));
    const ascending = (await collection.find({ grp: "chain" }).sort("total", 1).limit(2).toArray())
      .map((d: any) => d.total);
    assert(`${label}: an ascending sort actually ascends`,
      JSON.stringify(ascending) === "[3,7]", JSON.stringify(ascending));

    // LAZY: building the chain must not execute it.
    const pending = collection.find({ grp: "chain" }).sort("total", -1);
    await collection.insertOne({ total: 99, grp: "chain" });
    const afterInsert = (await pending.toArray()).map((d: any) => d.total);
    assert(`${label}: the chain runs at materialisation, not at find()`,
      afterInsert[0] === 99, JSON.stringify(afterInsert));

    await collection.deleteMany({});
  }

  // ── ADR-0025 / client-lifecycle-is-bounded (ASSERTED) ─────────────────────
  //
  // docstore_contract.json :: client-lifecycle-is-bounded
  //
  // MEASURED 2026-08-03 against a real MongoDB: getCollection() built a NEW
  // MongoClient on every call and never closed it. 20 calls left 40 server
  // connections open, growing linearly and without bound. Invisible in
  // development, because the SQLite fallback opens no connections at all - the
  // leak existed ONLY after the swap to the real provider.
  //
  // The test that matters is the SHAPE of the growth, not its size. A pool
  // legitimately opens several connections to serve concurrent work and then
  // PLATEAUS; a leak keeps climbing. So this drives three identical rounds plus
  // a long sequential run and asserts the last round adds nothing.
  console.log("\n--- repeated get collection does not grow connections ---");
  if (!hasMongo) {
    console.log(`  \x1b[33mSKIP\x1b[0m no reachable MongoDB`);
  } else {
    // EVERY COUNT HERE IS SCOPED TO THE CONNECTIONS THIS TEST OWNS.
    // serverStatus.connections.current, which this test used to read, is a
    // SERVER-GLOBAL counter across every client on that mongod, so any other
    // process moves it and the assertion becomes a coin flip rather than a
    // gate. Measured 2026-08-04 against the shared lab MongoDB 7.0.39 with the
    // docstore code UNCHANGED and correct, the global count read [88, 89, 90]
    // with one other agent connected and [193, 194, 195] with 45 further real
    // clients held open, against an idle baseline near 6.
    //
    // $currentOp with idleConnections is the per-client view: an appName in the
    // connection string tags every socket this test's client opens, and nobody
    // else's carry it. That also lets closeDocStore be asserted at its real
    // strength - OUR connections must reach exactly ZERO, not merely "fewer
    // than before", which another tenant disconnecting could satisfy alone.
    const appName = "tina4_docstore_lifecycle_" + randomBytes(5).toString("hex");
    const taggedUri = MONGO_URI + (MONGO_URI.includes("?") ? "&" : "/?") + "appName=" + appName;
    for (const k of ["TINA4_MONGO_URI", "TINA4_SESSION_MONGO_URI", "TINA4_SESSION_MONGO_URL"]) delete process.env[k];
    process.env.TINA4_MONGO_URI = taggedUri;
    process.env.TINA4_DOC_STORE_PATH = join(mkdtempSync(join(tmpdir(), "ds")), "ds.db");
    // ONE module instance on purpose: collectionFor() re-imports per call, which
    // would hand every call a fresh client cache and hide exactly what is measured.
    const mod = await import(ORM + "?t=" + Math.random());
    const { MongoClient } = await import("mongodb");
    const ownConnections = async (): Promise<number> => {
      const probe = new MongoClient(MONGO_URI);
      await probe.connect();
      const rows = await probe.db("admin").aggregate([
        { $currentOp: { allUsers: true, idleConnections: true, localOps: true } },
        { $match: { appName } },
        { $count: "n" },
      ]).toArray();
      await probe.close();
      // $count emits NO document when nothing matched, which is 0.
      return rows.length === 0 ? 0 : (rows[0] as any).n;
    };

    // The measurement must be able to SEE this client, or every assertion
    // below is vacuously true and proves nothing.
    await (await mod.getCollection("lifecycle_probe")).countDocuments({});
    assert("appName scoping can see this test's own connections",
      (await ownConnections()) > 0, "the probe is blind, so nothing below would prove anything");

    const rounds: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 20; i++) {
        const c = await mod.getCollection("lifecycle_probe");
        await c.countDocuments({});
      }
      rounds.push(await ownConnections());
    }
    const settled = rounds[rounds.length - 1];
    for (let i = 0; i < 100; i++) {
      const c = await mod.getCollection("lifecycle_probe");
      await c.countDocuments({});
    }
    const afterHundred = await ownConnections();

    // POSITIVE: 100 further calls on a settled pool must add nothing. Under the
    // old one-client-per-call code this was +200.
    assert("repeated get collection does not grow connections",
      afterHundred <= settled, `settled=${settled} after 100 more=${afterHundred}`);
    // And the growth must have flattened rather than tracked the call count.
    // Both halves are scoped, so the ceiling measures OUR pool.
    assert("connection growth plateaus instead of tracking calls",
      rounds[2] - rounds[1] <= 2 && rounds[2] <= 10, JSON.stringify(rounds));

    // NEGATIVE: after close there must be NONE of ours left, not merely fewer.
    await mod.closeDocStore();
    await new Promise((r) => setTimeout(r, 1000));
    const afterClose = await ownConnections();
    assert("close doc store releases the connections",
      afterClose === 0, `ours still open after close: ${afterClose}`);
  }

  // ── ADR-0025 clause 4 / query-semantics-match-on-both-providers (ASSERTED) ─
  //
  // MEASURED 2026-08-03 against a real MongoDB: EIGHT array-query behaviours
  // diverged IDENTICALLY in all four frameworks - the signature of a contract
  // nobody had written down. Three were FALSE POSITIVES, where the fallback
  // returned a document Mongo excludes: {nums: {$gt: 9}} matched [1,2,3],
  // because json_extract of an array returns its JSON TEXT and SQLite sorts any
  // text above any number.
  //
  // MongoDB's rule is one sentence: a condition on an array-valued field matches
  // when ANY ELEMENT matches it (or the whole array equals the operand), and a
  // negation matches when NO element does.
  //
  // What is asserted is not "the fallback returns N" - it is that BOTH PROVIDERS
  // RETURN THE SAME THING. That is ADR-0024 stated directly.
  console.log("\n--- array queries match identically on both providers ---");
  if (!hasMongo) {
    console.log(`  \x1b[33mSKIP\x1b[0m no reachable MongoDB`);
  } else {
    const ARRAY_DOC = { name: "w", tags: ["x", "y"], nums: [1, 2, 3], empty: [], scalar: "x", obj: { city: "x" } };
    const ARRAY_CASES: [string, any][] = [
      ["equality containment", { tags: "x" }],
      ["equality no match", { tags: "z" }],
      ["exact array, right order", { tags: ["x", "y"] }],
      ["exact array, wrong order", { tags: ["y", "x"] }],
      ["$in hits one element", { tags: { $in: ["x", "q"] } }],
      ["$in hits nothing", { tags: { $in: ["q"] } }],
      ["$nin excludes a present element", { tags: { $nin: ["x"] } }],
      ["$nin with an absent element", { tags: { $nin: ["q"] } }],
      ["$ne a present element", { tags: { $ne: "x" } }],
      ["$ne an absent element", { tags: { $ne: "q" } }],
      ["numeric containment", { nums: 1 }],
      ["$gt any element", { nums: { $gt: 2 } }],
      ["$gt no element", { nums: { $gt: 9 } }],
      ["$lt any element", { nums: { $lt: 2 } }],
      ["$exists on an array", { tags: { $exists: true } }],
      ["empty array exact", { empty: [] }],
      ["$regex on an array element", { tags: { $regex: "^x$" } }],
      ["scalar still works", { scalar: "x" }],
      ["object field is not matched by its value", { obj: "x" }],
      ["object field matches the whole object", { obj: { city: "x" } }],
    ];

    const results: Record<string, Record<string, number>> = {};
    for (const [provider, uri] of [["fallback", null], ["mongo", MONGO_URI]] as const) {
      const { collection } = await collectionFor(uri);
      await collection.deleteMany({});
      await collection.insertOne({ ...ARRAY_DOC });
      const row: Record<string, number> = {};
      for (const [name, q] of ARRAY_CASES) row[name] = (await collection.find(q).toArray()).length;
      results[provider] = row;
      await collection.deleteMany({});
    }

    const mismatched: Record<string, [number, number]> = {};
    for (const [name] of ARRAY_CASES) {
      if (results.fallback[name] !== results.mongo[name]) {
        mismatched[name] = [results.fallback[name], results.mongo[name]];
      }
    }
    assert("array queries match identically on both providers",
      Object.keys(mismatched).length === 0,
      `diverging (fallback, mongo): ${JSON.stringify(mismatched)}`);
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

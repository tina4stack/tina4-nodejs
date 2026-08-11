/**
 * MongoDB SQL provider — fail-closed WHERE + mass-delete data-loss guard (feature 14).
 *
 * Shared contract: plan/v3/fixtures/mongosql_contract.json (MONGO-DEC-01). This
 * is the Node half; Python/PHP/Ruby carry the same case names against the same
 * real MongoDB.
 *
 * WHY THIS FILE EXISTS
 *   The MongoDB SQL provider translates a SQL WHERE into a Mongo filter with a
 *   hand-rolled regex parser. Before MONGO-DEC-01 an UNPARSEABLE / UNSUPPORTED
 *   WHERE silently degraded to an EMPTY filter, so a DELETE/UPDATE then reached
 *   deleteMany({}) / updateMany({}) and matched EVERY document — a silent mass
 *   wipe — and NO functional test in any framework exercised the parse/CRUD path.
 *   Node also silently ACKNOWLEDGED a no-WHERE UPDATE as a no-op, and deleteAsync
 *   had an explicit "empty filter = delete all" branch.
 *
 *   The guard is fail-closed: an unparseable WHERE THROWS (never match-all), and
 *   a DELETE/UPDATE with NO WHERE clause is REFUSED (truncate() is the explicit
 *   whole-collection spelling). This proves it against a REAL MongoDB.
 *
 * NO MOCKS. A real MongoDB over a real socket. The framework adapter performs the
 * writes (the code under test); an independent raw MongoClient seeds and
 * witnesses the resulting document state. After the guard fires, the collection
 * count is UNCHANGED. Mutation-proved: disable the guard and the unparseable
 * delete wipes the collection, turning "count unchanged" red.
 */
import process from "node:process";

const MONGO_URI = process.env.TINA4_TEST_MONGO_URI ?? "mongodb://127.0.0.1:27017";
const DB_NAME = "tina4_mongosql_node";

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

/** The connection URI with a dedicated database appended, keeping any shape valid. */
function uriWithDb(): string {
  const [scheme, rest] = MONGO_URI.split("://", 2) as [string, string];
  const query = rest.includes("?") ? "?" + rest.split("?", 2)[1] : "";
  const host = rest.split("?", 2)[0]!.split("/", 2)[0];
  return `${scheme}://${host}/${DB_NAME}${query}`;
}

/** A real connect + ping, not a bare port probe. */
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

async function run(): Promise<void> {
  if (!(await mongoReachable())) {
    const msg = `no reachable MongoDB at ${MONGO_URI} — mongo not reachable (set TINA4_TEST_MONGO_URI)`;
    // Under the require-services gate a real-service SKIP is a hard FAILURE:
    // "a run with skips is NOT verification". The runner's _serviceGate applies
    // this when driven through run-all.ts; enforce it here too for a direct run.
    if (/^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "")) {
      console.error(`  \x1b[31mFAIL\x1b[0m ${msg} (TINA4_REQUIRE_SERVICES is set)`);
      process.exit(1);
    }
    console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
    process.exit(0);
  }

  const { MongoClient } = await import("mongodb");
  const { MongodbAdapter } = await import("@tina4/orm");

  /** Fresh adapter (code under test) + independent witness client + unique collection. */
  async function withCase(
    body: (adapter: any, witness: any, collection: string) => Promise<void>,
  ): Promise<void> {
    const collection = "widgets_" + Math.random().toString(16).slice(2, 10);
    const adapter: any = new MongodbAdapter(uriWithDb());
    await adapter.connect();
    const witnessClient = new MongoClient(MONGO_URI);
    await witnessClient.connect();
    const witness = witnessClient.db(DB_NAME).collection(collection);
    try {
      await body(adapter, witness, collection);
    } finally {
      await witness.drop().catch(() => {});
      adapter.close();
      await witnessClient.close();
    }
  }

  const seed = (witness: any, rows: Array<Record<string, unknown>>) => witness.insertMany(rows);
  const count = (witness: any) => witness.countDocuments({});
  const statuses = async (witness: any) =>
    (await witness.find().toArray()).map((d: any) => d.status).sort();

  async function raises(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return false;
    } catch {
      return true;
    }
  }

  console.log("\n--- MongoDB SQL fail-closed guard ---");

  // ── Guard 1: an unparseable / unsupported WHERE fails closed ───────────────

  await withCase(async (adapter, witness, collection) => {
    await seed(witness, [
      { id: 1, status: "keep" },
      { id: 2, status: "keep" },
      { id: 3, status: "gone" },
    ]);
    // UPPER(status) is a function on the column — unsupported by the regex
    // parser. Before the fix it degraded to {} and deleteMany({}) wiped all 3.
    const threw = await raises(() =>
      adapter.executeAsync(`DELETE FROM ${collection} WHERE UPPER(status) = 'GONE'`),
    );
    const remaining = await count(witness);
    check(
      "an unparseable where delete raises and deletes nothing",
      threw && remaining === 3,
      `threw=${threw} remaining=${remaining}`,
    );
  });

  await withCase(async (adapter, witness, collection) => {
    // A COMPOUND WHERE where one AND-part is valid and one is unsupported. If the
    // parser silently DROPPED the unsupported part it would leave { id: 1 } — a
    // NON-empty but WRONG filter that the empty-filter guard waves through — and
    // delete id=1 regardless of its status. Only the fail-closed parse catches
    // this: the whole statement must throw, deleting nothing.
    await seed(witness, [
      { id: 1, status: "keep" },
      { id: 2, status: "gone" },
    ]);
    const threw = await raises(() =>
      adapter.executeAsync(`DELETE FROM ${collection} WHERE id = 1 AND UPPER(status) = 'GONE'`),
    );
    const remaining = await count(witness);
    const after = await statuses(witness);
    check(
      "a partially unparseable where delete raises and deletes nothing",
      threw && remaining === 2 && JSON.stringify(after) === JSON.stringify(["gone", "keep"]),
      `threw=${threw} remaining=${remaining} statuses=${JSON.stringify(after)}`,
    );
  });

  await withCase(async (adapter, witness, collection) => {
    await seed(witness, [
      { id: 1, status: "keep" },
      { id: 2, status: "keep" },
    ]);
    const threw = await raises(() =>
      adapter.executeAsync(`UPDATE ${collection} SET status = 'wiped' WHERE UPPER(status) = 'KEEP'`),
    );
    const after = await statuses(witness);
    check(
      "an unparseable where update raises and changes nothing",
      threw && JSON.stringify(after) === JSON.stringify(["keep", "keep"]),
      `threw=${threw} statuses=${JSON.stringify(after)}`,
    );
  });

  // ── Guard 2: a DELETE/UPDATE with NO WHERE is refused (mass-write guard) ────

  await withCase(async (adapter, witness, collection) => {
    await seed(witness, [
      { id: 1, status: "keep" },
      { id: 2, status: "keep" },
      { id: 3, status: "keep" },
    ]);
    const threw = await raises(() => adapter.executeAsync(`DELETE FROM ${collection}`));
    const remaining = await count(witness);
    check(
      "a no where delete is rejected and deletes nothing",
      threw && remaining === 3,
      `threw=${threw} remaining=${remaining}`,
    );
  });

  await withCase(async (adapter, witness, collection) => {
    await seed(witness, [
      { id: 1, status: "keep" },
      { id: 2, status: "keep" },
    ]);
    const threw = await raises(() =>
      adapter.executeAsync(`UPDATE ${collection} SET status = 'wiped'`),
    );
    const after = await statuses(witness);
    check(
      "a no where update is rejected and changes nothing",
      threw && JSON.stringify(after) === JSON.stringify(["keep", "keep"]),
      `threw=${threw} statuses=${JSON.stringify(after)}`,
    );
  });

  // ── Positive: a real WHERE scopes the write to only the matching docs ──────

  await withCase(async (adapter, witness, collection) => {
    await seed(witness, [
      { id: 1, status: "keep" },
      { id: 2, status: "gone" },
      { id: 3, status: "keep" },
      { id: 4, status: "gone" },
    ]);
    await adapter.executeAsync(`DELETE FROM ${collection} WHERE status = ?`, ["gone"]);
    const remaining = await count(witness);
    const after = await statuses(witness);
    check(
      "a valid where delete removes only matching docs",
      remaining === 2 && JSON.stringify(after) === JSON.stringify(["keep", "keep"]),
      `remaining=${remaining} statuses=${JSON.stringify(after)}`,
    );
  });

  await withCase(async (adapter, witness, collection) => {
    await seed(witness, [
      { id: 1, status: "keep" },
      { id: 2, status: "keep" },
      { id: 3, status: "keep" },
    ]);
    await adapter.executeAsync(`UPDATE ${collection} SET status = ? WHERE id = ?`, ["changed", 2]);
    const after = await statuses(witness);
    check(
      "a valid where update changes only matching docs",
      JSON.stringify(after) === JSON.stringify(["changed", "keep", "keep"]),
      `statuses=${JSON.stringify(after)}`,
    );
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(60)}\n`);
  // A real Mongo client keeps the event loop alive, so exit explicitly.
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("UNEXPECTED ERROR:", e);
  process.exit(1);
});

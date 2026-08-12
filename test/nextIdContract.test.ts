/**
 * Race-safe getNextId() contract — feature 16 (nextid_contract.json), parity
 * with tina4-python/tests/test_nextid_contract.py.
 *
 * Two duplicate-id bugs locked out against REAL databases with REAL concurrency
 * (Promise.all over INDEPENDENT connections — no mocks):
 *
 *   * NEXTID-GENERIC-TOCTOU + NEXTID-PG-FIRSTUSE: the generic sequence fallback
 *     did an UPDATE then a SEPARATE SELECT with an `await` between them (two
 *     concurrent callers read the same post-increment value → DUPLICATE id), and
 *     the PostgreSQL first-use path let two concurrent first-callers each CREATE
 *     a separate sequence so the loser drew a duplicate from a second counter.
 *     Fixed: a single atomic UPDATE ... RETURNING, and CREATE SEQUENCE IF NOT
 *     EXISTS + always-draw-from-nextval so every caller shares ONE counter.
 *
 *   * NEXTID-MONGO-BROKEN: Node had no dedicated Mongo path — getNextId fell to
 *     the relational path, where parseSql's SET-clause parser matched only
 *     `col = ?` and DROPPED the `current_value + 1` (empty $set), so the value
 *     never advanced and every call returned the same id. It now has a DEDICATED
 *     atomic findOneAndUpdate($inc) counter keyed by _id, monotonic and
 *     concurrency-safe.
 *
 * Real services on the .99 lab: PostgreSQL :55432 (tina4/tina4 → tina4_node),
 * MySQL :3306 (tina4/tina4 → tina4_test), MongoDB :27017.
 *
 * Mutation-proof: revert the fallback to UPDATE-then-separate-SELECT and the
 * generic-concurrency case goes RED (a duplicate id); drop the $inc from the
 * Mongo path and the monotonic case goes RED (id2 === id1).
 */
import process from "node:process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { Database, createAdapterFromUrl, MongodbAdapter } from "@tina4/orm";

// A higher fan-out than the other frameworks on purpose: Node's single event
// loop schedules each worker's statements close together, so a wider fan-out is
// what reliably interleaves the (mutation-reverted) UPDATE-then-separate-SELECT
// into a duplicate. The atomic UPDATE ... RETURNING fix is distinct at any N.
const CONCURRENCY = 48;

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

const MYSQL_HOST = process.env.TINA4_TEST_MYSQL_HOST ?? "127.0.0.1";
const MYSQL_PORT = parseInt(process.env.TINA4_TEST_MYSQL_PORT ?? "3306", 10);
const MYSQL_USER = process.env.TINA4_TEST_MYSQL_USERNAME ?? "tina4";
const MYSQL_PASS = process.env.TINA4_TEST_MYSQL_PASSWORD ?? "tina4";
const MYSQL_DB = process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test";

const MONGO_URI = process.env.TINA4_TEST_MONGO_URI ?? "mongodb://127.0.0.1:27017";
const MONGO_DB = "tina4_nextid_node";

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

const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");
function skip(msg: string): void {
  // "a run with skips is NOT verification" — under the gate, a service that a
  // provisioned lab must have is a hard FAILURE, not a green skip.
  if (requireServices) {
    console.error(`  \x1b[31mSKIP-AS-FAIL\x1b[0m ${msg}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

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

const pgUrl = (): string => `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;
const mysqlUrl = (): string => `mysql://${MYSQL_USER}:${MYSQL_PASS}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`;
function mongoUrlWithDb(): string {
  const [scheme, rest] = MONGO_URI.split("://", 2) as [string, string];
  const query = rest.includes("?") ? "?" + rest.split("?", 2)[1] : "";
  const host = rest.split("?", 2)[0]!.split("/", 2)[0];
  return `${scheme}://${host}/${MONGO_DB}${query}`;
}

const hex = (n: number): string => randomBytes(n).toString("hex");

/** Build an independent Database (its own connection) for engine `type`. */
async function independentDb(url: string, type: string): Promise<{ db: Database; adapter: any }> {
  const adapter: any = await createAdapterFromUrl(url);
  const db = new Database(adapter);
  db.setDbType(type);
  return { db, adapter };
}

/**
 * Pre-open n independent connections, fire the op on all of them together
 * (Promise.all — real server-side concurrency), then close them all.
 */
async function hammer(
  n: number,
  url: string,
  type: string,
  op: (db: Database) => Promise<number>,
): Promise<{ ids: number[]; errors: string[] }> {
  const handles = await Promise.all(
    Array.from({ length: n }, () => independentDb(url, type)),
  );
  try {
    const settled = await Promise.allSettled(handles.map(({ db }) => op(db)));
    const ids: number[] = [];
    const errors: string[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") ids.push(r.value);
      else errors.push(String((r.reason as Error)?.message ?? r.reason));
    }
    return { ids, errors };
  } finally {
    for (const { adapter } of handles) {
      try { await adapter.close(); } catch { /* ignore */ }
    }
  }
}

const distinct = (arr: number[]): number => new Set(arr).size;

async function run(): Promise<void> {
  // ── PostgreSQL ────────────────────────────────────────────────────────────
  if (!(await tcpReachable(PG_HOST, PG_PORT))) {
    skip(`no reachable postgres at ${PG_HOST}:${PG_PORT} (set TINA4_TEST_PG_*)`);
  } else {
    // case 1: concurrent get next id on a fresh table yields distinct ids
    {
      const table = `nextid_fresh_${hex(5)}`;
      const { db: admin, adapter } = await independentDb(pgUrl(), "postgres");
      try {
        await admin.execute(`DROP TABLE IF EXISTS ${table}`);
        await admin.execute(`DROP SEQUENCE IF EXISTS ${table}_id_seq`);
        await admin.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, v VARCHAR(20))`);
        const { ids, errors } = await hammer(CONCURRENCY, pgUrl(), "postgres", (db) => db.getNextId(table));
        check(
          "concurrent get next id on a fresh table yields distinct ids",
          errors.length === 0 && ids.length === CONCURRENCY && distinct(ids) === CONCURRENCY,
          `errors=${errors.slice(0, 3)} ids=${[...ids].sort((a, b) => a - b)}`,
        );
      } finally {
        try { await admin.execute(`DROP TABLE IF EXISTS ${table}`); } catch { /* ignore */ }
        try { await admin.execute(`DROP SEQUENCE IF EXISTS ${table}_id_seq`); } catch { /* ignore */ }
        try { await adapter.close(); } catch { /* ignore */ }
      }
    }

    // case 2: concurrent generic sequence next id yields distinct ids
    {
      const seq = `gen.${hex(5)}`;
      const { db: admin, adapter } = await independentDb(pgUrl(), "postgres");
      try {
        // Seed the tina4_sequences row once so every worker hits the atomic
        // increment. On postgres, sequenceNext() routes to the generic fallback.
        await (admin as any).sequenceNext(seq, undefined, "id");
        const { ids, errors } = await hammer(CONCURRENCY, pgUrl(), "postgres", (db) =>
          (db as any).sequenceNext(seq, undefined, "id"),
        );
        check(
          "concurrent generic sequence next id yields distinct ids",
          errors.length === 0 && ids.length === CONCURRENCY && distinct(ids) === CONCURRENCY,
          `errors=${errors.slice(0, 3)} ids=${[...ids].sort((a, b) => a - b)}`,
        );
      } finally {
        try { await admin.execute("DELETE FROM tina4_sequences WHERE seq_name = ?", [seq]); } catch { /* ignore */ }
        try { await adapter.close(); } catch { /* ignore */ }
      }
    }
  }

  // ── MySQL ───────────────────────────────────────────────────────────────
  if (!(await tcpReachable(MYSQL_HOST, MYSQL_PORT))) {
    skip(`no reachable mysql at ${MYSQL_HOST}:${MYSQL_PORT} (set TINA4_TEST_MYSQL_*)`);
  } else {
    const table = `nextid_my_${hex(4)}`;
    const { db: admin, adapter } = await independentDb(mysqlUrl(), "mysql");
    try {
      await admin.execute(`DROP TABLE IF EXISTS ${table}`);
      await admin.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, v VARCHAR(20))`);
      await admin.getNextId(table); // pre-create tina4_sequences + the row
      const { ids, errors } = await hammer(CONCURRENCY, mysqlUrl(), "mysql", (db) => db.getNextId(table));
      check(
        "concurrent get next id on mysql yields distinct ids",
        errors.length === 0 && ids.length === CONCURRENCY && distinct(ids) === CONCURRENCY,
        `errors=${errors.slice(0, 3)} ids=${[...ids].sort((a, b) => a - b)}`,
      );
    } finally {
      try { await admin.execute("DELETE FROM tina4_sequences WHERE seq_name = ?", [`${table}.id`]); } catch { /* ignore */ }
      try { await admin.execute(`DROP TABLE IF EXISTS ${table}`); } catch { /* ignore */ }
      try { await adapter.close(); } catch { /* ignore */ }
    }
  }

  // ── MongoDB ─────────────────────────────────────────────────────────────
  if (!(await mongoReachable())) {
    skip(`no reachable mongodb at ${MONGO_URI} (set TINA4_TEST_MONGO_URI)`);
  } else {
    // case 4: mongo next id increments monotonically
    {
      const table = `mono_${hex(5)}`;
      const adapter: any = new MongodbAdapter(mongoUrlWithDb());
      await adapter.connect();
      const db = new Database(adapter);
      db.setDbType("mongodb");
      try {
        const id1 = await db.getNextId(table);
        const id2 = await db.getNextId(table);
        const id3 = await db.getNextId(table);
        check(
          "mongo next id increments monotonically",
          id2 > id1 && id3 > id2 && distinct([id1, id2, id3]) === 3,
          `id1=${id1} id2=${id2} id3=${id3}`,
        );
      } finally {
        try { await adapter.execute(`DROP TABLE ${table}`); } catch { /* ignore */ }
        try { await adapter.close(); } catch { /* ignore */ }
      }
    }

    // case 5: concurrent mongo next id yields distinct ids (one shared client)
    {
      const table = `conc_${hex(5)}`;
      const adapter: any = new MongodbAdapter(mongoUrlWithDb());
      await adapter.connect();
      const db = new Database(adapter);
      db.setDbType("mongodb");
      try {
        await db.getNextId(table); // seed the counter once
        const settled = await Promise.allSettled(
          Array.from({ length: CONCURRENCY }, () => db.getNextId(table)),
        );
        const ids: number[] = [];
        const errors: string[] = [];
        for (const r of settled) {
          if (r.status === "fulfilled") ids.push(r.value);
          else errors.push(String((r.reason as Error)?.message ?? r.reason));
        }
        check(
          "concurrent mongo next id yields distinct ids",
          errors.length === 0 && ids.length === CONCURRENCY && distinct(ids) === CONCURRENCY,
          `errors=${errors.slice(0, 3)} ids=${[...ids].sort((a, b) => a - b)}`,
        );
      } finally {
        try { await adapter.execute(`DROP TABLE ${table}`); } catch { /* ignore */ }
        try { await adapter.close(); } catch { /* ignore */ }
      }
    }
  }

  console.log(`\nnextIdContract: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

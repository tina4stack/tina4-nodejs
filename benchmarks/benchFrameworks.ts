/**
 * Framework Comparison: tina4-nodejs vs raw node:sqlite vs Knex vs Drizzle.
 *
 * The Node counterpart of tina4-ruby/benchmarks/bench_frameworks.rb and
 * tina4-php/benchmarks/bench_frameworks.php. It measures database CRUD
 * performance against real competitor libraries, under the SAME rules, so the
 * numbers are comparable:
 *
 *   - Equal work: every framework materialises the SAME row count for
 *     "Select ALL"; an equal-work GATE withholds the performance table if the
 *     counts disagree. A rigged row is worse than no row.
 *   - Equal SQLite settings: journal_mode=WAL + foreign_keys=ON on every
 *     connection (Tina4 sets them itself), so writes compare code, not journal
 *     modes.
 *   - Median of ITERATIONS after an untimed warm-up (not a mean, not a cold
 *     first sample).
 *
 * TWO SQLITE DRIVERS ARE IN PLAY -- read the table honestly. tina4-nodejs and
 * the raw floor use Node's BUILT-IN node:sqlite (Tina4 is zero-dependency by
 * design). Knex and Drizzle have no node:sqlite driver, so they run on
 * better-sqlite3, a faster native binding. That binding lives ONLY in this
 * directory's package.json / node_modules -- it is NEVER a dependency of the
 * framework (packages/*). Because the competitors get a faster driver, their
 * times carry a driver advantage over node:sqlite: compare them in the table,
 * but the true FRAMEWORK overhead number is Tina4 vs its OWN raw driver (the
 * only same-driver pair), reported at the end.
 *
 * The competitor libraries live in this directory's own package.json /
 * node_modules, NOT the framework's. Node's upward module resolution still
 * finds @tina4/* in the repo-root node_modules.
 *   cd benchmarks && npm install
 *   npx tsx benchmarks/benchFrameworks.ts     # from the repo root
 *
 * A framework whose library is absent is skipped cleanly; raw node:sqlite and
 * Tina4 always run.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NUM_ROWS = 5000;
const ITERATIONS = 20;
const LIMIT = 20;
// Explicit "give me everything" bound for read APIs that apply a default cap.
const ALL_ROWS = NUM_ROWS * 2;

const CITIES = ["NewYork", "London", "Tokyo", "Paris", "Berlin",
                "Sydney", "Toronto", "Mumbai", "SaoPaulo", "Cairo"];

interface Row { name: string; email: string; age: number; city: string; active: number; }

/** Deterministic seed data (LCG so every framework inserts identical rows). */
function generateUsers(n: number): Row[] {
  let seed = 42;
  const rand = (max: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % max; };
  const rows: Row[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      name: "user" + i,
      email: `user${i}@example.com`,
      age: 18 + rand(63),
      city: CITIES[rand(CITIES.length)],
      active: rand(2),
    });
  }
  return rows;
}

abstract class FrameworkBench {
  readonly name: string;
  protected dbPath: string;
  protected users: Row[];

  // Shared SQLite settings so writes compare frameworks, not journal modes.
  protected static readonly EQUAL_PRAGMAS = ["journal_mode = WAL", "foreign_keys = ON"];

  constructor(name: string) {
    this.name = name;
    const dir = mkdtempSync(join(tmpdir(), "tina4-bench-"));
    this.dbPath = join(dir, name.replace(/[^a-z0-9]/gi, "_") + ".db");
    this.users = generateUsers(NUM_ROWS);
  }

  /** Median of ITERATIONS timings (ms) after one untimed warm-up. Awaits a
   *  real promise, so sync (node:sqlite, Drizzle) and async (Tina4, Knex) ops
   *  are handled uniformly. */
  protected async bench(op: () => unknown | Promise<unknown>): Promise<number> {
    { const r = op(); if (r && typeof (r as { then?: unknown }).then === "function") await r; }
    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = process.hrtime.bigint();
      const r = op();
      if (r && typeof (r as { then?: unknown }).then === "function") await r;
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }

  abstract setup(): Promise<void>;
  abstract cleanup(): Promise<void>;
  abstract selectAllRowCount(): Promise<number>;

  abstract benchInsertSingle(): Promise<number>;
  abstract benchInsertBulk(): Promise<number>;
  abstract benchSelectAll(): Promise<number>;
  abstract benchSelectFiltered(): Promise<number>;
  abstract benchSelectPaginated(): Promise<number>;
  abstract benchUpdate(): Promise<number>;
  abstract benchDelete(): Promise<number>;

  benchmarks(): Array<[string, () => Promise<number>]> {
    return [
      ["Insert (single)", () => this.benchInsertSingle()],
      ["Insert (100 bulk)", () => this.benchInsertBulk()],
      ["Select ALL rows", () => this.benchSelectAll()],
      ["Select filtered", () => this.benchSelectFiltered()],
      ["Select paginated", () => this.benchSelectPaginated()],
      ["Update (by PK)", () => this.benchUpdate()],
      ["Delete (by PK)", () => this.benchDelete()],
    ];
  }
}

// ---------------------------------------------------------------------------
// 1. Raw node:sqlite -- the floor (built into Node, no dependency).
//    This is Tina4's OWN driver, so Tina4's overhead below is pure framework
//    cost. The competitors run on better-sqlite3 and are NOT measured against
//    this floor as overhead (different, faster driver).
// ---------------------------------------------------------------------------
class RawSqliteBench extends FrameworkBench {
  private db!: DatabaseSync;
  constructor() { super("node:sqlite"); }

  async setup(): Promise<void> {
    this.db = new DatabaseSync(this.dbPath);
    for (const p of FrameworkBench.EQUAL_PRAGMAS) this.db.exec(`PRAGMA ${p}`);
    this.db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, age INTEGER, city TEXT, active INTEGER)");
    const ins = this.db.prepare("INSERT INTO users (name,email,age,city,active) VALUES (?,?,?,?,?)");
    this.db.exec("BEGIN");
    for (const u of this.users) ins.run(u.name, u.email, u.age, u.city, u.active);
    this.db.exec("COMMIT");
  }
  async cleanup(): Promise<void> { this.db.close(); rmSync(this.dbPath, { force: true }); }
  async selectAllRowCount(): Promise<number> { return this.db.prepare("SELECT * FROM users").all().length; }

  async benchInsertSingle(): Promise<number> {
    const ins = this.db.prepare("INSERT INTO users (name,email,age,city,active) VALUES (?,?,?,?,?)");
    return this.bench(() => { ins.run("x", "x@x.com", 25, "Test", 1); this.db.exec(`DELETE FROM users WHERE id > ${NUM_ROWS}`); });
  }
  async benchInsertBulk(): Promise<number> {
    const ins = this.db.prepare("INSERT INTO users (name,email,age,city,active) VALUES (?,?,?,?,?)");
    return this.bench(() => {
      this.db.exec("BEGIN");
      for (let i = 0; i < 100; i++) ins.run("x", "x@x.com", 25, "Test", 1);
      this.db.exec("COMMIT");
      this.db.exec(`DELETE FROM users WHERE id > ${NUM_ROWS}`);
    });
  }
  async benchSelectAll(): Promise<number> { const s = this.db.prepare("SELECT * FROM users"); return this.bench(() => s.all()); }
  async benchSelectFiltered(): Promise<number> { const s = this.db.prepare("SELECT * FROM users WHERE age > ? AND city = ?"); return this.bench(() => s.all(30, "London")); }
  async benchSelectPaginated(): Promise<number> { const s = this.db.prepare(`SELECT * FROM users LIMIT ${LIMIT} OFFSET 100`); return this.bench(() => s.all()); }
  async benchUpdate(): Promise<number> { const u = this.db.prepare("UPDATE users SET age = ? WHERE id = ?"); return this.bench(() => u.run(99, 1 + Math.floor(Math.random() * NUM_ROWS))); }
  async benchDelete(): Promise<number> {
    const ins = this.db.prepare("INSERT INTO users (name,email,age,city,active) VALUES (?,?,?,?,?)");
    return this.bench(() => { ins.run("del", "d@x.com", 20, "Test", 1); this.db.exec(`DELETE FROM users WHERE id > ${NUM_ROWS}`); });
  }
}

// ---------------------------------------------------------------------------
// 2. Tina4 -- the framework under test (@tina4/orm), on the SAME node:sqlite.
// ---------------------------------------------------------------------------
class Tina4Bench extends FrameworkBench {
  private db: any;
  constructor() { super("tina4_nodejs"); }

  async setup(): Promise<void> {
    const { initDatabase } = await import("@tina4/orm"); // Tina4 sets WAL + FK itself
    this.db = await initDatabase({ url: `sqlite:///${this.dbPath}` });
    await this.db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, age INTEGER, city TEXT, active INTEGER)");
    await this.db.startTransaction();
    for (const u of this.users) await this.db.insert("users", u);
    await this.db.commit();
  }
  async cleanup(): Promise<void> { this.db.close(); rmSync(this.dbPath, { force: true }); }
  async selectAllRowCount(): Promise<number> {
    // Explicit ALL_ROWS in case fetch ever gains a default cap (parity with the
    // Ruby/Python/PHP harnesses, whose fetch defaults to LIMIT 100).
    return (await this.db.fetch("SELECT * FROM users", [], ALL_ROWS)).records.length;
  }

  async benchInsertSingle(): Promise<number> {
    return this.bench(async () => {
      await this.db.insert("users", { name: "x", email: "x@x.com", age: 25, city: "Test", active: 1 });
      await this.db.execute("DELETE FROM users WHERE id > ?", [NUM_ROWS]);
    });
  }
  async benchInsertBulk(): Promise<number> {
    return this.bench(async () => {
      await this.db.startTransaction();
      for (let i = 0; i < 100; i++) await this.db.insert("users", { name: "x", email: "x@x.com", age: 25, city: "Test", active: 1 });
      await this.db.commit();
      await this.db.execute("DELETE FROM users WHERE id > ?", [NUM_ROWS]);
    });
  }
  async benchSelectAll(): Promise<number> { return this.bench(async () => (await this.db.fetch("SELECT * FROM users", [], ALL_ROWS)).records); }
  async benchSelectFiltered(): Promise<number> { return this.bench(async () => (await this.db.fetch("SELECT * FROM users WHERE age > ? AND city = ?", [30, "London"], ALL_ROWS)).records); }
  async benchSelectPaginated(): Promise<number> { return this.bench(async () => (await this.db.fetch("SELECT * FROM users", [], LIMIT, 100)).records); }
  async benchUpdate(): Promise<number> { return this.bench(async () => this.db.update("users", { age: 99 }, { id: 1 + Math.floor(Math.random() * NUM_ROWS) })); }
  async benchDelete(): Promise<number> {
    return this.bench(async () => {
      await this.db.insert("users", { name: "del", email: "d@x.com", age: 20, city: "Test", active: 1 });
      await this.db.execute("DELETE FROM users WHERE id > ?", [NUM_ROWS]);
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Knex -- the most-used Node query builder. Runs on the better-sqlite3
//    native driver (no node:sqlite driver exists). That binding is isolated to
//    benchmarks/ and is NEVER a framework dependency.
// ---------------------------------------------------------------------------
class KnexBench extends FrameworkBench {
  private k: any;
  constructor() { super("Knex"); }

  async setup(): Promise<void> {
    const knex = (await import("knex")).default;
    this.k = knex({ client: "better-sqlite3", connection: { filename: this.dbPath }, useNullAsDefault: true });
    for (const p of FrameworkBench.EQUAL_PRAGMAS) await this.k.raw(`PRAGMA ${p}`);
    await this.k.raw("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, age INTEGER, city TEXT, active INTEGER)");
    await this.k.transaction(async (trx: any) => {
      for (const u of this.users) await trx("users").insert(u);
    });
  }
  async cleanup(): Promise<void> { await this.k.destroy(); rmSync(this.dbPath, { force: true }); }
  async selectAllRowCount(): Promise<number> { return (await this.k("users").select("*")).length; }

  async benchInsertSingle(): Promise<number> {
    return this.bench(async () => {
      await this.k("users").insert({ name: "x", email: "x@x.com", age: 25, city: "Test", active: 1 });
      await this.k("users").where("id", ">", NUM_ROWS).del();
    });
  }
  async benchInsertBulk(): Promise<number> {
    return this.bench(async () => {
      await this.k.transaction(async (trx: any) => {
        for (let i = 0; i < 100; i++) await trx("users").insert({ name: "x", email: "x@x.com", age: 25, city: "Test", active: 1 });
      });
      await this.k("users").where("id", ">", NUM_ROWS).del();
    });
  }
  async benchSelectAll(): Promise<number> { return this.bench(async () => this.k("users").select("*")); }
  async benchSelectFiltered(): Promise<number> { return this.bench(async () => this.k("users").where("age", ">", 30).andWhere("city", "London")); }
  async benchSelectPaginated(): Promise<number> { return this.bench(async () => this.k("users").limit(LIMIT).offset(100)); }
  async benchUpdate(): Promise<number> { return this.bench(async () => this.k("users").where("id", 1 + Math.floor(Math.random() * NUM_ROWS)).update({ age: 99 })); }
  async benchDelete(): Promise<number> {
    return this.bench(async () => {
      await this.k("users").insert({ name: "del", email: "d@x.com", age: 20, city: "Test", active: 1 });
      await this.k("users").where("id", ">", NUM_ROWS).del();
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Drizzle -- modern TypeScript ORM. Runs on the better-sqlite3 native driver
//    (synchronous). Same isolation note as Knex: better-sqlite3 lives only in
//    benchmarks/, never in the framework.
// ---------------------------------------------------------------------------
class DrizzleBench extends FrameworkBench {
  private db: any;
  private sqlite: any;
  private users_!: any;
  private ops!: { eq: any; and: any; gt: any };
  constructor() { super("Drizzle"); }

  async setup(): Promise<void> {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const { sqliteTable, integer, text } = await import("drizzle-orm/sqlite-core");
    const { eq, and, gt } = await import("drizzle-orm");
    this.ops = { eq, and, gt };

    this.users_ = sqliteTable("users", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      name: text("name"), email: text("email"), age: integer("age"),
      city: text("city"), active: integer("active"),
    });

    this.sqlite = new BetterSqlite3(this.dbPath);
    for (const p of FrameworkBench.EQUAL_PRAGMAS) this.sqlite.exec(`PRAGMA ${p}`);
    this.sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, age INTEGER, city TEXT, active INTEGER)");
    this.db = drizzle(this.sqlite);

    const insertMany = this.sqlite.transaction((rows: Row[]) => {
      for (const u of rows) this.db.insert(this.users_).values(u).run();
    });
    insertMany(this.users);
  }
  async cleanup(): Promise<void> { this.sqlite.close(); rmSync(this.dbPath, { force: true }); }
  async selectAllRowCount(): Promise<number> { return this.db.select().from(this.users_).all().length; }

  async benchInsertSingle(): Promise<number> {
    return this.bench(() => {
      this.db.insert(this.users_).values({ name: "x", email: "x@x.com", age: 25, city: "Test", active: 1 }).run();
      this.sqlite.exec(`DELETE FROM users WHERE id > ${NUM_ROWS}`);
    });
  }
  async benchInsertBulk(): Promise<number> {
    const insertMany = this.sqlite.transaction(() => {
      for (let i = 0; i < 100; i++) this.db.insert(this.users_).values({ name: "x", email: "x@x.com", age: 25, city: "Test", active: 1 }).run();
    });
    return this.bench(() => { insertMany(); this.sqlite.exec(`DELETE FROM users WHERE id > ${NUM_ROWS}`); });
  }
  async benchSelectAll(): Promise<number> { return this.bench(() => this.db.select().from(this.users_).all()); }
  async benchSelectFiltered(): Promise<number> {
    const { and, gt, eq } = this.ops;
    return this.bench(() => this.db.select().from(this.users_).where(and(gt(this.users_.age, 30), eq(this.users_.city, "London"))).all());
  }
  async benchSelectPaginated(): Promise<number> { return this.bench(() => this.db.select().from(this.users_).limit(LIMIT).offset(100).all()); }
  async benchUpdate(): Promise<number> {
    const { eq } = this.ops;
    return this.bench(() => this.db.update(this.users_).set({ age: 99 }).where(eq(this.users_.id, 1 + Math.floor(Math.random() * NUM_ROWS))).run());
  }
  async benchDelete(): Promise<number> {
    return this.bench(() => {
      this.db.insert(this.users_).values({ name: "del", email: "d@x.com", age: 20, city: "Test", active: 1 }).run();
      this.sqlite.exec(`DELETE FROM users WHERE id > ${NUM_ROWS}`);
    });
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
type FrameworkClass = new () => FrameworkBench;
type BenchResults = Record<string, Record<string, number | null>>;

async function runFramework(
  Cls: FrameworkClass,
  order: string[],
  results: BenchResults,
  rowCounts: Record<string, number | null>,
): Promise<string[]> {
  let fw: FrameworkBench;
  try {
    fw = new Cls();
  } catch (e) {
    console.log(`  [${Cls.name}] FAILED to init: ${(e as Error).message}`);
    return [];
  }
  console.log(`  [${fw.name}] Setting up...`);
  try {
    await fw.setup();
  } catch (e) {
    console.log(`  [${fw.name}] SKIP (setup failed: ${(e as Error).message})`);
    return [];
  }
  try {
    try {
      rowCounts[fw.name] = await fw.selectAllRowCount();
      console.log(`  [${fw.name}] Select-all materialises ${rowCounts[fw.name]} rows`);
    } catch (e) {
      rowCounts[fw.name] = null;
      console.log(`  [${fw.name}] could not report Select-all row count: ${(e as Error).message}`);
    }
    order.push(fw.name);
    results[fw.name] = {};
    for (const [label, operation] of fw.benchmarks()) {
      try {
        results[fw.name][label] = await operation();
      } catch (e) {
        results[fw.name][label] = null;
        console.log(`    ${label.padEnd(20)} FAILED: ${(e as Error).message}`);
      }
    }
    return fw.benchmarks().map(([label]) => label);
  } finally {
    await fw.cleanup();
  }
}

function assertEqualWork(rowCounts: Record<string, number | null>): boolean {
  const seen = [...new Set(Object.values(rowCounts).filter((c): c is number => c !== null))];
  if (seen.length <= 1) return true;
  console.log("\n  !! EQUAL-WORK CHECK FAILED - performance table withheld.");
  for (const [name, count] of Object.entries(rowCounts)) console.log(`     ${name.padEnd(16)} Select-all rows: ${count}`);
  console.log("     The frameworks materialised different row counts, so these timings");
  console.log("     are not comparable. Fix the read call that truncates, then re-run.\n");
  return false;
}

function printPerformanceTable(
  order: string[],
  benchNames: string[],
  results: BenchResults,
): void {
  console.log("\n" + "-".repeat(100));
  process.stdout.write("  " + "Operation".padEnd(22));
  for (const name of order) process.stdout.write(name.padStart(16));
  console.log("\n" + "-".repeat(100));
  for (const label of benchNames) {
    process.stdout.write("  " + label.padEnd(22));
    const values = order.map((name) => results[name][label]);
    const best = values.reduce<number | null>((current, value) =>
      value !== null && (current === null || value < current) ? value : current, null);
    for (const value of values) {
      if (value === null) process.stdout.write("FAIL".padStart(16));
      else process.stdout.write((value.toFixed(3) + (value === best ? " *" : "  ")).padStart(16));
    }
    console.log("");
  }
  console.log("-".repeat(100));
  console.log("  * = fastest\n");
}

function average(values: Record<string, number | null>): number {
  const present = Object.values(values).filter((value): value is number => value !== null);
  return present.reduce((sum, value) => sum + value, 0) / Math.max(1, present.length);
}

function printOverhead(
  order: string[],
  results: BenchResults,
  baseline: string,
  differentDriver: Set<string>,
): void {
  if (!results[baseline]) return;
  const baseAvg = average(results[baseline]);
  console.log("  FRAMEWORK OVERHEAD vs raw node:sqlite (same driver = true framework cost):");
  for (const name of order) {
    if (name === baseline || differentDriver.has(name)) continue;
    const pct = (average(results[name]) / baseAvg - 1) * 100;
    console.log(`    ${name.padEnd(16)} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
  }
  console.log("");
  console.log("  NOTE: Knex and Drizzle run on the better-sqlite3 native driver (isolated to");
  console.log("  this benchmarks/ dir -- NEVER a framework dependency), which is faster than");
  console.log("  node:sqlite. Their times therefore include a driver advantage over node:sqlite;");
  console.log("  read them from the table above, not as overhead vs a node:sqlite floor.\n");
}

async function main(): Promise<void> {
  console.log("\n" + "=".repeat(100));
  console.log("  NODE FRAMEWORK COMPARISON: tina4_nodejs vs node:sqlite vs Knex vs Drizzle");
  console.log("=".repeat(100));
  console.log(`  DB Benchmark: ${NUM_ROWS} users | ${ITERATIONS} iterations | SQLite (WAL, same for all)\n`);
  console.log("  PART 1: DATABASE PERFORMANCE (ms per operation, median, lower is better)");
  console.log("=".repeat(100) + "\n");

  const classes = [RawSqliteBench, Tina4Bench, KnexBench, DrizzleBench];
  const baseline = "node:sqlite";
  // Competitors on the faster better-sqlite3 driver -- shown in the table, but
  // NOT reported as overhead vs the node:sqlite floor (different driver).
  const differentDriver = new Set(["Knex", "Drizzle"]);
  const order: string[] = [];
  const results: Record<string, Record<string, number | null>> = {};
  const rowCounts: Record<string, number | null> = {};
  let benchNames: string[] = [];

  for (const Cls of classes) {
    const names = await runFramework(Cls, order, results, rowCounts);
    if (benchNames.length === 0) benchNames = names;
  }

  // ---- Equal-work gate ----
  if (!assertEqualWork(rowCounts)) process.exit(1);

  // ---- Performance table ----
  printPerformanceTable(order, benchNames, results);

  // ---- Overhead: only the same-driver pair (Tina4 vs its own node:sqlite) ----
  printOverhead(order, results, baseline, differentDriver);
}

main().catch((e) => { console.error(e); process.exit(1); });

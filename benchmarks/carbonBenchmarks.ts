/**
 * Tina4 v3 Carbon Benchmarks (Node) - 9 workload categories.
 *
 * Run all:      npx tsx benchmarks/carbonBenchmarks.ts
 * Run one:      npx tsx benchmarks/carbonBenchmarks.ts json
 * Startup cost: npx tsx benchmarks/carbonBenchmarks.ts --startup
 * Carbon (SCI): npx tsx benchmarks/carbonBenchmarks.ts --carbon
 * Categories:   json, db_single, db_multi, template, json_large,
 *               plaintext, crud, paginated, startup
 *
 * By default this reports WALL-CLOCK time and throughput. `--carbon` shells out
 * to the real Carbonah CLI for Software Carbon Intensity; `--startup` spawns
 * fresh Node processes to measure per-process boot cost, which no in-process
 * loop can see (the ESM loader evaluates each module once).
 *
 * Parity: this is the Node half of the cross-framework suite. The workloads,
 * iteration counts, SQL, JSON payloads and the Twig template are deliberately
 * IDENTICAL to tina4-python/benchmarks/carbon_benchmarks.py and
 * tina4-php/benchmarks/carbon_benchmarks.php so the numbers are comparable
 * between languages rather than merely coexisting.
 *
 * Two deliberate divergences, both forced by the platform rather than chosen:
 *
 *   - The response benchmarks build a REAL node:http ServerResponse over a real
 *     unconnected Socket. Node's createResponse() wraps a ServerResponse rather
 *     than being standalone like Python's Response() or PHP's new Response(), so
 *     there is no way to exercise it without one. These are the genuine Node
 *     classes, not stand-ins.
 *   - The startup table reports no module count. Python has sys.modules and PHP
 *     has get_included_files(), but Node exposes no registry of evaluated ESM
 *     modules, so any number here would be invented. The static import-graph
 *     sizes live in test/lazyFeatureLoading.test.ts instead.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createResponse } from "@tina4/core";
import { Frond } from "@tina4/frond";
import { initDatabase } from "@tina4/orm";

// Nominal count, still used by --single (carbonah needs fixed work, not a fixed
// duration).
const ITERATIONS = 1000;

/** Timed runs continue until this much wall-clock has elapsed. */
const MIN_SECONDS = 0.25;

/** ...but never fewer than this many iterations, however fast the operation. */
const MIN_ITERATIONS = 200;

/** A benchmark returns the operation to time, plus optional teardown. */
type Prepared = { op: () => void | Promise<void>; teardown?: () => void };

/** A real ServerResponse over a real (unconnected) Socket - not a double. */
function freshResponse() {
  const req = new IncomingMessage(new Socket());
  return createResponse(new ServerResponse(req));
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "tina4-bench-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir must never fail a benchmark run */
  }
}

// ── 1. JSON serialization - raw overhead ───────────────────────

async function benchJson(): Promise<Prepared> {
  const payload = { message: "Hello, World!", status: "ok" };
  return { op: () => { freshResponse().json(payload); } };
}

// ── 2. Single database query ───────────────────────────────────

async function benchDbSingle(): Promise<Prepared> {
  const dir = tempDir();
  const db = await initDatabase({ url: `sqlite:///${dir}/bench.db` });
  await db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
  await db.execute("INSERT INTO users VALUES (1, 'Alice', 'alice@test.com')");
  db.commit();
  return {
    op: async () => { await db.fetchOne("SELECT * FROM users WHERE id = ?", [1]); },
    teardown: () => { db.close(); cleanup(dir); },
  };
}

// ── 3. Multiple database queries ───────────────────────────────

async function benchDbMulti(): Promise<Prepared> {
  const dir = tempDir();
  const db = await initDatabase({ url: `sqlite:///${dir}/bench.db` });
  await db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price REAL)");
  for (let i = 0; i < 100; i++) {
    await db.execute("INSERT INTO items VALUES (?, ?, ?)", [i, `Item ${i}`, i * 1.5]);
  }
  db.commit();
  return {
    op: async () => {
      await db.fetch("SELECT * FROM items WHERE price > ?", [50.0], 20);
      await db.fetchOne("SELECT COUNT(*) as cnt FROM items");
      await db.fetch("SELECT * FROM items ORDER BY price DESC", [], 5);
    },
    teardown: () => { db.close(); cleanup(dir); },
  };
}

// ── 4. Template rendering ──────────────────────────────────────

async function benchTemplate(): Promise<Prepared> {
  const dir = tempDir();
  {
    const engine = new Frond(dir);
    const tpl = `<!DOCTYPE html>
<html>
<head><title>{{ title }}</title></head>
<body>
<h1>{{ heading }}</h1>
<ul>
{% for item in items %}
<li class="{{ loop.even ? 'even' : 'odd' }}">{{ loop.index }}. {{ item.name | upper }} - \${{ item.price | number_format(2) }}</li>
{% endfor %}
</ul>
{% if show_footer %}
<footer>{{ footer_text | truncate(50) }}</footer>
{% endif %}
</body>
</html>`;
    const items = Array.from({ length: 20 }, (_, i) => ({
      name: `Product ${i}`,
      price: i * 9.99,
    }));
    const data = {
      title: "Benchmark Page",
      heading: "Product List",
      items,
      show_footer: true,
      footer_text:
        "This is a footer with some text that may be truncated for display purposes.",
    };
    // render() from a FILE, not renderString(). renderString recompiles on every
    // call (Frond has no compiled-template cache), so timing it measured
    // compile+render while a Jinja2-style comparison measures render alone.
    // render("bench.twig") is the per-request call a real app makes.
    writeFileSync(join(dir, "bench.twig"), tpl);
    return {
      op: () => { engine.render("bench.twig", data); },
      teardown: () => cleanup(dir),
    };
  }
}

// ── 5. Large JSON payload ──────────────────────────────────────

async function benchJsonLarge(): Promise<Prepared> {
  const payload = {
    users: Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `User ${i}`,
      email: `user${i}@test.com`,
      active: i % 2 === 0,
      score: i * 1.5,
      tags: ["tag1", "tag2", "tag3"],
      address: { street: `${i} Main St`, city: "TestCity", zip: `${10000 + i}` },
    })),
    meta: { total: 100, page: 1, per_page: 100 },
  };
  return { op: () => { freshResponse().json(payload); } };
}

// ── 6. Plaintext response ──────────────────────────────────────

async function benchPlaintext(): Promise<Prepared> {
  return { op: () => { freshResponse().html("Hello, World!"); } };
}

// ── 7. Full CRUD cycle ─────────────────────────────────────────

async function benchCrud(): Promise<Prepared> {
  const dir = tempDir();
  const db = await initDatabase({ url: `sqlite:///${dir}/bench.db` });
  await db.execute(
    "CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, done INTEGER DEFAULT 0)",
  );
  db.commit();
  // One measured op is ONE full create/read/update/delete cycle. The old code ran
  // ITERATIONS/10 cycles inside a single timed call, so the reported ops/sec
  // counted tenths of a cycle and read 10x too high.
  return {
    op: async () => {
      await db.insert("tasks", { title: "Benchmark task", done: 0 });
      const taskId = db.getLastId();
      await db.fetchOne("SELECT * FROM tasks WHERE id = ?", [taskId]);
      // Node's update/delete take an OBJECT filter where Python and PHP take a
      // where-string plus params. Same work, different signature.
      await db.update("tasks", { done: 1 }, { id: taskId });
      await db.delete("tasks", { id: taskId });
      db.commit();
    },
    teardown: () => { db.close(); cleanup(dir); },
  };
}

// ── 8. Paginated query with count ──────────────────────────────

async function benchPaginated(): Promise<Prepared> {
  const dir = tempDir();
  const db = await initDatabase({ url: `sqlite:///${dir}/bench.db` });
  await db.execute(
    "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, category TEXT, price REAL)",
  );
  for (let i = 0; i < 500; i++) {
    await db.execute("INSERT INTO products VALUES (?, ?, ?, ?)", [
      i,
      `Product ${i}`,
      `Cat ${i % 10}`,
      i * 2.5,
    ]);
  }
  db.commit();
  return {
    op: async () => {
      const result = await db.fetch("SELECT * FROM products WHERE category = ?", ["Cat 3"], 20, 0);
      void result.records.length;
    },
    teardown: () => { db.close(); cleanup(dir); },
  };
}

// ── 9. Framework startup ───────────────────────────────────────

/**
 * Runs the work ONCE in this process.
 *
 * Boot cost cannot be measured by looping: the ESM loader evaluates each module
 * once, so a second import is a registry hit. The Python suite had exactly this
 * bug (it looped 100 imports and reported ~400us per "startup" while the real
 * import cost was 79ms). `--startup` measures the real thing by spawning fresh
 * processes.
 */
async function benchStartup(): Promise<Prepared> {
  // Everything in the core barrel is already evaluated by the time this module
  // body runs -- static ESM re-exports are eager by specification. So the honest
  // in-process measurement is what an app boot does AFTER import: construct the
  // pieces it needs.
  const core = await import("@tina4/core");
  const orm = await import("@tina4/orm");
  const swagger = await import("@tina4/swagger");

  return {
    op: () => {
      void core.Router;
      void orm.BaseModel;
      void swagger.generate;
      new core.Router();
      new Frond(tmpdir());
    },
  };
}

// ── Runner ─────────────────────────────────────────────────────

type Bench = [label: string, fn: () => Promise<Prepared>];

const BENCHMARKS: Record<string, Bench> = {
  json: ["JSON Hello World", benchJson],
  db_single: ["Single DB Query", benchDbSingle],
  db_multi: ["Multiple DB Queries", benchDbMulti],
  template: ["Template Rendering", benchTemplate],
  json_large: ["Large JSON Payload", benchJsonLarge],
  plaintext: ["Plaintext Response", benchPlaintext],
  crud: ["CRUD Cycle", benchCrud],
  paginated: ["Paginated Query", benchPaginated],
  startup: ["Framework Startup", benchStartup],
};

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

/**
 * Run one benchmark: setup and teardown OUTSIDE the clock, op timed in a loop
 * that runs until MIN_SECONDS has elapsed.
 *
 * The previous version timed the whole bench function, so per-benchmark setup sat
 * inside the measurement. Measured in the PHP twin, the equivalent db_single
 * setup cost 11.20ms against 4.26ms for the reads it claimed to measure -- 72% of
 * the number was setup, understating throughput 87x. Same class of bug as the
 * Python compare harness timing its own imports.
 *
 * Duration-based rather than a fixed count because these categories span five
 * orders of magnitude: 1,000 iterations is a few ms of noise for plaintext and
 * hundreds of ms for templates.
 */
async function runBenchmark(name: string): Promise<number> {
  const [label, fn] = BENCHMARKS[name];
  const { op, teardown } = await fn();

  // Startup is one-shot: looping it would time already-evaluated module lookups
  // instead of boot work.
  if (name === "startup") {
    const start = performance.now();
    await op();
    const elapsed = (performance.now() - start) / 1000;
    teardown?.();
    console.log(`  ${pad(label, 25)} ${elapsed.toFixed(3)}s  (1 run, in-process)`);
    return elapsed;
  }

  await op();                                  // warm-up, untimed

  let iterations = 0;
  const start = performance.now();
  do {
    await op();
    iterations += 1;
  } while (
    iterations < MIN_ITERATIONS ||
    (performance.now() - start) / 1000 < MIN_SECONDS
  );
  const elapsed = (performance.now() - start) / 1000;
  teardown?.();

  const ops = Math.round(iterations / Math.max(elapsed, 1e-9)).toLocaleString("en-US");
  console.log(
    `  ${pad(label, 25)} ${elapsed.toFixed(3)}s  (${ops} ops/sec, n=${iterations.toLocaleString("en-US")})`,
  );
  return elapsed;
}

/**
 * Boot cost is per-PROCESS, so it can only be measured by spawning fresh ones.
 *
 * No module-count column: Node exposes no registry of evaluated ESM modules
 * (Python has sys.modules, PHP has get_included_files()), and inventing a number
 * would be worse than omitting one. See test/lazyFeatureLoading.test.ts for the
 * static import-graph sizes.
 */
function measureStartup(runs = 20): void {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const root = fileURLToPath(new URL("..", import.meta.url));

  // These import the BUILT dist entries, not the "@tina4/core" specifier, and
  // that is deliberate: every package's exports["."].import points at
  // ./src/index.ts, so a bare `import "@tina4/core"` under plain node resolves to
  // TypeScript and dies with ERR_MODULE_NOT_FOUND on the first .js-suffixed
  // relative import. Only tsx can load the specifier form, and measuring through
  // tsx would time esbuild's transform rather than the framework. dist/index.js
  // is what a working consumer actually evaluates, so it is what we measure.
  //
  // (That exports-map mismatch is a real packaging bug, not a benchmark quirk --
  // see the note in benchmarks/README.md.)
  const dist = (p: string) => JSON.stringify(join(root, "packages", p, "dist", "index.js"));
  const snippets: Record<string, string> = {
    "bare node": "",
    "core (dist)": `await import(${dist("core")});`,
    "+ orm": `await import(${dist("core")}); await import(${dist("orm")});`,
    "+ swagger": `await import(${dist("core")}); await import(${dist("orm")}); await import(${dist("swagger")});`,
    "frond alone": `await import(${dist("frond")});`,
  };

  console.log(`\n  Startup cost - fresh process, best of ${runs}\n`);
  console.log(`  ${pad("Scenario", 24)} ${padStart("Best", 9)}`);
  console.log("  " + "-".repeat(35));

  let baseline: number | null = null;
  for (const [label, snippet] of Object.entries(snippets)) {
    // One untimed warm-up. Without it the FIRST row pays the cold file cache and
    // can read HIGHER than a strictly-larger scenario measured after it - a
    // nonsense ordering that makes the whole table untrustworthy.
    spawnSync(process.execPath, ["--input-type=module", "-e", snippet], { cwd: here });

    let best: number | null = null;
    let failed = false;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      const p = spawnSync(process.execPath, ["--input-type=module", "-e", snippet], {
        cwd: here,
        encoding: "utf-8",
      });
      const elapsed = performance.now() - start;
      if (p.status !== 0) {
        console.log(`  ${pad(label, 24)}  FAILED: ${(p.stderr ?? "").trim().slice(0, 60)}`);
        failed = true;
        break;
      }
      best = best === null ? elapsed : Math.min(best, elapsed);
    }
    if (failed || best === null) continue;

    let delta = "";
    if (baseline === null) {
      baseline = best;
    } else {
      delta = `  (+${(best - baseline).toFixed(1)}ms over bare)`;
    }
    console.log(`  ${pad(label, 24)} ${padStart(best.toFixed(1) + "ms", 9)}${delta}`);
  }
  console.log(
    "\n  No module count: Node exposes no registry of evaluated ESM modules.\n" +
      "  See test/lazyFeatureLoading.test.ts for static import-graph sizes.\n",
  );
}

/**
 * Measure each benchmark's SCI with the real Carbonah CLI.
 *
 * Carbonah is an external tool, so its absence is reported rather than faked,
 * and a run with no hardware energy counter is labelled "(modelled)" instead of
 * being presented as measured.
 */
function measureCarbon(selected: string[]): void {
  // Probe by running the tool itself. NOT `execFileSync("command", [...], {shell})`
  // -- passing args alongside a shell trips Node's DEP0190 deprecation (the args
  // are concatenated, not escaped) and there is no reason to involve a shell here.
  const probe = spawnSync("carbonah", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.log("\n  carbonah not on PATH - skipping SCI measurement.");
    console.log("  Install it (https://carbonah.dev) and re-run with --carbon.\n");
    return;
  }

  const region = process.env.CARBONAH_REGION || "ZA";
  console.log(`\n  Software Carbon Intensity via Carbonah (region ${region})\n`);
  console.log(
    `  ${pad("Benchmark", 25)} ${padStart("gCO2e/run", 11)} ${padStart("Grade", 7)} ${padStart("Energy kWh", 13)}`,
  );
  console.log("  " + "-".repeat(60));

  const script = fileURLToPath(import.meta.url);
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  for (const name of selected) {
    if (!BENCHMARKS[name]) continue;
    const label = BENCHMARKS[name][0];
    const p = spawnSync(
      "carbonah",
      ["measure", "--format", "json", "--region", region, "--", tsx, script, "--single", name],
      { encoding: "utf-8" },
    );
    const raw = p.stdout ?? "";
    // carbonah prints a progress line before the JSON body.
    const brace = raw.indexOf("{");
    if (brace < 0) {
      console.log(`  ${pad(label, 25)}  no JSON from carbonah`);
      continue;
    }
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw.slice(brace));
    } catch {
      console.log(`  ${pad(label, 25)}  unparseable carbonah output`);
      continue;
    }
    const modelled = d.energy_measured ? "" : "  (modelled)";
    console.log(
      `  ${pad(label, 25)} ${padStart((d.value as number).toFixed(6), 11)} ` +
        `${padStart(String(d.grade), 7)} ${padStart((d.energy_kwh as number).toExponential(3), 13)}${modelled}`,
    );
  }
  console.log("\n  'modelled' means Carbonah had no hardware energy counter on this");
  console.log("  platform and derived energy from duration x grid intensity. Treat");
  console.log("  those as comparative, not absolute.\n");
}

// ── Entry point ────────────────────────────────────────────────

const args = process.argv.slice(2);

// --single runs ONE benchmark bare, with no reporting: this is the form
// `carbonah measure` wraps, so the SCI reflects the benchmark and not the
// printing around it.
const singleIdx = args.indexOf("--single");
if (singleIdx >= 0) {
  const only = args[singleIdx + 1] ?? "";
  if (!BENCHMARKS[only]) {
    console.error(`unknown benchmark: ${only}`);
    process.exit(1);
  }
  // Benchmarks return { op, teardown }; carbonah needs a FIXED amount of work
  // (not a fixed duration), so run the op ITERATIONS times.
  const { op, teardown } = await BENCHMARKS[only][1]();
  if (only === "startup") {
    await op();
  } else {
    for (let i = 0; i < ITERATIONS; i++) await op();
  }
  teardown?.();
  process.exit(0);
}

const wantCarbon = args.includes("--carbon");
const wantStartup = args.includes("--startup");
const selected = args.filter((a) => !a.startsWith("--"));
const toRun = selected.length ? selected : Object.keys(BENCHMARKS);

console.log(`\nTina4 v3 Carbon Benchmarks (Node) - ${ITERATIONS} iterations per test\n`);
console.log(`  ${pad("Benchmark", 25)} ${pad("Time", 10)} Throughput`);
console.log("  " + "-".repeat(55));

let total = 0;
for (const name of toRun) {
  if (BENCHMARKS[name]) {
    total += await runBenchmark(name);
  } else {
    console.log(`  Unknown benchmark: ${name}`);
  }
}

console.log(`\n  Total: ${total.toFixed(3)}s`);

if (wantStartup) measureStartup();
if (wantCarbon) measureCarbon(toRun);
if (!wantStartup && !wantCarbon) {
  console.log("\n  --startup  measure real per-process boot cost (fresh Node processes)");
  console.log("  --carbon   measure Software Carbon Intensity via the Carbonah CLI");
}
console.log("");

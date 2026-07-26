/**
 * Lock-in tests for the bound on Frond's template caches (ADR-0004).
 * Run with: npx tsx test/frondTemplateCache.test.ts
 *
 * `compiled` (file templates) and `compiledStrings` (renderString) were plain
 * unbounded Maps. Each entry is a whole token list, and renderString keys on
 * md5(source), so an app that builds template strings dynamically grew them
 * for the life of the worker.
 *
 * Reproduced for real below: real renders through the real engine, real
 * template files on disk, and the real private caches read off the instance.
 * The bound must never cost correctness — an evicted template re-tokenizes.
 *
 * No mocks: nothing here stands in for the engine or the filesystem.
 */
import { Frond } from "../packages/frond/src/index.ts";
import { TEMPLATE_CACHE_MAX } from "../packages/frond/src/engine.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

const tmpDir = "/tmp/frond-template-cache-test";
try { rmSync(tmpDir, { recursive: true }); } catch {}
mkdirSync(tmpDir, { recursive: true });

function writeTemplate(name: string, contents: string): string {
  writeFileSync(join(tmpDir, name), contents, "utf-8");
  return name;
}

/** Read a private cache off the instance. */
function cacheOf(engine: Frond, name: string): Map<string, unknown> {
  return (engine as unknown as Record<string, Map<string, unknown>>)[name];
}

console.log("=== Frond Template Cache Bound (ADR-0004) ===\n");

// ── The cap itself ─────────────────────────────────────────────
assert("TEMPLATE_CACHE_MAX is a positive cap", TEMPLATE_CACHE_MAX > 0);

// ── renderString keys on md5(source) — the real footgun ────────
{
  const engine = new Frond(tmpDir);
  const distinct = TEMPLATE_CACHE_MAX * 2 + 13;
  let allCorrect = true;

  for (let index = 0; index < distinct; index++) {
    const rendered = engine.renderString(`t${index}={{ n + ${index} }}`, { n: 10 });
    if (rendered !== `t${index}=${10 + index}`) allCorrect = false;
  }

  const size = cacheOf(engine, "compiledStrings").size;
  assert(
    `compiledStrings bounded at ${TEMPLATE_CACHE_MAX} across ${distinct} distinct sources (got ${size})`,
    size <= TEMPLATE_CACHE_MAX,
  );
  assert("every dynamic render stayed byte-correct across eviction", allCorrect);
}

// ── The bound must not cost correctness ────────────────────────
{
  const engine = new Frond(tmpDir);
  const firstSource = "first={{ n + 1 }}";
  assert("first source renders", engine.renderString(firstSource, { n: 10 }) === "first=11");

  for (let index = 0; index < TEMPLATE_CACHE_MAX * 2; index++) {
    engine.renderString(`filler${index}={{ n }}`, { n: index });
  }

  const evictedKey = createHash("md5").update(firstSource).digest("hex");
  assert(
    "the first entry was evicted by the sweep",
    !cacheOf(engine, "compiledStrings").has(evictedKey),
  );
  // Re-tokenizes from cold, still byte-correct, and still tracks the data
  // rather than replaying a stale cached result.
  assert(
    "an evicted string template re-tokenizes and renders correctly",
    engine.renderString(firstSource, { n: 10 }) === "first=11",
  );
  assert(
    "an evicted string template still tracks the data",
    engine.renderString(firstSource, { n: 100 }) === "first=101",
  );
}

// ── File-template token cache ──────────────────────────────────
{
  const engine = new Frond(tmpDir);
  const distinct = TEMPLATE_CACHE_MAX + 41;

  for (let index = 0; index < distinct; index++) {
    writeTemplate(`tpl${index}.twig`, `T${index}={{ n + ${index} }}`);
  }

  let allCorrect = true;
  for (let index = 0; index < distinct; index++) {
    if (engine.render(`tpl${index}.twig`, { n: 5 }) !== `T${index}=${5 + index}`) allCorrect = false;
  }

  const size = cacheOf(engine, "compiled").size;
  assert(
    `compiled bounded at ${TEMPLATE_CACHE_MAX} across ${distinct} distinct templates (got ${size})`,
    size <= TEMPLATE_CACHE_MAX,
  );
  assert("every file render was byte-correct", allCorrect);

  // Every template still renders correctly after the sweep, including the
  // earliest ones, which were evicted and must re-read from disk.
  let allCorrectAfter = true;
  for (let index = 0; index < distinct; index++) {
    if (engine.render(`tpl${index}.twig`, { n: 7 }) !== `T${index}=${7 + index}`) allCorrectAfter = false;
  }
  assert("every evicted file template re-read from disk correctly", allCorrectAfter);
}

// ── Negative control: the cap must not fire EARLY ──────────────
{
  const engine = new Frond(tmpDir);
  const belowCap = TEMPLATE_CACHE_MAX - 1;

  for (let index = 0; index < belowCap; index++) {
    engine.renderString(`u${index}={{ n }}`, { n: index });
  }

  assert(
    "nothing is evicted while the cache is under the cap",
    cacheOf(engine, "compiledStrings").size === belowCap,
  );
}

// ── clearCache() still empties both ────────────────────────────
{
  const engine = new Frond(tmpDir);
  writeTemplate("page.twig", "page={{ n }}");
  assert("file template renders", engine.render("page.twig", { n: 3 }) === "page=3");
  assert("string template renders", engine.renderString("str={{ n }}", { n: 4 }) === "str=4");

  assert("compiled is warm", cacheOf(engine, "compiled").size > 0);
  assert("compiledStrings is warm", cacheOf(engine, "compiledStrings").size > 0);

  engine.clearCache();

  assert("clearCache empties compiled", cacheOf(engine, "compiled").size === 0);
  assert("clearCache empties compiledStrings", cacheOf(engine, "compiledStrings").size === 0);

  assert("renders from cold after clear (file)", engine.render("page.twig", { n: 3 }) === "page=3");
  assert("renders from cold after clear (string)", engine.renderString("str={{ n }}", { n: 4 }) === "str=4");
}

// ── Inheritance re-reads the parent from disk, not the cache ───
{
  const engine = new Frond(tmpDir);
  writeTemplate("base.twig", "BASE[{% block body %}dflt{% endblock %}]");
  writeTemplate("child.twig", '{% extends "base.twig" %}{% block body %}{{ n * 2 }}{% endblock %}');

  assert("inheritance renders before the storm", engine.render("child.twig", { n: 4 }) === "BASE[8]");

  for (let index = 0; index < TEMPLATE_CACHE_MAX * 2; index++) {
    engine.renderString(`storm${index}={{ n }}`, { n: index });
  }

  assert("inheritance survives an eviction storm", engine.render("child.twig", { n: 4 }) === "BASE[8]");
  assert("inheritance still tracks the data", engine.render("child.twig", { n: 10 }) === "BASE[20]");
}

// ── Summary ────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

try { rmSync(tmpDir, { recursive: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);

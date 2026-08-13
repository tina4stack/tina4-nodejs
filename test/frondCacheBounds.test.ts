/**
 * Lock-in tests for 3.13.100's remaining Frond cache bounds (ADR-0004).
 * Run with: npx tsx test/frondCacheBounds.test.ts
 *
 * `compiled`/`compiledStrings` were already bounded at TEMPLATE_CACHE_MAX
 * (see frondTemplateCache.test.ts). This file covers the two module-level
 * per-expression memos that were still plain unbounded Maps --
 * `filterChainCache` and `pathParseCache` -- plus the `{% cache %}`
 * fragment store (`fragmentCache`), which was BOTH unbounded AND never
 * swept a TTL-expired entry: a key that expired and was never read again
 * sat in memory for the life of the worker.
 *
 * Reproduced for real below: real renders through the real engine, real
 * template files on disk, and the real caches read directly (the two
 * memo caches are module-level, so they are exported for exactly this —
 * see engine.ts). No mocks: nothing here stands in for the engine, the
 * clock, or the filesystem.
 */
import { Frond } from "../packages/frond/src/index.ts";
import {
  TEMPLATE_CACHE_MAX,
  MEMO_CACHE_MAX,
  filterChainCache,
  pathParseCache,
} from "../packages/frond/src/engine.ts";
import { mkdirSync, rmSync } from "node:fs";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tmpDir = "/tmp/frond-cache-bounds-test";
try { rmSync(tmpDir, { recursive: true }); } catch {}
mkdirSync(tmpDir, { recursive: true });

/** Read a private instance cache off the engine (compiled/fragmentCache etc.). */
function instanceCacheOf(engine: Frond, name: string): Map<string, unknown> {
  return (engine as unknown as Record<string, Map<string, unknown>>)[name];
}

console.log("=== Frond Cache Bounds (ADR-0004) ===\n");

// ── The caps themselves ─────────────────────────────────────────
assert("TEMPLATE_CACHE_MAX is a positive cap", TEMPLATE_CACHE_MAX > 0);
assert("MEMO_CACHE_MAX is a positive cap not smaller than TEMPLATE_CACHE_MAX", MEMO_CACHE_MAX >= TEMPLATE_CACHE_MAX);

// ── filterChainCache (module-level) ─────────────────────────────
{
  const engine = new Frond(tmpDir);
  const distinct = MEMO_CACHE_MAX * 2 + 17;
  let allCorrect = true;

  for (let index = 0; index < distinct; index++) {
    const rendered = engine.renderString(`{{ n | default(${index}) }}`, {});
    if (rendered !== String(index)) allCorrect = false;
  }

  assert(
    `filterChainCache bounded at ${MEMO_CACHE_MAX} across ${distinct} distinct expressions (got ${filterChainCache.size})`,
    filterChainCache.size <= MEMO_CACHE_MAX,
  );
  assert("every distinct filter-chain render stayed byte-correct across eviction", allCorrect);
}

// ── pathParseCache (module-level) ───────────────────────────────
{
  const engine = new Frond(tmpDir);
  const distinct = MEMO_CACHE_MAX * 2 + 17;
  let allCorrect = true;

  for (let index = 0; index < distinct; index++) {
    const rendered = engine.renderString(`{{ v${index}.name }}`, { [`v${index}`]: { name: String(index) } });
    if (rendered !== String(index)) allCorrect = false;
  }

  assert(
    `pathParseCache bounded at ${MEMO_CACHE_MAX} across ${distinct} distinct paths (got ${pathParseCache.size})`,
    pathParseCache.size <= MEMO_CACHE_MAX,
  );
  assert("every distinct dotted-path render stayed byte-correct across eviction", allCorrect);
}

// ── Negative control: the memo caps must not fire EARLY ─────────
{
  filterChainCache.clear();
  const engine = new Frond(tmpDir);
  const belowCap = MEMO_CACHE_MAX - 1;

  for (let index = 0; index < belowCap; index++) {
    engine.renderString(`{{ n | default(${index}) }}`, {});
  }

  assert(
    "filterChainCache evicts nothing while under the cap",
    filterChainCache.size === belowCap,
  );
}

// ── fragmentCache bound ──────────────────────────────────────────
{
  const engine = new Frond(tmpDir);
  const distinct = TEMPLATE_CACHE_MAX * 2 + 13;
  let allCorrect = true;

  for (let index = 0; index < distinct; index++) {
    const rendered = engine.renderString(`{% cache "frag${index}" 300 %}{{ n }}{% endcache %}`, { n: index });
    if (rendered !== String(index)) allCorrect = false;
  }

  const size = instanceCacheOf(engine, "fragmentCache").size;
  assert(
    `fragmentCache bounded at ${TEMPLATE_CACHE_MAX} across ${distinct} distinct keys (got ${size})`,
    size <= TEMPLATE_CACHE_MAX,
  );
  assert("every distinct fragment-cache render stayed byte-correct across eviction", allCorrect);
}

// ── fragmentCache negative control ──────────────────────────────
{
  const engine = new Frond(tmpDir);
  const belowCap = TEMPLATE_CACHE_MAX - 1;

  for (let index = 0; index < belowCap; index++) {
    engine.renderString(`{% cache "under${index}" 300 %}{{ n }}{% endcache %}`, { n: index });
  }

  assert(
    "fragmentCache evicts nothing while under the cap",
    instanceCacheOf(engine, "fragmentCache").size === belowCap,
  );
}

// ── fragmentCache: bound must not cost correctness ──────────────
{
  const engine = new Frond(tmpDir);
  const first = engine.renderString('{% cache "first_evictable" 300 %}{{ n }}{% endcache %}', { n: "one" });
  assert("first fragment renders", first === "one");

  for (let index = 0; index < TEMPLATE_CACHE_MAX * 2; index++) {
    engine.renderString(`{% cache "filler${index}" 300 %}{{ n }}{% endcache %}`, { n: index });
  }

  const keys = instanceCacheOf(engine, "fragmentCache");
  assert("the first fragment was evicted by the size cap", !keys.has("first_evictable"));

  const recomputed = engine.renderString('{% cache "first_evictable" 300 %}{{ n }}{% endcache %}', { n: "two" });
  assert("an evicted fragment recomputes and stays correct", recomputed === "two");
}

// ── fragmentCache: TTL-expired entry is SWEPT, not left stale ───
await (async () => {
  const engine = new Frond(tmpDir);

  const shortLived = engine.renderString('{% cache "short_lived" 1 %}{{ n }}{% endcache %}', { n: "first" });
  assert("short-lived fragment renders", shortLived === "first");
  engine.renderString('{% cache "control" 300 %}{{ n }}{% endcache %}', { n: "control" });

  await sleep(1100);

  // Touch a DIFFERENT cache key -- proving the sweep runs as a side effect
  // of any fragment-cache render, not only on a re-read of the SAME key
  // (which the old code already handled by silent overwrite).
  engine.renderString('{% cache "trigger" 300 %}{{ n }}{% endcache %}', { n: "trigger" });

  const cache = instanceCacheOf(engine, "fragmentCache");
  assert("the expired entry was swept, not merely left stale", !cache.has("short_lived"));
  assert("a still-live entry was not swept early", cache.has("control"));

  const refreshed = engine.renderString('{% cache "short_lived" 1 %}{{ n }}{% endcache %}', { n: "second" });
  assert("a fresh render recomputes rather than reading stale content", refreshed === "second");
})();

// ── Summary ────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

try { rmSync(tmpDir, { recursive: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);

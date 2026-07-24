/**
 * Node's half of the four-framework "unused features do not load" contract.
 * Run with: npx tsx test/lazyFeatureLoading.test.ts
 *
 * THE CONSTRAINT, STATED HONESTLY. Node is the one framework that cannot express
 * a transparent lazy barrel. Python defers through a PEP 562 module __getattr__,
 * Ruby through Module#autoload, PHP through PSR-4 (lazy by definition). All three
 * intercept the FIRST reference to a name. ECMAScript has no such hook: a static
 * re-export
 *
 *     export { Queue } from "./queue.js";
 *
 * is evaluated when the module graph is instantiated, before any user code runs.
 * A Proxy cannot back named ESM exports, and the packages are "type": "module",
 * so there is no CJS escape hatch either. This is a language guarantee, not an
 * oversight, and no amount of restructuring inside index.ts changes it.
 *
 * WHAT NODE HAS INSTEAD is the package split -- @tina4/core, @tina4/orm,
 * @tina4/swagger, @tina4/frond -- so granularity exists at package granularity
 * rather than per-symbol.
 *
 * WHERE THAT SPLIT ACTUALLY DELIVERS (measured by walking the real static import
 * graph, macOS, Node 24):
 *
 *     @tina4/core    barrel     64 modules   33,969 LOC   <- all eager, by spec
 *     @tina4/orm     barrel     86 modules   45,376 LOC   <- pulls core + its own
 *     @tina4/swagger barrel     89 modules   45,983 LOC   <- pulls core + its own
 *     @tina4/frond   barrel      2 modules    2,957 LOC   <- genuinely standalone
 *
 * So the split delivers for frond and NOT for orm/swagger: importing either of
 * those costs strictly more than importing core. An app that wants only the queue
 * needs 6 modules / 3,039 LOC of real dependency but pays for all 64. Every
 * package's `exports` map declares only ".", so a consumer cannot reach
 * @tina4/core/queue to avoid it -- Node's own resolution refuses the subpath.
 *
 * These tests therefore assert what is TRUE rather than the tidier claim:
 *   - frond's independence is real, so lock it in;
 *   - the core barrel's breadth is a spec consequence, so pin it against
 *     silent growth instead of pretending it is lazy.
 *
 * Reads the REAL source tree off disk -- no mocks, no fixtures.
 *
 * Parity: Python tests/test_lazy_feature_loading.py, Ruby
 * spec/lazy_feature_loading_spec.rb, PHP tests/LazyFeatureLoadingTest.php.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKGS = join(__dirname, "..", "packages");

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Every local module reachable from an entry point by static import/export. */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  // Matches `import ... from "x"`, `export ... from "x"`, and bare `import "x"`.
  const specRe = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    specRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = specRe.exec(src)) !== null) {
      const spec = m[1] ?? m[2];
      // Only local edges count. A package or node: builtin is not part of the
      // framework's own eager graph.
      if (!spec || !spec.startsWith(".")) continue;
      const base = normalize(join(dirname(file), spec));
      // TS source is imported with a .js extension (Node16 resolution).
      const candidates = [base.replace(/\.js$/, ".ts"), `${base}.ts`, base];
      const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
      if (hit && !seen.has(hit)) stack.push(hit);
    }
  }
  return seen;
}

const coreBarrel = join(PKGS, "core", "src", "index.ts");
const frondBarrel = join(PKGS, "frond", "src", "index.ts");

assert("core barrel exists", existsSync(coreBarrel), coreBarrel);
assert("frond barrel exists", existsSync(frondBarrel), frondBarrel);

// ── @tina4/frond is genuinely standalone ────────────────────────────────────
// This is the one place Node's package split delivers real granularity: an app
// that only renders templates pays for frond and nothing else. If frond ever
// imports core, that win silently disappears -- so assert it directly.
const frondGraph = importGraph(frondBarrel);
const frondPullsCore = [...frondGraph].some((f) => f.includes(`${PKGS}/core/`));
assert(
  "@tina4/frond does not pull in @tina4/core",
  !frondPullsCore,
  "frond stopped being standalone -- the only real granularity win in Node is gone",
);
assert(
  "@tina4/frond stays small (< 10 modules)",
  frondGraph.size < 10,
  `${frondGraph.size} modules`,
);

// ── The core barrel is eager: pin its breadth ───────────────────────────────
// Because ESM re-exports cannot be deferred, every module here is loaded by any
// `import { anything } from "@tina4/core"`. A ceiling is the only defence: it
// does not make the barrel lazy, it stops it quietly getting worse.
const coreGraph = importGraph(coreBarrel);
const CORE_MODULE_CEILING = 75; // measured 64; headroom for ordinary growth
assert(
  `core barrel eager graph within ceiling (${coreGraph.size} <= ${CORE_MODULE_CEILING})`,
  coreGraph.size <= CORE_MODULE_CEILING,
  `${coreGraph.size} modules are now loaded by ANY import from @tina4/core. ` +
    `Every one is eager (static ESM re-exports cannot be deferred), so this is ` +
    `the real cost of importing the package. Either drop the new module from the ` +
    `barrel and let apps reach it another way, or raise the ceiling deliberately ` +
    `with a measurement in the commit message.`,
);
assert(
  "core barrel graph is non-trivial (the walker actually resolved edges)",
  coreGraph.size > 20,
  `${coreGraph.size} -- suspiciously small; the import-graph walker probably ` +
    `failed to resolve .js -> .ts and is measuring nothing`,
);

// ── The eager-by-spec shape is real, not assumed ────────────────────────────
// If the barrel ever switched to dynamic import() the constraint would be gone
// and this whole file should be rewritten -- so prove the static form is what
// ships today rather than taking the comment above on trust.
const barrelSrc = readFileSync(coreBarrel, "utf-8");
const staticReExports = (barrelSrc.match(/^export \{[^}]*\} from /gm) ?? []).length;
assert(
  "core barrel uses static re-exports (the eager-by-spec case)",
  staticReExports > 20,
  `${staticReExports} static re-exports found`,
);

// ── Optional subsystems really are a small slice of what gets loaded ────────
// Documents the size of the gap: this is the cost the other three frameworks
// avoid and Node currently cannot.
for (const sub of ["queue", "graphql", "wsdl", "mqtt"]) {
  const file = join(PKGS, "core", "src", `${sub}.ts`);
  if (!existsSync(file)) continue;
  const own = importGraph(file);
  assert(
    `./${sub}.ts needs far less than the barrel (${own.size} vs ${coreGraph.size})`,
    own.size < coreGraph.size / 2,
    `${own.size} modules`,
  );
}

console.log(
  `\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`,
);
process.exit(fail > 0 ? 1 : 0);

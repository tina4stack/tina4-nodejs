/**
 * No-mock lock-in for the published package's exports map (nodejs#32/#353).
 *
 * The bug: the root package.json `exports` map pointed every subpath at
 * TypeScript SOURCE (`./packages/orm/src/index.ts`, ...). `exports` wins over
 * `main`, so an installed consumer doing `import "tina4-nodejs/orm"` under PLAIN
 * node (no tsx) resolved a `.ts` file node cannot execute -> the package was
 * unimportable from a real app.
 *
 * This test reads the REAL package.json and imports the REAL built dist bundles,
 * so it fails against the old `.ts`-pointing map (regression guard) AND against a
 * dist bundle that is not self-contained. No mocks. The full end-to-end proof
 * (npm pack -> install into a clean app -> import under plain node) lives in
 * packInstall.test.ts; this encodes the map invariant + plain-node loadability.
 *
 * Run with: npx tsx test/packageExports.test.ts (dist is built by `pretest`).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== Package Exports Map Tests (nodejs#32) ===\n");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const exportsMap = pkg.exports ?? {};
const SUBPATHS = [".", "./orm", "./swagger", "./frond"];

// --- Contract: every subpath's RUNTIME condition points at built dist .js, not .ts ---
console.log("--- exports map contract ---");
for (const sub of SUBPATHS) {
  const entry = exportsMap[sub];
  assert(`"${sub}" is a conditional exports object`, entry !== undefined && typeof entry === "object",
    `got ${JSON.stringify(entry)}`);
  if (!entry || typeof entry !== "object") continue;

  const runtime = entry.import ?? entry.default;
  assert(`"${sub}" has a runtime (import/default) condition`, typeof runtime === "string", `got ${JSON.stringify(entry)}`);
  // The bug: runtime pointed at .ts. It MUST be a built .js under dist/.
  assert(`"${sub}" runtime resolves to a built .js under dist/ (not .ts source)`,
    typeof runtime === "string" && /\/dist\/.+\.js$/.test(runtime) && !runtime.endsWith(".ts"),
    `runtime = ${runtime}`);
  // The runtime target file must actually exist in the tree we would publish.
  if (typeof runtime === "string") {
    assert(`"${sub}" runtime target exists on disk (${runtime})`,
      existsSync(join(ROOT, runtime.replace(/^\.\//, ""))),
      "build the workspaces (npm run build) so dist/ is present");
  }
}

// --- Self-containment: each built dist imports under the CURRENT node + exposes its API ---
console.log("\n--- built dist bundles load and expose their public API ---");

// Ensure the dist bundles exist (build once if a fresh checkout has not built yet).
const ormDist = join(ROOT, "packages/orm/dist/index.js");
if (!existsSync(ormDist)) {
  console.log("  (dist not built — running `npm run build` once)");
  execSync("npm run build", { cwd: ROOT, stdio: "ignore" });
}

const EXPECT: Record<string, string[]> = {
  "./packages/core/dist/index.js": ["startServer", "get", "Api"],
  "./packages/orm/dist/index.js": ["BaseModel", "Database", "initDatabase"],
  "./packages/swagger/dist/index.js": ["generate", "swaggerEnabled"],
  "./packages/frond/dist/index.js": ["Frond"],
};

for (const [rel, expected] of Object.entries(EXPECT)) {
  try {
    const mod = await import(join(ROOT, rel));
    const missing = expected.filter((k) => !(k in mod));
    assert(`${rel} loads under plain node and exports ${expected.join(", ")}`,
      missing.length === 0, `missing: ${missing.join(", ")}`);
  } catch (e) {
    assert(`${rel} loads under plain node`, false, `${(e as any)?.code || (e as Error).name}: ${(e as Error).message.split("\n")[0]}`);
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

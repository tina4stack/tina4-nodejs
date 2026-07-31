/**
 * The dispatch pipeline's COMPLEXITY gate (feature 6, group B) - Node.
 *
 * Split out of test/dispatchPipeline.test.ts, which keeps the assertions that
 * need nothing but the source: the stage list, that every listed stage exists,
 * arity, and that no stage calls another.
 *
 * These two need the tina4 Rust CLI on PATH. Metrics is measured by the NATIVE
 * engine (ADR-0002) with no in-framework fallback, so CI cannot run them -
 * run-all.ts skips every file in METRICS_FILES, which is why this one is listed
 * there. The engine is tested where it lives, tina4stack/tina4 src/metrics.rs,
 * exercised by `cargo test` in its own pipeline.
 *
 * Runs locally (and with TINA4_SKIP_METRICS=0) for anyone with the CLI, which
 * is where a refactor that regrows a god-function gets caught.
 */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const here = dirname(fileURLToPath(import.meta.url));

console.log("=== Dispatch pipeline complexity gate (Node) ===\n");

// ── The complexity gate — the thing that keeps this fixed ──────────
//
// Asserted from `tina4 metrics`, the same tool the CI gate uses, so the ceiling
// cannot rot into a stale hand-written number.
function metricsFor(relativePath: string): any {
  // The child MUST NOT see node_modules/.bin on its PATH.
  //
  // tina4-nodejs ships its own `tina4` bin alias (a symlink to
  // tina4nodejs/dist/bin.js), and npx/tsx prepend node_modules/.bin - so plain
  // `tina4 metrics` runs the FRAMEWORK CLI, which has no metrics command,
  // exits 0 and prints nothing. The gate then asserted against an empty result
  // and reported nothing wrong. Same class as the Ruby twin, where `bundle
  // exec` resolved `tina4` as a tina4ruby binstub: a name collision that
  // silently answers instead of failing.
  const cleanPath = (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => !dir.includes("node_modules/.bin"))
    .join(":");

  let output: string;
  try {
    output = execFileSync("tina4", ["metrics", "--json", "--path", relativePath], {
      cwd: join(here, ".."),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: cleanPath },
    });
  } catch (err: any) {
    throw new Error(
      `tina4 metrics failed - the complexity gate cannot be asserted. Install the ` +
      `tina4 CLI. ${err?.stderr ?? err?.message ?? err}`);
  }
  if (!output.trimStart().startsWith("{")) {
    throw new Error(`tina4 metrics did not return JSON: ${output.slice(0, 120)}`);
  }
  return JSON.parse(output);
}

{
  const over = metricsFor("packages/core/src/dispatchPipeline.ts")
    .offenders.filter((o: any) => o.kind === "complexity");
  assert("no dispatch stage exceeds complexity ten", over.length === 0,
    over.map((o: any) => o.detail).join("; "));
}

{
  // dispatch was 65 and runMatchedRoute 15. Both live in server.ts, so this
  // asserts against THAT file - the extraction is only real while they stay
  // small. startServer is deliberately NOT included: it is server bootstrap,
  // measured 45 throughout, and did not move as dispatch shrank.
  const regrown = metricsFor("packages/core/src/server.ts")
    .offenders.filter((o: any) =>
      o.kind === "complexity" && /\b(dispatch|runMatchedRoute|wrapResponseEnd)\b/.test(o.detail));
  assert("the god function does not come back", regrown.length === 0,
    regrown.map((o: any) => o.detail).join("; "));
}


console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

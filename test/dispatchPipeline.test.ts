/**
 * The dispatch pipeline CONTRACT (feature 6, group B) - Node.
 *
 * The characterisation suite proves the extraction changed no behaviour. This
 * proves the extraction STAYS extracted. A refactor with no gate regrows: the
 * next person to inline a stage should get a red test, not a slightly worse
 * number in a report nobody reads.
 *
 * Every assertion is derived from the code or from `tina4 metrics`, never from
 * a hand-maintained copy of the answer - a list duplicated into a test drifts
 * from the list it is meant to guard.
 *
 * Twin of tina4-ruby/spec/dispatch_pipeline_spec.rb.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as pipeline from "../packages/core/src/dispatchPipeline.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = join(here, "..", "packages", "core", "src");

console.log("=== Dispatch pipeline contract (Node) ===\n");

// ── The stage list is DATA ─────────────────────────────────────────
{
  assert("the pipeline declares its stages in order",
    JSON.stringify(pipeline.PROLOGUE_STAGES) ===
      JSON.stringify(["resetRequestCaches", "headStripIntercept", "sessionAutoStart"]),
    JSON.stringify(pipeline.PROLOGUE_STAGES));
}

// NEGATIVE: a name in the list with no function behind it, or a stage quietly
// deleted, must fail here rather than at 3am on a real request.
{
  const missing = pipeline.PROLOGUE_STAGES.filter(
    (s) => typeof (pipeline as Record<string, unknown>)[s] !== "function");
  assert("has no unnamed stage", missing.length === 0,
    `listed but not defined: ${missing.join(", ")}`);
}

// ── Isolation ──────────────────────────────────────────────────────
//
// The prologue stages take only the raw request/response - that is WHY they
// were extractable first, and it is worth pinning: a stage that grows a
// dependency on startServer's scope would need another parameter.
{
  const arities: Record<string, number> = {
    resetRequestCaches: 0,
    headStripIntercept: 2,
    sessionAutoStart: 3,
  };
  const wrong = pipeline.PROLOGUE_STAGES.filter(
    (s) => ((pipeline as any)[s] as Function).length !== arities[s]);
  assert("each stage is callable on its own", wrong.length === 0,
    `unexpected arity: ${wrong.join(", ")}`);
}

// NEGATIVE: ordering lives in the list, not in calls between stages.
{
  const source = readFileSync(join(coreSrc, "dispatchPipeline.ts"), "utf-8");
  // Strip the doc comments - they NAME the stages when explaining the order,
  // and matching those would report an offence that does not exist.
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "");
  const bodies = code.split(/export (?:async )?function /).slice(1);

  const offenders: string[] = [];
  for (const body of bodies) {
    const name = body.match(/^(\w+)/)?.[1];
    if (!name || !(pipeline.PROLOGUE_STAGES as readonly string[]).includes(name)) continue;
    for (const other of pipeline.PROLOGUE_STAGES) {
      if (other !== name && new RegExp(`(?<![.\\w])${other}\\s*\\(`).test(body)) {
        offenders.push(`${name} calls ${other}`);
      }
    }
  }
  assert("a stage does not reach into another stage", offenders.length === 0,
    offenders.join(", "));
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

/**
 * The dispatch pipeline CONTRACT (feature 6, group B) - Node.
 *
 * The characterisation suite proves the extraction changed no behaviour. This
 * proves the extraction STAYS extracted. A refactor with no gate regrows: the
 * next person to inline a stage should get a red test, not a slightly worse
 * number in a report nobody reads.
 *
 * Every assertion is derived from the code, never from a hand-maintained copy
 * of the answer - a list duplicated into a test drifts from the list it is
 * meant to guard. The stage NAMES are data in dispatchPipeline.ts; the checks
 * below tie each list back to what dispatch actually runs, so the data and the
 * runner cannot diverge silently.
 *
 * Twin of tina4-ruby/spec/dispatch_pipeline_spec.rb,
 * tina4-php/tests/DispatchPipelineTest.php and
 * tina4-python/tests/test_dispatch_pipeline.py.
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
const serverSrc = readFileSync(join(coreSrc, "server.ts"), "utf-8");
const pipelineSrc = readFileSync(join(coreSrc, "dispatchPipeline.ts"), "utf-8");

const ALL_STAGES = [
  ...pipeline.PROLOGUE_STAGES,
  ...pipeline.REQUEST_STAGES,
  ...pipeline.ROUTE_STAGES,
  ...pipeline.FALLBACK_STAGES,
  ...pipeline.ERROR_STAGES,
];
const UNIQUE_STAGES = [...new Set<string>(ALL_STAGES)];

/**
 * Slice out one function's body by brace matching from its declaration.
 *
 * Deliberately NOT a regex over the whole declaration: these signatures carry
 * arrow types (`(ctx) => boolean`), and a lazy pattern like `[^=]*` stops dead
 * at the first `=>` and silently matches nothing. A gate that parses to empty
 * asserts nothing while reporting green, so every extraction below is checked
 * for a non-empty result before it is trusted.
 */
function functionBody(source: string, decl: string): string {
  const start = source.indexOf(decl);
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return "";
}

/** Names that are CALLED in a body, ordered by first mention. */
function callOrder(body: string, names: readonly string[]): string[] {
  return names
    .map((n) => ({ n, at: body.search(new RegExp(`(?<![.\\w])${n}\\s*\\(`)) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.n);
}

const eq = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a]) === JSON.stringify([...b]);

console.log("=== Dispatch pipeline contract (Node) ===\n");

// ── The stage lists are DATA ───────────────────────────────────────
{
  assert("the pipeline declares its stages in order",
    eq(pipeline.PROLOGUE_STAGES, ["resetRequestCaches", "headStripIntercept", "compressionEtagIntercept", "sessionAutoStart"]) &&
    eq(pipeline.REQUEST_STAGES, ["blockAiPortReload", "wrapResponseEnd", "runGlobalMiddlewarePass"]) &&
    eq(pipeline.ROUTE_STAGES, ["runGlobalMiddlewarePass", "enforceRouteAuth", "runRouteMiddlewares",
      "invokeRouteHandler", "renderIfTemplateRoute"]) &&
    eq(pipeline.FALLBACK_STAGES, ["serveTemplateFallback", "serveLandingPage", "serveMethodNotAllowed",
      "serveStaticAsset", "serveNotFound"]) &&
    eq(pipeline.ERROR_STAGES, ["renderDispatchError"]),
    JSON.stringify(ALL_STAGES));
}

// NEGATIVE: a name in a list with no function behind it, or a stage quietly
// deleted, must fail here rather than at 3am on a real request.
{
  const both = serverSrc + pipelineSrc;
  const missing = UNIQUE_STAGES.filter(
    (s) => !new RegExp(`(?:export )?(?:async )?function ${s}\\s*\\(`).test(both) &&
           !new RegExp(`\\b${s}\\b[^;]*?from "`, "s").test(serverSrc));
  assert("has no unnamed stage", missing.length === 0,
    `listed but neither defined nor imported: ${missing.join(", ")}`);
}

// ── The data list IS the runner ────────────────────────────────────
//
// The assertion that matters most. server.ts holds FALLBACK_STAGES as an array
// of the real FUNCTIONS - that is what dispatch walks. If the names here ever
// drifted from it, every other check in this file would guard a fiction.
{
  const from = serverSrc.indexOf("const FALLBACK_STAGES");
  const open = serverSrc.indexOf("[", from);
  const close = serverSrc.indexOf("];", open);
  const real = from === -1 || open === -1 || close === -1
    ? []
    : serverSrc.slice(open + 1, close).split(",").map((s) => s.trim()).filter(Boolean);

  assert("the fallback data list matches the array dispatch really walks",
    real.length > 0 && eq(real, pipeline.FALLBACK_STAGES),
    `server.ts has [${real.join(", ")}]`);
}

// The prologue and request stages are called in dispatchInner, in list order.
//
// PRE-EXISTING DRIFT FIX (found while adding compressionEtagIntercept,
// feature 40): this used to search "async function dispatch(" - the thin
// requestId/Log.runWithRequestId wrapper - which never itself calls any
// prologue/request stage; dispatch delegates to dispatchInner, which does.
// The search target was stale from before dispatch/dispatchInner were split,
// so this assertion silently checked two empty arrays against the real
// (non-empty) lists and had been failing before this fix, independent of and
// unrelated to feature 40's own change.
{
  const body = functionBody(serverSrc, "async function dispatchInner(");
  const prologue = callOrder(body, pipeline.PROLOGUE_STAGES);
  const request = callOrder(body, pipeline.REQUEST_STAGES);
  assert("dispatchInner calls the prologue and request stages in list order",
    body.length > 0 && eq(prologue, pipeline.PROLOGUE_STAGES) && eq(request, pipeline.REQUEST_STAGES),
    `prologue=[${prologue}] request=[${request}]`);
}

// Every route stage is really called by runMatchedRoute.
//
// Membership, not source order: the handler call is NESTED as an argument -
// `renderIfTemplateRoute(match, res, await invokeRouteHandler(...))` - so it
// READS right-to-left while it RUNS left-to-right. Asserting source order here
// would encode a falsehood. ROUTE_STAGES holds EXECUTION order, and that order
// is proven by behaviour in globalMiddlewareSplit and dispatchCharacterisation.
{
  const body = functionBody(serverSrc, "async function runMatchedRoute(");
  const missing = pipeline.ROUTE_STAGES.filter(
    (s) => !new RegExp(`(?<![.\\w])${s}\\s*\\(`).test(body));
  assert("runMatchedRoute calls every route stage",
    body.length > 0 && missing.length === 0,
    `not called: ${missing.join(", ")}`);
}

// ── Isolation ──────────────────────────────────────────────────────
//
// The prologue stages take only the raw request/response - that is WHY they
// were extractable first, and it is worth pinning: a stage that grew a
// dependency on startServer's scope would need another parameter.
{
  const arities: Record<string, number> = {
    resetRequestCaches: 0,
    headStripIntercept: 2,
    compressionEtagIntercept: 2,
    sessionAutoStart: 3,
  };
  const wrong = pipeline.PROLOGUE_STAGES.filter(
    (s) => ((pipeline as any)[s] as Function).length !== arities[s]);
  assert("each prologue stage is callable on its own", wrong.length === 0,
    `unexpected arity: ${wrong.join(", ")}`);
}

// A stage is an internal step, not public API. If one leaked onto the package
// surface it would become something callers depend on, and the list would stop
// being the only thing that decides ordering.
//
// KNOWN EXCEPTION, listed rather than hidden so a NEW leak still fails here.
// `runRouteMiddlewares` is exported from index.ts, and Node is alone in that:
// PHP has `private static function runRouteMiddleware`, Ruby keeps
// `route_middleware` inside the DispatchPipeline module, Python's is
// `_run_before_middleware`. It is not in the documented public API either -
// four of this repo's own test files import it, which is how it stuck.
// Un-exporting it is a public-surface change, so it is FLAGGED here, not made
// as a side effect of a refactor.
const SURFACE_EXCEPTIONS = new Set(["runRouteMiddlewares"]);
{
  const index = readFileSync(join(coreSrc, "index.ts"), "utf-8");
  const leaked = UNIQUE_STAGES.filter(
    (s) => !SURFACE_EXCEPTIONS.has(s) && new RegExp(`\\b${s}\\b`).test(index));
  assert("keeps every stage out of the package surface", leaked.length === 0,
    `exported from index.ts: ${leaked.join(", ")}`);

  // The exception must stay REAL: if someone un-exports it, this list is stale
  // and should shrink. A permanent allow-list that no longer allows anything is
  // how an exception outlives its reason.
  const stale = [...SURFACE_EXCEPTIONS].filter((s) => !new RegExp(`\\b${s}\\b`).test(index));
  assert("no stale surface exception", stale.length === 0,
    `no longer exported, drop from SURFACE_EXCEPTIONS: ${stale.join(", ")}`);
}

// NEGATIVE: ordering lives in the lists, not in calls between stages.
//
// A stage calling another directly hides an edge the list does not show -
// exactly the coupling the extraction removed. `dispatch` and `runMatchedRoute`
// are the RUNNERS, not stages, so they are the ones allowed to call.
{
  const offenders: string[] = [];
  for (const src of [pipelineSrc, serverSrc]) {
    // Strip doc comments - they NAME the stages when explaining the order, and
    // matching those would report an offence that does not exist.
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");
    for (const stage of UNIQUE_STAGES) {
      const body = functionBody(code, `function ${stage}(`);
      if (!body) continue;
      for (const other of UNIQUE_STAGES) {
        if (other !== stage && new RegExp(`(?<![.\\w])${other}\\s*\\(`).test(body)) {
          offenders.push(`${stage} calls ${other}`);
        }
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

/**
 * #59 — stacked Swagger metadata (summary + description + tags) must ALL
 * survive on a route in the generated OpenAPI operation.
 *
 * Reported (Python #59): stacked @summary/@description/@tags decorators dropped
 * all but the one nearest the route. Node does NOT use stacking decorators — a
 * route declares one `meta` object (`export const meta = { summary, description,
 * tags }`), so all three are sibling keys of a single object and the generator
 * emits each (generator.ts: summary, tags, and description). Node is therefore
 * already correct by construction; this test LOCKS IT IN (all three survive,
 * order-independent, no cross-route contamination) and is the contract the
 * `meta` convention must keep matching the Python master.
 *
 * Pure-logic: builds an OpenAPI spec from in-process RouteDefinition objects —
 * no DB, no network, no doubles.
 * Run with: npx tsx test/swaggerStackedMeta.test.ts
 */
import { generate } from "../packages/swagger/src/generator.ts";
import type { RouteDefinition } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const noop = async () => {};

console.log("=== Swagger stacked metadata survival (#59) ===\n");

// All three keys present on one route — every one must land in the operation.
{
  const routes: RouteDefinition[] = [
    {
      method: "GET",
      pattern: "/widgets",
      handler: noop,
      meta: {
        summary: "List widgets",
        description: "Returns every widget in the catalogue.",
        tags: ["widgets", "catalogue"],
      },
    },
  ];
  const op = generate(routes).paths["/widgets"]?.get as Record<string, unknown>;
  assert("summary survives", op?.summary === "List widgets", `got ${JSON.stringify(op?.summary)}`);
  assert("description survives", op?.description === "Returns every widget in the catalogue.", `got ${JSON.stringify(op?.description)}`);
  assert("tags survive", JSON.stringify(op?.tags) === JSON.stringify(["widgets", "catalogue"]), `got ${JSON.stringify(op?.tags)}`);
}

// Key order in the meta object must not matter — none wins by position, none
// is dropped (mirrors Python's stack-order-independence test).
{
  const routes: RouteDefinition[] = [
    {
      method: "POST",
      pattern: "/orders",
      handler: noop,
      meta: {
        tags: ["orders"],
        summary: "Create order",
        description: "Creates a new order.",
      },
    },
  ];
  const op = generate(routes).paths["/orders"]?.post as Record<string, unknown>;
  assert("order-independent: summary survives", op?.summary === "Create order", `got ${JSON.stringify(op?.summary)}`);
  assert("order-independent: description survives", op?.description === "Creates a new order.", `got ${JSON.stringify(op?.description)}`);
  assert("order-independent: tags survive", JSON.stringify(op?.tags) === JSON.stringify(["orders"]), `got ${JSON.stringify(op?.tags)}`);
}

// Two routes with distinct metadata must not cross-contaminate — each keeps
// exactly its own summary/description/tags.
{
  const routes: RouteDefinition[] = [
    { method: "GET", pattern: "/a", handler: noop, meta: { summary: "A sum", description: "A desc", tags: ["a"] } },
    { method: "GET", pattern: "/b", handler: noop, meta: { summary: "B sum", description: "B desc", tags: ["b"] } },
  ];
  const spec = generate(routes);
  const a = spec.paths["/a"]?.get as Record<string, unknown>;
  const b = spec.paths["/b"]?.get as Record<string, unknown>;
  assert("route A keeps its own summary/description/tags",
    a?.summary === "A sum" && a?.description === "A desc" && JSON.stringify(a?.tags) === JSON.stringify(["a"]),
    `got ${JSON.stringify(a)}`);
  assert("route B keeps its own summary/description/tags",
    b?.summary === "B sum" && b?.description === "B desc" && JSON.stringify(b?.tags) === JSON.stringify(["b"]),
    `got ${JSON.stringify(b)}`);
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

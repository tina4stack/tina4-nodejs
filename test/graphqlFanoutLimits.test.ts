/**
 * Medium security finding F2 — GraphQL fan-out limits.
 *
 * The depth guard bounds NESTING but not WIDTH. This pins the two controls that
 * close the gap, at parity with tina4-python/tests/test_graphql_fanout_limits.py,
 * tina4-php/tests/GraphQLFanoutLimitsTest.php and
 * tina4-ruby/spec/graphql_fanout_limits_spec.rb:
 *   - a total expanded-node (complexity) budget, TINA4_GRAPHQL_MAX_NODES, which
 *     rejects a fragment bomb and an alias explosion before any resolver runs;
 *   - a parser recursion bound, so a deeply nested query fails with a clean
 *     error instead of overflowing the parser stack.
 *
 * Run with: npx tsx test/graphqlFanoutLimits.test.ts
 */
import { GraphQL } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}
function makeGql(maxNodes?: number): GraphQL {
  const g = new GraphQL();
  g.addQuery("ping", {}, "String", () => "pong");
  if (maxNodes !== undefined) g.maxNodes = maxNodes;
  return g;
}
function errText(r: { errors?: Array<{ message: string }> }): string {
  return (r.errors ?? []).map((e) => e.message).join(" ");
}

console.log("\n  GraphQL fan-out limits (F2)\n");

// Fragment bomb — fragments spreading fragments, shallow but exponential.
{
  const g = makeGql(100);
  let frags = "fragment f0 on Query { ping }\n";
  let prev = "f0";
  for (let i = 1; i < 8; i++) { frags += `fragment f${i} on Query { ...${prev} ...${prev} }\n`; prev = `f${i}`; }
  const r = await g.execute(frags + "{ ...f7 }") as { errors?: Array<{ message: string }> };
  assert("fragment bomb is rejected", /complexity/i.test(errText(r)), `errs=${errText(r)}`);
}

// Alias explosion — many aliases of one field, no nesting.
{
  const g = makeGql(100);
  const aliases = Array.from({ length: 200 }, (_, i) => `a${i}: ping`).join(" ");
  const r = await g.execute(`{ ${aliases} }`) as { errors?: Array<{ message: string }> };
  assert("alias explosion is rejected", /complexity/i.test(errText(r)), `errs=${errText(r)}`);
}

// Deeply nested query — must fail with a clean parse error, never a stack overflow.
{
  process.env.TINA4_GRAPHQL_MAX_DEPTH = "20";
  const g = makeGql(0); // disable the node budget so this isolates the parser bound
  let inner = "x";
  for (let i = 0; i < 3000; i++) inner = `ping { ${inner} }`;
  const r = await g.execute(`{ ${inner} }`) as { errors?: Array<{ message: string }> };
  assert("deeply nested query is bounded by the parser", /exceeds maximum depth/i.test(errText(r)), `errs=${errText(r)}`);
  delete process.env.TINA4_GRAPHQL_MAX_DEPTH;
}

// Positive twin — an ordinary query under the budget resolves normally.
{
  const g = makeGql(100);
  const r = await g.execute("{ ping }") as { data?: Record<string, unknown> };
  assert("ordinary query still works", (r.data as { ping?: string } | undefined)?.ping === "pong", JSON.stringify(r));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

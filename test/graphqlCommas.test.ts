// GraphQL spec 2.1.7: commas are insignificant - "," is ignored exactly like
// whitespace, between arguments, between selected fields, inside list and
// object values and between variable definitions.
//
// Case: commas_are_insignificant_between_arguments_and_fields (shared name;
// Ruby's tokenizer made "," a token no parse loop consumed, so a comma-separated
// argument list was a parse error).
//
// In-process, pure logic: the real GraphQL engine, no service, no double.
// Run with: npx tsx test/graphqlCommas.test.ts

import { GraphQL } from "../packages/core/src/index.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const gql = new GraphQL();
gql.addType("Pair", { a: { type: "Int" }, b: { type: "Int" }, sum: { type: "Int" } });
gql.addQuery("pair", { a: "Int", b: "Int" }, "Pair", (_root, args) => {
  const a = Number(args.a); const b = Number(args.b);
  return { a, b, sum: a + b };
});
gql.addQuery("total", { values: "[Int]" }, "Int", (_root, args) =>
  (args.values as number[]).reduce((acc, v) => acc + Number(v), 0));
gql.addQuery("echo", { input: "String" }, "String", (_root, args) => JSON.stringify(args.input));

const label = "commas_are_insignificant_between_arguments_and_fields";

async function run(): Promise<void> {
  console.log(`\n--- ${label} ---`);
  const cases: [string, string, Record<string, unknown> | undefined, (data: any) => boolean][] = [
    ["comma-separated arguments", "{ pair(a: 1, b: 2) { sum } }", undefined, (d) => d?.pair?.sum === 3],
    ["comma-separated selected fields", "{ pair(a: 1 b: 2) { a, b, sum } }", undefined,
      (d) => d?.pair?.a === 1 && d?.pair?.b === 2 && d?.pair?.sum === 3],
    ["commas between top-level fields", "{ first: pair(a: 1, b: 1) { sum }, second: pair(a: 2, b: 2) { sum } }", undefined,
      (d) => d?.first?.sum === 2 && d?.second?.sum === 4],
    ["comma-separated list values", "{ total(values: [1, 2, 3]) }", undefined, (d) => d?.total === 6],
    ["a trailing comma is ignored", "{ pair(a: 4, b: 5,) { sum, } }", undefined, (d) => d?.pair?.sum === 9],
    ["comma-separated variable definitions", "query Q($a: Int, $b: Int) { pair(a: $a, b: $b) { sum } }", { a: 6, b: 7 },
      (d) => d?.pair?.sum === 13],
    ["commas and no commas agree", "{ pair(a: 1 b: 2) { a b sum } }", undefined, (d) => d?.pair?.sum === 3],
  ];
  for (const [name, query, variables, check] of cases) {
    const result = await gql.execute(query, variables);
    assert(`${label}: ${name}`, !result.errors?.length && check(result.data), JSON.stringify(result));
  }
  console.log(`\n==================================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`==================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

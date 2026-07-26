/**
 * Frond expression parity gate -- the cross-framework output contract.
 * Run with: npx tsx test/frondExpressionParity.test.ts
 *
 * WHY THIS FILE EXISTS. "Frond expressions behave the same in all four
 * frameworks" was an assumption, never a measurement. When it was finally
 * measured -- 72 expressions rendered through Python, PHP, Ruby and Node
 * against one identical dataset -- 11 of the 72 disagreed. Booleans disagreed
 * in ALL FOUR (PHP printed false as an EMPTY STRING; Ruby was inconsistent
 * with itself; Python emitted Python's True/False), {{ not x }} was silently
 * dropped in three, and PHP's |json_encode skipped HTML escaping. Each
 * implementation looked correct in isolation, which is exactly why the drift
 * survived for so long.
 *
 * So the corpus is no longer a one-off script -- it is a fixture, and it lives
 * in all four repos as the SAME BYTES:
 *
 *   tina4-python/tests/fixtures/frond_expression_{corpus,expected}.txt
 *   tina4-php/tests/fixtures/...
 *   tina4-ruby/spec/fixtures/...
 *   tina4-nodejs/test/fixtures/...
 *
 * expected.txt is a single agreed answer key, not a per-language snapshot. If
 * one framework drifts, ITS suite goes red while the other three stay green,
 * and the diff names the expression. Changing the contract on purpose means
 * changing the answer key in all four repos in the same change -- the point.
 *
 * Keep the dataset below byte-identical to the other three runners.
 */
import { Frond } from "../packages/frond/src/index.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let passed = 0;
let failed = 0;

function assertEq(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
    console.log(`       actual   ${JSON.stringify(actual)}`);
  }
}

// The shared dataset. Must stay identical across all four frameworks -- an
// expression can only be compared if it is fed the same values.
function context(): Record<string, unknown> {
  return {
    name: "Andre",
    lower_name: "andre van zuydam",
    padded: "  pad  ",
    empty_str: "",
    n: 5,
    f: 1234.5678,
    neg: -42,
    t: true,
    f_bool: false,
    nil_val: null,
    user: { name: "Ann", addr: { city: "CPT" } },
    list: ["a", "b", "c"],
    map: { a: 1, b: 2 },
    html: "<b>&x</b>",
  };
}

/** Parse a `label<sep>value` fixture into an ordered list of pairs. */
function loadFixture(file: string, separator: string): Array<[string, string]> {
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const i = line.indexOf(separator);
      return [line.slice(0, i), line.slice(i + 1)] as [string, string];
    });
}

const corpus = loadFixture("frond_expression_corpus.txt", "|");
const expected = new Map(loadFixture("frond_expression_expected.txt", "\t"));

console.log("=== Frond Expression Parity (cross-framework contract) ===\n");

// Guard the guard: a corpus entry with no expected value would otherwise pass
// by never being asserted.
assertEq("corpus holds 72 expressions", corpus.length, 72);
assertEq(
  "every corpus label has an answer-key entry",
  corpus.filter(([label]) => !expected.has(label)).length,
  0,
);

{
  const engine = new Frond();
  for (const [label, source] of corpus) {
    assertEq(label, engine.renderString(source, context()), expected.get(label));
  }
}

// -- Named regressions for the bugs the corpus actually caught ---------------
// The loop above would catch these too, but only as "some line changed". These
// name the behaviour, and each carries the NEGATIVE case.

console.log("\n-- boolean rendering --");
{
  const e = new Frond();
  const ctx = { t: true, f: false, n: 5 };
  // 3.13.87 contract: a boolean renders lowercase true/false. Node was already
  // correct here (String(value)); the assertions live in all four so one
  // contract is enforced from one place and Node cannot silently drift into
  // the hole the other three were in.
  assertEq("bare true", e.renderString("{{ t }}", ctx), "true");
  assertEq("bare false", e.renderString("{{ f }}", ctx), "false");
  assertEq("comparison true", e.renderString("{{ n > 3 }}", ctx), "true");
  assertEq("comparison false", e.renderString("{{ n < 3 }}", ctx), "false");
  // A false boolean must NOT vanish -- the PHP bug this contract retired.
  assertEq("false does not render blank", e.renderString("[{{ f }}]", ctx), "[false]");
  // An integer 1 still renders as 1, not as "true".
  assertEq("integer 1 stays 1", e.renderString("{{ one }}", { one: 1 }), "1");
}

console.log("\n-- the not operator --");
{
  const e = new Frond();
  const ctx = { t: true, f: false };
  // `{{ not x }}` renders the boolean instead of being silently dropped.
  //
  // Every logical operator was matched WITH surrounding spaces, so a LEADING
  // `not` (nothing to its left) matched none of them, fell through to the
  // variable-resolution tail, and was looked up as a variable literally named
  // "not x" -- which rendered EMPTY. `{% if not x %}` and `x and not y` always
  // worked, so the operator logic was fine; only the standalone output
  // expression was lost. Before booleans rendered lowercase, a dropped
  // expression and `false -> ''` were indistinguishable, which is why it hid.
  assertEq("{{ not t }}", e.renderString("{{ not t }}", ctx), "false");
  assertEq("{{ not f }}", e.renderString("{{ not f }}", ctx), "true");
  assertEq("{{ not missing }}", e.renderString("{{ not missing }}", ctx), "true");
  // The paths that always worked -- they must not drift from the standalone form.
  assertEq(
    "not inside {% if %}",
    e.renderString("{% if not f %}Y{% else %}N{% endif %}", ctx),
    "Y",
  );
  assertEq("not combined with and", e.renderString("{{ t and not f }}", ctx), "true");
  assertEq("not as a ternary condition", e.renderString("{{ not t ? 'A' : 'B' }}", ctx), "B");
  // NEGATIVE: an identifier that merely starts with "not" is a variable, and
  // "not" inside a string literal is text. Neither is the operator.
  assertEq("'notes' is a variable", e.renderString("{{ notes }}", { notes: null }), "");
  assertEq("'nothing' is a variable", e.renderString("{{ nothing }}", { nothing: "x" }), "x");
  assertEq("'not' inside a string is text", e.renderString('{{ "not a var" }}', ctx), "not a var");
}

console.log("\n-- json_encode escaping --");
{
  const e = new Frond();
  const ctx = { data: { a: 1 } };
  // `|json_encode` escapes; `|json_encode|raw` does not. Node always escaped
  // here; PHP alone returned raw JSON and was changed to match in 3.13.87.
  assertEq(
    "json_encode escapes by default",
    e.renderString("{{ data|json_encode }}", ctx),
    "{&quot;a&quot;:1}",
  );
  assertEq(
    "json_encode|raw opts out",
    e.renderString("{{ data|json_encode|raw }}", ctx),
    '{"a":1}',
  );
}

// -- Summary ----------------------------------------------------------------
// This file SELF-EXECUTES and exits non-zero on failure. run-all.ts runs each
// test file as a standalone script: a file that only EXPORTS a function runs
// nothing and reports a passing "0 passed".
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);

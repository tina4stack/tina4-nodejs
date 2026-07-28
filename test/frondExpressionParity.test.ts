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
    // Non-finite numbers: the tina4-php#184 payload. JSON has no Infinity or
    // NaN, so both must serialize as null in every framework.
    inf_val: Infinity,
    nan_map: { v: NaN },
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
assertEq("corpus holds 84 expressions", corpus.length, 84);
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

console.log("\n-- json_encode output contract --");
{
  const e = new Frond();
  // 3.13.88 reverts 3.13.87's HTML-escaping of this filter. Entity-encoding the
  // payload produced {&quot;a&quot;:1}, a SyntaxError inside <script>, which
  // broke the filter's primary use in all four frameworks at once. The safe form
  // escapes only the dangerous characters, as JSON \uXXXX escapes: valid JSON,
  // valid JavaScript, cannot terminate a </script>, safe in a single-quoted
  // attribute. Jinja2's tojson model.
  assertEq(
    "json_encode is valid inside a script block",
    e.renderString("{{ data|json_encode }}", { data: { a: 1 } }),
    '{"a":1}',
  );
  // Negative case: escapes must be \uXXXX, never HTML entities, and </script>
  // must not survive intact.
  const escaped = e.renderString("{{ data|json_encode }}", { data: { x: "</script>&'" } });
  assertEq(
    "json_encode escapes < > & ' as \\uXXXX",
    escaped,
    '{"x":"\\u003c/script\\u003e\\u0026\\u0027"}',
  );
  assertEq("json_encode emits no HTML entities", escaped.includes("&quot;"), false);
  assertEq("json_encode cannot close a script tag", escaped.includes("</script>"), false);
  assertEq(
    "json_encode|raw is now a no-op",
    e.renderString("{{ data|json_encode|raw }}", { data: { a: 1 } }),
    '{"a":1}',
  );

  // tina4-php#184 (justin-k-bruce): a non-finite value must become null. Node
  // was the only framework already correct here; the assertion is mirrored into
  // all four so the contract is enforced from one place.
  assertEq("json_encode Infinity", e.renderString("{{ v|json_encode }}", { v: Infinity }), "null");
  assertEq("json_encode -Infinity", e.renderString("{{ v|json_encode }}", { v: -Infinity }), "null");
  assertEq("json_encode NaN", e.renderString("{{ v|json_encode }}", { v: NaN }), "null");
  assertEq(
    "json_encode nested Infinity",
    e.renderString("{{ v|json_encode }}", { v: { a: 1, b: Infinity } }),
    '{"a":1,"b":null}',
  );
  assertEq(
    "json_encode NaN in a list",
    e.renderString("{{ v|json_encode }}", { v: [1, NaN] }),
    "[1,null]",
  );
  // Negative case: undefined must not reach the page as the literal
  // "undefined" (JSON.stringify returns the VALUE undefined for it).
  assertEq("json_encode undefined", e.renderString("{{ v|json_encode }}", { v: undefined }), "null");

  // -- 3.13.89: block set + unknown tags --------------------------------------
  // {% set name %}...{% endset %} binds the rendered body. Core syntax in BOTH
  // reference engines, and broken identically in all four frameworks until now:
  // the body rendered inline where it stood and the variable was never assigned.
  const blockSet = e.renderString("{% set g %}Hi {{ n }}{% endset %}[{{ g }}]", { n: "Andre" });
  assertEq("block set captures its body", blockSet, "[Hi Andre]");
  // Negative case: the old bug printed the body first and left the variable
  // empty. Neither may happen.
  assertEq("block set does not print the body inline", blockSet.startsWith("Hi"), false);
  assertEq("block set does not leave the variable empty", blockSet.includes("[]"), false);
  assertEq(
    "block set captures a loop",
    e.renderString("{% set g %}{% for i in [1,2] %}{{ i }}{% endfor %}{% endset %}[{{ g }}]", {}),
    "[12]",
  );
  // Nesting: the inner endset must not close the outer block.
  assertEq(
    "block set nests",
    e.renderString("{% set a %}A{% set b %}B{% endset %}{{ b }}{% endset %}[{{ a }}]", {}),
    "[AB]",
  );

  // The capture is already-escaped output, so it is not escaped again. Twig and
  // Jinja2 both mark a captured block safe. A value interpolated INTO the body is
  // still escaped on the way in -- escaping happens once, in the right place.
  assertEq(
    "block set capture is not double-escaped",
    e.renderString("{% set g %}{{ h }}{% endset %}[{{ g }}]", { h: "<b>&x</b>" }),
    "[&lt;b&gt;&amp;x&lt;/b&gt;]",
  );
  assertEq(
    "literal markup in a capture stays literal",
    e.renderString("{% set g %}<b>hi</b>{% endset %}[{{ g }}]", {}),
    "[<b>hi</b>]",
  );
  // Negative case: the inline assignment form is untouched, including an "="
  // inside a quoted value -- that must NOT be read as the block form.
  assertEq("inline set still works", e.renderString('{% set g = "x" %}[{{ g }}]', {}), "[x]");
  assertEq(
    "inline set with = inside a string",
    e.renderString('{% set g = "a = b" %}[{{ g }}]', {}),
    "[a = b]",
  );

  // THE security-shaped one. {% iff user.is_admin %}...{% endiff %} used to render
  // the admin block UNCONDITIONALLY: the unknown tag emitted nothing and its body
  // was parsed as ordinary content, so a reviewer read a guard that was not there.
  // Twig and Jinja2 both raise on an unknown tag. There is no user-extension point
  // for tags, so an unknown name is always a mistake.
  let threwIff = "";
  try { e.renderString("{% iff admin %}SECRET{% endiff %}", { admin: false }); }
  catch (err: any) { threwIff = err.message; }
  assertEq("unknown tag throws", threwIff.includes('unknown tag "iff"'), true);
  assertEq("unknown tag does not leak its body", threwIff.includes("SECRET"), false);
  let threwFrob = "";
  try { e.renderString("{% frobnicate 42 %}", {}); }
  catch (err: any) { threwFrob = err.message; }
  assertEq("unknown inline tag throws", threwFrob.includes('unknown tag "frobnicate"'), true);
  // Negative case 1: every real tag still parses.
  assertEq(
    "all known tags still parse",
    e.renderString(
      "{% if 1 %}x{% endif %}{% for i in [1] %}{{ i }}{% endfor %}" +
      "{% raw %}{{ q }}{% endraw %}{% spaceless %} a {% endspaceless %}" +
      "{% autoescape true %}y{% endautoescape %}", {},
    ),
    "x1{{ q }} a y",
  );
  // Negative case 2: a STRAY terminator is not an unknown tag. It stays a silent
  // no-op -- it was always one, and unlike an unknown tag it cannot expose gated
  // content.
  assertEq("a stray terminator stays a no-op", e.renderString("A{% endif %}B", {}), "AB");

  // The three spellings share one serializer and must not drift apart.
  const ctx = { v: { a: 1, u: "a/b", n: "caf\u00e9", bad: Infinity } };
  const out = e.renderString("{{ v|json_encode }}", ctx);
  assertEq("to_json matches json_encode", e.renderString("{{ v|to_json }}", ctx), out);
  assertEq("tojson matches json_encode", e.renderString("{{ v|tojson }}", ctx), out);
  // Slashes stay unescaped and non-ASCII stays raw -- PHP alone used to write
  // "a\\/b", and Python alone used to write "caf\\u00e9".
  assertEq("json_encode leaves / unescaped", out.includes('"u":"a/b"'), true);
  assertEq("json_encode leaves non-ASCII raw", out.includes("caf\u00e9"), true);
}

// -- Summary ----------------------------------------------------------------
// This file SELF-EXECUTES and exits non-zero on failure. run-all.ts runs each
// test file as a standalone script: a file that only EXPORTS a function runs
// nothing and reports a passing "0 passed".
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);

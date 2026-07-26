/**
 * Regression: a macro parameter declared WITH a default was unusable.
 *
 * handleMacro / handleFromImport split the parameter list on "," only, so
 * `{% macro greet(name, greeting='Hello') %}` produced a parameter literally
 * NAMED "greeting='Hello'". Two things broke at once:
 *
 *   1. the body's {{ greeting }} matched no key            -> rendered EMPTY
 *   2. a caller's positional argument went to that junk key -> SILENTLY LOST
 *
 *      {% macro d(a, b='B') %}[{{ a }}|{{ b }}]{% endmacro %}
 *      {{ d(1) }}{{ d(1,2) }}
 *      before: "[1|][1|]"     <- default gone AND the explicit 2 gone
 *      after:  "[1|B][1|2]"
 *
 * Parameters with NO default always worked, which is why this hid for so long.
 * Fixed by Frond.parseMacroParams, mirroring the Python master's
 * _parse_macro_params. Python is the reference implementation; every expectation
 * below was verified against a real Python render of the same template.
 *
 * No mocks: real template files in a real temp dir through the real engine.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Frond } from "../packages/frond/src/index.js";

let passed = 0;
let failed = 0;

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    // eslint-disable-next-line no-console
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frond-macro-defaults-"));

function render(source: string, name = "t.twig"): string {
  fs.writeFileSync(path.join(dir, name), source);
  return new Frond(dir).render(name, {});
}

try {
  // ---------------------------------------------------------------- positive

  it("applies a single-quoted default when the argument is omitted", () => {
    assert.equal(
      render("{% macro d(a, b='B') %}[{{ a }}|{{ b }}]{% endmacro %}{{ d(1) }}", "p1.twig"),
      "[1|B]",
    );
  });

  it("applies a double-quoted default when the argument is omitted", () => {
    assert.equal(
      render('{% macro d(a, b="dq") %}[{{ a }}|{{ b }}]{% endmacro %}{{ d(1) }}', "p2.twig"),
      "[1|dq]",
    );
  });

  it("lets an explicit argument override the default", () => {
    assert.equal(
      render("{% macro d(a, b='B') %}[{{ a }}|{{ b }}]{% endmacro %}{{ d(1,2) }}", "p3.twig"),
      "[1|2]",
    );
  });

  it("still binds parameters that declare no default", () => {
    assert.equal(
      render("{% macro t(a, b, c) %}[{{ a }}|{{ b }}|{{ c }}]{% endmacro %}{{ t(1,2,3) }}", "p4.twig"),
      "[1|2|3]",
    );
  });

  it("honours defaults through {% from \"file\" import %}", () => {
    fs.writeFileSync(
      path.join(dir, "macros.twig"),
      "{% macro greet(name, greeting='Hello') %}<p>{{ greeting }}, {{ name }}!</p>{% endmacro %}",
    );
    assert.equal(
      render(
        '{% from "macros.twig" import greet %}{{ greet("Andre") }}|{{ greet("Ann","Yo") }}',
        "p5.twig",
      ),
      "<p>Hello, Andre!</p>|<p>Yo, Ann!</p>",
    );
  });

  // ---------------------------------------------------------------- negative

  it("does not render an empty value where the default belongs", () => {
    const out = render("{% macro d(a, b='B') %}[{{ a }}|{{ b }}]{% endmacro %}{{ d(1) }}", "n1.twig");
    assert.notEqual(out, "[1|]", "the default was dropped (pre-fix behaviour)");
    assert.ok(out.includes("B"), "the default value must reach the body");
  });

  it("does not silently drop an explicitly-passed argument", () => {
    const out = render("{% macro d(a, b='B') %}[{{ a }}|{{ b }}]{% endmacro %}{{ d(1,2) }}", "n2.twig");
    assert.notEqual(out, "[1|]", "the explicit argument was swallowed (pre-fix behaviour)");
    assert.ok(out.includes("2"), "an explicitly-passed argument must not be dropped");
  });

  it("never leaks the default declaration syntax into the output", () => {
    const out = render("{% macro d(a, b='B') %}[{{ a }}|{{ b }}]{% endmacro %}{{ d(1) }}", "n3.twig");
    assert.ok(!out.includes("="), "default syntax leaked into the render");
    assert.ok(!out.includes("'"), "default quoting leaked into the render");
  });

  // ------------------------------------------------------------ parser unit
  // Pure function over its inputs -- no dependency, no double.

  it("parses name / name='d' / name=\"d\" into [name, default] pairs", () => {
    assert.deepEqual(Frond.parseMacroParams("a, b='B'"), [["a", null], ["b", "B"]]);
    assert.deepEqual(Frond.parseMacroParams('x, y="Z"'), [["x", null], ["y", "Z"]]);
  });

  it("handles an empty and a whitespace-heavy parameter list", () => {
    assert.deepEqual(Frond.parseMacroParams(""), []);
    assert.deepEqual(Frond.parseMacroParams("  a ,  b  "), [["a", null], ["b", null]]);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// eslint-disable-next-line no-console
console.log(`\nFrond macro default params: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

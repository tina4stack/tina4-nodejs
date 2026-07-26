/**
 * {% import "file" as alias %} -- load every macro in a file under one namespace.
 *
 * Node did not implement this tag at all: it was silently ignored and
 * {{ m.greet("Andre") }} rendered as EMPTY -- worse than an error, because a template
 * using it fails with no signal. The alias is now bound as a plain object of macro
 * functions, so {{ alias.greet(x) }} resolves through the engine's existing
 * dotted-call path with the same argument binding, defaults and SafeString output.
 *
 * A namespace OBJECT (not a class) is deliberate: a function stored as a class
 * attribute binds as a method and injects the namespace as the first argument -- the
 * exact argument-shift bug the Python master carried before its SimpleNamespace fix.
 *
 * Every expectation was verified against a real Python render of the same templates
 * (Python is the reference implementation), so all four frameworks agree byte-for-byte.
 *
 * No mocks: real .twig files in a real temp dir through the real engine.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frond-import-as-"));
fs.writeFileSync(
  path.join(dir, "macros.twig"),
  "{% macro greet(name, greeting='Hello') %}<p>{{ greeting }}, {{ name }}!</p>{% endmacro %}" +
    "{% macro shout(w) %}<b>{{ w }}</b>{% endmacro %}" +
    "{% macro three(a, b, c) %}[{{ a }}|{{ b }}|{{ c }}]{% endmacro %}",
);

function render(source: string, name = "t.twig"): string {
  fs.writeFileSync(path.join(dir, name), source);
  return new Frond(dir).render(name, {});
}

try {
  // ---------------------------------------------------------------- positive

  it("passes the argument to the aliased macro", () => {
    assert.equal(
      render('{% import "macros.twig" as m %}{{ m.greet("Andre") }}', "p1.twig"),
      "<p>Hello, Andre!</p>",
    );
  });

  it("honours a second argument", () => {
    assert.equal(
      render('{% import "macros.twig" as m %}{{ m.greet("Ann","Yo") }}', "p2.twig"),
      "<p>Yo, Ann!</p>",
    );
  });

  it("does not shift arguments across three parameters", () => {
    assert.equal(
      render('{% import "macros.twig" as m %}{{ m.three(1, 2, 3) }}', "p3.twig"),
      "[1|2|3]",
    );
  });

  it("exposes every macro in the imported file", () => {
    assert.equal(
      render('{% import "macros.twig" as m %}{{ m.shout("x") }}{{ m.greet("Z") }}', "p4.twig"),
      "<b>x</b><p>Hello, Z!</p>",
    );
  });

  it("renders identically to {% from import %}", () => {
    const asOut = render('{% import "macros.twig" as m %}{{ m.greet("Andre") }}', "cmpA.twig");
    const fromOut = render('{% from "macros.twig" import greet %}{{ greet("Andre") }}', "cmpF.twig");
    assert.equal(asOut, fromOut, "the two import forms must render identically");
  });

  // ---------------------------------------------------------------- negative

  it("does not render empty (the pre-implementation behaviour)", () => {
    const out = render('{% import "macros.twig" as m %}{{ m.greet("Andre") }}', "n1.twig");
    assert.notEqual(out, "", "the import tag was silently ignored");
    assert.ok(out.includes("Andre"));
  });

  it("never leaks a namespace object or address into the output", () => {
    const out = render('{% import "macros.twig" as m %}{{ m.greet("Andre") }}', "n2.twig");
    assert.ok(!out.includes("Namespace"));
    assert.ok(!out.includes("[object"));
    assert.ok(!/0x[0-9a-f]+/.test(out), "an object address leaked");
  });

  it("stays silent on a malformed import tag instead of hanging or crashing", () => {
    // Regression: the dispatch branch originally forgot to advance the token index,
    // so ANY {% import %} spun forever and died on an out-of-memory heap error.
    assert.equal(render('{% import "macros.twig" %}after', "bad.twig"), "after");
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// eslint-disable-next-line no-console
console.log(`\nFrond import-as: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

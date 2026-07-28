/**
 * Sandbox contract: a sandbox denies by revoking capability, not by skipping a step.
 *
 * Audit feature 38 (plan/v3/features/038-sandboxing.md), P1. Mirrors
 * tina4-python/tests/test_frond_sandbox_contract.py,
 * tina4-php/tests/FrondSandboxContractTest.php and
 * tina4-ruby/spec/frond_sandbox_contract_spec.rb.
 *
 * Three ways an untrusted template defeated the Node sandbox:
 *
 * P1  {{ x|raw }} / {{ x|safe }} with raw/safe DENIED still produced UNESCAPED
 *     output. isSafe was set from the filter NAME before the sandbox gate ran, so
 *     skipping the filter left the value marked safe anyway. Denying raw produced
 *     byte-identical output to allowing it.
 *
 * P1c NODE ONLY, and the same root cause with a wider blast radius: |escape and |e
 *     also set isSafe from the name. Node's escape filter returns a PLAIN string
 *     (engine.ts) rather than a SafeString, so the flag is what suppresses
 *     auto-escaping -- and a DENIED escape therefore marked the value safe WITHOUT
 *     ever escaping it, emitting live markup. The other three frameworks are immune
 *     by construction because escaping produces a value-level marker only when the
 *     filter actually RUNS: a SafeString in Python and Ruby, a RAW_MARKER sentinel
 *     in PHP. Node is the only one that trusts the name.
 *
 * P1b the tag gate covered four names (if, for, set, include). Every other tag
 *     ignored the allow-list, so {% autoescape false %} switched escaping off from
 *     inside a sandbox whose tags were restricted to something else entirely.
 *
 * Node already had skipBlock and already used it for if/for/set, so the
 * body-consumption half of the token-stream problem was solved here before this
 * change -- the gate just needed to cover the whole vocabulary rather than four
 * hardcoded names.
 *
 * Pure string rendering. No I/O, no dependency, no doubles.
 */

import assert from "node:assert/strict";
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

const XSS = "<script>alert(1)</script>";
const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";

/** A sandbox whose filter allow-list does NOT include raw or safe. */
const denied = (): Frond => new Frond().sandbox(["upper"], ["if"], ["x"]);

/** The same sandbox, but raw and safe ARE on the allow-list. */
const allowed = (): Frond => new Frond().sandbox(["upper", "raw", "safe"], ["if"], ["x"]);

// --- pair 1: raw is revocable ---------------------------------------------

it("escapes the value when raw is denied", () => {
  assert.equal(denied().renderString("{{ x|raw }}", { x: XSS }), ESCAPED);
});

it("negative: a denied raw filter never produces unescaped output", () => {
  const out = denied().renderString("{{ x|raw }}", { x: XSS });
  assert.ok(!out.includes("<script>"), `a DENIED raw filter produced live markup: ${out}`);
});

// --- pair 2: safe is revocable -------------------------------------------

it("escapes the value when safe is denied", () => {
  assert.equal(denied().renderString("{{ x|safe }}", { x: XSS }), ESCAPED);
});

it("negative: a denied safe filter never produces unescaped output", () => {
  const out = denied().renderString("{{ x|safe }}", { x: XSS });
  assert.ok(!out.includes("<script>"), `a DENIED safe filter produced live markup: ${out}`);
});

// --- pair 3: deny must differ from allow ---------------------------------

it("renders verbatim when raw is allowed and escaped when denied", () => {
  assert.equal(allowed().renderString("{{ x|raw }}", { x: XSS }), XSS);
  assert.equal(denied().renderString("{{ x|raw }}", { x: XSS }), ESCAPED);
});

it("negative: denying a filter never produces the same output as allowing it", () => {
  assert.notEqual(
    denied().renderString("{{ x|raw }}", { x: XSS }),
    allowed().renderString("{{ x|raw }}", { x: XSS }),
    "denying raw and allowing raw produced identical output - the gate is inert",
  );
});

// --- pair 4: escape is revocable too (P1c, Node-only hole) ---------------

it("negative: a denied escape filter never produces unescaped output", () => {
  // THE NODE-SPECIFIC REPRODUCTION. escape is not on the allow-list, so it must
  // not run -- and because it did not run, the value must still be auto-escaped.
  // Marking it safe from the NAME emitted live markup instead.
  const out = denied().renderString("{{ x|escape }}", { x: XSS });
  assert.ok(
    !out.includes("<script>"),
    `a DENIED escape filter produced live markup: ${out}. The name conferred safety ` +
      `that the filter never actually applied.`,
  );
});

it("negative: a denied e filter never produces unescaped output", () => {
  const out = denied().renderString("{{ x|e }}", { x: XSS });
  assert.ok(!out.includes("<script>"), `a DENIED e filter produced live markup: ${out}`);
});

it("still escapes exactly once when escape IS allowed", () => {
  // The guard must not cost the allowed path: |escape escapes once, never twice.
  const e = new Frond().sandbox(["escape"], ["if"], ["x"]);
  assert.equal(e.renderString("{{ x|escape }}", { x: XSS }), ESCAPED);
});

// --- pair 5: the tag gate cannot be bypassed (P1b) -----------------------

it("does not let a denied autoescape tag disable escaping", () => {
  const out = denied().renderString("{% autoescape false %}{{ x }}{% endautoescape %}", {
    x: XSS,
  });
  assert.ok(
    !out.includes("<script>"),
    `{% autoescape false %} disabled escaping despite not being on the tag allow-list: ${out}`,
  );
});

it("negative: no tag can disable escaping inside a sandbox", () => {
  for (const tpl of [
    "{% autoescape false %}{{ x }}{% endautoescape %}",
    "{% autoescape off %}{{ x }}{% endautoescape %}",
  ]) {
    const out = denied().renderString(tpl, { x: XSS });
    assert.ok(!out.includes("<script>"), `${tpl} disabled escaping: ${out}`);
  }
});

// --- pair 6: a denied tag consumes its body -----------------------------

it("consumes the body of a denied block tag instead of leaking it", () => {
  const e = new Frond().sandbox(["upper"], ["if"], ["x", "items"]);
  const out = e.renderString("{% for i in items %}LEAK{% endfor %}", { items: [1, 2] });
  assert.ok(!out.includes("LEAK"), `a DENIED block tag leaked its body: ${out}`);
});

it("keeps a denied tag from binding a variable (no side effects)", () => {
  const e = new Frond().sandbox(["upper"], ["if"], ["x", "y"]);
  const out = e.renderString("{% set y = 'LEAK' %}{{ y }}", {});
  assert.ok(!out.includes("LEAK"), `a DENIED set tag bound its variable anyway: ${out}`);
});

it("gates a nested denied tag", () => {
  const e = new Frond().sandbox(["upper"], ["if"], ["x", "items"]);
  const out = e.renderString("{% if x %}{% for i in items %}LEAK{% endfor %}{% endif %}", {
    x: true,
    items: [1, 2],
  });
  assert.ok(!out.includes("LEAK"), `a nested DENIED tag ran: ${out}`);
});

it("still runs an allowed nested tag", () => {
  const e = new Frond().sandbox(["upper"], ["if", "for"], ["x", "items"]);
  const out = e.renderString("{% if x %}{% for i in items %}Y{% endfor %}{% endif %}", {
    x: true,
    items: [1, 2],
  });
  assert.equal(out, "YY", "an ALLOWED nested tag was blocked");
});

// --- pair 7: what must NOT change ---------------------------------------

it("never gates output on the tag allow-list", () => {
  const e = new Frond().sandbox(undefined, ["if"], undefined);
  assert.equal(e.renderString("{{ greeting }}", { greeting: "hello" }), "hello");
});

it("runs an allowed filter and skips a denied one", () => {
  const e = new Frond().sandbox(["upper"], ["if"], ["v"]);
  assert.equal(e.renderString("{{ v|upper }}", { v: "MiXeD" }), "MIXED");
  assert.equal(e.renderString("{{ v|lower }}", { v: "MiXeD" }), "MiXeD");
});

it("still renders a denied variable as empty", () => {
  const e = new Frond().sandbox(["upper"], ["if"], ["ok"]);
  assert.equal(e.renderString("{{ secret }}", { ok: "y", secret: "LEAKED" }), "");
});

it("leaves escaping outside a sandbox unchanged", () => {
  const plain = new Frond();
  assert.equal(plain.renderString("{{ x }}", { x: XSS }), ESCAPED);
  assert.equal(plain.renderString("{{ x|raw }}", { x: XSS }), XSS);
  assert.equal(plain.renderString("{{ x|safe }}", { x: XSS }), XSS);
  assert.equal(plain.renderString("{{ x|escape }}", { x: XSS }), ESCAPED);
});

it("restores raw on unsandbox", () => {
  const e = denied();
  assert.equal(e.renderString("{{ x|raw }}", { x: XSS }), ESCAPED);
  e.unsandbox();
  assert.equal(e.renderString("{{ x|raw }}", { x: XSS }), XSS);
});

// --- undefined vs empty allow-list --------------------------------------
// undefined means "allow everything". An EMPTY array must not silently mean the
// same, or a caller who computes an allow-list and gets nothing back opens the
// sandbox.

it("permits everything on an undefined allow-list", () => {
  const e = new Frond().sandbox(undefined, undefined, undefined);
  assert.equal(e.renderString("{{ x|raw }}", { x: XSS }), XSS);
});

it("negative: an empty allow-list does not permit everything", () => {
  const e = new Frond().sandbox([], [], ["x"]);
  const out = e.renderString("{{ x|raw }}", { x: XSS });
  assert.ok(
    !out.includes("<script>"),
    `an EMPTY filter allow-list behaved like undefined (allow all): ${out}`,
  );
});

// eslint-disable-next-line no-console
console.log(`\nFrond sandbox contract: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

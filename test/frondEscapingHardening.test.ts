/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Frond auto-escaping + sandbox hardening — F2, F4, F5, F6, F7 (ADR-0077).
 * Real renders, inert markup, mutation-proved.
 * Run with: npx tsx test/frondEscapingHardening.test.ts
 */
import { Frond } from "../packages/frond/src/index.ts";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

const f = new Frond("/nonexistent");

// F4 — structured values are escaped
assert("F4 list escaped", !f.renderString("{{ items }}", { items: ["<b>x</b>"] }).includes("<b>x</b>"));
assert("F4 object escaped", !f.renderString("{{ d }}", { d: { a: "<b>x</b>" } }).includes("<b>x</b>"));
assert("F4 string still escaped", f.renderString("{{ s }}", { s: "<b>x</b>" }) === "&lt;b&gt;x&lt;/b&gt;");
assert("number unchanged", f.renderString("{{ n }}", { n: 5 }) === "5");

// F2 — a filter after e/escape re-escapes
assert("F2 e|replace reescapes", !f.renderString("{{ 'Hi @@'|e|replace('@@', u) }}", { u: "<b>x</b>" }).includes("<b>x</b>"));
assert("F2 e('html')|replace reescapes", !f.renderString("{{ 'Hi @@'|e('html')|replace('@@', u) }}", { u: "<b>x</b>" }).includes("<b>x</b>"));

// F5 — js_escape neutralises markup
{
  const o = f.renderString("{{ u|js_escape }}", { u: "</b>&'\"" });
  assert("F5 js_escape neutralises markup", !/[<>&/'"]/.test(o));
}

// F7 — e(strategy)
assert("F7 e('url')", f.renderString("{{ u|e('url') }}", { u: "a b&c/d" }) === "a%20b%26c%2Fd");
assert("F7 e('html_attr')", f.renderString("{{ u|e('html_attr') }}", { u: 'a"b' }) === "a&#x22;b");
{
  let threw = false;
  try { f.renderString("{{ u|e('bogus') }}", { u: "x" }); } catch { threw = true; }
  assert("F7 unknown strategy throws", threw);
}

// F6 — prototype/constructor escape blocked
assert("F6 constructor call blocked", !f.renderString("{{ d.constructor('return 1') }}", { d: {} }).includes("return 1"));

// F6 — sandbox allow-list is not bypassable
{
  const s = new Frond("/nonexistent");
  s.sandbox(["upper"], ["if", "for", "set"], ["user"]);
  assert("F6 set cannot smuggle", !s.renderString("{% set user = secret %}{{ user }}", { secret: "hunter2" }).includes("hunter2"));
  assert("F6 for cannot smuggle", !s.renderString("{% for x in [secret] %}{{ x }}{% endfor %}", { secret: "hunter2" }).includes("hunter2"));
  assert("F6 if cannot read blocked var", s.renderString("{% if secret == 'hunter2' %}YES{% endif %}", { secret: "hunter2" }) === "");
  assert("F6 allowed var + filter still render", s.renderString("{{ user|upper }}", { user: "bob" }) === "BOB");
}

console.log(`\nFrond escaping hardening: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

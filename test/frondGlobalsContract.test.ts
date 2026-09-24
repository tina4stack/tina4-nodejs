/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Frond globals contract — ADR-0085.
 *
 * A bare zero-argument callable global is invoked and its RETURN VALUE is used
 * for both ``{{ g }}`` output and ``{% if g %}`` conditions. Explicit ``g()``
 * still works and never double-calls. A non-callable global is unchanged, a
 * global that returns a callable is called once (not twice), and an
 * unregistered ``nope()`` is falsy rather than an error.
 *
 * Node is the reference implementation (engine.ts resolvePathPart auto-calls a
 * function member on bare access). This suite is the guard that pins that
 * behaviour so a refactor cannot silently drop it; Python, PHP and Ruby ship
 * the same cases against the shared fixture frond_globals_contract.json.
 *
 * Run with: npx tsx test/frondGlobalsContract.test.ts
 */
import { Frond } from "../packages/frond/src/index.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

console.log("=== Frond Globals Contract (ADR-0085) ===\n");

// zero arg global closure returning false is falsy in if
{
  const f = new Frond();
  f.addGlobal("admin_only", () => false);
  assert(
    "zero arg global closure returning false is falsy in if",
    f.renderString("{% if admin_only %}Y{% else %}N{% endif %}", {}) === "N",
  );
}

// zero arg global closure returning true is truthy in if
{
  const f = new Frond();
  f.addGlobal("admin_only", () => true);
  assert(
    "zero arg global closure returning true is truthy in if",
    f.renderString("{% if admin_only %}Y{% else %}N{% endif %}", {}) === "Y",
  );
}

// zero arg global closure prints its return value
{
  const f = new Frond();
  f.addGlobal("greeting", () => "hello");
  assert(
    "zero arg global closure prints its return value",
    f.renderString("{{ greeting }}", {}) === "hello",
  );
}

// explicit call syntax still works
{
  const f = new Frond();
  f.addGlobal("admin_only", () => false);
  assert(
    "explicit call syntax still works",
    f.renderString("{% if admin_only() %}Y{% else %}N{% endif %}", {}) === "N",
  );
}

// non callable global is unchanged
{
  const f = new Frond();
  f.addGlobal("site_name", "Tina4");
  assert(
    "non callable global is unchanged",
    f.renderString("{{ site_name }}", {}) === "Tina4",
  );
}

// global returning a callable is not double called
{
  const f = new Frond();
  let outerCalls = 0;
  let innerCalls = 0;
  f.addGlobal("outer", () => {
    outerCalls++;
    return () => {
      innerCalls++;
      return "inner";
    };
  });
  // A bare reference calls the global ONCE and yields the inner function; the
  // inner function must NOT be invoked (no double-call).
  f.renderString("{% if outer %}Y{% endif %}", {});
  assert(
    "global returning a callable is not double called",
    outerCalls === 1 && innerCalls === 0,
  );
}

// unregistered function call is falsy
{
  const f = new Frond();
  assert(
    "unregistered function call is falsy",
    f.renderString("{% if nope() %}Y{% else %}N{% endif %}", {}) === "N" &&
      f.renderString("{{ nope() }}", {}) === "",
  );
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

process.exit(failed > 0 ? 1 : 0);

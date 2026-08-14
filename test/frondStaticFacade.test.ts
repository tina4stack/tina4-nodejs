/**
 * Tests for the Frond static-facade pattern — class-level registries
 * for filters, globals, and tests.
 *
 * Mirrors the Python parity feature: ``Frond.addFilter("money", fn)``
 * at app startup updates a class registry that every future
 * ``new Frond()`` instance drains on construction.
 *
 * Run with: npx tsx test/frondStaticFacade.test.ts
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

console.log("=== Frond Static-Facade Tests ===\n");

// Always clear before each block so test order can't leak state.
// Built-in filters/globals are NOT touched — clearRegistry() only
// clears the class-level user registry.
Frond.clearRegistry();

Frond.addFilter("class_filter", (value) => `class:${String(value)}`);
assert(
  "class registration is process global",
  new Frond().renderString("{{ value | class_filter }}", { value: "value" }) === "class:value",
);

// ── Static addFilter is inherited by NEW instances ─────────────
console.log("--- Static addFilter ---");

Frond.addFilter("money", (value) => {
  const n = Number(value) || 0;
  return n.toFixed(2);
});

const f1 = new Frond();
assert(
  "Static-registered filter available in new instance",
  f1.renderString("{{ 100 | money }}", {}) === "100.00",
);
assert(
  "Static filter applies to instance-supplied value",
  f1.renderString("{{ price | money }}", { price: 12.5 }) === "12.50",
);

// A second new instance also sees it — proves it lives at class level
const f2 = new Frond();
assert(
  "Second new instance also inherits static filter",
  f2.renderString("{{ 7 | money }}", {}) === "7.00",
);

// ── Static addGlobal ───────────────────────────────────────────
console.log("\n--- Static addGlobal ---");

Frond.addGlobal("APP", "MyApp");
Frond.addGlobal("VERSION", "3.13.4");

const f3 = new Frond();
assert(
  "Static global resolves in new instance",
  f3.renderString("{{ APP }}", {}) === "MyApp",
);
assert(
  "Second static global resolves",
  f3.renderString("{{ APP }} v{{ VERSION }}", {}) === "MyApp v3.13.4",
);

// ── Static addTest ─────────────────────────────────────────────
console.log("\n--- Static addTest ---");

Frond.addTest("positive", (v) => Number(v) > 0);
Frond.addTest("negative", (v) => Number(v) < 0);

const f4 = new Frond();
assert(
  "Static test resolves true",
  f4.renderString("{% if x is positive %}yes{% else %}no{% endif %}", { x: 5 }) === "yes",
);
assert(
  "Static test resolves false",
  f4.renderString("{% if x is positive %}yes{% else %}no{% endif %}", { x: -1 }) === "no",
);
assert(
  "Second static test (negative)",
  f4.renderString("{% if n is negative %}neg{% else %}pos{% endif %}", { n: -3 }) === "neg",
);

// ── Instance registrations stay local ─────────────────────────
console.log("\n--- Instance registrations stay local ---");

const f5 = new Frond();
f5.addFilter("shout", (v) => String(v).toUpperCase() + "!");
assert(
  "Instance filter works on its own instance",
  f5.renderString("{{ name | shout }}", { name: "hello" }) === "HELLO!",
);

const f6 = new Frond();
assert(
  "instance filter registration is instance local",
  f6.renderString("{{ name | shout }}", { name: "world" }) === "world",
);

// Instance addGlobal — same promotion semantics
const f7 = new Frond();
f7.addGlobal("BUILD", "abc123");
const f8 = new Frond();
assert(
  "instance global registration is instance local",
  f8.renderString("{{ BUILD }}", {}) === "",
);

// Instance addTest — same promotion semantics
const f9 = new Frond();
f9.addTest("is_four_only", (v) => Number(v) === 4);
const f10 = new Frond();
assert(
  "instance test registration is instance local",
  f10.renderString("{% if n is is_four_only %}E{% else %}O{% endif %}", { n: 4 }) === "O",
);

// ── clearRegistry wipes class-level entries ────────────────────
console.log("\n--- clearRegistry ---");

Frond.clearRegistry();

const f11 = new Frond();
// money was registered statically — should NOT survive clearRegistry
assert(
  "Cleared filter no longer applies (raw value renders)",
  f11.renderString("{{ 100 | money }}", {}) === "100",
);
assert(
  "Cleared global resolves to empty",
  f11.renderString("{{ APP }}", {}) === "",
);
assert(
  "Cleared test gone — uses fallback branch",
  f11.renderString("{% if x is positive %}yes{% else %}no{% endif %}", { x: 5 }) === "no",
);

// ── Built-in filters survive clearRegistry ─────────────────────
console.log("\n--- Built-in filters survive clearRegistry ---");

const f12 = new Frond();
assert(
  "Built-in upper still works after clearRegistry",
  f12.renderString("{{ name | upper }}", { name: "abc" }) === "ABC",
);
assert(
  "Built-in lower still works after clearRegistry",
  f12.renderString("{{ name | lower }}", { name: "ABC" }) === "abc",
);
assert(
  "Built-in default still works after clearRegistry",
  f12.renderString("{{ missing | default('fallback') }}", {}) === "fallback",
);

// Final cleanup — leave no class-level state behind for other suites
Frond.clearRegistry();

// ── Summary ────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

process.exit(failed > 0 ? 1 : 0);

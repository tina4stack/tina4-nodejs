/**
 * Unit tests for the Frond template engine.
 * Run with: npx tsx test/frond.test.ts
 */
import { Frond } from "../packages/frond/src/index.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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

// Helper to create a temporary template directory for include/extends tests
const tmpDir = "/tmp/frond-test-templates";
try { rmSync(tmpDir, { recursive: true }); } catch {}
mkdirSync(tmpDir, { recursive: true });

const engine = new Frond(tmpDir);

console.log("=== Frond Template Engine Tests ===\n");

// ── Variables ──────────────────────────────────────────────────
console.log("--- Variables ---");

assert("Simple variable", engine.renderString("Hello {{ name }}", { name: "World" }) === "Hello World");
assert("Dotted path", engine.renderString("{{ user.name }}", { user: { name: "Alice" } }) === "Alice");
assert("Array access", engine.renderString("{{ items[0] }}", { items: ["a", "b", "c"] }) === "a");
assert("Nested access", engine.renderString("{{ users[0].name }}", { users: [{ name: "Bob" }] }) === "Bob");
assert("Undefined variable", engine.renderString("{{ missing }}", {}) === "");
assert("Null variable", engine.renderString("{{ val }}", { val: null }) === "");
assert("Boolean true", engine.renderString("{{ val }}", { val: true }) === "true");
assert("Number variable", engine.renderString("{{ num }}", { num: 42 }) === "42");

// ── Auto-escaping ──────────────────────────────────────────────
console.log("\n--- Auto-escaping ---");

assert("HTML auto-escaped", engine.renderString("{{ html }}", { html: "<b>bold</b>" }) === "&lt;b&gt;bold&lt;/b&gt;");
assert("Raw filter skips escaping", engine.renderString("{{ html | raw }}", { html: "<b>bold</b>" }) === "<b>bold</b>");
assert("Safe filter skips escaping", engine.renderString("{{ html | safe }}", { html: "<i>em</i>" }) === "<i>em</i>");

// ── String concatenation ───────────────────────────────────────
console.log("\n--- Concatenation ---");

assert("Tilde concat", engine.renderString('{{ "Hello" ~ " " ~ name }}', { name: "World" }) === "Hello World");

// ── Ternary ────────────────────────────────────────────────────
console.log("\n--- Ternary ---");

assert("Ternary true", engine.renderString('{{ active ? "yes" : "no" }}', { active: true }) === "yes");
assert("Ternary false", engine.renderString('{{ active ? "yes" : "no" }}', { active: false }) === "no");

// ── Null coalescing ────────────────────────────────────────────
console.log("\n--- Null coalescing ---");

assert("Coalescing with null", engine.renderString('{{ val ?? "fallback" }}', { val: null }) === "fallback");
assert("Coalescing with value", engine.renderString('{{ val ?? "fallback" }}', { val: "found" }) === "found");

// ── Filters ────────────────────────────────────────────────────
console.log("\n--- Filters ---");

assert("upper", engine.renderString("{{ name | upper }}", { name: "hello" }) === "HELLO");
assert("lower", engine.renderString("{{ name | lower }}", { name: "HELLO" }) === "hello");
assert("capitalize", engine.renderString("{{ name | capitalize }}", { name: "hello world" }) === "Hello world");
assert("title", engine.renderString("{{ name | title }}", { name: "hello world" }) === "Hello World");
assert("trim", engine.renderString("{{ name | trim }}", { name: "  hi  " }) === "hi");
assert("ltrim", engine.renderString("{{ name | ltrim }}", { name: "  hi  " }) === "hi  ");
assert("rtrim", engine.renderString("{{ name | rtrim }}", { name: "  hi  " }) === "  hi");
assert("length array", engine.renderString("{{ items | length }}", { items: [1, 2, 3] }) === "3");
assert("length string", engine.renderString("{{ name | length }}", { name: "hello" }) === "5");
assert("replace", engine.renderString('{{ name | replace("world", "earth") }}', { name: "hello world" }) === "hello earth");
assert("striptags", engine.renderString("{{ html | striptags }}", { html: "<p>Hello</p>" }) === "Hello");
assert("default with empty", engine.renderString('{{ val | default("N/A") }}', { val: "" }) === "N/A");
assert("default with value", engine.renderString('{{ val | default("N/A") }}', { val: "ok" }) === "ok");
assert("abs", engine.renderString("{{ num | abs }}", { num: -5 }) === "5");
assert("round", engine.renderString("{{ num | round(2) }}", { num: 3.14159 }) === "3.14");
assert("int filter", engine.renderString("{{ val | int }}", { val: "42" }) === "42");
assert("float filter", engine.renderString("{{ val | float }}", { val: "3.14" }) === "3.14");
assert("join", engine.renderString('{{ items | join(", ") }}', { items: ["a", "b", "c"] }) === "a, b, c");
assert("split", engine.renderString("{{ name | split(\" \") | length }}", { name: "hello world" }) === "2");
assert("first", engine.renderString("{{ items | first }}", { items: [10, 20, 30] }) === "10");
assert("last", engine.renderString("{{ items | last }}", { items: [10, 20, 30] }) === "30");
assert("reverse array", engine.renderString('{{ items | reverse | join(",") }}', { items: [1, 2, 3] }) === "3,2,1");
assert("sort", engine.renderString('{{ items | sort | join(",") }}', { items: [3, 1, 2] }) === "1,2,3");
assert("unique", engine.renderString('{{ items | unique | join(",") }}', { items: [1, 2, 2, 3] }) === "1,2,3");
assert("keys", engine.renderString('{{ obj | keys | join(",") }}', { obj: { a: 1, b: 2 } }) === "a,b");
assert("values", engine.renderString('{{ obj | values | join(",") }}', { obj: { a: 1, b: 2 } }) === "1,2");
assert("slice", engine.renderString('{{ items | slice(1, 3) | join(",") }}', { items: [10, 20, 30, 40] }) === "20,30");
assert("batch", engine.renderString("{{ items | batch(2) | length }}", { items: [1, 2, 3, 4, 5] }) === "3");
assert("json_encode", engine.renderString("{{ data | json_encode | safe }}", { data: { a: 1 } }) === '{"a":1}');
assert("escape filter", engine.renderString("{{ html | escape }}", { html: "<b>hi</b>" }) === "&lt;b&gt;hi&lt;/b&gt;");
assert("slug", engine.renderString("{{ title | slug }}", { title: "Hello World!" }) === "hello-world");
assert("truncate", engine.renderString('{{ text | truncate(5) }}', { text: "Hello World" }) === "Hello...");
assert("nl2br", engine.renderString("{{ text | nl2br | safe }}", { text: "a\nb" }) === "a<br>\nb");
assert("number_format", engine.renderString("{{ num | number_format(2) }}", { num: 1234.5 }) === "1,234.50");
assert("base64_encode", engine.renderString("{{ text | base64_encode }}", { text: "hello" }) === "aGVsbG8=");
assert("base64_decode", engine.renderString("{{ text | base64_decode }}", { text: "aGVsbG8=" }) === "hello");
assert("url_encode", engine.renderString("{{ text | url_encode }}", { text: "hello world" }) === "hello%20world");
assert("md5", engine.renderString("{{ text | md5 }}", { text: "hello" }) === "5d41402abc4b2a76b9719d911017c592");
assert("sha256 length", engine.renderString("{{ text | sha256 }}", { text: "hello" }).length === 64);
assert("map filter", engine.renderString('{{ users | map("name") | join(", ") }}', { users: [{ name: "A" }, { name: "B" }] }) === "A, B");
assert("column filter", engine.renderString('{{ rows | column("x") | join(",") }}', { rows: [{ x: 1 }, { x: 2 }] }) === "1,2");
assert("string filter", engine.renderString("{{ num | string }}", { num: 42 }) === "42");
// Dump filter + dump() global function — the inspectValue-based
// implementation wraps output in <pre> and handles complex objects that
// JSON.stringify would crash or silently corrupt (circular refs, BigInt,
// Map/Set, Error, class instances, Date).
//
// Dump is gated on TINA4_DEBUG=true and returns "" in production. We
// explicitly enable debug for the dump assertions, then restore the
// previous value afterwards so later tests aren't affected.
{
  const prevDebug = process.env.TINA4_DEBUG;
  process.env.TINA4_DEBUG = "true";

  assert("dump plain array",    engine.renderString("{{ val | dump | safe }}", { val: [1, 2] }) === "<pre>[1, 2]</pre>");
  assert("dump plain object",   engine.renderString("{{ val | dump | safe }}", { val: { a: 1, b: "hi" } }) === '<pre>{ a: 1, b: &quot;hi&quot; }</pre>');
  assert("dump class instance", (() => {
    class User { constructor(public name: string) {} }
    return engine.renderString("{{ val | dump | safe }}", { val: new User("Alice") });
  })() === '<pre>User { name: &quot;Alice&quot; }</pre>');
  assert("dump circular ref does not throw", (() => {
    const c: { name: string; self?: unknown } = { name: "root" };
    c.self = c;
    const out = engine.renderString("{{ val | dump | safe }}", { val: c });
    return out.includes("[Circular]") && out.includes("root");
  })());
  assert("dump BigInt does not throw", (() => {
    const out = engine.renderString("{{ val | dump | safe }}", { val: { n: 9007199254740993n } });
    return out.includes("9007199254740993n");
  })());
  assert("dump Date retains type", (() => {
    const out = engine.renderString("{{ val | dump | safe }}", { val: new Date("2026-04-09T13:00:00Z") });
    return out.includes("Date(2026-04-09T13:00:00.000Z)");
  })());
  assert("dump Map shows contents", (() => {
    const out = engine.renderString("{{ val | dump | safe }}", { val: new Map([["a", 1], ["b", 2]]) });
    return out.includes("Map(2)") && out.includes("a") && out.includes("b");
  })());
  assert("dump Set shows contents", (() => {
    const out = engine.renderString("{{ val | dump | safe }}", { val: new Set([1, 2, 3]) });
    return out.includes("Set(3)") && out.includes("1, 2, 3");
  })());
  assert("dump Error shows type + message", (() => {
    const out = engine.renderString("{{ val | dump | safe }}", { val: new Error("boom") });
    return out.includes("Error(") && out.includes("boom");
  })());
  assert("dump undefined property preserved", (() => {
    const out = engine.renderString("{{ val | dump | safe }}", { val: { a: undefined, b: 1 } });
    return out.includes("undefined");
  })());
  assert("dump function shown as [Function: ...]", (() => {
    const out = engine.renderString("{{ val | dump | safe }}", { val: { cb: function myFn() {} } });
    return out.includes("[Function:");
  })());

  // dump() global function — must produce identical output to the filter
  // form so templates can use either style interchangeably.
  assert("dump() function form matches filter form", (() => {
    const data = { val: { a: 1, b: "hi" } };
    const filterOut = engine.renderString("{{ val | dump | safe }}", data);
    const fnOut = engine.renderString("{{ dump(val) | safe }}", data);
    return filterOut === fnOut && fnOut === '<pre>{ a: 1, b: &quot;hi&quot; }</pre>';
  })());
  assert("dump() function on circular ref", (() => {
    const c: { name: string; self?: unknown } = { name: "root" };
    c.self = c;
    const out = engine.renderString("{{ dump(val) | safe }}", { val: c });
    return out.includes("[Circular]");
  })());

  // Production gating — TINA4_DEBUG=false suppresses dump entirely so no
  // internal state leaks through rendered HTML.
  process.env.TINA4_DEBUG = "false";
  const frondProd = new Frond(tmpDir);
  assert("dump filter silent in production",
    frondProd.renderString("{{ val | dump | safe }}", { val: { secret: "hunter2" } }) === "");
  assert("dump() function silent in production",
    frondProd.renderString("{{ dump(val) | safe }}", { val: { secret: "hunter2" } }) === "");

  // Restore
  if (prevDebug === undefined) delete process.env.TINA4_DEBUG;
  else process.env.TINA4_DEBUG = prevDebug;
}
assert("format filter", engine.renderString('{{ "Hello %s, you are %s" | format("Alice", "cool") }}', {}) === "Hello Alice, you are cool");
assert("filter chain", engine.renderString("{{ name | upper | trim }}", { name: "  hello  " }) === "HELLO");

// Date filter
assert("date filter", engine.renderString('{{ d | date("%Y-%m-%d") }}', { d: "2024-06-15T10:30:00" }) === "2024-06-15");

// ── Custom filters ─────────────────────────────────────────────
console.log("\n--- Custom Filters ---");

const e2 = new Frond(tmpDir);
e2.addFilter("double", (v) => (typeof v === "number" ? v * 2 : v));
assert("Custom filter", e2.renderString("{{ num | double }}", { num: 5 }) === "10");

// ── Filter chain order ─────────────────────────────────────────
console.log("\n--- Filter Chain ---");
assert("Filter chain left to right", engine.renderString("{{ name | trim | upper }}", { name: "  hello  " }) === "HELLO");

// ── If / Elseif / Else ────────────────────────────────────────
console.log("\n--- If / Elseif / Else ---");

assert("If true", engine.renderString("{% if show %}yes{% endif %}", { show: true }) === "yes");
assert("If false", engine.renderString("{% if show %}yes{% endif %}", { show: false }) === "");
assert("If else", engine.renderString("{% if show %}yes{% else %}no{% endif %}", { show: false }) === "no");
assert("If elseif", engine.renderString("{% if x == 1 %}one{% elseif x == 2 %}two{% else %}other{% endif %}", { x: 2 }) === "two");
assert("If elif", engine.renderString("{% if x == 1 %}one{% elif x == 2 %}two{% else %}other{% endif %}", { x: 2 }) === "two");
assert("If comparison >", engine.renderString("{% if x > 5 %}big{% else %}small{% endif %}", { x: 10 }) === "big");
assert("If and", engine.renderString("{% if a and b %}both{% endif %}", { a: true, b: true }) === "both");
assert("If or", engine.renderString("{% if a or b %}one{% endif %}", { a: false, b: true }) === "one");
assert("If not", engine.renderString("{% if not show %}hidden{% endif %}", { show: false }) === "hidden");
assert("Nested if", engine.renderString("{% if a %}{% if b %}both{% endif %}{% endif %}", { a: true, b: true }) === "both");

// ── Tests (is) ────────────────────────────────────────────────
console.log("\n--- Tests (is) ---");

assert("is defined", engine.renderString("{% if x is defined %}yes{% endif %}", { x: 1 }) === "yes");
assert("is not defined", engine.renderString("{% if x is not defined %}yes{% endif %}", {}) === "yes");
assert("is empty", engine.renderString("{% if items is empty %}yes{% endif %}", { items: [] }) === "yes");
assert("is even", engine.renderString("{% if x is even %}yes{% endif %}", { x: 4 }) === "yes");
assert("is odd", engine.renderString("{% if x is odd %}yes{% endif %}", { x: 3 }) === "yes");
assert("is divisible by", engine.renderString("{% if x is divisible by(3) %}yes{% endif %}", { x: 9 }) === "yes");
assert("is null", engine.renderString("{% if x is null %}yes{% endif %}", { x: null }) === "yes");
assert("is string", engine.renderString("{% if x is string %}yes{% endif %}", { x: "hi" }) === "yes");
assert("is number", engine.renderString("{% if x is number %}yes{% endif %}", { x: 42 }) === "yes");
assert("is boolean", engine.renderString("{% if x is boolean %}yes{% endif %}", { x: true }) === "yes");
assert("is iterable", engine.renderString("{% if x is iterable %}yes{% endif %}", { x: [1, 2] }) === "yes");

// ── Membership (in / not in) ──────────────────────────────────
console.log("\n--- Membership ---");

assert("in array", engine.renderString('{% if "a" in items %}yes{% endif %}', { items: ["a", "b"] }) === "yes");
assert("not in array", engine.renderString('{% if "c" not in items %}yes{% endif %}', { items: ["a", "b"] }) === "yes");

// ── For loops ──────────────────────────────────────────────────
console.log("\n--- For Loops ---");

assert("For loop basic", engine.renderString("{% for item in items %}{{ item }}{% endfor %}", { items: ["a", "b", "c"] }) === "abc");
assert("For loop.index", engine.renderString("{% for item in items %}{{ loop.index }}{% endfor %}", { items: ["a", "b"] }) === "12");
assert("For loop.index0", engine.renderString("{% for item in items %}{{ loop.index0 }}{% endfor %}", { items: ["a", "b"] }) === "01");
assert("For loop.first", engine.renderString("{% for item in items %}{% if loop.first %}F{% endif %}{% endfor %}", { items: ["a", "b"] }) === "F");
assert("For loop.last", engine.renderString("{% for item in items %}{% if loop.last %}L{% endif %}{% endfor %}", { items: ["a", "b"] }) === "L");
assert("For loop.length", engine.renderString("{% for item in items %}{{ loop.length }}{% endfor %}", { items: ["a", "b", "c"] }) === "333");
assert("For loop.even/odd", engine.renderString("{% for item in items %}{% if loop.odd %}O{% else %}E{% endif %}{% endfor %}", { items: [1, 2, 3] }) === "OEO");
assert("For key-value", engine.renderString("{% for k, v in obj %}{{ k }}={{ v }} {% endfor %}", { obj: { a: 1, b: 2 } }) === "a=1 b=2 ");
assert("For else branch", engine.renderString("{% for item in items %}{{ item }}{% else %}empty{% endfor %}", { items: [] }) === "empty");
assert("Nested for", engine.renderString("{% for row in rows %}{% for col in row %}{{ col }}{% endfor %}|{% endfor %}", { rows: [[1, 2], [3, 4]] }) === "12|34|");

// ── Set ────────────────────────────────────────────────────────
console.log("\n--- Set ---");

assert("Set variable", engine.renderString('{% set name = "Alice" %}{{ name }}', {}) === "Alice");
assert("Set expression", engine.renderString("{% set x = 42 %}{{ x }}", {}) === "42");

// ── Whitespace control ─────────────────────────────────────────
console.log("\n--- Whitespace Control ---");

assert("Strip before var", engine.renderString("Hello   {{- name }}", { name: "World" }) === "HelloWorld");
assert("Strip after var", engine.renderString("{{ name -}}   there", { name: "Hello" }) === "Hellothere");
assert("Strip both block", engine.renderString("  {%- if true -%}  yes  {%- endif -%}  ") === "yes");

// ── Comments ───────────────────────────────────────────────────
console.log("\n--- Comments ---");

assert("Comment removed", engine.renderString("Hello{# this is a comment #} World", {}) === "Hello World");

// ── Globals ────────────────────────────────────────────────────
console.log("\n--- Globals ---");

const e3 = new Frond(tmpDir);
e3.addGlobal("siteName", "TestSite");
assert("Global variable", e3.renderString("{{ siteName }}", {}) === "TestSite");
assert("Global with data", e3.renderString("{{ siteName }} - {{ page }}", { page: "Home" }) === "TestSite - Home");

// ── Include ────────────────────────────────────────────────────
console.log("\n--- Include ---");

writeFileSync(join(tmpDir, "partial.html"), "<span>{{ name }}</span>");
assert("Include basic", engine.render("partial.html", { name: "Alice" }) === "<span>Alice</span>");
assert("Include in template", engine.renderString('{% include "partial.html" %}', { name: "Bob" }) === "<span>Bob</span>");
assert("Include ignore missing", engine.renderString('{% include "missing.html" ignore missing %}', {}) === "");

// ── Extends / Block ─────────────────────────────────────────────
console.log("\n--- Extends / Block ---");

writeFileSync(join(tmpDir, "base.html"), "<h1>{% block title %}Default{% endblock %}</h1><div>{% block content %}base content{% endblock %}</div>");
writeFileSync(join(tmpDir, "child.html"), '{% extends "base.html" %}{% block title %}My Page{% endblock %}{% block content %}child content{% endblock %}');

assert("Extends and block override", engine.render("child.html", {}) === "<h1>My Page</h1><div>child content</div>");

// Render parent directly (default blocks)
assert("Parent default blocks", engine.render("base.html", {}) === "<h1>Default</h1><div>base content</div>");

// Extends with leading whitespace
writeFileSync(join(tmpDir, "child-ws.html"), '  {% extends "base.html" %}\n{% block content %}<h1>Hello</h1>{% endblock %}');
{
  const r = engine.render("child-ws.html", {});
  assert("Extends with leading whitespace", r.includes("<h1>Hello</h1>") && r.includes("<div>"));
}

// Extends with leading newlines
writeFileSync(join(tmpDir, "child-nl.html"), '\n\n{% extends "base.html" %}\n{% block content %}<h1>Hello</h1>{% endblock %}');
{
  const r = engine.render("child-nl.html", {});
  assert("Extends with leading newlines", r.includes("<h1>Hello</h1>") && r.includes("<div>"));
}

// Extends with variables in blocks
writeFileSync(join(tmpDir, "base-full.html"), '<head><title>{% block title %}Default{% endblock %}</title></head>\n<body>{% block content %}{% endblock %}</body>');
writeFileSync(join(tmpDir, "error.html"), '\n{% extends "base-full.html" %}\n{% block title %}Error {{ code }}{% endblock %}\n{% block content %}<div class="card"><h1>{{ code }}</h1><p>{{ msg }}</p></div>{% endblock %}');
{
  const r = engine.render("error.html", { code: 500, msg: "Internal Server Error" });
  assert("Extends with variables in blocks - title", r.includes("<title>Error 500</title>"));
  assert("Extends with variables in blocks - code", r.includes("<h1>500</h1>"));
  assert("Extends with variables in blocks - msg", r.includes("Internal Server Error"));
}

// ── parent() / super() in block inheritance ────────────────────
console.log("\n--- parent() / super() ---");

writeFileSync(join(tmpDir, "base-parent.html"), "{% block content %}Parent Content{% endblock %}");
writeFileSync(join(tmpDir, "child-parent.html"), '{% extends "base-parent.html" %}{% block content %}{{ parent() }} + Child Content{% endblock %}');
{
  const r = engine.render("child-parent.html", {});
  assert("parent() includes parent block content", r.includes("Parent Content") && r.includes("+ Child Content"));
}

writeFileSync(join(tmpDir, "child-super.html"), '{% extends "base-parent.html" %}{% block content %}{{ super() }} + Child Content{% endblock %}');
{
  const r = engine.render("child-super.html", {});
  assert("super() is an alias for parent()", r.includes("Parent Content") && r.includes("+ Child Content"));
}

writeFileSync(join(tmpDir, "child-nop.html"), '{% extends "base-parent.html" %}{% block content %}Child Only{% endblock %}');
assert("No parent() = full replacement", engine.render("child-nop.html", {}) === "Child Only");

writeFileSync(join(tmpDir, "base-pvar.html"), "{% block content %}Hello {{ name }}{% endblock %}");
writeFileSync(join(tmpDir, "child-pvar.html"), '{% extends "base-pvar.html" %}{% block content %}{{ parent() }} and Goodbye {{ name }}{% endblock %}');
{
  const r = engine.render("child-pvar.html", { name: "World" });
  assert("parent() with template variables", r.includes("Hello World") && r.includes("and Goodbye World"));
}

writeFileSync(join(tmpDir, "base-multi.html"), "{% block title %}Default Title{% endblock %} - {% block content %}Default Content{% endblock %}");
writeFileSync(join(tmpDir, "child-multi.html"), '{% extends "base-multi.html" %}{% block content %}Custom Content{% endblock %}');
{
  const r = engine.render("child-multi.html", {});
  assert("Unreplaced blocks keep parent default", r.includes("Default Title") && r.includes("Custom Content") && !r.includes("Default Content"));
}

writeFileSync(join(tmpDir, "base-mp.html"), "{% block header %}Base Header{% endblock %}|{% block footer %}Base Footer{% endblock %}");
writeFileSync(join(tmpDir, "child-mp.html"), '{% extends "base-mp.html" %}{% block header %}{{ parent() }} + Extra Header{% endblock %}{% block footer %}{{ parent() }} + Extra Footer{% endblock %}');
{
  const r = engine.render("child-mp.html", {});
  assert("Multiple blocks with parent()", r.includes("Base Header") && r.includes("+ Extra Header") && r.includes("Base Footer") && r.includes("+ Extra Footer"));
}

// ── Multi-level extends (A extends B extends C) ────────────────
console.log("\n--- Multi-level extends ---");

// 3-level chain: grandchild -> child -> base
writeFileSync(join(tmpDir, "base-ml.html"), "<html>{% block head %}<head>Default Head</head>{% endblock %}{% block body %}<body>Default Body</body>{% endblock %}</html>");
writeFileSync(join(tmpDir, "layout-ml.html"), '{% extends "base-ml.html" %}{% block head %}<head>Layout Head</head>{% endblock %}{% block body %}<body>{% block content %}Layout Content{% endblock %}</body>{% endblock %}');
writeFileSync(join(tmpDir, "page-ml.html"), '{% extends "layout-ml.html" %}{% block content %}Page Content{% endblock %}');
{
  const r = engine.render("page-ml.html", {});
  assert("3-level extends: grandchild block reaches root", r.includes("Page Content"));
  assert("3-level extends: parent block preserved", r.includes("Layout Head"));
  assert("3-level extends: wrapper html present", r.includes("<html>") && r.includes("</html>"));
}

// 3-level with variables
writeFileSync(join(tmpDir, "page-ml-var.html"), '{% extends "layout-ml.html" %}{% block content %}Hello {{ name }}{% endblock %}');
{
  const r = engine.render("page-ml-var.html", { name: "World" });
  assert("3-level extends with variables", r.includes("Hello World"));
}

// 3-level with grandchild overriding a block from root (skipping middle)
writeFileSync(join(tmpDir, "page-ml-head.html"), '{% extends "layout-ml.html" %}{% block head %}<head>Custom Head</head>{% endblock %}{% block content %}Custom Content{% endblock %}');
{
  const r = engine.render("page-ml-head.html", {});
  assert("3-level extends: grandchild overrides root block", r.includes("Custom Head") && !r.includes("Layout Head"));
  assert("3-level extends: grandchild also overrides nested block", r.includes("Custom Content"));
}

// 4-level chain
writeFileSync(join(tmpDir, "base-4.html"), "<root>{% block slot %}Base{% endblock %}</root>");
writeFileSync(join(tmpDir, "mid1-4.html"), '{% extends "base-4.html" %}{% block slot %}{% block inner %}Mid1{% endblock %}{% endblock %}');
writeFileSync(join(tmpDir, "mid2-4.html"), '{% extends "mid1-4.html" %}{% block inner %}Mid2 {% block deep %}deep-default{% endblock %}{% endblock %}');
writeFileSync(join(tmpDir, "leaf-4.html"), '{% extends "mid2-4.html" %}{% block deep %}Leaf{% endblock %}');
{
  const r = engine.render("leaf-4.html", {});
  assert("4-level extends chain", r.includes("Leaf") && r.includes("<root>"));
}


// ── Macros ──────────────────────────────────────────────────────
console.log("\n--- Macros ---");

assert("Macro definition and call", engine.renderString(
  '{% macro greet(name) %}Hello {{ name }}{% endmacro %}{{ greet("Alice") }}',
  {},
) === "Hello Alice");

assert("Macro with multiple params", engine.renderString(
  '{% macro tag(name, cls) %}<{{ name }} class="{{ cls }}">{% endmacro %}{{ tag("div", "box") }}',
  {},
) === '<div class="box">');

// ── Sandboxing ─────────────────────────────────────────────────
console.log("\n--- Sandboxing ---");

const sandboxed = new Frond(tmpDir);
sandboxed.sandbox(["upper"], ["if", "for"], ["allowed"]);

assert("Sandbox allows whitelisted var", sandboxed.renderString("{{ allowed }}", { allowed: "ok", secret: "nope" }) === "ok");
assert("Sandbox blocks non-whitelisted var", sandboxed.renderString("{{ secret }}", { allowed: "ok", secret: "nope" }) === "");
assert("Sandbox allows whitelisted filter", sandboxed.renderString("{{ allowed | upper }}", { allowed: "ok" }) === "OK");
assert("Sandbox blocks non-whitelisted filter", sandboxed.renderString("{{ allowed | lower }}", { allowed: "OK" }) === "OK");
assert("Sandbox allows loop var", sandboxed.renderString("{% for i in items %}{{ loop.index }}{% endfor %}", { items: [1] }) === "1");
assert("Sandbox blocks non-whitelisted tag (set)", sandboxed.renderString('{% set x = "bad" %}{{ x }}', { x: "good" }) === "");

// Unsandbox
sandboxed.unsandbox();
assert("Unsandbox restores access", sandboxed.renderString("{{ secret }}", { secret: "visible" }) === "visible");

// ── Fragment Caching ────────────────────────────────────────────
console.log("\n--- Fragment Caching ---");

const cacheEngine = new Frond(tmpDir);
let counter = 0;
cacheEngine.addGlobal("getCount", () => ++counter);

const cacheTpl = '{% cache "test" 60 %}{{ getCount() }}{% endcache %}';
const first = cacheEngine.renderString(cacheTpl, {});
const second = cacheEngine.renderString(cacheTpl, {});
assert("Fragment cache returns cached value", first === second);
assert("Fragment cache called function only once", counter === 1);

// ── Custom Tests ────────────────────────────────────────────────
console.log("\n--- Custom Tests ---");

const testEngine = new Frond(tmpDir);
testEngine.addTest("positive", (v) => typeof v === "number" && v > 0);
assert("Custom test positive true", testEngine.renderString("{% if x is positive %}yes{% endif %}", { x: 5 }) === "yes");
assert("Custom test positive false", testEngine.renderString("{% if x is positive %}yes{% else %}no{% endif %}", { x: -1 }) === "no");

// ── Form Token Tests ──────────────────────────────────────────
console.log("\n--- Form Token ---");

{
  const ftResult = engine.renderString("{{ form_token() | raw }}", {});
  assert("form_token() renders hidden input", ftResult.includes('<input type="hidden" name="formToken" value="'));

  // Extract JWT and verify structure
  const tokenMatch = ftResult.match(/value="([^"]+)"/);
  assert("form_token() contains a JWT", tokenMatch !== null);
  if (tokenMatch) {
    const token = tokenMatch[1];
    const parts = token.split(".");
    assert("form_token() JWT has 3 parts", parts.length === 3);

    // Decode payload and verify type
    const payloadJson = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/") + "==", "base64").toString();
    const payload = JSON.parse(payloadJson);
    assert("form_token() JWT payload has type=form", payload.type === "form");
    assert("form_token() JWT payload has exp", typeof payload.exp === "number");
  }

  // Test formToken alias
  const ftResult2 = engine.renderString("{{ formToken() | raw }}", {});
  assert("formToken() alias works", ftResult2.includes('<input type="hidden" name="formToken" value="'));

  // Test as filter
  const ftResult3 = engine.renderString('{{ "" | form_token | raw }}', {});
  assert("form_token filter works", ftResult3.includes('<input type="hidden" name="formToken" value="'));
}

// ── Raw Block ─────────────────────────────────────────────────
console.log("\n--- Raw Block ---");

assert("raw preserves var syntax",
  engine.renderString("{% raw %}{{ name }}{% endraw %}", { name: "Alice" }) === "{{ name }}");

assert("raw preserves block syntax",
  engine.renderString("{% raw %}{% if true %}yes{% endif %}{% endraw %}", {}) === "{% if true %}yes{% endif %}");

assert("raw mixed with normal",
  engine.renderString("Hello {{ name }}! {% raw %}{{ not_parsed }}{% endraw %} done", { name: "World" }) === "Hello World! {{ not_parsed }} done");

assert("multiple raw blocks",
  engine.renderString("{% raw %}{{ a }}{% endraw %} mid {% raw %}{{ b }}{% endraw %}", {}) === "{{ a }} mid {{ b }}");

assert("raw block multiline",
  engine.renderString("{% raw %}\n{{ var }}\n{% tag %}\n{% endraw %}", {}) === "\n{{ var }}\n{% tag %}\n");

// ── From Import ───────────────────────────────────────────────
console.log("\n--- From Import ---");

writeFileSync(join(tmpDir, "macros.twig"), '{% macro greeting(name) %}Hello {{ name }}!{% endmacro %}');
assert("from import basic",
  engine.renderString('{% from "macros.twig" import greeting %}{{ greeting("World") }}', {}) === "Hello World!");

writeFileSync(join(tmpDir, "helpers.twig"), '{% macro bold(t) %}B{{ t }}B{% endmacro %}{% macro italic(t) %}I{{ t }}I{% endmacro %}');
{
  const result = engine.renderString('{% from "helpers.twig" import bold, italic %}{{ bold("hi") }} {{ italic("there") }}', {});
  assert("from import multiple - bold", result.includes("BhiB"));
  assert("from import multiple - italic", result.includes("IthereI"));
}

writeFileSync(join(tmpDir, "mix.twig"), '{% macro used(x) %}[{{ x }}]{% endmacro %}{% macro unused(x) %}{{{ x }}}{% endmacro %}');
assert("from import selective",
  engine.renderString('{% from "mix.twig" import used %}{{ used("ok") }}', {}).includes("[ok]"));

mkdirSync(join(tmpDir, "macros"), { recursive: true });
writeFileSync(join(tmpDir, "macros/forms.twig"), '{% macro field(label, name) %}{{ label }}:{{ name }}{% endmacro %}');
assert("from import subdirectory",
  engine.renderString('{% from "macros/forms.twig" import field %}{{ field("Name", "name") }}', {}).includes("Name:name"));

// ── Spaceless Tag ─────────────────────────────────────────────
console.log("\n--- Spaceless Tag ---");

assert("Spaceless removes whitespace between tags",
  engine.renderString("{% spaceless %}<div>  <p>  Hello  </p>  </div>{% endspaceless %}", {}) === "<div><p>  Hello  </p></div>");

assert("Spaceless preserves content whitespace",
  engine.renderString("{% spaceless %}<span>  text  </span>{% endspaceless %}", {}) === "<span>  text  </span>");

assert("Spaceless with multiline",
  engine.renderString("{% spaceless %}\n<div>\n    <p>Hi</p>\n</div>\n{% endspaceless %}", {}).includes("<div><p>"));

assert("Spaceless with variables",
  engine.renderString("{% spaceless %}<div>  <span>{{ name }}</span>  </div>{% endspaceless %}", { name: "Alice" }) === "<div><span>Alice</span></div>");

// ── Autoescape Tag ────────────────────────────────────────────
console.log("\n--- Autoescape Tag ---");

assert("Autoescape false disables escaping",
  engine.renderString('{% autoescape false %}{{ html }}{% endautoescape %}', { html: "<b>bold</b>" }) === "<b>bold</b>");

assert("Autoescape true keeps escaping",
  engine.renderString('{% autoescape true %}{{ html }}{% endautoescape %}', { html: "<b>bold</b>" }).includes("&lt;b&gt;"));

assert("Autoescape false with filters",
  engine.renderString('{% autoescape false %}{{ name | upper }}{% endautoescape %}', { name: "alice" }) === "ALICE");

assert("Autoescape false multiple variables",
  engine.renderString('{% autoescape false %}{{ a }} {{ b }}{% endautoescape %}', { a: "<i>x</i>", b: "<b>y</b>" }) === "<i>x</i> <b>y</b>");

// ── Inline If Expression ──────────────────────────────────────
console.log("\n--- Inline If Expression ---");

assert("Inline if true branch",
  engine.renderString("{{ 'yes' if active else 'no' }}", { active: true }) === "yes");

assert("Inline if false branch",
  engine.renderString("{{ 'yes' if active else 'no' }}", { active: false }) === "no");

assert("Inline if with variable value",
  engine.renderString("{{ name if name else 'Anonymous' }}", { name: "Alice" }) === "Alice");

assert("Inline if with missing variable",
  engine.renderString("{{ name if name else 'Anonymous' }}", {}) === "Anonymous");

assert("Inline if with numeric",
  engine.renderString("{{ count if count else 0 }}", { count: 5 }) === "5");

// ── Token Pre-Compilation (Cache) Tests ───────────────────────

console.log("\n--- Token Cache ---");

assert("render_string cache same output",
  (() => {
    const src = "Hello {{ name }}!";
    const first = engine.renderString(src, { name: "World" });
    const second = engine.renderString(src, { name: "World" });
    return first === "Hello World!" && first === second;
  })());

assert("cached tokens work with different data",
  (() => {
    const src = "{{ greeting }}, {{ name }}!";
    const r1 = engine.renderString(src, { greeting: "Hi", name: "Alice" });
    const r2 = engine.renderString(src, { greeting: "Bye", name: "Bob" });
    return r1 === "Hi, Alice!" && r2 === "Bye, Bob!";
  })());

assert("file render cache same output",
  (() => {
    writeFileSync(join(tmpDir, "cached.html"), "<p>{{ msg }}</p>");
    const e = new Frond(tmpDir);
    const first = e.render("cached.html", { msg: "hello" });
    const second = e.render("cached.html", { msg: "hello" });
    return first === "<p>hello</p>" && first === second;
  })());

assert("cached file tokens work with different data",
  (() => {
    writeFileSync(join(tmpDir, "cached2.html"), "{{ x }} + {{ y }}");
    const e = new Frond(tmpDir);
    const r1 = e.render("cached2.html", { x: 1, y: 2 });
    const r2 = e.render("cached2.html", { x: 10, y: 20 });
    return r1 === "1 + 2" && r2 === "10 + 20";
  })());

assert("clearCache empties caches",
  (() => {
    const e = new Frond(tmpDir);
    e.renderString("{{ x }}", { x: 1 });
    e.clearCache();
    // After clearing, rendering still works (re-tokenizes)
    return e.renderString("{{ x }}", { x: 2 }) === "2";
  })());

assert("for loop works from cache",
  (() => {
    const src = "{% for i in items %}{{ i }},{% endfor %}";
    const data = { items: [1, 2, 3] };
    const first = engine.renderString(src, data);
    const second = engine.renderString(src, data);
    return first === "1,2,3," && first === second;
  })());

assert("conditionals work from cache",
  (() => {
    const src = "{% if show %}visible{% else %}hidden{% endif %}";
    const r1 = engine.renderString(src, { show: true });
    const r2 = engine.renderString(src, { show: false });
    return r1 === "visible" && r2 === "hidden";
  })());

assert("cache invalidation on file change (dev mode)",
  (() => {
    process.env.TINA4_DEBUG = "true";
    try {
      const cacheDir = "/tmp/frond-cache-test";
      try { rmSync(cacheDir, { recursive: true }); } catch {}
      mkdirSync(cacheDir, { recursive: true });
      const e = new Frond(cacheDir);

      writeFileSync(join(cacheDir, "changing.html"), "Version 1: {{ v }}");
      const r1 = e.render("changing.html", { v: "a" });

      // Simulate file change with slight delay to update mtime
      const start = Date.now();
      while (Date.now() - start < 50) { /* spin */ }
      writeFileSync(join(cacheDir, "changing.html"), "Version 2: {{ v }}");
      const r2 = e.render("changing.html", { v: "b" });

      try { rmSync(cacheDir, { recursive: true }); } catch {}
      return r1 === "Version 1: a" && r2 === "Version 2: b";
    } finally {
      delete process.env.TINA4_DEBUG;
    }
  })());

// ── Filters in if conditions ────────────────────────────────────
console.log("\n--- Filters in if conditions ---");

assert("if items|length > 0 (non-empty)",
  engine.renderString("{% if items|length > 0 %}yes{% else %}no{% endif %}", { items: [1, 2, 3] }) === "yes");

assert("if items|length > 0 (empty)",
  engine.renderString("{% if items|length > 0 %}yes{% else %}no{% endif %}", { items: [] }) === "no");

assert("if items|length == 3",
  engine.renderString("{% if items|length == 3 %}match{% else %}nope{% endif %}", { items: ["a", "b", "c"] }) === "match");

assert("if name|upper == 'ALICE'",
  engine.renderString('{% if name|upper == "ALICE" %}hi alice{% else %}who{% endif %}', { name: "alice" }) === "hi alice");

assert("compound: items|length >= 2 and name|upper == 'ALICE'",
  engine.renderString(
    '{% if items|length >= 2 and name|upper == "ALICE" %}both{% else %}nope{% endif %}',
    { items: [1, 2, 3], name: "alice" },
  ) === "both");

assert("non-filter condition still works: x > 5",
  engine.renderString("{% if x > 5 %}big{% else %}small{% endif %}", { x: 10 }) === "big");

assert("non-filter condition still works: x > 5 (false)",
  engine.renderString("{% if x > 5 %}big{% else %}small{% endif %}", { x: 3 }) === "small");

// ── Arithmetic in expressions and {% set %} ──────────────────────────
console.log("\n── Arithmetic in expressions and {% set %} ──");

assert("set addition: {% set x = 5 + 3 %}",
  engine.renderString("{% set x = 5 + 3 %}{{ x }}", {}) === "8");

assert("set subtraction: {% set x = 10 - 4 %}",
  engine.renderString("{% set x = 10 - 4 %}{{ x }}", {}) === "6");

assert("set with context variables: {% set x = a * b %}",
  engine.renderString("{% set x = a * b %}{{ x }}", { a: 3, b: 7 }) === "21");

assert("expression addition: {{ 2 + 3 }}",
  engine.renderString("{{ 2 + 3 }}", {}) === "5");

assert("expression floor division: {{ 7 // 2 }}",
  engine.renderString("{{ 7 // 2 }}", {}) === "3");

assert("expression power: {{ 2 ** 3 }}",
  engine.renderString("{{ 2 ** 3 }}", {}) === "8");

assert("set with filter pipe: {% set x = name|upper %}",
  engine.renderString("{% set x = name|upper %}{{ x }}", { name: "alice" }) === "ALICE");

// ── Empty Templates ──────────────────────────────────────────
console.log("\n--- Empty Templates ---");

assert("empty string returns empty", engine.renderString("", {}) === "");
assert("whitespace only returns whitespace", engine.renderString("   ", {}).trim() === "");
assert("no variables returns literal", engine.renderString("Hello World", {}) === "Hello World");

// ── Nested Loops ──────────────────────────────────────────────
console.log("\n--- Nested Loops ---");

assert("nested for loops",
  engine.renderString(
    "{% for group in groups %}{% for item in group %}{{ item }}{% endfor %},{% endfor %}",
    { groups: [[1, 2], [3, 4]] }
  ) === "12,34,");

assert("for loop with if inside",
  engine.renderString(
    "{% for n in nums %}{% if n > 2 %}{{ n }}{% endif %}{% endfor %}",
    { nums: [1, 2, 3, 4, 5] }
  ) === "345");

// ── Filter Chaining ──────────────────────────────────────────
console.log("\n--- Filter Chaining ---");

assert("multiple filters chained",
  engine.renderString("{{ name | upper | trim }}", { name: "  alice  " }) === "ALICE");

assert("lower then capitalize",
  engine.renderString("{{ name | lower | capitalize }}", { name: "ALICE" }) === "Alice");

// ── Ternary / Default ────────────────────────────────────────
console.log("\n--- Default Filter ---");

assert("default filter with undefined",
  engine.renderString("{{ missing | default('N/A') }}", {}) === "N/A");

assert("default filter with null",
  engine.renderString("{{ val | default('fallback') }}", { val: null }) === "fallback");

assert("default filter not applied when value exists",
  engine.renderString("{{ val | default('fallback') }}", { val: "real" }) === "real");

// ── Numeric Filters ──────────────────────────────────────────
console.log("\n--- Numeric Filters ---");

assert("abs filter positive",
  engine.renderString("{{ n | abs }}", { n: 5 }) === "5");

assert("abs filter negative",
  engine.renderString("{{ n | abs }}", { n: -5 }) === "5");

assert("round filter",
  engine.renderString("{{ n | round }}", { n: 3.7 }) === "4");

// ── String Filters ──────────────────────────────────────────
console.log("\n--- String Filters ---");

assert("title filter",
  engine.renderString("{{ s | title }}", { s: "hello world" }) === "Hello World");

assert("replace filter",
  engine.renderString("{{ s | replace('world', 'earth') }}", { s: "hello world" }) === "hello earth");

assert("trim filter",
  engine.renderString("{{ s | trim }}", { s: "  hello  " }) === "hello");

assert("length filter on string",
  engine.renderString("{{ s | length }}", { s: "hello" }) === "5");

assert("length filter on array",
  engine.renderString("{{ arr | length }}", { arr: [1, 2, 3] }) === "3");

// ── Conditional edge cases ──────────────────────────────────
console.log("\n--- Conditional Edge Cases ---");

assert("if with false boolean",
  engine.renderString("{% if show %}yes{% else %}no{% endif %}", { show: false }) === "no");

assert("if with 0 is falsy",
  engine.renderString("{% if count %}yes{% else %}no{% endif %}", { count: 0 }) === "no");

assert("if with empty string is falsy",
  engine.renderString("{% if val %}yes{% else %}no{% endif %}", { val: "" }) === "no");

// Note: empty arrays are truthy in JavaScript (and in this engine)
assert("if with empty array is truthy (JS semantics)",
  engine.renderString("{% if items %}yes{% else %}no{% endif %}", { items: [] }) === "yes");

assert("if with non-empty array is truthy",
  engine.renderString("{% if items %}yes{% else %}no{% endif %}", { items: [1] }) === "yes");

assert("if with number is truthy",
  engine.renderString("{% if n %}yes{% else %}no{% endif %}", { n: 1 }) === "yes");

// ── Loop Variables ──────────────────────────────────────────
console.log("\n--- Loop Variables ---");

assert("loop.index starts at 1",
  engine.renderString(
    "{% for x in items %}{{ loop.index }}{% endfor %}",
    { items: ["a", "b", "c"] }
  ) === "123");

assert("loop.index0 starts at 0",
  engine.renderString(
    "{% for x in items %}{{ loop.index0 }}{% endfor %}",
    { items: ["a", "b", "c"] }
  ) === "012");

assert("loop.first",
  engine.renderString(
    "{% for x in items %}{% if loop.first %}F{% endif %}{{ x }}{% endfor %}",
    { items: ["a", "b", "c"] }
  ) === "Fabc");

assert("loop.last",
  engine.renderString(
    "{% for x in items %}{{ x }}{% if loop.last %}L{% endif %}{% endfor %}",
    { items: ["a", "b", "c"] }
  ) === "abcL");

assert("loop.length",
  engine.renderString(
    "{% for x in items %}{{ loop.length }}{% endfor %}",
    { items: ["a", "b", "c"] }
  ) === "333");

// ── Comments ──────────────────────────────────────────────────
console.log("\n--- Comments ---");

assert("comments are stripped",
  engine.renderString("Hello{# this is a comment #} World", {}) === "Hello World");

assert("multiline comment stripped",
  engine.renderString("A{# comment\nspanning\nlines #}B", {}) === "AB");

// ── Whitespace Control ──────────────────────────────────────
console.log("\n--- Whitespace Control ---");

assert("trim left on block tag",
  engine.renderString("Hello \n{%- if true %} World{% endif %}", {}) === "Hello World");

assert("trim right on block tag",
  engine.renderString("{% if true -%}  \nWorld{% endif %}", {}) === "World");

// ── Set Tag ──────────────────────────────────────────────────
console.log("\n--- Set Tag ---");

assert("set string variable",
  engine.renderString("{% set name = 'Bob' %}{{ name }}", {}) === "Bob");

assert("set number variable",
  engine.renderString("{% set x = 42 %}{{ x }}", {}) === "42");

assert("set overrides context",
  engine.renderString("{% set name = 'Override' %}{{ name }}", { name: "Original" }) === "Override");

// ── For-Else ──────────────────────────────────────────────────
console.log("\n--- For-Else ---");

assert("for-else shows else when empty",
  engine.renderString(
    "{% for x in items %}{{ x }}{% else %}No items{% endfor %}",
    { items: [] }
  ) === "No items");

assert("for-else shows items when non-empty",
  engine.renderString(
    "{% for x in items %}{{ x }}{% else %}No items{% endfor %}",
    { items: [1, 2] }
  ) === "12");

// ── Object Iteration ──────────────────────────────────────────
console.log("\n--- Object Iteration ---");

assert("iterate object keys",
  engine.renderString(
    "{% for key, val in obj %}{{ key }}={{ val }} {% endfor %}",
    { obj: { a: 1, b: 2 } }
  ).trim() === "a=1 b=2");

// ── Comparison Operators ──────────────────────────────────────
console.log("\n--- Comparison Operators ---");

assert("greater than",
  engine.renderString("{% if a > b %}yes{% else %}no{% endif %}", { a: 5, b: 3 }) === "yes");

assert("less than",
  engine.renderString("{% if a < b %}yes{% else %}no{% endif %}", { a: 3, b: 5 }) === "yes");

assert("equals",
  engine.renderString("{% if a == b %}yes{% else %}no{% endif %}", { a: 5, b: 5 }) === "yes");

assert("not equals",
  engine.renderString("{% if a != b %}yes{% else %}no{% endif %}", { a: 5, b: 3 }) === "yes");

assert("greater or equal",
  engine.renderString("{% if a >= b %}yes{% else %}no{% endif %}", { a: 5, b: 5 }) === "yes");

assert("less or equal",
  engine.renderString("{% if a <= b %}yes{% else %}no{% endif %}", { a: 3, b: 5 }) === "yes");

// ── Logical Operators ────────────────────────────────────────
console.log("\n--- Logical Operators ---");

assert("and operator true",
  engine.renderString("{% if a and b %}yes{% else %}no{% endif %}", { a: true, b: true }) === "yes");

assert("and operator false",
  engine.renderString("{% if a and b %}yes{% else %}no{% endif %}", { a: true, b: false }) === "no");

assert("or operator true",
  engine.renderString("{% if a or b %}yes{% else %}no{% endif %}", { a: false, b: true }) === "yes");

assert("or operator false",
  engine.renderString("{% if a or b %}yes{% else %}no{% endif %}", { a: false, b: false }) === "no");

assert("not operator",
  engine.renderString("{% if not val %}yes{% else %}no{% endif %}", { val: false }) === "yes");

// ── In Operator ──────────────────────────────────────────────
console.log("\n--- In Operator ---");

assert("in operator with array (found)",
  engine.renderString("{% if 'b' in items %}yes{% else %}no{% endif %}", { items: ["a", "b", "c"] }) === "yes");

assert("in operator with array (not found)",
  engine.renderString("{% if 'z' in items %}yes{% else %}no{% endif %}", { items: ["a", "b", "c"] }) === "no");

// ── Concatenation ────────────────────────────────────────────
console.log("\n--- String Concatenation ---");

assert("tilde concatenation",
  engine.renderString("{{ 'Hello' ~ ' ' ~ 'World' }}", {}) === "Hello World");

assert("tilde with variable",
  engine.renderString("{{ greeting ~ ' ' ~ name }}", { greeting: "Hi", name: "Bob" }) === "Hi Bob");

// ── Math in expressions ──────────────────────────────────────
console.log("\n--- Math in Expressions ---");

assert("subtraction: {{ 10 - 3 }}",
  engine.renderString("{{ 10 - 3 }}", {}) === "7");

assert("multiplication: {{ 4 * 5 }}",
  engine.renderString("{{ 4 * 5 }}", {}) === "20");

assert("division: {{ 10 / 2 }}",
  engine.renderString("{{ 10 / 2 }}", {}) === "5");

assert("modulo: {{ 10 % 3 }}",
  engine.renderString("{{ 10 % 3 }}", {}) === "1");

// ── renderDump ────────────────────────────────────────────────
console.log("\n--- renderDump ---");

{
  const prevDebug = process.env.TINA4_DEBUG;
  delete process.env.TINA4_DEBUG;
  assert("renderDump returns empty string when TINA4_DEBUG unset",
    engine.renderDump({ key: "value" }) === "");
  process.env.TINA4_DEBUG = "true";
  const dumpResult = engine.renderDump({ key: "value" });
  assert("renderDump returns HTML with <pre> in debug mode",
    dumpResult.includes("<pre>"));
  assert("renderDump handles null gracefully",
    typeof engine.renderDump(null) === "string");
  if (prevDebug === undefined) delete process.env.TINA4_DEBUG;
  else process.env.TINA4_DEBUG = prevDebug;
}

// ── Filter + property chain (regression for tina4-php#113) ───
//
// Property access chained after a filter must resolve as
// (filter).property, never as a literal `filter.property` filter
// name. Silent null here once cost a receipt template the entire
// invoice total — render shows R0.00.
console.log("\n--- filter + property chain (issue #113) ---");
{
  const data113 = { details: [{ groupSummary: { totalAmount: 190 } }] };

  assert(
    "#113 filter then single property",
    engine.renderString("{{ details|first.groupSummary.totalAmount }}", data113)
      === "190",
  );

  assert(
    "#113 filter then property in {% set %}",
    engine.renderString(
      "{% set summary = details|first.groupSummary %}{{ summary.totalAmount }}",
      data113,
    ) === "190",
  );

  const multi = { invoices: [{ customer: { address: { city: "Cape Town" } } }] };
  assert(
    "#113 filter then multi-level chain",
    engine.renderString("{{ invoices|first.customer.address.city }}", multi)
      === "Cape Town",
  );

  const rows = { rows: [{ sku: "A1" }, { sku: "B2" }] };
  assert(
    "#113 last filter then property",
    engine.renderString("{{ rows|last.sku }}", rows) === "B2",
  );

  // number_format(2) — verifies filter args path stays intact
  assert(
    "#113 number_format(2) preserves filter args",
    engine.renderString("{{ price|number_format(2) }}", { price: 19.5 })
      === "19.50",
  );

  // replace(".", "-") — dots inside quoted args must NOT be split
  assert(
    "#113 dot inside quoted filter args is not a property",
    engine.renderString('{{ stamp|replace(".", "-") }}', { stamp: "2026.05.05" })
      === "2026-05-05",
  );
}

// ── Summary ────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

// Cleanup
try { rmSync(tmpDir, { recursive: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);

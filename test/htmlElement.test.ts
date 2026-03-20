/**
 * Unit tests for the HtmlElement module.
 * Run with: npx tsx test/htmlElement.test.ts
 */
import { HtmlElement, htmlElement, addHtmlHelpers } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function assertEqual(name: string, actual: string, expected: string) {
  assert(name, actual === expected, `\n    expected: ${expected}\n    actual:   ${actual}`);
}

console.log("=== HtmlElement Tests ===\n");

// --- Basic rendering ---
console.log("--- Basic rendering ---");

assertEqual(
  "simple element",
  new HtmlElement("div", { class: "card" }, ["Hello"]).toString(),
  '<div class="card">Hello</div>',
);

assertEqual(
  "empty element",
  new HtmlElement("div").toString(),
  "<div></div>",
);

assertEqual(
  "multiple children",
  new HtmlElement("ul", {}, [
    new HtmlElement("li", {}, ["One"]),
    new HtmlElement("li", {}, ["Two"]),
  ]).toString(),
  "<ul><li>One</li><li>Two</li></ul>",
);

// --- Void tags ---
console.log("\n--- Void tags ---");

assertEqual("br void tag", new HtmlElement("br").toString(), "<br>");

assertEqual(
  "img with attributes",
  new HtmlElement("img", { src: "photo.jpg", alt: "A photo" }).toString(),
  '<img src="photo.jpg" alt="A photo">',
);

assertEqual(
  "input void tag",
  new HtmlElement("input", { type: "text", name: "q" }).toString(),
  '<input type="text" name="q">',
);

// --- Attribute handling ---
console.log("\n--- Attribute handling ---");

assertEqual(
  "boolean true attribute",
  new HtmlElement("input", { disabled: true, type: "text" }).toString(),
  '<input disabled type="text">',
);

assertEqual(
  "boolean false omitted",
  new HtmlElement("input", { disabled: false, type: "text" }).toString(),
  '<input type="text">',
);

assertEqual(
  "null attribute omitted",
  new HtmlElement("div", { id: null, class: "x" }).toString(),
  '<div class="x"></div>',
);

{
  const html = new HtmlElement("a", { href: "/search?q=a&b=c", title: 'say "hi"' }).toString();
  assert("escapes & in attributes", html.includes('href="/search?q=a&amp;b=c"'));
  assert('escapes " in attributes', html.includes('title="say &quot;hi&quot;"'));
}

// --- Builder pattern (htmlElement) ---
console.log("\n--- Builder pattern ---");

{
  const builder = htmlElement("div");
  const el = builder("Hello", " ", "World");
  assertEqual("builder adds children", el.toString(), "<div>Hello World</div>");
}

{
  const el = htmlElement("div")(htmlElement("p")("Text"));
  assertEqual("nested builder", el.toString(), "<div><p>Text</p></div>");
}

{
  const el = htmlElement("div", { class: "a" })({ id: "main" }, "Content");
  assertEqual("builder merges attrs", el.toString(), '<div class="a" id="main">Content</div>');
}

{
  const original = htmlElement("div");
  original("child");
  assertEqual("builder immutable", original.toString(), "<div></div>");
}

// --- Helper functions ---
console.log("\n--- Helper functions ---");

{
  const h: Record<string, any> = {};
  addHtmlHelpers(h);

  assert("_div exists", typeof h._div === "function");
  assert("_p exists", typeof h._p === "function");
  assert("_span exists", typeof h._span === "function");
  assert("_a exists", typeof h._a === "function");
  assert("_br exists", typeof h._br === "function");

  assertEqual(
    "helper creates element",
    h._div({ class: "card" }, "Hello").toString(),
    '<div class="card">Hello</div>',
  );

  assertEqual(
    "nested helpers",
    h._div({ class: "card" }, h._p("Hello")).toString(),
    '<div class="card"><p>Hello</p></div>',
  );

  assertEqual("void tag helper", h._br().toString(), "<br>");

  assertEqual(
    "complex nested",
    h._div({ class: "nav" }, h._a({ href: "/" }, "Home")).toString(),
    '<div class="nav"><a href="/">Home</a></div>',
  );
}

// --- Summary ---
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

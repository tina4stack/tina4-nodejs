/**
 * Unit tests for the HtmlElement module.
 * Run with: npx tsx test/htmlElement.test.ts
 */
import { HtmlElement, htmlElement, addHtmlHelpers, Raw, SafeString } from "../packages/core/src/index.ts";

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

  // Exercise each injected helper and assert the rendered markup (not just typeof).
  assertEqual("_div renders", h._div({ id: "x" }, "hi").toString(), '<div id="x">hi</div>');
  assertEqual("_p renders", h._p("para").toString(), "<p>para</p>");
  assertEqual("_span renders", h._span({ class: "tag" }, "x").toString(), '<span class="tag">x</span>');
  assertEqual("_a renders", h._a({ href: "/p" }, "link").toString(), '<a href="/p">link</a>');
  // _br is a void tag — renders with no closing tag.
  assertEqual("_br renders void", h._br().toString(), "<br>");

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

// --- XSS escaping + Raw opt-in (H1 lock-in) ---
console.log("\n--- XSS escaping + Raw opt-in ---");

{
  // A plain string child must be HTML-ESCAPED (defeats stored/reflected XSS).
  const html = new HtmlElement("div", {}, ["<script>alert(1)</script>"]).toString();
  assert(
    "string child is escaped (no live tag)",
    html.includes("&lt;script&gt;") && !html.includes("<script>"),
    `\n    actual: ${html}`,
  );
}

{
  const html = new HtmlElement("div", {}, ["<script>alert(1)</script>"]).toString();
  assertEqual(
    "string child escaped exact",
    html,
    "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>",
  );
}

{
  // A Raw() child renders UNESCAPED — explicit opt-in for trusted markup.
  const html = new HtmlElement("div", {}, [new Raw("<b>x</b>")]).toString();
  assertEqual("Raw child renders raw", html, "<div><b>x</b></div>");
}

{
  // SafeString is an alias for Raw and also renders unescaped.
  const html = new HtmlElement("div", {}, [new SafeString("<i>y</i>")]).toString();
  assertEqual("SafeString alias renders raw", html, "<div><i>y</i></div>");
}

{
  // SafeString is the unescaping marker, not merely the same object as Raw.
  // Prove it renders trusted markup verbatim in a child slot...
  assertEqual(
    "SafeString renders unescaped like Raw",
    new HtmlElement("div", {}, [new SafeString("<b>z</b>")]).toString(),
    "<div><b>z</b></div>",
  );
  // ...while a plain string in the SAME slot is escaped — confirming SafeString
  // is what disables escaping, not the default behaviour.
  assertEqual(
    "plain string in same slot is escaped",
    new HtmlElement("div", {}, ["<b>z</b>"]).toString(),
    "<div>&lt;b&gt;z&lt;/b&gt;</div>",
  );
  // And it is the literal same constructor as Raw (the alias is real).
  assert("SafeString === Raw", (SafeString as unknown) === (Raw as unknown));
}

{
  // Nested HtmlElement renders as-is (already escapes its own children) — no double-escape.
  const inner = new HtmlElement("span", {}, ["A & B"]);
  const html = new HtmlElement("div", {}, [inner]).toString();
  assertEqual("nested element no double-escape", html, "<div><span>A &amp; B</span></div>");
}

{
  // Mixed children: escaped string + raw + nested element.
  const html = new HtmlElement("div", {}, [
    "<x>",
    new Raw("<b>ok</b>"),
    new HtmlElement("p", {}, ["c & d"]),
  ]).toString();
  assertEqual(
    "mixed children render correctly",
    html,
    "<div>&lt;x&gt;<b>ok</b><p>c &amp; d</p></div>",
  );
}

{
  // Builder pattern children must still render verbatim (escaped by their own toString).
  const html = htmlElement("div")(htmlElement("p")("<z>")).toString();
  assertEqual("builder child escapes its own content", html, "<div><p>&lt;z&gt;</p></div>");
}

{
  // Attribute value with a quote is escaped.
  const html = new HtmlElement("a", { title: 'say "hi"' }).toString();
  assert('attribute quote escaped', html.includes('title="say &quot;hi&quot;"'), `\n    actual: ${html}`);
}

{
  // Attribute value with a < is escaped.
  const html = new HtmlElement("div", { "data-x": "<bad>" }).toString();
  assert("attribute < escaped", html.includes('data-x="&lt;bad&gt;"'), `\n    actual: ${html}`);
}

// --- Summary ---
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

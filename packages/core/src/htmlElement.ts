/**
 * Programmatic HTML builder — avoids string concatenation.
 *
 * Usage:
 *   const el = new HtmlElement("div", { class: "card" }, ["Hello"]);
 *   el.toString();  // '<div class="card">Hello</div>'
 *
 *   // Builder pattern
 *   const el = htmlElement("div")(htmlElement("p")("Text"));
 *
 *   // Helper functions
 *   const h: Record<string, any> = {};
 *   addHtmlHelpers(h);
 *   const html = h._div({ class: "card" }, h._p("Hello"));
 */

const VOID_TAGS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const HTML_TAGS: readonly string[] = [
  "a", "abbr", "address", "area", "article", "aside", "audio",
  "b", "base", "bdi", "bdo", "blockquote", "body", "br", "button",
  "canvas", "caption", "cite", "code", "col", "colgroup",
  "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt",
  "em", "embed",
  "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html",
  "i", "iframe", "img", "input", "ins",
  "kbd",
  "label", "legend", "li", "link",
  "main", "map", "mark", "menu", "meta", "meter",
  "nav", "noscript",
  "object", "ol", "optgroup", "option", "output",
  "p", "param", "picture", "pre", "progress",
  "q",
  "rp", "rt", "ruby",
  "s", "samp", "script", "section", "select", "slot", "small", "source", "span",
  "strong", "style", "sub", "summary", "sup",
  "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time",
  "title", "tr", "track",
  "u", "ul",
  "var", "video",
  "wbr",
];

/**
 * Raw — marker for trusted, pre-sanitised HTML that must render UNESCAPED.
 *
 * String/scalar children of an HtmlElement are HTML-escaped by default to
 * prevent stored/reflected XSS. Wrap a value in Raw to opt out of escaping
 * when (and only when) you have already sanitised it yourself.
 *
 *   new HtmlElement("div", {}, ["<b>x</b>"]).toString()           // &lt;b&gt;x&lt;/b&gt;  (escaped)
 *   new HtmlElement("div", {}, [new Raw("<b>x</b>")]).toString()  // <b>x</b>              (raw)
 *
 * Alias: SafeString.
 */
export class Raw {
  readonly value: string;

  constructor(value: string) {
    this.value = String(value);
  }

  toString(): string {
    return this.value;
  }
}

// Alias — some callers/frameworks prefer the SafeString name (matches Frond/Python).
export const SafeString = Raw;

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = string | number | HtmlElement | Raw;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape a plain string/scalar child so it cannot inject markup (defeats XSS).
 */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isAttrs(arg: unknown): arg is Attrs {
  return typeof arg === "object" && arg !== null
    && !(arg instanceof HtmlElement) && !(arg instanceof Raw) && !Array.isArray(arg);
}

/**
 * A builder produced by htmlElement() is a callable function branded with
 * `_isHtmlElement`. Its toString() already produces fully-escaped HTML, so it
 * must render verbatim (not be escaped as a string).
 */
function isBuilderElement(arg: unknown): boolean {
  return typeof arg === "function" && (arg as { _isHtmlElement?: boolean })._isHtmlElement === true;
}

/**
 * HtmlElement — a single HTML tag with attributes and children.
 */
export class HtmlElement {
  readonly tag: string;
  readonly attrs: Attrs;
  readonly children: Child[];

  constructor(tag: string, attrs: Attrs = {}, children: Child[] = []) {
    this.tag = tag.toLowerCase();
    this.attrs = { ...attrs };
    this.children = [...children];
  }

  /**
   * Render to HTML string.
   */
  toString(): string {
    let html = `<${this.tag}`;

    for (const [key, value] of Object.entries(this.attrs)) {
      if (value === true) {
        html += ` ${key}`;
      } else if (value !== false && value !== null && value !== undefined) {
        html += ` ${key}="${escapeAttr(String(value))}"`;
      }
    }

    if (VOID_TAGS.has(this.tag)) {
      return html + ">";
    }

    html += ">";

    for (const child of this.children) {
      if (child instanceof HtmlElement) {
        // Nested elements render themselves (already escape their own children).
        html += child.toString();
      } else if (child instanceof Raw) {
        // Explicitly trusted markup — emit unescaped.
        html += child.toString();
      } else if (isBuilderElement(child)) {
        // Callable builder produced by htmlElement() — render via its toString.
        html += String(child);
      } else {
        // Plain string/scalar child — escape to defeat XSS.
        html += escapeText(String(child));
      }
    }

    html += `</${this.tag}>`;
    return html;
  }
}

/**
 * Create a callable HTML element builder.
 * Returns a function that, when called with children/attrs, produces a new HtmlElement.
 *
 * Usage:
 *   const div = htmlElement("div");
 *   const el = div({ class: "card" }, "Hello");
 *   console.log(el.toString());  // '<div class="card">Hello</div>'
 */
export function htmlElement(tag: string, attrs: Attrs = {}, children: Child[] = []) {
  const el = new HtmlElement(tag, attrs, children);

  const builder = (...args: (Child | Attrs | Child[])[]) => {
    const newAttrs: Attrs = { ...el.attrs };
    const newChildren: Child[] = [...el.children];

    for (const arg of args) {
      if (isAttrs(arg)) {
        Object.assign(newAttrs, arg);
      } else if (Array.isArray(arg)) {
        newChildren.push(...arg);
      } else {
        newChildren.push(arg as Child);
      }
    }

    return htmlElement(tag, newAttrs, newChildren);
  };

  // Expose HtmlElement properties and toString on the builder function
  builder.tag = el.tag;
  builder.attrs = el.attrs;
  builder.children = el.children;
  builder.toString = () => el.toString();
  builder._isHtmlElement = true;

  return builder;
}

/**
 * Injects helper functions (_div, _p, _a, _span, etc.) into the target object.
 *
 * Usage:
 *   const h: Record<string, any> = {};
 *   addHtmlHelpers(h);
 *   const html = h._div({ class: "card" }, h._p("Hello"));
 */
export function addHtmlHelpers(target: Record<string, unknown>): void {
  for (const tag of HTML_TAGS) {
    target[`_${tag}`] = (...args: (Child | Attrs | Child[])[]) => {
      const attrs: Attrs = {};
      const children: Child[] = [];

      for (const arg of args) {
        if (isAttrs(arg)) {
          Object.assign(attrs, arg);
        } else if (Array.isArray(arg)) {
          children.push(...arg);
        } else {
          children.push(arg as Child);
        }
      }

      return new HtmlElement(tag, attrs, children);
    };
  }
}

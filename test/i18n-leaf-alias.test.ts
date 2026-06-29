/**
 * Vitest tests for I18n leaf-key aliasing, the corrected _flatten contract,
 * partial interpolation, JSON-native scalar coercion, and auto-wire of the
 * t() template global.
 *
 * Run with: npx vitest run test/i18n-leaf-alias.test.ts
 *
 * Real on-disk locale files, real I18n / Frond instances — no mocks.
 *
 * Constructor arg order is (locale, path) to match Python I18n(locale, path)
 * (BUG-7, BREAKING — was previously (localeDir, defaultLocale)).
 */
import { describe, it, expect, afterAll } from "vitest";
import { I18n } from "../packages/core/src/index.ts";
import { Frond } from "../packages/frond/src/engine.ts";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOT = "/tmp/tina4-i18n-leaf-test";

afterAll(() => {
  try { rmSync(TEST_ROOT, { recursive: true }); } catch { /* ignore */ }
});

/** Write a single en.json under a fresh per-test dir and return the dir. */
function makeLocaleDir(name: string, payload: Record<string, unknown>): string {
  const dir = join(TEST_ROOT, name, "locales");
  try { rmSync(join(TEST_ROOT, name), { recursive: true }); } catch { /* ignore */ }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "en.json"), JSON.stringify(payload));
  return dir;
}

describe("I18n — leaf-key resolution from nested JSON", () => {
  const dir = makeLocaleDir("leaf", {
    nav: { home: "Home", about: "About Us" },
    footer: { contact: "Contact" },
  });
  const i18n = new I18n("en", dir);

  it("dot-path still works: nav.home", () => expect(i18n.t("nav.home")).toBe("Home"));
  it("dot-path still works: nav.about", () => expect(i18n.t("nav.about")).toBe("About Us"));
  it("dot-path still works: footer.contact", () => expect(i18n.t("footer.contact")).toBe("Contact"));
  it("leaf key resolves: home", () => expect(i18n.t("home")).toBe("Home"));
  it("leaf key resolves: about", () => expect(i18n.t("about")).toBe("About Us"));
  it("leaf key resolves: contact", () => expect(i18n.t("contact")).toBe("Contact"));
});

describe("I18n — mixed flat and nested keys", () => {
  const dir = makeLocaleDir("mixed", {
    greeting: "Hello",
    nav: { home: "Home Page", logout: "Sign Out" },
    farewell: "Goodbye",
  });
  const i18n = new I18n("en", dir);

  it("flat key 'greeting' works", () => expect(i18n.t("greeting")).toBe("Hello"));
  it("flat key 'farewell' works", () => expect(i18n.t("farewell")).toBe("Goodbye"));
  it("nested dot-path 'nav.home' works", () => expect(i18n.t("nav.home")).toBe("Home Page"));
  it("leaf alias 'home' resolves", () => expect(i18n.t("home")).toBe("Home Page"));
  it("leaf alias 'logout' resolves", () => expect(i18n.t("logout")).toBe("Sign Out"));
});

describe("I18n — deeply nested keys", () => {
  const dir = makeLocaleDir("deep", {
    app: { ui: { buttons: { submit: "Submit", cancel: "Cancel" } } },
  });
  const i18n = new I18n("en", dir);

  it("deep dot-path 'app.ui.buttons.submit' works", () => expect(i18n.t("app.ui.buttons.submit")).toBe("Submit"));
  it("leaf alias 'submit' resolves from deep nesting", () => expect(i18n.t("submit")).toBe("Submit"));
  it("leaf alias 'cancel' resolves from deep nesting", () => expect(i18n.t("cancel")).toBe("Cancel"));
});

// ── LOCK-IN TESTS (corrected _flatten / interpolation / coercion contract) ──

describe("I18n — _flatten lock-in contract", () => {
  it("leaf_alias_first_wins_on_conflict", () => {
    // First dot-path wins on a leaf collision: nav.title is flattened before
    // page.title, so the derived leaf alias "title" -> "Navigation Title".
    const dir = makeLocaleDir("first-wins", {
      nav: { title: "Navigation Title" },
      page: { title: "Page Title" },
    });
    const i18n = new I18n("en", dir);
    expect(i18n.t("nav.title")).toBe("Navigation Title");
    expect(i18n.t("page.title")).toBe("Page Title");
    expect(i18n.t("title")).toBe("Navigation Title");
  });

  it("leaf_alias_does_not_overwrite_explicit_flat_key", () => {
    // An explicit top-level flat key is NEVER clobbered by a derived alias.
    const dir = makeLocaleDir("no-clobber", {
      home: "Flat Home",
      nav: { home: "Nested Home" },
    });
    const i18n = new I18n("en", dir);
    expect(i18n.t("home")).toBe("Flat Home");
    expect(i18n.t("nav.home")).toBe("Nested Home");
  });

  it("leaf_alias_does_not_overwrite_explicit_flat_key — flat declared AFTER nested", () => {
    // Ordering-insensitive: the explicit flat key wins even when it appears
    // after the nested block in source order.
    const dir = makeLocaleDir("no-clobber-reordered", {
      nav: { home: "Nested Home" },
      home: "Flat Home",
    });
    const i18n = new I18n("en", dir);
    expect(i18n.t("home")).toBe("Flat Home");
    expect(i18n.t("nav.home")).toBe("Nested Home");
  });
});

describe("I18n — partial interpolation lock-in contract", () => {
  it("interpolation_partial_leaves_missing_literal", () => {
    const dir = makeLocaleDir("partial", { msg: "Hi {first} and {second}" });
    const i18n = new I18n("en", dir);
    expect(i18n.t("msg", { first: "A" })).toBe("Hi A and {second}");
  });

  it("interpolation_never_crashes_on_stray_brace", () => {
    const dir = makeLocaleDir("stray", { msg: "Set { and forget" });
    const i18n = new I18n("en", dir);
    let result = "";
    expect(() => { result = i18n.t("msg", { anything: "x" }); }).not.toThrow();
    expect(result).toBe("Set { and forget");
  });

  it("interpolation_never_crashes_on_attr_or_spec", () => {
    const dir = makeLocaleDir("attr-spec", {
      attr: "Hello {name.first}",
      spec: "You have {n:d} items",
    });
    const i18n = new I18n("en", dir);

    let attrResult = "";
    expect(() => { attrResult = i18n.t("attr", { name: "Alice" }); }).not.toThrow();
    expect(attrResult).toBe("Hello {name.first}");

    let specResult = "";
    expect(() => { specResult = i18n.t("spec", { n: "five" }); }).not.toThrow();
    expect(specResult).toBe("You have {n:d} items");
  });
});

describe("I18n — JSON-native scalar coercion lock-in contract", () => {
  it("non_string_scalar_coercion_json_native", () => {
    // Node's String(value) already yields JSON-native renderings — confirm it
    // matches the decided contract: true/false -> "true"/"false", null -> "null",
    // number -> plain form.
    const dir = makeLocaleDir("scalars", {
      flag: true,
      off: false,
      nil: null,
      num: 42,
    });
    const i18n = new I18n("en", dir);
    expect(i18n.t("flag")).toBe("true");
    expect(i18n.t("off")).toBe("false");
    expect(i18n.t("nil")).toBe("null");
    expect(i18n.t("num")).toBe("42");
  });
});

// ── Auto-wire t() template global ──────────────────────────────────────────

describe("Frond auto-wire — t() template global", () => {
  it("registers and renders t() when locale files exist", () => {
    Frond.clearRegistry();
    const dir = makeLocaleDir("autowire", {
      hello: "Hello World",
      nav: { home: "Home" },
    });
    const templatesDir = join(TEST_ROOT, "autowire", "templates");
    mkdirSync(templatesDir, { recursive: true });
    const frondEngine = new Frond(templatesDir) as any;

    // Simulate the auto-wire logic from server.ts (locale, path) order
    if (!frondEngine.globals?.t) {
      const autoI18n = new I18n("en", dir);
      frondEngine.addGlobal("t", (key: string, params?: Record<string, string>) => autoI18n.t(key, params));
    }

    expect(frondEngine.renderString("{{ t('hello') }}", {})).toBe("Hello World");
    expect(frondEngine.globals.t("hello")).toBe("Hello World");
    expect(frondEngine.globals.t("nav.home")).toBe("Home");
    expect(frondEngine.globals.t("home")).toBe("Home");
  });

  it("does NOT register t() when no locale files exist", () => {
    Frond.clearRegistry();
    const emptyLocaleDir = join(TEST_ROOT, "empty", "locales");
    mkdirSync(emptyLocaleDir, { recursive: true });
    const templatesDir = join(TEST_ROOT, "empty", "templates");
    mkdirSync(templatesDir, { recursive: true });
    const frond = new Frond(templatesDir) as any;

    const emptyFiles = readdirSync(emptyLocaleDir).filter((f: string) => f.endsWith(".json"));
    if (emptyFiles.length > 0 && !frond.globals?.t) {
      frond.addGlobal("t", () => "should not happen");
    }

    expect(frond.globals.t).toBeUndefined();
  });

  it("does NOT overwrite a user-registered t()", () => {
    Frond.clearRegistry();
    const dir = makeLocaleDir("user-t", { hello: "Hello World" });
    const templatesDir = join(TEST_ROOT, "user-t", "templates");
    mkdirSync(templatesDir, { recursive: true });
    const frond = new Frond(templatesDir) as any;

    const userT = (key: string) => `USER:${key}`;
    frond.addGlobal("t", userT);

    const locFiles = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
    if (locFiles.length > 0 && !frond.globals?.t) {
      const autoI18n = new I18n("en", dir);
      frond.addGlobal("t", (key: string, params?: Record<string, string>) => autoI18n.t(key, params));
    }

    expect(frond.globals.t).toBe(userT);
    expect(frond.globals.t("hello")).toBe("USER:hello");
  });
});

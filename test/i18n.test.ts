/**
 * Vitest tests for the I18n module.
 * Run with: npx vitest run test/i18n.test.ts
 *
 * Real on-disk locale files, real I18n instances — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { I18n } from "../packages/core/src/index.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOT = "/tmp/tina4-i18n-test";
const LOCALE_DIR = join(TEST_ROOT, "locales");

beforeAll(() => {
  try { rmSync(TEST_ROOT, { recursive: true }); } catch { /* ignore */ }
  mkdirSync(LOCALE_DIR, { recursive: true });

  writeFileSync(join(LOCALE_DIR, "en.json"), JSON.stringify({
    greeting: "Hello",
    farewell: "Goodbye",
    welcome: "Welcome, {name}!",
    errors: {
      not_found: "Not found",
      forbidden: "Access denied",
    },
    count: "You have {count} items",
  }));

  writeFileSync(join(LOCALE_DIR, "fr.json"), JSON.stringify({
    greeting: "Bonjour",
    farewell: "Au revoir",
    welcome: "Bienvenue, {name}!",
    errors: {
      not_found: "Non trouvé",
    },
  }));

  writeFileSync(join(LOCALE_DIR, "de.json"), JSON.stringify({
    greeting: "Hallo",
  }));
});

afterAll(() => {
  try { rmSync(TEST_ROOT, { recursive: true }); } catch { /* ignore */ }
});

// Constructor arg order is (locale, path) to match Python I18n(locale, path).
describe("I18n — basic translation", () => {
  it("default locale is en", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    expect(i18n.getLocale()).toBe("en");
  });

  it("translates a simple key", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    expect(i18n.t("greeting")).toBe("Hello");
  });

  it("translates a nested key with dot notation", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    expect(i18n.t("errors.not_found")).toBe("Not found");
  });

  it("returns the key itself for a missing translation", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    expect(i18n.t("nonexistent")).toBe("nonexistent");
  });
});

describe("I18n — parameter substitution", () => {
  it("substitutes a single parameter", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    expect(i18n.t("welcome", { name: "Alice" })).toBe("Welcome, Alice!");
  });

  it("substitutes multiple parameters", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    expect(i18n.t("count", { count: "5" })).toBe("You have 5 items");
  });
});

describe("I18n — locale switching", () => {
  it("setLocale changes the current locale", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    i18n.setLocale("fr");
    expect(i18n.getLocale()).toBe("fr");
  });

  it("translates in French after setLocale", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    i18n.setLocale("fr");
    expect(i18n.t("greeting")).toBe("Bonjour");
  });

  it("falls back to the default locale for a missing French key", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    i18n.setLocale("fr");
    expect(i18n.t("errors.forbidden")).toBe("Access denied");
  });
});

describe("I18n — per-call locale override", () => {
  it("translates with an explicit locale parameter", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    i18n.setLocale("fr");
    expect(i18n.t("greeting", undefined, "de")).toBe("Hallo");
  });

  it("leaves the current locale unchanged after an override call", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    i18n.setLocale("fr");
    i18n.t("greeting", undefined, "de");
    expect(i18n.getLocale()).toBe("fr");
  });
});

describe("I18n — translate alias", () => {
  it("translate() is an alias for t()", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    i18n.setLocale("fr");
    expect(i18n.translate("greeting")).toBe("Bonjour");
  });

  it("translate() with a locale override switches then restores the previous locale", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    expect(i18n.translate("greeting", undefined, "de")).toBe("Hallo");
    expect(i18n.getLocale()).toBe("en");
  });
});

describe("I18n — dynamic translation", () => {
  it("addTranslation adds an in-memory translation", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    i18n.addTranslation("en", "custom.key", "Custom Value");
    expect(i18n.t("custom.key")).toBe("Custom Value");
  });
});

describe("I18n — load translations", () => {
  it("loadTranslations returns a record", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    const enTranslations = i18n.loadTranslations("en");
    expect(typeof enTranslations).toBe("object");
    expect(enTranslations["greeting"]).toBe("Hello");
  });
});

describe("I18n — available locales", () => {
  it("lists all locale files", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    const locales = i18n.availableLocales();
    expect(locales).toContain("en");
    expect(locales).toContain("fr");
    expect(locales).toContain("de");
  });

  it("returns locales sorted", () => {
    const i18n = new I18n("en", LOCALE_DIR);
    const locales = i18n.availableLocales();
    expect(locales[0]).toBe("de");
    expect(locales[1]).toBe("en");
    expect(locales[2]).toBe("fr");
  });
});

describe("I18n — edge cases", () => {
  it("missing locale dir returns the key as-is", () => {
    const i18nMissing = new I18n("en", "/tmp/nonexistent-locale-dir-xyz");
    expect(i18nMissing.t("anything")).toBe("anything");
  });

  it("missing locale dir lists the default locale only", () => {
    const i18nMissing = new I18n("en", "/tmp/nonexistent-locale-dir-xyz");
    expect(i18nMissing.availableLocales().length).toBe(1);
  });
});

// ── Constructor arg order (BUG-7, BREAKING) ───────────────────────────────
// Python master is I18n(locale, path); Node now matches.
describe("I18n — constructor positional (locale, path)", () => {
  it("constructor_positional_locale_then_path: first arg is locale, second is path", () => {
    const root = join(TEST_ROOT, "ctor");
    const dir = join(root, "locales");
    try { rmSync(root, { recursive: true }); } catch { /* ignore */ }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fr.json"), JSON.stringify({ greeting: "Bonjour" }));
    writeFileSync(join(dir, "en.json"), JSON.stringify({ greeting: "Hello" }));

    // Positional: locale="fr", path=dir
    const i18n = new I18n("fr", dir);
    expect(i18n.getLocale()).toBe("fr");
    expect(i18n.t("greeting")).toBe("Bonjour");
  });
});

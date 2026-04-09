/**
 * Unit tests for the I18n module.
 * Run with: npx tsx test/i18n.test.ts
 */
import { I18n } from "../packages/core/src/index.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const LOCALE_DIR = "/tmp/tina4-i18n-test/locales";
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

// Clean slate
try { rmSync("/tmp/tina4-i18n-test", { recursive: true }); } catch {}

// Create locale files
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

console.log("=== I18n Tests ===\n");

// --- Basic translation ---
console.log("--- Basic Translation ---");

const i18n = new I18n(LOCALE_DIR, "en");

assert("Default locale is en", i18n.getLocale() === "en");

assert("Translates simple key", i18n.t("greeting") === "Hello");

assert("Translates nested key with dot notation",
  i18n.t("errors.not_found") === "Not found");

assert("Returns key itself for missing translation",
  i18n.t("nonexistent") === "nonexistent");

// --- Parameter substitution ---
console.log("\n--- Parameter Substitution ---");

assert("Substitutes single parameter",
  i18n.t("welcome", { name: "Alice" }) === "Welcome, Alice!");

assert("Substitutes multiple parameters",
  i18n.t("count", { count: "5" }) === "You have 5 items");

// --- Locale switching ---
console.log("\n--- Locale Switching ---");

i18n.setLocale("fr");
assert("setLocale changes current locale", i18n.getLocale() === "fr");

assert("Translates in French after setLocale",
  i18n.t("greeting") === "Bonjour");

assert("Falls back to default locale for missing French key",
  i18n.t("errors.forbidden") === "Access denied");

// --- Locale override per call ---
console.log("\n--- Per-call Locale Override ---");

assert("Translate with explicit locale parameter",
  i18n.t("greeting", undefined, "de") === "Hallo");

assert("Current locale unchanged after override call",
  i18n.getLocale() === "fr");

// --- translate alias ---
console.log("\n--- Translate Alias ---");

assert("translate() is alias for t()",
  i18n.translate("greeting") === "Bonjour");

// --- addTranslation ---
console.log("\n--- Dynamic Translation ---");

i18n.addTranslation("fr", "custom.key", "Valeur personnalisée");
assert("addTranslation adds in-memory translation",
  i18n.t("custom.key") === "Valeur personnalisée");

// --- loadTranslations ---
console.log("\n--- Load Translations ---");

const enTranslations = i18n.loadTranslations("en");
assert("loadTranslations returns record",
  typeof enTranslations === "object" && enTranslations["greeting"] === "Hello");

// --- getAvailableLocales ---
console.log("\n--- Available Locales ---");

const locales = i18n.availableLocales();
assert("getAvailableLocales returns all locale files",
  locales.includes("en") && locales.includes("fr") && locales.includes("de"));

assert("Available locales are sorted",
  locales[0] === "de" && locales[1] === "en" && locales[2] === "fr");

// --- Missing locale directory ---
console.log("\n--- Edge Cases ---");

const i18nMissing = new I18n("/tmp/nonexistent-locale-dir-xyz");
assert("Missing locale dir returns key as-is",
  i18nMissing.t("anything") === "anything");

assert("Missing locale dir lists default locale only",
  i18nMissing.availableLocales().length === 1);

// Cleanup
rmSync("/tmp/tina4-i18n-test", { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

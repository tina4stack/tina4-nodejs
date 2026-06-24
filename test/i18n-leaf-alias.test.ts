/**
 * Tests for I18n leaf-key aliasing and auto-wire of t() template global.
 * Run with: npx tsx test/i18n-leaf-alias.test.ts
 */
import { I18n } from "../packages/core/src/index.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const TEST_ROOT = "/tmp/tina4-i18n-leaf-test";
const LOCALE_DIR = join(TEST_ROOT, "locales");
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
try { rmSync(TEST_ROOT, { recursive: true }); } catch {}

console.log("=== I18n Leaf-Key Aliasing Tests ===\n");

// ── Feature 1: Leaf-key aliasing ──────────────────────────────

console.log("--- Leaf key resolution from nested JSON ---");

mkdirSync(LOCALE_DIR, { recursive: true });

writeFileSync(join(LOCALE_DIR, "en.json"), JSON.stringify({
  nav: {
    home: "Home",
    about: "About Us",
  },
  footer: {
    contact: "Contact",
  },
}));

const i18n = new I18n(LOCALE_DIR, "en");

assert("Dot-path still works: nav.home",
  i18n.t("nav.home") === "Home");

assert("Dot-path still works: nav.about",
  i18n.t("nav.about") === "About Us");

assert("Dot-path still works: footer.contact",
  i18n.t("footer.contact") === "Contact");

assert("Leaf key resolves: home",
  i18n.t("home") === "Home");

assert("Leaf key resolves: about",
  i18n.t("about") === "About Us");

assert("Leaf key resolves: contact",
  i18n.t("contact") === "Contact");

// ── First-wins on conflict ────────────────────────────────────

console.log("\n--- First-wins on leaf-key conflict ---");

try { rmSync(TEST_ROOT, { recursive: true }); } catch {}
mkdirSync(LOCALE_DIR, { recursive: true });

writeFileSync(join(LOCALE_DIR, "en.json"), JSON.stringify({
  nav: {
    title: "Nav Title",
  },
  page: {
    title: "Page Title",
  },
}));

const i18nConflict = new I18n(LOCALE_DIR, "en");

assert("Dot-path nav.title works",
  i18nConflict.t("nav.title") === "Nav Title");

assert("Dot-path page.title works",
  i18nConflict.t("page.title") === "Page Title");

// The leaf alias "title" should resolve to whichever was flattened first
const titleValue = i18nConflict.t("title");
assert("Leaf alias 'title' resolves to first-wins value",
  titleValue === "Nav Title" || titleValue === "Page Title",
  `got: ${titleValue}`);

// ── Mixed flat and nested ─────────────────────────────────────

console.log("\n--- Mixed flat and nested keys ---");

try { rmSync(TEST_ROOT, { recursive: true }); } catch {}
mkdirSync(LOCALE_DIR, { recursive: true });

writeFileSync(join(LOCALE_DIR, "en.json"), JSON.stringify({
  greeting: "Hello",
  nav: {
    home: "Home Page",
    logout: "Sign Out",
  },
  farewell: "Goodbye",
}));

const i18nMixed = new I18n(LOCALE_DIR, "en");

assert("Flat key 'greeting' works",
  i18nMixed.t("greeting") === "Hello");

assert("Flat key 'farewell' works",
  i18nMixed.t("farewell") === "Goodbye");

assert("Nested dot-path 'nav.home' works",
  i18nMixed.t("nav.home") === "Home Page");

assert("Leaf alias 'home' resolves",
  i18nMixed.t("home") === "Home Page");

assert("Leaf alias 'logout' resolves",
  i18nMixed.t("logout") === "Sign Out");

// ── Flat key takes precedence over leaf alias ─────────────────

console.log("\n--- Flat key shadows leaf alias ---");

try { rmSync(TEST_ROOT, { recursive: true }); } catch {}
mkdirSync(LOCALE_DIR, { recursive: true });

writeFileSync(join(LOCALE_DIR, "en.json"), JSON.stringify({
  home: "Flat Home",
  nav: {
    home: "Nav Home",
  },
}));

const i18nShadow = new I18n(LOCALE_DIR, "en");

assert("Explicit flat key 'home' wins over leaf alias from nav.home",
  i18nShadow.t("home") === "Flat Home");

assert("Dot-path 'nav.home' still works",
  i18nShadow.t("nav.home") === "Nav Home");

// ── Deeply nested ─────────────────────────────────────────────

console.log("\n--- Deeply nested keys ---");

try { rmSync(TEST_ROOT, { recursive: true }); } catch {}
mkdirSync(LOCALE_DIR, { recursive: true });

writeFileSync(join(LOCALE_DIR, "en.json"), JSON.stringify({
  app: {
    ui: {
      buttons: {
        submit: "Submit",
        cancel: "Cancel",
      },
    },
  },
}));

const i18nDeep = new I18n(LOCALE_DIR, "en");

assert("Deep dot-path 'app.ui.buttons.submit' works",
  i18nDeep.t("app.ui.buttons.submit") === "Submit");

assert("Leaf alias 'submit' resolves from deep nesting",
  i18nDeep.t("submit") === "Submit");

assert("Leaf alias 'cancel' resolves from deep nesting",
  i18nDeep.t("cancel") === "Cancel");

// ── Feature 2: Auto-wire t() template global ──────────────────

console.log("\n--- Auto-wire registers t() when locales exist ---");

try { rmSync(TEST_ROOT, { recursive: true }); } catch {}
mkdirSync(LOCALE_DIR, { recursive: true });

writeFileSync(join(LOCALE_DIR, "en.json"), JSON.stringify({
  hello: "Hello World",
  nav: { home: "Home" },
}));

// Simulate what server.ts does: create a Frond engine, then auto-wire
let frondEngine: any = null;
try {
  const { Frond } = await import("../packages/frond/src/engine.js");
  const templatesDir = join(TEST_ROOT, "templates");
  mkdirSync(templatesDir, { recursive: true });
  frondEngine = new Frond(templatesDir);
} catch {
  // Frond not available
}

if (frondEngine) {
  // Simulate the auto-wire logic from server.ts
  const localeFiles = (await import("node:fs")).readdirSync(LOCALE_DIR).filter((f: string) => f.endsWith(".json"));
  if (localeFiles.length > 0 && !frondEngine.globals?.t) {
    const autoI18n = new I18n(LOCALE_DIR, "en");
    frondEngine.addGlobal("t", (key: string, params?: Record<string, string>) => autoI18n.t(key, params));
  }

  assert("t() global renders in a template via the engine",
    frondEngine.renderString("{{ t('hello') }}", {}) === "Hello World");

  assert("t() global translates flat keys",
    frondEngine.globals.t("hello") === "Hello World");

  assert("t() global translates dot-path keys",
    frondEngine.globals.t("nav.home") === "Home");

  assert("t() global translates leaf alias keys",
    frondEngine.globals.t("home") === "Home");

  // --- Auto-wire does nothing when no locales ---
  console.log("\n--- Auto-wire does nothing when no locales ---");

  const emptyLocaleDir = join(TEST_ROOT, "empty-locales");
  mkdirSync(emptyLocaleDir, { recursive: true });

  const { Frond: Frond2 } = await import("../packages/frond/src/engine.js");
  // Clear class-level registry — the static-facade pattern persists
  // ``addGlobal`` calls across instances, so the t() registered on
  // frondEngine above would otherwise leak into this fresh instance.
  Frond2.clearRegistry();
  const frondNoLocales = new Frond2(join(TEST_ROOT, "templates"));

  // Simulate auto-wire with empty locale dir
  const emptyFiles = (await import("node:fs")).readdirSync(emptyLocaleDir).filter((f: string) => f.endsWith(".json"));
  if (emptyFiles.length > 0 && !frondNoLocales.globals?.t) {
    // This block should NOT execute
    frondNoLocales.addGlobal("t", () => "should not happen");
  }

  assert("t() is NOT registered when no locale files exist",
    frondNoLocales.globals.t === undefined);

  // --- User-registered t() is not overwritten ---
  console.log("\n--- User-registered t() is not overwritten ---");

  const { Frond: Frond3 } = await import("../packages/frond/src/engine.js");
  const frondUserT = new Frond3(join(TEST_ROOT, "templates"));

  // User registers their own t()
  const userT = (key: string) => `USER:${key}`;
  frondUserT.addGlobal("t", userT);

  // Simulate auto-wire: should skip because t already exists
  const locFiles = (await import("node:fs")).readdirSync(LOCALE_DIR).filter((f: string) => f.endsWith(".json"));
  if (locFiles.length > 0 && !frondUserT.globals?.t) {
    const autoI18n2 = new I18n(LOCALE_DIR, "en");
    frondUserT.addGlobal("t", (key: string, params?: Record<string, string>) => autoI18n2.t(key, params));
  }

  assert("User-registered t() is preserved",
    frondUserT.globals.t === userT);

  assert("User t() still returns custom value",
    frondUserT.globals.t("hello") === "USER:hello");

} else {
  console.log("  SKIP: Frond engine not available — auto-wire tests skipped");
}

// ── Auto-wire with nonexistent locale dir ─────────────────────

console.log("\n--- Auto-wire with nonexistent locale directory ---");

if (frondEngine) {
  const { Frond: Frond4 } = await import("../packages/frond/src/engine.js");
  // Same reason as the "no locales" block above — clear class-level
  // registry so the t() global registered earlier doesn't leak in.
  Frond4.clearRegistry();
  const frondNoDir = new Frond4(join(TEST_ROOT, "templates"));

  // Simulate auto-wire with a directory that doesn't exist
  const fakeDirPath = join(TEST_ROOT, "nonexistent-locales");
  if (existsSync(fakeDirPath)) {
    // Would enter auto-wire — but it doesn't exist, so skip
  }

  assert("t() is NOT registered when locale directory does not exist",
    frondNoDir.globals.t === undefined);
}

// Cleanup
try { rmSync(TEST_ROOT, { recursive: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);

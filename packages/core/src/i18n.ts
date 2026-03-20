// Tina4 i18n — Internationalization and localization, zero dependencies.
// Load JSON translation files, support nested keys, parameter substitution, locale fallback.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export class I18n {
  private _localeDir: string;
  private _defaultLocale: string;
  private _currentLocale: string;
  private _translations: Map<string, Record<string, string>> = new Map();

  constructor(localeDir?: string, defaultLocale?: string) {
    this._localeDir = resolve(
      localeDir ?? process.env.TINA4_LOCALE_DIR ?? "src/locales"
    );
    this._defaultLocale = defaultLocale ?? process.env.TINA4_LOCALE ?? "en";
    this._currentLocale = this._defaultLocale;
    this._loadLocale(this._defaultLocale);
  }

  setLocale(locale: string): void {
    this._currentLocale = locale;
    this._loadLocale(locale);
  }

  getLocale(): string {
    return this._currentLocale;
  }

  /**
   * Translate a key. Supports {placeholder} interpolation.
   * Falls back to default locale, then returns the key itself.
   */
  t(key: string, params?: Record<string, string>, locale?: string): string {
    const effectiveLocale = locale ?? this._currentLocale;

    // Ensure locale is loaded
    if (locale) {
      this._loadLocale(locale);
    }

    // Try effective locale
    const translations = this._translations.get(effectiveLocale) ?? {};
    let value: string | undefined = translations[key];

    // Fallback to default locale
    if (value === undefined && effectiveLocale !== this._defaultLocale) {
      const fallback = this._translations.get(this._defaultLocale) ?? {};
      value = fallback[key];
    }

    // Fallback to key itself
    if (value === undefined) {
      value = key;
    }

    // Interpolate parameters: {name} → value
    if (params) {
      for (const [pKey, pVal] of Object.entries(params)) {
        value = value.replace(new RegExp(`\\{${pKey}\\}`, "g"), pVal);
      }
    }

    return value;
  }

  /** Alias for t() */
  translate(key: string, params?: Record<string, string>, locale?: string): string {
    return this.t(key, params, locale);
  }

  /** Load and return translations for a locale. */
  loadTranslations(locale: string): Record<string, string> {
    this._loadLocale(locale);
    return { ...(this._translations.get(locale) ?? {}) };
  }

  /** Add a single translation key/value to a locale (in-memory only). */
  addTranslation(locale: string, key: string, value: string): void {
    if (!this._translations.has(locale)) {
      this._translations.set(locale, {});
    }
    this._translations.get(locale)![key] = value;
  }

  /** List available locale codes based on JSON files in the locale directory. */
  getAvailableLocales(): string[] {
    if (!existsSync(this._localeDir)) {
      return [this._defaultLocale];
    }
    try {
      const files = readdirSync(this._localeDir);
      const locales = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
      return locales.length > 0 ? locales : [this._defaultLocale];
    } catch {
      return [this._defaultLocale];
    }
  }

  /** Load a locale file if not already loaded. */
  private _loadLocale(locale: string): void {
    if (this._translations.has(locale)) {
      return;
    }
    const filePath = join(this._localeDir, `${locale}.json`);
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
        this._translations.set(locale, I18n._flatten(data));
      } catch {
        this._translations.set(locale, {});
      }
    } else {
      this._translations.set(locale, {});
    }
  }

  /** Flatten nested objects: {"a": {"b": "c"}} → {"a.b": "c"} */
  private static _flatten(data: Record<string, unknown>, prefix = ""): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        Object.assign(result, I18n._flatten(value as Record<string, unknown>, fullKey));
      } else {
        result[fullKey] = String(value);
      }
    }
    return result;
  }
}

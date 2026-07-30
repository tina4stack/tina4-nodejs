import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parse a .env file content string into key-value pairs.
 * Supports:
 *   - KEY=value
 *   - KEY="double quoted"
 *   - KEY='single quoted'
 *   - export KEY=value
 *   - # comments
 *   - Empty lines
 *   - Multi-line with trailing backslash \
 */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Emit a parse warning. dotenv loads before the logger exists, so stderr. */
function warnEnv(message: string): void {
  process.stderr.write(`[tina4] ${message}\n`);
}

/**
 * Expand ${VAR} against already-loaded keys plus the real environment.
 *
 * `process.env` is checked FIRST so the effective value wins: loading is
 * first-wins, so a key already in the real environment is what the process will
 * actually see, and an interpolation that resolved against the file's value
 * instead would disagree with it. `parsed` then supplies keys set earlier in
 * this same file, which are not in process.env until the whole file is applied.
 *
 * An unresolved name stays LITERAL and is warned about once per name, so a typo
 * is visible without breaking the load.
 */
function interpolate(
  value: string,
  parsed: Record<string, string>,
  lineNo: number,
  warnedRefs: Set<string>
): string {
  return value.replace(REFERENCE, (whole, name: string) => {
    const resolved = process.env[name] ?? parsed[name];
    if (resolved !== undefined) return resolved;
    if (!warnedRefs.has(name)) {
      warnedRefs.add(name);
      warnEnv(`.env:${lineNo}: \${${name}} is not set, left as-is`);
    }
    return whole;
  });
}

function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");
  const warnedRefs = new Set<string>();
  let i = 0;

  while (i < lines.length) {
    let line = lines[i].trim();
    const lineNo = i + 1;
    i++;

    // Skip empty lines and comments
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    // Strip "export " prefix
    if (line.startsWith("export ")) {
      line = line.slice(7).trim();
    }

    // Find the first = sign. A line with no "=" sets nothing, so say so rather
    // than dropping it in silence.
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      warnEnv(`.env:${lineNo}: no '=' in "${line}", line skipped`);
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!VALID_KEY.test(key)) {
      warnEnv(`.env:${lineNo}: invalid key "${key}", line skipped`);
      continue;
    }
    let value = line.slice(eqIndex + 1).trim();

    // Handle quoted values. Quoting decides escapes AND interpolation, in that
    // order -- the cross-framework behaviour table (feature 1 of the audit).
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
      // Process escape sequences in double-quoted values
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      value = interpolate(value, result, lineNo, warnedRefs);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      // Single-quoted: verbatim. No escape processing, and NO interpolation --
      // shell semantics, and the documented way to keep a literal ${...}.
      value = value.slice(1, -1);
    } else {
      // Unquoted: handle multi-line with trailing backslash
      while (value.endsWith("\\") && i < lines.length) {
        value = value.slice(0, -1) + lines[i].trim();
        i++;
      }
      // Strip inline comments (only for unquoted values)
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trim();
      }
      value = interpolate(value, result, lineNo, warnedRefs);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Load environment variables from a .env file into process.env.
 *
 * By default does NOT override existing process.env values — it is first-wins:
 * a key is only set if it is not already present. This is how real env vars
 * always win. To get the precedence real-env > `.env.local` > `.env`, load
 * `.env.local` FIRST then `.env`, both with override=false (the default): the
 * real env (already present) wins over both, `.env.local` fills local-only keys,
 * and `.env` fills the rest. Do NOT load `.env.local` with override=true — that
 * would let a stray gitignored `.env.local` clobber an explicitly set real env
 * var (e.g. a production TINA4_SECRET).
 *
 * Resolution order for the env file path:
 *   1. Explicit `path` argument
 *   2. `TINA4_ENV_FILE` env var (if set and non-empty)
 *   3. `.env` in the current working directory
 *
 * @param path     - Path to the .env file. Optional override.
 * @param override - When true, overwrite keys already present in process.env.
 * @returns The parsed key-value pairs, or an empty object if the file doesn't exist.
 */
export function loadEnv(path?: string, override = false): Record<string, string> {
  const fromEnv = (process.env.TINA4_ENV_FILE ?? "").trim();
  const target = path ?? (fromEnv.length > 0 ? fromEnv : ".env");
  const envPath = resolve(target);

  if (!existsSync(envPath)) {
    return {};
  }

  const content = readFileSync(envPath, "utf-8");
  const parsed = parseEnvContent(content);

  for (const [key, value] of Object.entries(parsed)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      _loadedKeys.push(key);
    }
  }

  return parsed;
}

/**
 * Get an environment variable value with an optional default.
 *
 * @param key - The environment variable name.
 * @param defaultValue - Value to return if the variable is not set.
 * @returns The environment variable value, or the default.
 */
export function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}

/**
 * Get a required environment variable. Throws if not set.
 *
 * @param key - The environment variable name.
 * @returns The environment variable value.
 * @throws Error if the variable is not set.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`Required environment variable "${key}" is not set.`);
  }
  return value;
}

/**
 * Check if an environment variable exists (is defined in process.env).
 *
 * @param key - The environment variable name.
 * @returns true if the variable is set, false otherwise.
 */
export function hasEnv(key: string): boolean {
  return process.env[key] !== undefined;
}

/**
 * Return all currently loaded environment variables.
 *
 * @returns A shallow copy of process.env as a record.
 */
export function allEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/**
 * Check if a value is truthy for env boolean checks.
 *
 * Accepts: "true", "True", "TRUE", "1", "yes", "Yes", "YES", "on", "On", "ON".
 * Everything else is falsy (including empty string, undefined, not set).
 *
 * Mirrors Python's `is_truthy()` in `tina4_python.dotenv`.
 */
export function isTruthy(val: string | undefined | null): boolean {
  if (val == null) return false;
  return ["true", "1", "yes", "on"].includes(val.trim().toLowerCase());
}

/** Keys loaded by loadEnv, tracked for resetEnv(). */
const _loadedKeys: string[] = [];

/**
 * Remove all environment variables that were loaded by loadEnv().
 * Useful for testing. Only removes keys set by loadEnv(), not pre-existing system env vars.
 */
export function resetEnv(): void {
  for (const key of _loadedKeys) {
    delete process.env[key];
  }
  _loadedKeys.length = 0;
}

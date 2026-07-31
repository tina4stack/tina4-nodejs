import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

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
 * Load environment variables from a root DIRECTORY or a single .env file.
 *
 * Pass a **directory** and it loads `<dir>/.env.local` then `<dir>/.env`, both
 * first-wins, which IS the precedence real-env > `.env.local` > `.env`. That is
 * the canonical form in all four frameworks.
 *
 * Before this, the ordering was the CALLER's job and this doc comment was the
 * only place it was written down: load `.env.local` first, then `.env`, both
 * with override=false. Every caller had to remember, and getting it wrong
 * (override=true on `.env.local`) lets a stray gitignored file clobber an
 * explicitly set real env var such as a production TINA4_SECRET. A rule nobody
 * can forget beats a rule written in a comment.
 *
 * A **file** path still works exactly as before: only that file is read, and the
 * caller owns the ordering.
 *
 * By default this does NOT override existing process.env values — it is
 * first-wins, which is how a real env var always beats both files.
 *
 * Resolution order when `path` is omitted:
 *   1. `TINA4_ENV_FILE` env var (if set and non-empty) — the named file, plus
 *      `.env.local` BESIDE it, so pointing at `.env.staging` does not silently
 *      stop honouring local overrides
 *   2. the current working directory, as a root
 *
 * @param path     - A root directory (canonical) OR a path to a single .env file.
 * @param override - When true, overwrite keys already present in process.env.
 * @returns The parsed key-value pairs. For the directory form this is the merge
 *          of both files, with `.env.local` winning on a duplicate key.
 */
export function loadEnv(path?: string, override = false): Record<string, string> {
  const fromEnv = (process.env.TINA4_ENV_FILE ?? "").trim();

  if (path === undefined && fromEnv.length > 0) {
    const named = resolve(fromEnv);
    return mergeFirstWins(
      loadEnvFile(join(dirname(named), ".env.local"), override),
      loadEnvFile(named, override),
    );
  }

  const target = resolve(path ?? ".");
  if (existsSync(target) && statSync(target).isDirectory()) {
    // .env.local FIRST so it beats .env; both first-wins, so a variable already
    // in the real environment still beats both.
    return mergeFirstWins(
      loadEnvFile(join(target, ".env.local"), override),
      loadEnvFile(join(target, ".env"), override),
    );
  }

  return loadEnvFile(target, override);
}

/** Merge two parsed maps, first argument winning on a duplicate key. */
function mergeFirstWins(
  first: Record<string, string>,
  second: Record<string, string>,
): Record<string, string> {
  return { ...second, ...first };
}

/**
 * Load ONE .env file. A missing file is not an error and yields `{}` - a fresh
 * checkout has no `.env.local`, and the directory form reads it unconditionally.
 */
function loadEnvFile(envPath: string, override: boolean): Record<string, string> {
  if (!existsSync(envPath)) {
    return {};
  }

  const content = readFileSync(envPath, "utf-8");
  const parsed = parseEnvContent(content);
  const effective: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed)) {
    // First-wins by default: a variable already in the real environment is
    // never clobbered.
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      _loadedKeys.push(key);
    }
    // Report the value that WON, not the one this file declared. They differ
    // exactly when the real environment beat the file, which is the case an
    // operator most needs to see: reporting the file's value there means the
    // returned map says "from_local" while the process is actually running on
    // "from_REAL". A map that disagrees with process.env is worse than no map,
    // because it looks authoritative.
    effective[key] = process.env[key] as string;
  }

  return effective;
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
/**
 * Validate that required environment variables exist, and return them.
 *
 * Takes VARARGS and returns a map, matching Python, PHP and Ruby. It used to
 * take one key and return that value, so checking five variables meant five
 * calls that each failed on the first problem - an operator fixing a deployment
 * got one name per restart instead of the whole list.
 *
 * @param keys - Variable names that must be set.
 * @returns Every requested key mapped to its value.
 * @throws Error naming ALL missing variables, not just the first.
 */
export function requireEnv(...keys: string[]): Record<string, string> {
  const missing: string[] = [];
  const found: Record<string, string> = {};

  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined) {
      missing.push(key);
      continue;
    }
    found[key] = value;
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return found;
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

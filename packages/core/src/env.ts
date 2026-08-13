/**
 * Typed environment-variable helpers — zero-deps.
 *
 * Reading env vars by hand gets old fast: every boolean flag becomes a
 * `(process.env.X ?? "false").toLowerCase() === "true" || ...` incantation,
 * every numeric tuning knob needs a parseInt + isNaN guard. `Env` centralises
 * that. Same API across all four Tina4 frameworks (`Tina4\Env` in PHP,
 * `Tina4::Env` in Ruby, `Env` in Python).
 *
 *     import { Env } from "@tina4/core";
 *
 *     const debug   = Env.bool("TINA4_DEBUG");                // default false
 *     const workers = Env.int("WORKERS", 4);
 *     const rate    = Env.float("RATE_LIMIT", 10.0);
 *     const region  = Env.str("AWS_REGION", "us-east-1");
 *
 * Values are accepted case-insensitively after `.trim().toLowerCase()`. Truthy:
 * `1 / true / on / yes / y / t`. Falsy: `0 / false / off / no / n / f / ""`.
 * Anything else returns `default`. Unparseable ints/floats log a warning via
 * `Log` (when available) and fall back to `default` — never throw.
 */
const TRUTHY = new Set(["1", "true", "on", "yes", "y", "t"]);
const FALSY = new Set(["0", "false", "off", "no", "n", "f", ""]);

/**
 * Emit a warning via Log without creating a circular import at module load.
 * Log itself depends on env parsing, so we resolve it lazily and swallow any
 * "not yet wired" errors (very early bootstrap, ESM cycle, etc.).
 */
function logWarning(message: string): void {
  try {
    // Lazy import to avoid the env → logger → env cycle.
    // Top-level await isn't usable here (sync API), so we fire-and-forget.
    import("./logger.js")
      .then((mod) => {
        try {
          mod.Log.warning(message);
        } catch {
          /* Log not ready — skip */
        }
      })
      .catch(() => {
        /* Module not yet loadable — skip */
      });
  } catch {
    /* Defensive — never let logging break the caller */
  }
}

/**
 * Typed environment-variable helpers.
 *
 * All methods are static so callers can write `Env.bool(...)` without
 * instantiating anything — matching the Python/PHP/Ruby ports.
 */
export class Env {
  /**
   * Read `name` and coerce to bool.
   *
   * Truthy values (case-insensitive after trim): `1`, `true`, `on`, `yes`,
   * `y`, `t`. Falsy: `0`, `false`, `off`, `no`, `n`, `f`, empty string.
   * Anything else returns the `defaultValue` — never throws.
   */
  static bool(name: string, defaultValue = false): boolean {
    const raw = process.env[name];
    if (raw === undefined) return defaultValue;
    const token = raw.trim().toLowerCase();
    if (TRUTHY.has(token)) return true;
    if (FALSY.has(token)) return false;
    return defaultValue;
  }

  /** Read `name` and coerce to int. Returns `defaultValue` on parse failure. */
  static int(name: string, defaultValue = 0): number {
    const raw = process.env[name];
    if (raw === undefined) return defaultValue;
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isNaN(parsed)) {
      logWarning(
        `Env.int(${JSON.stringify(name)}): could not parse ${JSON.stringify(raw)} as int — using default ${defaultValue}`,
      );
      return defaultValue;
    }
    return parsed;
  }

  /** Read `name` and coerce to float. Returns `defaultValue` on parse failure. */
  static float(name: string, defaultValue = 0.0): number {
    const raw = process.env[name];
    if (raw === undefined) return defaultValue;
    const parsed = Number.parseFloat(raw.trim());
    if (Number.isNaN(parsed)) {
      logWarning(
        `Env.float(${JSON.stringify(name)}): could not parse ${JSON.stringify(raw)} as float — using default ${defaultValue}`,
      );
      return defaultValue;
    }
    return parsed;
  }

  /**
   * Read `name` as a string. Returns `defaultValue` if unset.
   *
   * Whitespace is preserved — this is a pass-through for the raw env value.
   * `Env.str("PATH")` is exactly `process.env.PATH ?? ""` with a more
   * discoverable name.
   */
  static str(name: string, defaultValue = ""): string {
    const raw = process.env[name];
    if (raw === undefined) return defaultValue;
    return raw;
  }
}

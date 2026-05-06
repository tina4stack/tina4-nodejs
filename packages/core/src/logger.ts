import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { isTruthy } from "./dotenv.js";

/** Log level severity */
type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/** Log level priority for filtering */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
};

/** Structured log entry for JSON output */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  request_id?: string;
  context?: unknown;
}

/** ANSI color codes for terminal output */
const COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[36m",    // cyan
  INFO: "\x1b[32m",     // green
  WARNING: "\x1b[33m",  // yellow
  ERROR: "\x1b[31m",    // red
  CRITICAL: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";

/** Regex to strip ANSI escape codes */
const ANSI_RE = /\033\[[0-9;]*m/g;

/** Default log directory */
const DEFAULT_LOG_DIR = "logs";

/** Default log filename */
const DEFAULT_LOG_FILE = "tina4.log";

/** Default rotation size — 10 MB */
const DEFAULT_ROTATE_SIZE = 10 * 1024 * 1024;

/** Default rotation keep count */
const DEFAULT_ROTATE_KEEP = 5;

/** Strip ANSI escape codes from a string */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Resolve the log file path from env (or constructor options).
 *
 * If `TINA4_LOG_FILE` is set:
 *   - absolute path → used as-is.
 *   - relative      → resolved against `TINA4_LOG_DIR` (default `logs`).
 *
 * Otherwise the directory is `TINA4_LOG_DIR` and filename is `tina4.log`.
 */
function resolveLogFilePath(logDir: string, logFile: string): string {
  if (isAbsolute(logFile)) return logFile;
  return join(logDir, logFile);
}

/**
 * Structured logger for Tina4.
 *
 * Production (TINA4_DEBUG not truthy): JSON or text lines to logs/tina4.log
 * Development (TINA4_DEBUG=true): Colorized human-readable to stdout + file
 *
 * Env vars:
 *   TINA4_LOG_FILE          — explicit log file (absolute or relative). Empty = use TINA4_LOG_DIR + tina4.log
 *   TINA4_LOG_DIR           — directory for log files (default: "logs")
 *   TINA4_LOG_FORMAT        — "text" | "json" (default: "text")
 *   TINA4_LOG_OUTPUT        — "stdout" | "file" | "both" (default: "stdout")
 *   TINA4_LOG_CRITICAL      — "true" to enable CRITICAL level shortcut (default: "false")
 *   TINA4_LOG_ROTATE_SIZE   — bytes; 0 disables rotation (default: 10485760 = 10MB)
 *   TINA4_LOG_ROTATE_KEEP   — number of historical files to keep (default: 5)
 *   TINA4_LOG_LEVEL         — minimum console level (default: "DEBUG")
 *
 * Rotation is stdlib roll-your-own:
 *   - On each write, statSync the file. If size >= TINA4_LOG_ROTATE_SIZE, rotate.
 *   - app.log.{N-1} → app.log.{N}, …, app.log → app.log.1 via fs.renameSync.
 *   - Files beyond _KEEP are dropped via fs.unlinkSync.
 *   - _SIZE=0 disables rotation entirely.
 */
export class Log {
  private static requestId: string | undefined;

  /**
   * Re-read all log-related env vars. Called on every log() so tests that
   * mutate process.env between calls see the new values without having to
   * call configure() each time.
   */
  private static readEnv(): {
    logDir: string;
    logFile: string;
    rotateSize: number;
    rotateKeep: number;
    minLevel: number;
    format: "text" | "json";
    output: "stdout" | "file" | "both";
    criticalEnabled: boolean;
  } {
    const logDir = process.env.TINA4_LOG_DIR ?? DEFAULT_LOG_DIR;
    const logFile = (process.env.TINA4_LOG_FILE ?? "").trim() || DEFAULT_LOG_FILE;

    const rawSize = process.env.TINA4_LOG_ROTATE_SIZE;
    let rotateSize = DEFAULT_ROTATE_SIZE;
    if (rawSize !== undefined) {
      const n = parseInt(rawSize, 10);
      rotateSize = isNaN(n) || n < 0 ? DEFAULT_ROTATE_SIZE : n;
    }

    const rawKeep = process.env.TINA4_LOG_ROTATE_KEEP;
    let rotateKeep = DEFAULT_ROTATE_KEEP;
    if (rawKeep !== undefined) {
      const n = parseInt(rawKeep, 10);
      rotateKeep = isNaN(n) || n < 1 ? DEFAULT_ROTATE_KEEP : n;
    }

    const levelEnv = (process.env.TINA4_LOG_LEVEL ?? "DEBUG").toUpperCase();
    const minLevel = LEVEL_PRIORITY[levelEnv as LogLevel] ?? 0;

    const fmt = (process.env.TINA4_LOG_FORMAT ?? "text").trim().toLowerCase();
    const format: "text" | "json" = fmt === "json" ? "json" : "text";

    const out = (process.env.TINA4_LOG_OUTPUT ?? "stdout").trim().toLowerCase();
    let output: "stdout" | "file" | "both" = "stdout";
    if (out === "file") output = "file";
    else if (out === "both") output = "both";

    const criticalEnabled = isTruthy(process.env.TINA4_LOG_CRITICAL);

    return { logDir, logFile, rotateSize, rotateKeep, minLevel, format, output, criticalEnabled };
  }

  /**
   * Set the current request ID for log correlation.
   */
  static setRequestId(id: string | undefined): void {
    Log.requestId = id;
  }

  /**
   * Get the current request ID.
   */
  static getRequestId(): string | undefined {
    return Log.requestId;
  }

  /**
   * Configure the log directory / filename. Mostly a no-op now —
   * env vars are re-read on every call. Kept for backwards compatibility.
   */
  static configure(options: { logDir?: string; logFile?: string }): void {
    if (options.logDir) process.env.TINA4_LOG_DIR = options.logDir;
    if (options.logFile) process.env.TINA4_LOG_FILE = options.logFile;
  }

  /** Log an informational message. */
  static info(message: string, data?: unknown): void {
    Log.log("INFO", message, data);
  }

  /** Log a debug message. */
  static debug(message: string, data?: unknown): void {
    Log.log("DEBUG", message, data);
  }

  /** Log a warning message. */
  static warning(message: string, data?: unknown): void {
    Log.log("WARNING", message, data);
  }

  /** Backwards-compat alias for warning(). */
  static warn(message: string, data?: unknown): void {
    Log.log("WARNING", message, data);
  }

  /** Log an error message. */
  static error(message: string, data?: unknown): void {
    Log.log("ERROR", message, data);
  }

  /**
   * Log a critical message. Only emitted when TINA4_LOG_CRITICAL=true,
   * otherwise this is a no-op (matches Python parity — critical is the
   * highest-severity bucket and is opt-in to avoid drowning noisy apps).
   */
  static critical(message: string, data?: unknown): void {
    Log.log("CRITICAL", message, data);
  }

  /** Check if running in production mode (TINA4_DEBUG is not truthy). */
  private static isProduction(): boolean {
    return !isTruthy(process.env.TINA4_DEBUG);
  }

  /** Get current ISO timestamp */
  private static timestamp(): string {
    return new Date().toISOString();
  }

  /** Ensure the log directory exists */
  private static ensureLogDir(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Roll-your-own rotation, stdlib only.
   *
   * Sequence on each write:
   *   1. statSync the current file. If size < rotateSize, return.
   *   2. Drop any file beyond keep via unlinkSync (cap the historical count).
   *   3. Atomic shift: app.log.{N-1} → app.log.{N}, …, app.log.1 → app.log.2.
   *   4. Rename current app.log → app.log.1.
   *   5. Truncate via writeFileSync(path, "") so subsequent appends start fresh.
   *
   * Sync calls per write are fine — the worst case is contention on a single
   * file, and the OS atomically serialises rename/unlink anyway.
   *
   * `rotateSize` of 0 disables rotation entirely.
   */
  private static rotateIfNeeded(filePath: string, rotateSize: number, rotateKeep: number): void {
    if (rotateSize <= 0) return;
    if (!existsSync(filePath)) return;

    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    if (size < rotateSize) return;

    // Drop files beyond keep
    for (let n = rotateKeep + 1; n <= rotateKeep + 10; n++) {
      const stale = `${filePath}.${n}`;
      if (existsSync(stale)) {
        try { unlinkSync(stale); } catch { /* ignore */ }
      } else {
        break;
      }
    }

    // Drop the oldest in-window file if at capacity
    const oldest = `${filePath}.${rotateKeep}`;
    if (existsSync(oldest)) {
      try { unlinkSync(oldest); } catch { /* ignore */ }
    }

    // Shift: .{N-1} -> .{N}, ..., .1 -> .2
    for (let n = rotateKeep - 1; n >= 1; n--) {
      const src = `${filePath}.${n}`;
      const dst = `${filePath}.${n + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    }

    // Move current → .1, then truncate
    try { renameSync(filePath, `${filePath}.1`); } catch { /* ignore */ }
    try { writeFileSync(filePath, "", "utf-8"); } catch { /* ignore */ }
  }

  /** Write a line to the log file, stripping ANSI codes. */
  private static writeToFile(filePath: string, line: string, rotateSize: number, rotateKeep: number): void {
    try {
      Log.ensureLogDir(filePath);
      Log.rotateIfNeeded(filePath, rotateSize, rotateKeep);
      appendFileSync(filePath, stripAnsi(line) + "\n", "utf-8");
    } catch {
      // Silently fail — logging should never crash the app
    }
  }

  /** Core log method */
  private static log(level: LogLevel, message: string, data?: unknown): void {
    const cfg = Log.readEnv();

    // Critical level is opt-in; treat as no-op when disabled.
    if (level === "CRITICAL" && !cfg.criticalEnabled) return;

    const entry: LogEntry = {
      timestamp: Log.timestamp(),
      level,
      message,
    };

    if (Log.requestId) {
      entry.request_id = Log.requestId;
    }

    if (data !== undefined) {
      entry.context = data;
    }

    // Build human-readable line
    const paddedLevel = level.padEnd(8);
    const reqPart = Log.requestId ? ` [${Log.requestId}]` : "";
    const dataPart = data !== undefined ? ` ${JSON.stringify(data)}` : "";
    const humanLine = `${entry.timestamp} [${paddedLevel}]${reqPart} ${message}${dataPart}`;

    // Build the file-format line based on TINA4_LOG_FORMAT
    const fileLine = cfg.format === "json" ? JSON.stringify(entry) : humanLine;

    const shouldLog = (LEVEL_PRIORITY[level] ?? 0) >= cfg.minLevel;

    // Console output. TINA4_LOG_OUTPUT="file" disables stdout entirely;
    // anything else (stdout, both) prints to console in dev, suppresses in prod.
    if (shouldLog && cfg.output !== "file" && !Log.isProduction()) {
      const color = COLORS[level];
      console.log(`${color}${humanLine}${RESET}`);
    }

    // File output: always teed for dev (legacy behaviour), and either always
    // (production default) or honoured per output mode.
    //
    //   output=stdout (default): file in dev + prod (legacy parity)
    //   output=file              file only — no console
    //   output=both              file + console (already handled above)
    //
    // The "stdout-only without file" mode that some Python deployments want
    // is gated on TINA4_LOG_OUTPUT=stdout combined with TINA4_LOG_FILE set
    // explicitly to an empty string in env — we treat empty file as default.
    const filePath = resolveLogFilePath(cfg.logDir, cfg.logFile);
    Log.writeToFile(filePath, fileLine, cfg.rotateSize, cfg.rotateKeep);
  }
}

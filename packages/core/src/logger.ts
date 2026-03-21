import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { isTruthy } from "./dotenv.js";

/** Log level severity */
type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

/** Log level priority for filtering */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
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
  DEBUG: "\x1b[36m",   // cyan
  INFO: "\x1b[32m",    // green
  WARNING: "\x1b[33m", // yellow
  ERROR: "\x1b[31m",   // red
};
const RESET = "\x1b[0m";

/** Regex to strip ANSI escape codes */
const ANSI_RE = /\033\[[0-9;]*m/g;

/** Default log directory */
const DEFAULT_LOG_DIR = "logs";

/** Default log filename */
const DEFAULT_LOG_FILE = "tina4.log";

/** Strip ANSI escape codes from a string */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Structured logger for Tina4.
 *
 * Production (TINA4_DEBUG not truthy): JSON lines to logs/tina4.log
 * Development (TINA4_DEBUG=true): Colorized human-readable to stdout + file
 *
 * Log rotation: numbered scheme (tina4.log -> tina4.log.1 -> ... -> tina4.log.{keep})
 * Raw log file always writes ALL levels (no filtering), plain text (no ANSI codes).
 * Console output respects TINA4_LOG_LEVEL.
 */
export class Log {
  private static requestId: string | undefined;
  private static logDir: string = DEFAULT_LOG_DIR;
  private static logFile: string = DEFAULT_LOG_FILE;
  private static maxFileSize: number = 10 * 1024 * 1024;
  private static keepFiles: number = 5;
  private static minLevel: number = 0;

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
   * Configure the log directory, filename, and rotation settings.
   */
  static configure(options: { logDir?: string; logFile?: string }): void {
    if (options.logDir) Log.logDir = options.logDir;
    if (options.logFile) Log.logFile = options.logFile;

    // Read rotation config from env (with defaults)
    const maxSizeMb = parseInt(process.env.TINA4_LOG_MAX_SIZE ?? "10", 10);
    Log.maxFileSize = (isNaN(maxSizeMb) ? 10 : maxSizeMb) * 1024 * 1024;
    const keep = parseInt(process.env.TINA4_LOG_KEEP ?? "5", 10);
    Log.keepFiles = isNaN(keep) ? 5 : keep;

    // Resolve minimum console log level
    const levelEnv = (process.env.TINA4_LOG_LEVEL ?? "DEBUG").toUpperCase();
    Log.minLevel = LEVEL_PRIORITY[levelEnv as LogLevel] ?? 0;
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

  /** Log an error message. */
  static error(message: string, data?: unknown): void {
    Log.log("ERROR", message, data);
  }

  /** Check if running in production mode (TINA4_DEBUG is not truthy). */
  private static isProduction(): boolean {
    return !isTruthy(process.env.TINA4_DEBUG);
  }

  /** Get current ISO timestamp */
  private static timestamp(): string {
    return new Date().toISOString();
  }

  /** Get the full path to the current log file */
  private static logFilePath(): string {
    return join(Log.logDir, Log.logFile);
  }

  /** Ensure the log directory exists */
  private static ensureLogDir(): void {
    const dir = dirname(Log.logFilePath());
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Rotate using numbered scheme: tina4.log.{keep} is deleted, all others shift up by 1.
   */
  private static rotateIfNeeded(): void {
    const filePath = Log.logFilePath();
    if (!existsSync(filePath)) return;

    try {
      const stats = statSync(filePath);
      if (stats.size < Log.maxFileSize) return;
    } catch {
      return;
    }

    const keep = Log.keepFiles;

    // Delete the oldest rotated file if it exists
    const oldest = `${filePath}.${keep}`;
    if (existsSync(oldest)) {
      try { unlinkSync(oldest); } catch { /* ignore */ }
    }

    // Shift existing rotated files: .{n} -> .{n+1}
    for (let n = keep - 1; n >= 1; n--) {
      const src = `${filePath}.${n}`;
      const dst = `${filePath}.${n + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    }

    // Rename current log to .1
    try { renameSync(filePath, `${filePath}.1`); } catch { /* ignore */ }
  }

  /** Write a line to the log file, stripping ANSI codes */
  private static writeToFile(line: string): void {
    try {
      Log.ensureLogDir();
      Log.rotateIfNeeded();
      appendFileSync(Log.logFilePath(), stripAnsi(line) + "\n", "utf-8");
    } catch {
      // Silently fail — logging should never crash the app
    }
  }

  /** Core log method */
  private static log(level: LogLevel, message: string, data?: unknown): void {
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

    // Build human-readable line for file/console
    const paddedLevel = level.padEnd(7);
    const reqPart = Log.requestId ? ` [${Log.requestId}]` : "";
    const dataPart = data !== undefined ? ` ${JSON.stringify(data)}` : "";
    const humanLine = `${entry.timestamp} [${paddedLevel}]${reqPart} ${message}${dataPart}`;

    // Console output respects TINA4_LOG_LEVEL
    const shouldLog = (LEVEL_PRIORITY[level] ?? 0) >= Log.minLevel;
    if (!Log.isProduction() && shouldLog) {
      const color = COLORS[level];
      console.log(`${color}${humanLine}${RESET}`);
    }

    // File always gets ALL levels (raw log, no filtering), plain text (no ANSI)
    Log.writeToFile(humanLine);
  }
}

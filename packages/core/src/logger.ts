import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";

/** Log level severity */
type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

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

/** Maximum log file size before rotation (10MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Default log directory */
const DEFAULT_LOG_DIR = "logs";

/** Default log filename */
const DEFAULT_LOG_FILE = "tina4.log";

/**
 * Structured logger for Tina4.
 *
 * Production (TINA4_ENV=production): JSON lines to logs/tina4.log
 * Development: Colorized human-readable to stdout + file
 * Supports log rotation by date and size (10MB).
 */
export class Log {
  private static requestId: string | undefined;
  private static logDir: string = DEFAULT_LOG_DIR;
  private static logFile: string = DEFAULT_LOG_FILE;

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
   * Configure the log directory and filename.
   */
  static configure(options: { logDir?: string; logFile?: string }): void {
    if (options.logDir) Log.logDir = options.logDir;
    if (options.logFile) Log.logFile = options.logFile;
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

  /** Check if running in production mode. */
  private static isProduction(): boolean {
    return process.env.TINA4_ENV === "production" || process.env.NODE_ENV === "production";
  }

  /** Get today's date string for rotation: YYYY-MM-DD */
  private static dateString(): string {
    return new Date().toISOString().slice(0, 10);
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
   * Rotate the log file if it exceeds MAX_FILE_SIZE.
   * Renames the current file to tina4-YYYY-MM-DD-N.log
   */
  private static rotateIfNeeded(): void {
    const filePath = Log.logFilePath();
    if (!existsSync(filePath)) return;

    try {
      const stats = statSync(filePath);
      if (stats.size >= MAX_FILE_SIZE) {
        const date = Log.dateString();
        const baseName = Log.logFile.replace(/\.log$/, "");
        let counter = 1;
        let rotatedPath: string;
        do {
          rotatedPath = join(Log.logDir, `${baseName}-${date}-${counter}.log`);
          counter++;
        } while (existsSync(rotatedPath));
        renameSync(filePath, rotatedPath);
      }
    } catch {
      // If we can't stat or rename, just continue writing
    }
  }

  /** Write a line to the log file */
  private static writeToFile(line: string): void {
    try {
      Log.ensureLogDir();
      Log.rotateIfNeeded();
      appendFileSync(Log.logFilePath(), line + "\n", "utf-8");
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

    const jsonLine = JSON.stringify(entry);

    if (Log.isProduction()) {
      // Production: JSON lines to file only
      Log.writeToFile(jsonLine);
    } else {
      // Development: colorized stdout + file
      const color = COLORS[level];
      const paddedLevel = level.padEnd(7);
      const reqPart = Log.requestId ? ` [${Log.requestId}]` : "";
      const dataPart = data !== undefined ? ` ${JSON.stringify(data)}` : "";
      const humanLine = `${color}${entry.timestamp} [${paddedLevel}]${reqPart} ${message}${dataPart}${RESET}`;
      console.log(humanLine);
      Log.writeToFile(jsonLine);
    }
  }
}

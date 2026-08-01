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
  function?: string;
  context?: unknown;
}

/**
 * Log frames we walk past when looking for the real caller of a Log.* call.
 * Mirrors Python's `_OWN_FRAMES`. Anything matching is treated as internal.
 */
const OWN_FRAMES = new Set<string>([
  "log", "Log.log",
  "callerName", "Log.callerName",
  "info", "debug", "warning", "warn", "error", "critical",
  "Log.info", "Log.debug", "Log.warning", "Log.warn", "Log.error", "Log.critical",
]);

/** V8 stack-trace markers that mean "no real function name". */
const ANON_NAMES = new Set<string>(["", "anonymous", "<anonymous>"]);

/**
 * Return the function name that called Log.{info,debug,warning,error}.
 *
 * Active only when `TINA4_LOG_FUNC=true` — captures `new Error().stack`,
 * walks past Log's own frames (info / warn / error / debug / log /
 * callerName) and returns the first user function name. Anonymous frames
 * (`anonymous`, `<anonymous>`, bare file paths) are filtered out as noise.
 * Returns undefined on any error — never throws. Parity feature #41 across
 * all four Tina4 frameworks.
 */
function callerName(): string | undefined {
  // Read the env directly (not via Env.bool) to keep the logger ↔ env cycle
  // one-way: env helpers depend on Log, not the other way around.
  const raw = (process.env.TINA4_LOG_FUNC ?? "").trim().toLowerCase();
  if (raw !== "1" && raw !== "true" && raw !== "on" && raw !== "yes" && raw !== "y" && raw !== "t") {
    return undefined;
  }
  try {
    const stack = new Error().stack;
    if (!stack) return undefined;
    const lines = stack.split("\n");
    // Skip line 0 ("Error") and walk frames. Cap at 32 to defend against
    // pathological recursion / wrapper stacks.
    for (let i = 1; i < lines.length && i < 32; i++) {
      const line = lines[i];
      // V8 frame: "    at functionName (file:line:col)"
      //        or "    at file:line:col"           (anonymous)
      //        or "    at async functionName (...)"
      const m = line.match(/^\s+at\s+(?:async\s+)?([^\s(]+)\s*\(/);
      if (!m) continue;
      const name = m[1];
      // Strip the leading `Object.` / class prefix some V8s emit, then check.
      const bare = name.includes(".") ? name.split(".").pop()! : name;
      if (OWN_FRAMES.has(name) || OWN_FRAMES.has(bare)) continue;
      if (ANON_NAMES.has(bare)) continue;
      return bare;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
const ANSI_RE = /\x1b\[[0-9;]*m/g;

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
// The logger must never be surprised by what it is handed, and must never be
// the reason a request dies. Same numbers in all four frameworks (feature 2).
const STDOUT_MAX_CHARS = 2000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Turn anything into a single safe line of text.
 *
 * A string passes through. A Buffer is decoded when it is valid UTF-8 and
 * described when it is not: raw bytes at a terminal garble it and can emit
 * escape sequences. Anything else becomes JSON, because an object rendered as
 * text is the whole reason the caller logged it, falling back to String() for a
 * value JSON cannot represent (a circular reference, a BigInt). Without this an
 * object logged as a message reached the output as "[object Object]".
 */
function coerceMessage(message: unknown): string {
  let text: string;
  if (typeof message === "string") {
    text = message;
  } else if (message instanceof Uint8Array) {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(message);
    text = decoded.includes("�") ? `<binary ${message.byteLength} bytes>` : decoded;
  } else if (message === null || message === undefined) {
    text = "";
  } else if (typeof message === "object") {
    try {
      text = JSON.stringify(message) ?? String(message);
    } catch {
      text = String(message);
    }
  } else {
    text = String(message);
  }
  return text.replace(CONTROL_CHARS, "");
}

/** Cap a console line. The file keeps the whole thing; a terminal does not. */
function truncateForStdout(line: string): string {
  if (line.length <= STDOUT_MAX_CHARS) return line;
  return `${line.slice(0, STDOUT_MAX_CHARS)}... (truncated, ${line.length} chars)`;
}

/**
 * Is this target a FILE PATH or a DIRECTORY?
 *
 * An existing directory is always a directory, extension or not. Otherwise a
 * basename with an extension (app.log, app.txt) is a file and anything else is
 * a directory to create. That keeps `configure("/var/log/myapp")` a directory
 * and `configure("/var/log/myapp/app.log")` a file without the path needing to
 * exist yet. Identical rule in all four frameworks.
 */
function targetIsFile(path: string): boolean {
  try {
    if (existsSync(path) && statSync(path).isDirectory()) return false;
  } catch { /* fall through to the extension test */ }
  const base = path.split(/[\\/]/).pop() ?? "";
  return base.includes(".") && !base.startsWith(".");
}

function resolveLogFilePath(logDir: string, logFile: string): string {
  if (isAbsolute(logFile)) return logFile;
  return join(logDir, logFile);
}

/**
 * Structured logger for Tina4.
 *
 * FORMAT IS TEXT BY DEFAULT, and TINA4_LOG_FORMAT=json is the ONLY thing that
 * selects JSON. Nothing else may. Until 3.13.95 an unset TINA4_DEBUG silently
 * flipped BOTH sinks to JSON here, and "production" meant four different things
 * across the four frameworks (Node: !TINA4_DEBUG; Ruby: TINA4_ENV/RACK_ENV/
 * RUBY_ENV == "production"; Python: only configure(production=True); PHP: no
 * switch at all, JSON always) — same machine, same .env, four log formats. That
 * implicit switch is deleted; an object passed as the message is still
 * JSON-encoded INLINE inside the text line, which is the only JSON a default
 * install emits.
 *
 * TINA4_DEBUG still decides COLOUR — a terminal concern, not a format one — so
 * a production pipe gets clean uncoloured bytes and a dev terminal stays
 * readable.
 *
 * Default file-output rule (TINA4_LOG_OUTPUT unset): the log FILE is written
 * only in development. An explicit TINA4_LOG_OUTPUT=file/both, OR an explicit
 * TINA4_LOG_FILE path, always forces a file (explicit wins). stdout is ALWAYS on.
 *
 * Env vars:
 *   TINA4_LOG_FILE          — explicit log file (absolute or relative). Setting it forces a file even in production. Empty = use TINA4_LOG_DIR + tina4.log
 *   TINA4_LOG_DIR           — directory for log files (default: "logs")
 *   TINA4_LOG_FORMAT        — "text" | "json" (default: "text") — the ONLY format switch
 *   TINA4_LOG_OUTPUT        — "stdout" | "file" | "both" (default: "stdout" → file only in dev)
 *   TINA4_LOG_ROTATE_SIZE   — bytes; 0 disables rotation (default: 10485760 = 10MB)
 *   TINA4_LOG_ROTATE_KEEP   — number of historical files to keep (default: 5)
 *   TINA4_LOG_LEVEL         — minimum console level: DEBUG | INFO | WARNING | ERROR | CRITICAL (default: "INFO")
 *   TINA4_LOG_STRICT        — truthy: a log-write failure THROWS instead of being swallowed (default: off)
 *
 * Every one of these is read LAZILY, on each log() call — a script, worker, CLI
 * tool or test that never boots a server still gets the operator's configuration.
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
    fileEnabled: boolean;
    /** True when the operator named ONE file, so no error.log sibling appears. */
    explicitFile: boolean;
    /** TINA4_LOG_STRICT — a failed log write throws instead of being swallowed. */
    strict: boolean;
  } {
    const logDir = process.env.TINA4_LOG_DIR ?? DEFAULT_LOG_DIR;
    const explicitFile = (process.env.TINA4_LOG_FILE ?? "").trim();
    const logFile = explicitFile || DEFAULT_LOG_FILE;

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

    // v3.13.14: default level INFO (was DEBUG) — parity with Python/PHP/Ruby;
    // surfaces request/startup/warn/error without debug noise in deploys.
    const levelEnv = (process.env.TINA4_LOG_LEVEL ?? "INFO").toUpperCase();
    const minLevel = LEVEL_PRIORITY[levelEnv as LogLevel] ?? 0;

    const fmt = (process.env.TINA4_LOG_FORMAT ?? "text").trim().toLowerCase();
    const format: "text" | "json" = fmt === "json" ? "json" : "text";

    const out = (process.env.TINA4_LOG_OUTPUT ?? "stdout").trim().toLowerCase();
    let output: "stdout" | "file" | "both" = "stdout";
    if (out === "file") output = "file";
    else if (out === "both") output = "both";

    // v3.13.39: dev/prod-aware default file output (Python master, 4c6d881).
    // When TINA4_LOG_OUTPUT is unset (default "stdout"), the log FILE is written
    // only in development (TINA4_DEBUG truthy). In production / containers the
    // logger is stdout-only — writing logs/tina4.log inside a container just
    // bloats the writable layer + disk, and 12-factor wants logs on stdout for
    // the platform to capture. Explicit TINA4_LOG_OUTPUT=file/both OR an explicit
    // TINA4_LOG_FILE path always wins (explicit forces a file regardless of env).
    let fileEnabled: boolean;
    if (output === "file" || output === "both") {
      fileEnabled = true;
    } else if (explicitFile !== "") {
      fileEnabled = true;
    } else {
      fileEnabled = !Log.isProduction();
    }

    // TINA4_LOG_STRICT — documented on all four env-var pages, implemented only
    // in Ruby until 3.13.95: a documented no-op in three frameworks. When truthy
    // a log-write failure THROWS instead of being swallowed, so a deploy whose
    // log directory is read-only fails loudly instead of running blind.
    const strict = isTruthy(process.env.TINA4_LOG_STRICT);

    return {
      logDir, logFile, rotateSize, rotateKeep, minLevel, format, output, fileEnabled,
      explicitFile: explicitFile !== "",
      strict,
    };
  }

  /**
   * The single console-threshold predicate: does a message at `level` clear
   * the configured minimum console level? This is the ONE place level
   * comparison lives — both the live log() gate and the public isEnabled()
   * predicate call it, so they can never disagree about what actually prints.
   */
  private static passesThreshold(level: LogLevel, minLevel: number): boolean {
    return (LEVEL_PRIORITY[level] ?? 0) >= minLevel;
  }

  /**
   * Return true if a message at `level` would pass the configured minimum
   * console level (TINA4_LOG_LEVEL) — the same threshold that gates stdout.
   *
   * This reflects CONSOLE (stdout) visibility only. The log file always
   * records every level regardless of this threshold, so don't use it to
   * decide whether something gets persisted — use it to skip building an
   * expensive payload that would not be shown:
   *
   *     if (Log.isEnabled("debug")) {
   *       Log.debug("state", expensiveSnapshot());
   *     }
   *
   * `level` is case-insensitive. "critical" is the highest severity (priority
   * 4 > error 3) and flows through the ordinary threshold check like every
   * other level — there is no toggle. It reuses the same passesThreshold()
   * check the logger itself uses, so it never drifts from what print does.
   */
  static isEnabled(level: string): boolean {
    const cfg = Log.readEnv();
    const lvl = (level ?? "").toUpperCase() as LogLevel;
    return Log.passesThreshold(lvl, cfg.minLevel);
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
   * Configure where logs are written.
   *
   * Logs land in a `logs/` folder by default. The argument OVERRIDES that, and
   * it accepts a DIRECTORY or a FILE PATH:
   *
   *   configure()                              -> ./logs/tina4.log + ./logs/error.log
   *   configure("/var/log/myapp")              -> /var/log/myapp/tina4.log + error.log
   *   configure("/var/log/myapp/app.log")      -> that exact file (no error.log sibling)
   *   configure({ logDir, logFile })           -> the explicit object form still works
   *
   * A plain string used to be accepted and silently ignored, because only the
   * object form was read - so the call that works in the other three
   * frameworks produced no log file here and said nothing (feature 2 of the
   * audit, D4). Both forms now work.
   */
  static configure(options?: string | { logDir?: string; logFile?: string }): void {
    if (typeof options === "string") {
      if (targetIsFile(options)) {
        process.env.TINA4_LOG_DIR = dirname(options);
        process.env.TINA4_LOG_FILE = options;
      } else {
        process.env.TINA4_LOG_DIR = options;
      }
      Log.applyAppendMode();
      return;
    }
    if (options) {
      if (options.logDir) process.env.TINA4_LOG_DIR = options.logDir;
      if (options.logFile) process.env.TINA4_LOG_FILE = options.logFile;
    }
    Log.applyAppendMode();
  }

  /**
   * TINA4_LOG_APPEND — append (default) or overwrite on startup.
   *
   * APPEND IS THE DEFAULT: a log you can lose by restarting the process is not
   * a log. Set it false for one file per run (a short CLI, a test fixture, a
   * container shipping logs elsewhere); the files are truncated once here at
   * configure time, never per line.
   */
  private static applyAppendMode(): void {
    const raw = process.env.TINA4_LOG_APPEND;
    const append = raw === undefined || isTruthy(raw);
    if (append) return;
    const cfg = Log.readEnv();
    const targets = cfg.explicitFile
      ? [resolveLogFilePath(cfg.logDir, cfg.logFile)]
      : [resolveLogFilePath(cfg.logDir, cfg.logFile), join(cfg.logDir, "error.log")];
    for (const path of targets) {
      try {
        if (existsSync(path)) writeFileSync(path, "", "utf-8");
      } catch (err) {
        // Same TINA4_LOG_STRICT contract as writeToFile: this IS a write to the
        // log file, so under strict it must not be swallowed either.
        if (cfg.strict) throw err;
        /* logging must never crash the app */
      }
    }
  }

  /** Log an informational message. */
  static info(message: unknown, data?: unknown): void {
    Log.log("INFO", message, data);
  }

  /** Log a debug message. */
  static debug(message: unknown, data?: unknown): void {
    Log.log("DEBUG", message, data);
  }

  /** Log a warning message. */
  static warning(message: unknown, data?: unknown): void {
    Log.log("WARNING", message, data);
  }

  /** Backwards-compat alias for warning(). */
  static warn(message: unknown, data?: unknown): void {
    Log.log("WARNING", message, data);
  }

  /** Log an error message. */
  static error(message: unknown, data?: unknown): void {
    Log.log("ERROR", message, data);
  }

  /**
   * Log a critical message. CRITICAL is the highest severity (priority 4 >
   * error 3) and ALWAYS emits like every other level — subject only to the
   * console threshold, which it always passes at normal levels — and is always
   * persisted to the log file (Node tees every level to a single tina4.log;
   * critical 4 >= warning 2 so it would be in error.log on a split-file model).
   * Matches Python master parity — there is no enable toggle.
   */
  static critical(message: unknown, data?: unknown): void {
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

  /**
   * Write a line to the log file, stripping ANSI codes.
   *
   * A failure is swallowed by default — logging must never crash the app. With
   * TINA4_LOG_STRICT truthy it is RE-THROWN instead: an app that believes it is
   * writing an audit trail into a read-only directory, and is not, is worse off
   * than one that dies at the first line. Same contract in all four frameworks.
   */
  private static writeToFile(
    filePath: string,
    line: string,
    rotateSize: number,
    rotateKeep: number,
    strict: boolean,
  ): void {
    try {
      Log.ensureLogDir(filePath);
      Log.rotateIfNeeded(filePath, rotateSize, rotateKeep);
      appendFileSync(filePath, stripAnsi(line) + "\n", "utf-8");
    } catch (err) {
      if (strict) throw err;
      // Silently fail — logging should never crash the app
    }
  }

  /** Core log method */
  private static log(level: LogLevel, rawMessage: unknown, data?: unknown): void {
    const cfg = Log.readEnv();

    // Coerce FIRST, into the local the human line is built from further down.
    // Anything can arrive as a message: an object from a handler, a Buffer off
    // a socket, a 10MB string. See coerceMessage.
    const message = coerceMessage(rawMessage);

    const entry: LogEntry = {
      timestamp: Log.timestamp(),
      level,
      message,
    };

    if (Log.requestId) {
      entry.request_id = Log.requestId;
    }

    // Caller-name injection — opt-in via TINA4_LOG_FUNC=true. Off by default
    // so existing log output stays byte-identical for users who haven't asked
    // for it. Parity feature across all four Tina4 frameworks.
    const fnName = callerName();
    if (fnName) {
      entry.function = fnName;
    }

    if (data !== undefined) {
      entry.context = data;
    }

    // Build human-readable line
    const paddedLevel = level.padEnd(8);
    const reqPart = Log.requestId ? ` [${Log.requestId}]` : "";
    const fnPart = fnName ? ` [${fnName}]` : "";
    const dataPart = data !== undefined ? ` ${JSON.stringify(data)}` : "";
    const humanLine = `${entry.timestamp} [${paddedLevel}]${reqPart}${fnPart} ${message}${dataPart}`;

    // ONE format decision, both sinks, one input: TINA4_LOG_FORMAT. Text is the
    // default; only an explicit `json` selects JSON. The `|| Log.isProduction()`
    // that used to live here made an UNSET TINA4_DEBUG silently reformat every
    // line — the owner's measured defect (four frameworks, four meanings of
    // "production", four different formats off one .env). An object passed as
    // the message is still JSON-encoded INLINE by coerceMessage, which is the
    // only structure a default install emits.
    const formattedLine = cfg.format === "json" ? JSON.stringify(entry) : humanLine;

    const shouldLog = Log.passesThreshold(level, cfg.minLevel);

    // Console output. v3.13.14: stdout is NOT suppressed in production —
    // containers read PID 1 stdout (docker logs / k8s) and the old
    // `!isProduction()` gate meant deployed apps logged nothing.
    // TINA4_LOG_OUTPUT="file" still opts out of stdout entirely.
    //
    // stdout carries the SAME formattedLine as the file — the format env is the
    // only thing that picks text vs JSON. TINA4_DEBUG decides COLOUR only: ANSI
    // is for a human at a terminal, and a production pipe / log shipper must get
    // clean bytes. Truncate on the CONSOLE only; the file keeps the full line so
    // a consumer parsing it loses nothing, and a terminal does not need 10MB.
    if (shouldLog && cfg.output !== "file") {
      const consoleLine = truncateForStdout(formattedLine);
      if (Log.isProduction()) {
        console.log(consoleLine);
      } else {
        console.log(`${COLORS[level]}${consoleLine}${RESET}`);
      }
    }

    // File output (v3.13.39 — Python master, 4c6d881): gated on cfg.fileEnabled.
    //
    //   output=stdout (default): file ONLY in dev (TINA4_DEBUG truthy);
    //                            production / containers are stdout-only — no
    //                            file to bloat the writable layer / disk.
    //   output=file              file only — no console (always writes a file)
    //   output=both              file + console (always writes a file)
    //   explicit TINA4_LOG_FILE  always writes a file (explicit wins)
    //
    // readEnv() resolves all of the above into cfg.fileEnabled, so flipping
    // that one flag gates the whole file writer (the only persisted sink).
    if (cfg.fileEnabled) {
      const filePath = resolveLogFilePath(cfg.logDir, cfg.logFile);
      Log.writeToFile(filePath, formattedLine, cfg.rotateSize, cfg.rotateKeep, cfg.strict);

      // Mirror WARNING and above into a dedicated error.log so
      // `tail -f logs/error.log` gives just the stuff worth looking at. Node
      // wrote ONE file where Python and PHP wrote two, so anyone whose
      // alerting tails error.log got silence here (feature 2 of the audit, D3).
      // Skipped when the operator named ONE file explicitly: they asked for a
      // single path, so a sibling error.log appearing beside it is a surprise.
      if (!cfg.explicitFile && LEVEL_PRIORITY[level] >= LEVEL_PRIORITY.WARNING) {
        const errorPath = join(cfg.logDir, "error.log");
        Log.writeToFile(errorPath, formattedLine, cfg.rotateSize, cfg.rotateKeep, cfg.strict);
      }
    }
  }
}

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, isAbsolute, basename } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isTruthy } from "./dotenv.js";

/**
 * Structured logger for Tina4. Conformant to the shared cross-framework
 * contract at plan/v3/fixtures/logger_contract.json (feature 2), decided in
 * plan/v3/features/002-structured-logger.md and ADR-0041, with the
 * 2026-08-10 override of decisions 8 and 20 (separate console/file levels;
 * single-file, in-process lock only).
 *
 * Rewritten 2026-08-13 alongside the shared conformance pass. Node's OWN
 * adaptations, each real and each documented at the point it applies:
 *
 *   - Request id: AsyncLocalStorage, not a manual clear-in-finally. A
 *     request's id is scoped to the ALS `run()` call around its dispatch, so
 *     it cannot leak into a sibling request and needs no "clear" step for
 *     correctness (see runWithRequestId below).
 *   - Fork (Decision 12's fork-discard requirement): child_process.fork()
 *     spawns a genuinely NEW process re-executing the module from scratch —
 *     unlike POSIX fork() in Python/PHP/Ruby, it shares no memory with the
 *     parent, so there is nothing to inherit and nothing to discard. A child
 *     process starts with `activeSnapshot === null` by construction.
 *   - The in-process lock (Decision 20): synchronous fs calls on the event
 *     loop's single thread cannot interleave (log() never awaits), so the
 *     common case needs no lock at all. Where a real lock is exercised (a
 *     worker_threads writer, or the LOG-E05 conformance case), it is backed
 *     by a real SharedArrayBuffer + Atomics — Node's actual cross-thread
 *     synchronous primitive — not a simulation.
 */

// ============================================================================
// Error taxonomy — three categories, matching every other Tina4 language.
// ============================================================================

export class LogConfigurationError extends Error {
  setting?: string;
  value?: unknown;
  accepted?: string[];
  sink?: string;
  operation?: string;
  constructor(
    message: string,
    opts: { setting?: string; value?: unknown; accepted?: string[]; sink?: string; operation?: string } = {},
  ) {
    super(message);
    this.name = "LogConfigurationError";
    Object.assign(this, opts);
  }
}

export class LogArgumentError extends Error {
  argument?: string;
  accepted?: string[];
  constructor(message: string, opts: { argument?: string; accepted?: string[] } = {}) {
    super(message);
    this.name = "LogArgumentError";
    Object.assign(this, opts);
  }
}

export class LogWriteError extends Error {
  sink?: string;
  operation?: string;
  constructor(message: string, opts: { sink?: string; operation?: string } = {}) {
    super(message);
    this.name = "LogWriteError";
    Object.assign(this, opts);
  }
}

// ============================================================================
// Constants — identical names and values across all four frameworks.
// ============================================================================

export type LogLevel = "ALL" | "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL" | "NONE";
type EventLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

const LEVELS: Record<LogLevel, number> = {
  ALL: 0,
  DEBUG: 1,
  INFO: 2,
  WARNING: 3,
  ERROR: 4,
  CRITICAL: 5,
  NONE: 6,
};
const EVENT_LEVELS: EventLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

const DEFAULT_LEVEL: LogLevel = "INFO";
const DEFAULT_FILE_LEVEL: LogLevel = "ALL";
const DEFAULT_ROTATE_SIZE = 10 * 1024 * 1024;
const MIN_ROTATE_SIZE = 1024;
const DEFAULT_ROTATE_KEEP = 5;
const STDOUT_MAX_BYTES = 8192;
const OVERFLOW_MESSAGE = "Log event omitted: encoded size exceeds sink limit";
const DEFAULT_LOG_DIR = "logs";
const DEFAULT_LOG_FILE_NAME = "tina4.log";
const LOCK_TIMEOUT_MS = 2000;

// Settings that used to exist and now hard-fail configuration (Decision 19).
const REMOVED_SETTINGS: Record<string, string> = {
  TINA4_LOG_MAX_SIZE: "removed; use TINA4_LOG_ROTATE_SIZE",
  TINA4_LOG_KEEP: "removed; use TINA4_LOG_ROTATE_KEEP",
  TINA4_LOG_APPEND: "removed; the logger always appends",
  TINA4_DEBUG_LEVEL: "removed; use TINA4_LOG_LEVEL",
  TINA4_LOG_CRITICAL: "removed; critical() always emits, subject only to the threshold",
};

const COLORS: Record<EventLevel, string> = {
  DEBUG: "\x1b[36m",
  INFO: "\x1b[32m",
  WARNING: "\x1b[33m",
  ERROR: "\x1b[31m",
  CRITICAL: "\x1b[35m",
};
const RESET = "\x1b[0m";
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function parseLevel(raw: string, setting: string): LogLevel {
  const key = raw.trim().toUpperCase() as LogLevel;
  if (!(key in LEVELS)) {
    throw new LogConfigurationError(`${setting}=${JSON.stringify(raw)} is not a valid level`, {
      setting,
      value: raw,
      accepted: Object.keys(LEVELS),
    });
  }
  return key;
}

// ============================================================================
// Request id — AsyncLocalStorage (Decision 12, Node adaptation above).
// ============================================================================

const requestIdStore = new AsyncLocalStorage<{ id: string | undefined }>();
let requestIdFallback: string | undefined;

// ============================================================================
// Native value normalization (Decision 14).
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Strict UTF-8 decode; invalid bytes become a sha256-addressed marker
 * rather than a silent U+FFFD replacement, which would hide exactly the
 * bytes an operator needs to diagnose (LOG-F09). */
function decodeMaybeBinary(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    const hash = createHash("sha256").update(buf).digest("hex");
    return `<binary ${buf.length} bytes sha256=${hash}>`;
  }
}

/**
 * Recursively normalize a native value into the logger's safe domain:
 * string (a Buffer/Uint8Array is treated as string-shaped: valid UTF-8
 * decodes, invalid becomes the binary marker above), null, boolean, finite
 * number, array, or plain object (string keys, own enumerable properties
 * only). Anything outside that domain becomes the literal "[Unsupported]"
 * WITHOUT EVER invoking the value's own toString/toJSON/valueOf (LOG-F10) —
 * the domain check is entirely structural (typeof / Array.isArray /
 * prototype identity), so a hostile object with a throwing stringifier is
 * never given the chance to run it. A circular array/object is caught via a
 * real ancestor identity chain (===) and becomes "[Circular]" (LOG-F08).
 */
function normalize(value: unknown, ancestors: unknown[] = []): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[Unsupported]";
  if (Buffer.isBuffer(value)) return decodeMaybeBinary(value);
  if (value instanceof Uint8Array) return decodeMaybeBinary(Buffer.from(value));
  if (Array.isArray(value)) {
    if (ancestors.includes(value)) return "[Circular]";
    const nxt = [...ancestors, value];
    return value.map((v) => normalize(v, nxt));
  }
  if (isPlainObject(value)) {
    if (ancestors.includes(value)) return "[Circular]";
    const nxt = [...ancestors, value];
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      out[k] = normalize((value as Record<string, unknown>)[k], nxt);
    }
    return out;
  }
  return "[Unsupported]";
}

function sortKeysRecursive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysRecursive);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysRecursive(src[k]);
    return out;
  }
  return value;
}

/** Compact, sorted-key JSON — the ONE spelling used for a native (non-string)
 * message AND for the context sub-object, in BOTH text and json format. */
function compactJson(value: unknown): string {
  return JSON.stringify(sortKeysRecursive(value));
}

/**
 * The message field's string spelling (LOG-F04/F05). A raw string message is
 * used verbatim. A Buffer/Uint8Array message goes through the same
 * decode-or-describe binary handling. Everything else is normalized then
 * rendered as compact sorted-key JSON — even in TEXT format, so an object
 * message is never "[object Object]".
 */
function messageToString(rawMessage: unknown): string {
  if (typeof rawMessage === "string") return rawMessage;
  if (Buffer.isBuffer(rawMessage)) return decodeMaybeBinary(rawMessage);
  if (rawMessage instanceof Uint8Array) return decodeMaybeBinary(Buffer.from(rawMessage));
  const normalized = normalize(rawMessage);
  // A non-string/non-buffer raw value can only normalize to a STRING via one
  // of normalize()'s own marker paths ("[Circular]", "[Unsupported]", or a
  // binary-decode result) -- numbers/booleans/null/arrays/objects never
  // become strings through ordinary normalization. Use that marker directly;
  // routing it through compactJson would re-encode it as a JSON string
  // literal (wrapping it in quotes), which is wrong for LOG-F10.
  if (typeof normalized === "string") return normalized;
  return compactJson(normalized);
}

/**
 * Single combined-pass escape - backslash, CR, LF - so one log call is
 * exactly one physical LF-terminated line (LOG-F06). A regex with a replacer
 * function makes one pass over the ORIGINAL string and cannot re-scan its own
 * output, unlike sequential string-replace calls (fix backslashes, THEN fix
 * newlines), which would double-escape a backslash a newline fix just wrote.
 */
function escapeText(str: string): string {
  return str.replace(/[\\\r\n]/g, (c) => (c === "\\" ? "\\\\" : c === "\r" ? "\\r" : "\\n"));
}

// ============================================================================
// Canonical event (Decision 15/23) — json_key_order: timestamp, level,
// message, request_id, function, context.
// ============================================================================

interface LogEvent {
  timestamp: string;
  level: EventLevel;
  message: string;
  request_id?: string;
  function?: string;
  context?: unknown;
}

function buildEvent(
  level: EventLevel,
  rawMessage: unknown,
  requestId: string | undefined,
  callerName: string | undefined,
  rawContext: unknown,
): LogEvent {
  const event: LogEvent = {
    timestamp: new Date().toISOString(),
    level,
    message: messageToString(rawMessage),
  };
  if (requestId) event.request_id = requestId;
  if (callerName) event.function = callerName;
  // Sort recursively at BUILD time (not just when rendering text) so the
  // JSON encoder -- which stringifies the event object directly rather than
  // routing through compactJson -- also gets sorted keys (LOG-F03).
  if (rawContext !== undefined) event.context = sortKeysRecursive(normalize(rawContext));
  return event;
}

function encodeJson(event: LogEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function encodeText(event: LogEvent): string {
  const paddedLevel = event.level.padEnd(8);
  const reqPart = event.request_id ? ` [${event.request_id}]` : "";
  const fnPart = event.function ? ` [${event.function}]` : "";
  const ctxPart = event.context !== undefined ? ` ${compactJson(event.context)}` : "";
  return `${event.timestamp} [${paddedLevel}]${reqPart}${fnPart} ${escapeText(event.message)}${ctxPart}\n`;
}

function encode(event: LogEvent, format: "text" | "json"): string {
  return format === "json" ? encodeJson(event) : encodeText(event);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}

/**
 * Replace an oversized encoded record with a small, valid, self-describing
 * replacement carrying the ORIGINAL byte length and its sha256 (LOG-F12) — a
 * witness an operator can use to prove nothing silently vanished, without
 * ever storing the too-large payload itself.
 */
function overflowRecord(original: LogEvent, encoded: string, format: "text" | "json"): string {
  const replacement: LogEvent = {
    timestamp: original.timestamp,
    level: original.level,
    message: OVERFLOW_MESSAGE,
  };
  if (original.request_id) replacement.request_id = original.request_id;
  if (original.function) replacement.function = original.function;
  replacement.context = {
    truncated: true,
    original_bytes: Buffer.byteLength(encoded, "utf-8"),
    sha256: sha256Hex(encoded),
  };
  return encode(replacement, format);
}

function boundedForSink(event: LogEvent, format: "text" | "json", maxBytes: number): string {
  const encoded = encode(event, format);
  if (Buffer.byteLength(encoded, "utf-8") <= maxBytes) return encoded;
  return overflowRecord(event, encoded, format);
}

// ============================================================================
// Real caller-name capture (Decision 16) — TINA4_LOG_FUNC opt-in.
// ============================================================================

const OWN_FRAMES = new Set<string>([
  "log", "Log.log", "emit", "Log.emit",
  "callerName", "Log.callerName", "resolveCallerName", "Log.resolveCallerName",
  "info", "debug", "warning", "error", "critical",
  "Log.info", "Log.debug", "Log.warning", "Log.error", "Log.critical",
]);
const ANON_NAMES = new Set<string>(["", "anonymous", "<anonymous>"]);

function resolveCallerName(): string | undefined {
  try {
    const stack = new Error().stack;
    if (!stack) return undefined;
    const lines = stack.split("\n");
    for (let i = 1; i < lines.length && i < 32; i++) {
      const m = lines[i].match(/^\s+at\s+(?:async\s+)?([^\s(]+)\s*\(/);
      if (!m) continue;
      const name = m[1];
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

// ============================================================================
// A real, working lock (Decision 20) — SharedArrayBuffer + Atomics, Node's
// actual synchronous cross-thread blocking primitive. On the ordinary main
// thread there is no contention to protect against (log() never awaits, so
// nothing can preempt a write mid-flight) but the SAME primitive is what
// makes the lock genuinely acquirable/contendable from a real
// worker_threads.Worker when one is handed this buffer — see
// logger_fixture_contract.test.ts's LOG-R07 and LOG-E05 cases, which do
// exactly that instead of simulating contention.
// ============================================================================

const LOCK_UNLOCKED = 0;
const LOCK_LOCKED = 1;

class SinkLock {
  readonly buffer: SharedArrayBuffer;
  private readonly view: Int32Array;

  constructor(buffer?: SharedArrayBuffer) {
    this.buffer = buffer ?? new SharedArrayBuffer(4);
    this.view = new Int32Array(this.buffer);
  }

  /** Blocks THIS thread (Atomics.wait) until acquired or the timeout elapses. */
  tryAcquire(timeoutMs: number): boolean {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Atomics.compareExchange(this.view, 0, LOCK_UNLOCKED, LOCK_LOCKED) === LOCK_UNLOCKED) {
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      // Atomics.wait blocks the calling thread for real (main thread or a
      // worker) until the value changes or the timeout elapses — this is
      // what makes the wait bounded rather than a busy spin.
      Atomics.wait(this.view, 0, LOCK_LOCKED, Math.min(remaining, 25));
    }
  }

  release(): void {
    Atomics.store(this.view, 0, LOCK_UNLOCKED);
    Atomics.notify(this.view, 0);
  }
}

// ============================================================================
// File sink — predictive rotation (check BEFORE append: current + next >
// rotate_size; exact equality does NOT rotate), bounded lock acquisition.
// ============================================================================

class LogFileSink {
  readonly path: string;
  private rotateSize: number;
  private rotateKeep: number;
  private lock: SinkLock;

  constructor(path: string, rotateSize: number, rotateKeep: number, lockBuffer?: SharedArrayBuffer) {
    this.path = path;
    this.rotateSize = rotateSize;
    this.rotateKeep = rotateKeep;
    this.lock = new SinkLock(lockBuffer);
  }

  /** Exposed only so a conformance test can hand the SAME lock to a real
   * worker_threads.Worker and prove real contention/timeout (LOG-E05). */
  get lockBuffer(): SharedArrayBuffer {
    return this.lock.buffer;
  }

  /** Create the directory and prove the file is writable (LOG-E01: configure()
   * itself proves the sink opens, before any snapshot is committed). */
  open(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(this.path, "a");
      closeSync(fd);
    } catch (err) {
      throw new LogConfigurationError(`cannot open log sink ${this.path}: ${(err as Error).message}`, {
        sink: this.path,
        operation: "open",
      });
    }
  }

  private rotateIfNeeded(nextRecordBytes: number): void {
    let currentSize = 0;
    try {
      currentSize = existsSync(this.path) ? statSync(this.path).size : 0;
    } catch {
      currentSize = 0;
    }
    if (currentSize === 0) return;
    if (currentSize + nextRecordBytes <= this.rotateSize) return;

    if (this.rotateKeep <= 0) {
      try {
        unlinkSync(this.path);
      } catch {
        /* nothing to discard */
      }
      return;
    }

    const oldest = `${this.path}.${this.rotateKeep}`;
    if (existsSync(oldest)) {
      try {
        unlinkSync(oldest);
      } catch {
        /* best effort */
      }
    }
    for (let n = this.rotateKeep - 1; n >= 1; n--) {
      const src = `${this.path}.${n}`;
      const dst = `${this.path}.${n + 1}`;
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch {
          /* best effort */
        }
      }
    }
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch {
      /* best effort */
    }
  }

  /** Append one complete encoded record, rotating first if it would cross
   * the threshold. Raises LogWriteError (timeout/write) to the caller, which
   * applies the sink failure policy (strict/non-strict). */
  write(encodedLine: string): void {
    const acquired = this.lock.tryAcquire(LOCK_TIMEOUT_MS);
    if (!acquired) {
      throw new LogWriteError(`timed out acquiring the log sink lock for ${this.path}`, {
        sink: this.path,
        operation: "lock",
      });
    }
    try {
      const payload = Buffer.from(encodedLine.replace(ANSI_RE, ""), "utf-8");
      this.rotateIfNeeded(payload.byteLength);
      appendFileSync(this.path, payload);
    } catch (err) {
      if (err instanceof LogWriteError) throw err;
      throw new LogWriteError(`cannot write log sink ${this.path}: ${(err as Error).message}`, {
        sink: this.path,
        operation: "write",
      });
    } finally {
      this.lock.release();
    }
  }
}

// ============================================================================
// Configuration resolution
// ============================================================================

interface ConfigureOptions {
  logDir?: string;
  logFile?: string;
  level?: string;
  fileLevel?: string;
  format?: string;
  output?: string;
  rotateSize?: number;
  rotateKeep?: number;
  strict?: boolean;
  caller?: boolean;
}

interface Snapshot {
  level: LogLevel;
  fileLevel: LogLevel;
  format: "text" | "json";
  stdoutEnabled: boolean;
  fileEnabled: boolean;
  outputSelector: "stdout" | "file" | "both";
  logDir: string;
  logFile: string | null;
  layout: "directory" | "single";
  rotateSize: number;
  rotateKeep: number;
  strict: boolean;
  callerCapture: boolean;
  mainSink: LogFileSink | null;
  errorSink: LogFileSink | null;
}

/** Is this target a FILE PATH or a DIRECTORY? Identical rule in all four
 * frameworks: an existing directory is always a directory; otherwise a
 * basename with an extension is a file. */
function targetIsFile(path: string): boolean {
  try {
    if (existsSync(path) && statSync(path).isDirectory()) return false;
  } catch {
    /* fall through to the extension test */
  }
  const base = basename(path);
  return base.includes(".") && !base.startsWith(".");
}

function resolveBool(explicit: boolean | undefined, envName: string, fallback: boolean): boolean {
  if (explicit !== undefined) {
    if (typeof explicit !== "boolean") {
      throw new LogConfigurationError(`${envName.replace("TINA4_LOG_", "").toLowerCase()} must be a boolean`, {
        setting: envName,
        value: explicit,
      });
    }
    return explicit;
  }
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  const key = raw.trim().toLowerCase();
  const truthy = ["1", "true", "on", "yes", "y", "t"];
  const falsy = ["0", "false", "off", "no", "n", "f", ""];
  if (truthy.includes(key)) return true;
  if (falsy.includes(key)) return false;
  throw new LogConfigurationError(`${envName}=${JSON.stringify(raw)} is not a valid boolean`, {
    setting: envName,
    value: raw,
    accepted: [...truthy, ...falsy],
  });
}

function resolveInt(
  explicit: number | undefined,
  envName: string,
  fallback: number,
  minimum: number,
): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < minimum) {
      throw new LogConfigurationError(`${envName} must be an integer >= ${minimum}`, {
        setting: envName,
        value: explicit,
      });
    }
    return explicit;
  }
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new LogConfigurationError(`${envName}=${JSON.stringify(raw)} is not an integer`, {
      setting: envName,
      value: raw,
    });
  }
  const n = parseInt(raw, 10);
  if (n < minimum) {
    throw new LogConfigurationError(`${envName}=${n} must be >= ${minimum}`, { setting: envName, value: n });
  }
  return n;
}

/** rotateKeep allows 0 (Decision: rotate_keep=0 discards the old current
 * entirely rather than renaming it to .1) but never negative or fractional. */
function resolveRotateKeep(explicit: number | undefined, fallback: number): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 0) {
      throw new LogConfigurationError("rotateKeep must be a non-negative integer", {
        setting: "TINA4_LOG_ROTATE_KEEP",
        value: explicit,
      });
    }
    return explicit;
  }
  const raw = process.env.TINA4_LOG_ROTATE_KEEP;
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new LogConfigurationError(`TINA4_LOG_ROTATE_KEEP=${JSON.stringify(raw)} is not an integer`, {
      setting: "TINA4_LOG_ROTATE_KEEP",
      value: raw,
    });
  }
  const n = parseInt(raw, 10);
  if (n < 0) {
    throw new LogConfigurationError(`TINA4_LOG_ROTATE_KEEP=${n} must not be negative`, {
      setting: "TINA4_LOG_ROTATE_KEEP",
      value: n,
    });
  }
  return n;
}

function checkRemovedSettings(): void {
  for (const [name, detail] of Object.entries(REMOVED_SETTINGS)) {
    if (process.env[name] !== undefined) {
      throw new LogConfigurationError(`${name} is a removed setting (${detail})`, {
        setting: name,
        value: process.env[name],
      });
    }
  }
}

function isProduction(): boolean {
  return !isTruthy(process.env.TINA4_DEBUG);
}

/**
 * Resolve one fully-validated configuration snapshot from explicit options,
 * then environment, then default (ADR-0041) — WITHOUT touching the
 * filesystem. Every invalid setting throws LogConfigurationError before this
 * function returns, so a caller (configure() or the lazy first-use path)
 * commits nothing on a validation failure (LOG-C07, LOG-V01..V05).
 */
function resolveSnapshot(options: ConfigureOptions): Omit<Snapshot, "mainSink" | "errorSink"> {
  checkRemovedSettings();

  const level = options.level !== undefined
    ? parseLevel(options.level, "level")
    : process.env.TINA4_LOG_LEVEL !== undefined
      ? parseLevel(process.env.TINA4_LOG_LEVEL, "TINA4_LOG_LEVEL")
      : DEFAULT_LEVEL;

  const fileLevel = options.fileLevel !== undefined
    ? parseLevel(options.fileLevel, "fileLevel")
    : process.env.TINA4_LOG_FILE_LEVEL !== undefined
      ? parseLevel(process.env.TINA4_LOG_FILE_LEVEL, "TINA4_LOG_FILE_LEVEL")
      : DEFAULT_FILE_LEVEL;

  // Format is DEBUG-DERIVED (Decision 3): explicit TINA4_LOG_FORMAT wins;
  // otherwise truthy TINA4_DEBUG selects text, else json.
  let format: "text" | "json";
  const explicitFormat = options.format ?? process.env.TINA4_LOG_FORMAT;
  if (explicitFormat !== undefined) {
    const f = explicitFormat.trim().toLowerCase();
    if (f !== "text" && f !== "json") {
      throw new LogConfigurationError(`TINA4_LOG_FORMAT=${JSON.stringify(explicitFormat)} is not valid`, {
        setting: "TINA4_LOG_FORMAT",
        value: explicitFormat,
        accepted: ["text", "json"],
      });
    }
    format = f;
  } else {
    format = isTruthy(process.env.TINA4_DEBUG) ? "text" : "json";
  }

  // Output: an explicit value (stdout/file/both) ALWAYS wins, full stop —
  // naming a file (below) never itself enables the file sink (LOG-C08).
  let outputSelector: "stdout" | "file" | "both";
  const explicitOutput = options.output ?? process.env.TINA4_LOG_OUTPUT;
  if (explicitOutput !== undefined) {
    const o = explicitOutput.trim().toLowerCase();
    if (o !== "stdout" && o !== "file" && o !== "both") {
      throw new LogConfigurationError(`TINA4_LOG_OUTPUT=${JSON.stringify(explicitOutput)} is not valid`, {
        setting: "TINA4_LOG_OUTPUT",
        value: explicitOutput,
        accepted: ["stdout", "file", "both"],
      });
    }
    outputSelector = o;
  } else {
    // Unset: dev/prod-aware default — file only in development.
    outputSelector = isProduction() ? "stdout" : "both";
  }
  const stdoutEnabled = outputSelector !== "file";
  const fileEnabled = outputSelector !== "stdout";

  const rotateSize = resolveInt(options.rotateSize, "TINA4_LOG_ROTATE_SIZE", DEFAULT_ROTATE_SIZE, MIN_ROTATE_SIZE);
  const rotateKeep = resolveRotateKeep(options.rotateKeep, DEFAULT_ROTATE_KEEP);
  const strict = resolveBool(options.strict, "TINA4_LOG_STRICT", false);
  const callerCapture = resolveBool(options.caller, "TINA4_LOG_FUNC", false);

  const dirRaw = options.logDir ?? process.env.TINA4_LOG_DIR ?? DEFAULT_LOG_DIR;
  if (dirRaw === "") {
    throw new LogConfigurationError("logDir must not be empty", { setting: "TINA4_LOG_DIR", value: dirRaw });
  }
  const fileRaw = options.logFile ?? process.env.TINA4_LOG_FILE ?? "";
  // A NUL byte can never be part of a real path (the underlying syscalls
  // reject it), but that would otherwise only surface at OPEN time -- and
  // only when the file sink ends up enabled. Reject it here, unconditionally,
  // so a malformed path fails CONFIGURATION regardless of whether output
  // happens to resolve to a sink that would ever touch the filesystem.
  if (dirRaw.includes("\0") || fileRaw.includes("\0")) {
    throw new LogConfigurationError("log path must not contain a NUL byte", {
      setting: dirRaw.includes("\0") ? "TINA4_LOG_DIR" : "TINA4_LOG_FILE",
    });
  }

  const projectRoot = process.cwd();
  let dirCandidate = dirRaw;
  let fileCandidate = fileRaw;
  if (!fileCandidate && targetIsFile(dirCandidate)) {
    fileCandidate = basename(dirCandidate);
    dirCandidate = dirname(dirCandidate);
  }

  const resolvedLogDir = (isAbsolute(dirCandidate) ? dirCandidate : join(projectRoot, dirCandidate)).replace(/\/$/, "");

  let resolvedLogFile: string | null;
  let layout: "directory" | "single";
  if (fileCandidate) {
    resolvedLogFile = isAbsolute(fileCandidate) ? fileCandidate : join(resolvedLogDir, fileCandidate);
    layout = "single";
  } else {
    resolvedLogFile = null;
    layout = "directory";
  }

  return {
    level,
    fileLevel,
    format,
    stdoutEnabled,
    fileEnabled,
    outputSelector,
    logDir: resolvedLogDir,
    logFile: resolvedLogFile,
    layout,
    rotateSize,
    rotateKeep,
    strict,
    callerCapture,
  };
}

// ============================================================================
// Log — the public class.
// ============================================================================

let activeSnapshot: Snapshot | null = null;

/** Lazily resolve (and CACHE) the effective configuration on first use
 * (LOG-C01/L2). Once resolved the snapshot is STABLE: a later environment
 * mutation does not retroactively change it (LOG-C05) until reset() (LOG-C06). */
function ensureSnapshot(): Snapshot {
  if (activeSnapshot) return activeSnapshot;
  const resolved = resolveSnapshot({});
  activeSnapshot = openSinks(resolved);
  return activeSnapshot;
}

function openSinks(resolved: Omit<Snapshot, "mainSink" | "errorSink">): Snapshot {
  let mainSink: LogFileSink | null = null;
  let errorSink: LogFileSink | null = null;
  if (resolved.fileEnabled) {
    if (resolved.layout === "single") {
      mainSink = new LogFileSink(resolved.logFile!, resolved.rotateSize, resolved.rotateKeep);
      mainSink.open();
    } else {
      mainSink = new LogFileSink(join(resolved.logDir, DEFAULT_LOG_FILE_NAME), resolved.rotateSize, resolved.rotateKeep);
      mainSink.open();
      errorSink = new LogFileSink(join(resolved.logDir, "error.log"), resolved.rotateSize, resolved.rotateKeep);
      errorSink.open();
    }
  }
  return { ...resolved, mainSink, errorSink };
}

function stdoutIsTty(): boolean {
  return process.stdout.isTTY === true;
}

export class Log {
  /**
   * Configure the logger. Two-phase and transactional: the WHOLE candidate
   * configuration is resolved and validated first (LOG-C07 — a bad setting
   * never touches the filesystem and never disturbs the prior snapshot),
   * then its sinks are opened (LOG-E01 — an inaccessible sink fails
   * configuration, still without replacing the prior snapshot), and only on
   * full success does it become the active configuration.
   *
   *   Log.configure()                                    -> logs/tina4.log + logs/error.log
   *   Log.configure({ logDir: "/var/log/myapp" })        -> /var/log/myapp/tina4.log + error.log
   *   Log.configure({ logFile: "/var/log/myapp/app.log" }) -> that exact file, no error.log sibling
   *   Log.configure({ level: "debug", format: "text", output: "both", strict: true, caller: true })
   *
   * A plain string is also accepted as shorthand for `{ logDir: string }` —
   * or `{ logFile: string }` when it looks like a file (has an extension and
   * is not an existing directory), via the same targetIsFile heuristic
   * configure() itself uses to split a bare TINA4_LOG_DIR that names a file.
   *
   *   Log.configure("/var/log/myapp")          -> same as { logDir: "/var/log/myapp" }
   *   Log.configure("/var/log/myapp/app.log")  -> same as { logFile: "/var/log/myapp/app.log" }
   */
  static configure(options: string | ConfigureOptions = {}): void {
    const normalized: ConfigureOptions = typeof options === "string"
      ? (targetIsFile(options) ? { logFile: options } : { logDir: options })
      : options;
    const resolved = resolveSnapshot(normalized);
    activeSnapshot = openSinks(resolved);
  }

  /** Forget the active configuration; the next use resolves fresh from the
   * environment. Idempotent. */
  static reset(): void {
    activeSnapshot = null;
    requestIdStore.disable?.();
    requestIdFallback = undefined;
  }

  /** A defensive copy of the effective, stable configuration (LOG-C10). */
  static configuration(): Record<string, unknown> {
    const s = ensureSnapshot();
    return {
      level: s.level,
      file_level: s.fileLevel,
      format: s.format,
      output: s.outputSelector,
      log_dir: s.logDir,
      log_file: s.logFile,
      layout: s.layout,
      rotate_size: s.rotateSize,
      rotate_keep: s.rotateKeep,
      strict: s.strict,
      caller: s.callerCapture,
      stdout_enabled: s.stdoutEnabled,
      file_enabled: s.fileEnabled,
    };
  }

  // ── request id (Decision 12 — AsyncLocalStorage) ─────────────────────

  /** Run `fn` with `id` established as the request-scoped correlation id.
   * Every log line inside `fn` — across every await — carries `id`, and two
   * concurrent requests each keep their own; the id needs no explicit clear
   * because it is scoped to this call, not to shared mutable state. */
  static runWithRequestId<T>(id: string | undefined, fn: () => T): T {
    return requestIdStore.run({ id }, fn);
  }

  static setRequestId(id: string | undefined): void {
    const store = requestIdStore.getStore();
    if (store) store.id = id;
    else requestIdFallback = id;
  }

  static getRequestId(): string | undefined {
    const store = requestIdStore.getStore();
    return store ? store.id : requestIdFallback;
  }

  /** Explicitly end a request's correlation scope (LOG-Q01/A01 public
   * surface). Equivalent to setRequestId(undefined) but named for parity
   * with the other three frameworks' clear_request_id. */
  static clearRequestId(): void {
    Log.setRequestId(undefined);
  }

  static sanitizeRequestId(value: string | string[] | undefined | null): string | undefined {
    if (value === undefined || value === null) return undefined;
    const raw = Array.isArray(value) ? value.join(",") : value;
    if (raw.length === 0 || raw.length > 128) return undefined;
    if (/[^A-Za-z0-9._-]/.test(raw)) return undefined;
    return raw;
  }

  // ── threshold ──────────────────────────────────────────────────────

  /**
   * True when `level` passes the queried sink's threshold and that sink is
   * active. `sink` is undefined/"console"/"stdout" (console — the historical
   * meaning) or "file" (Decision 8: the file sink has its own independent
   * TINA4_LOG_FILE_LEVEL threshold).
   */
  static isEnabled(level: string, sink?: "console" | "stdout" | "file"): boolean {
    if (level === undefined || level === null) {
      throw new LogArgumentError("isEnabled requires a level", { argument: "level" });
    }
    const key = String(level).trim().toUpperCase() as LogLevel;
    if (!(key in LEVELS)) {
      throw new LogArgumentError(`${JSON.stringify(level)} is not a valid level`, {
        argument: "level",
        accepted: Object.keys(LEVELS),
      });
    }
    const s = ensureSnapshot();
    if (sink === undefined || sink === "console" || sink === "stdout") {
      return s.stdoutEnabled && LEVELS[key] >= LEVELS[s.level];
    }
    if (sink === "file") {
      return s.fileEnabled && LEVELS[key] >= LEVELS[s.fileLevel];
    }
    throw new LogArgumentError(`${JSON.stringify(sink)} is not a valid sink`, {
      argument: "sink",
      accepted: ["console", "file"],
    });
  }

  // ── event methods (Decision 23) ──────────────────────────────────────

  static debug(message: unknown, context?: unknown): void {
    Log.emit("DEBUG", message, context);
  }

  static info(message: unknown, context?: unknown): void {
    Log.emit("INFO", message, context);
  }

  static warning(message: unknown, context?: unknown): void {
    Log.emit("WARNING", message, context);
  }

  static error(message: unknown, context?: unknown): void {
    Log.emit("ERROR", message, context);
  }

  /** Highest severity. Always emits, subject only to the configured
   * threshold — there is no separate enable toggle. */
  static critical(message: unknown, context?: unknown): void {
    Log.emit("CRITICAL", message, context);
  }

  private static emit(level: EventLevel, rawMessage: unknown, rawContext: unknown): void {
    const s = ensureSnapshot();
    const consoleOk = s.stdoutEnabled && LEVELS[level] >= LEVELS[s.level];
    const fileOk = s.fileEnabled && LEVELS[level] >= LEVELS[s.fileLevel];
    if (!consoleOk && !fileOk) return;

    const requestId = Log.getRequestId();
    const callerName = s.callerCapture ? resolveCallerName() : undefined;
    const event = buildEvent(level, rawMessage, requestId, callerName, rawContext);

    if (consoleOk) {
      const line = boundedForSink(event, s.format, STDOUT_MAX_BYTES).replace(/\n$/, "");
      const plain = s.format === "json" || !stdoutIsTty();
      const text = plain ? line : `${COLORS[level]}${line}${RESET}`;
      // console.log (not a direct process.stdout.write) — interceptable by
      // reassigning console.log, which is how both this codebase's own tests
      // and application code conventionally capture/redirect log output; it
      // still ultimately writes to stdout when not overridden.
      console.log(text);
    }

    if (fileOk && s.mainSink) {
      const mainLine = boundedForSink(event, s.format, s.rotateSize);
      writeSink(s.mainSink, mainLine, s.strict);
      if (s.layout === "directory" && s.errorSink && LEVELS[level] >= LEVELS.WARNING) {
        writeSink(s.errorSink, mainLine, s.strict);
      }
    }
  }
}

function writeSink(sink: LogFileSink, line: string, strict: boolean): void {
  try {
    sink.write(line);
  } catch (err) {
    if (strict) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`tina4: log sink ${sink.path} failed: ${msg}`);
  }
}

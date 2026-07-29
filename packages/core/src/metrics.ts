// Tina4 Code Metrics -- the native engine (ADR-0002) plus an instant file census.
//
// The regex-based analyzer that used to live here is gone. Everything except the
// instant census now comes from `tina4 metrics --json`, so a number measured in
// Node is comparable with the same number measured in Python, PHP or Ruby.
// There is deliberately NO fallback: a second engine is exactly the condition
// that made the four frameworks' numbers incomparable.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// -- Census helpers (kept verbatim: the census parses no code) ----------------

// Where the census last resolved to, so fileDetail() can accept a path taken
// straight out of file_metrics. Written by resolveRoot below.
let _lastScanRoot = "";


function walkFiles(
  dir: string,
  extensions: string[],
  exclude: string[] = ["node_modules", ".git", "dist", "build"]
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!exclude.includes(entry.name)) {
        results.push(...walkFiles(fullPath, extensions, exclude));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (
        extensions.includes(ext) &&
        !entry.name.endsWith(".d.ts")
      ) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function relativePath(filePath: string, root: string = "."): string {
  return path.relative(root, filePath);
}

interface LineCounts {
  loc: number;
  blank: number;
  comment: number;
}

function countLines(source: string): LineCounts {
  const lines = source.split("\n");
  let loc = 0;
  let blank = 0;
  let comment = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const stripped = line.trim();

    if (!stripped) {
      blank++;
      continue;
    }

    if (inBlockComment) {
      comment++;
      if (stripped.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }

    if (stripped.startsWith("/*")) {
      comment++;
      if (!stripped.includes("*/") || stripped.endsWith("/*")) {
        inBlockComment = true;
      }
      continue;
    }

    if (stripped.startsWith("//")) {
      comment++;
      continue;
    }

    loc++;
  }

  return { loc, blank, comment };
}

/**
 * Replace the CONTENTS of string literals, template literals (including
 * interpolations), regex literals, and both comment styles with neutral
 * placeholder characters (spaces), preserving newlines so line numbers and
 * structure stay intact. The surrounding delimiters are kept.
 *
 * This is the regex-based stand-in for Python's AST: the decision-point
 * patterns and the function-extraction patterns must only ever see real code,
 * never text that happens to live inside a string, template, regex, line
 * comment or block comment. Without this, a string full of boolean operators
 * or a regex inflates complexity and yields bogus "functions".
 *
 * Regex-vs-division is resolved conservatively: a slash only starts a regex
 * when the previous significant token can't end an expression (an operator,
 * keyword, open bracket, comma, semicolon, etc.). When in doubt we treat the
 * slash as division and DON'T strip — favouring "leave code intact" over
 * "wrongly blank out a division", per the brief.
 */
function stripLiterals(source: string): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;

  // The last non-whitespace, non-comment character we EMITTED as real code —
  // used to decide whether a `/` opens a regex or is a division operator.
  let prevSignificant = "";
  // The last "word" token (identifier/keyword) emitted, for keyword checks.
  let prevWord = "";

  /** Keywords after which a `/` is a regex, not division. */
  const regexKeywords = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "case", "do", "else", "yield", "await",
  ]);

  /** Can the previous significant token end an expression? If so, `/` = division. */
  function prevEndsExpression(): boolean {
    if (prevSignificant === "") return false; // start of input → regex
    // Identifier/number ending char → could be a value → division …
    if (/[A-Za-z0-9_$]/.test(prevSignificant)) {
      // …unless it's a keyword like `return`/`case` that precedes a regex.
      return !regexKeywords.has(prevWord);
    }
    // Closing brackets and these chars end an expression → division.
    if (prevSignificant === ")" || prevSignificant === "]") return true;
    // `.` (member access) ends an expression-ish context → division ( `a./` is odd, treat as div).
    if (prevSignificant === ".") return true;
    // Everything else (operators, `(`, `,`, `{`, `[`, `;`, `:`, `=`, `<`, `>`, `&`,
    // `|`, `!`, `?`, `+`, `-`, `*`, `%`, `^`, `~`) → regex context.
    return false;
  }

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : "";

    // ── Line comment ──
    if (ch === "/" && next === "/") {
      out.push("//");
      i += 2;
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    // ── Block comment ──
    if (ch === "/" && next === "*") {
      out.push("/*");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("*/");
        i += 2;
      }
      continue;
    }

    // ── String literals ' " ──
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out.push(quote);
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out.push("  "); // blank the escape pair, stay 2 chars wide
          i += 2;
          continue;
        }
        if (source[i] === "\n") {
          out.push("\n"); // unterminated string safety
          i++;
          break;
        }
        out.push(" ");
        i++;
      }
      if (i < n && source[i] === quote) {
        out.push(quote);
        i++;
      }
      prevSignificant = quote;
      prevWord = "";
      continue;
    }

    // ── Template literals ` ` (with ${ ... } interpolation, recursively code) ──
    if (ch === "`") {
      out.push("`");
      i++;
      while (i < n && source[i] !== "`") {
        if (source[i] === "\\" && i + 1 < n) {
          out.push(source[i + 1] === "\n" ? " \n" : "  ");
          i += 2;
          continue;
        }
        // Interpolation: ${ ... } — the inside IS real code, recurse on it.
        if (source[i] === "$" && source[i + 1] === "{") {
          out.push("${");
          i += 2;
          let depth = 1;
          const exprStart = i;
          while (i < n && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            if (depth === 0) break;
            i++;
          }
          // Strip literals INSIDE the interpolation too (handles nested strings/regex).
          out.push(stripLiterals(source.slice(exprStart, i)));
          if (i < n && source[i] === "}") {
            out.push("}");
            i++;
          }
          continue;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n && source[i] === "`") {
        out.push("`");
        i++;
      }
      prevSignificant = "`";
      prevWord = "";
      continue;
    }

    // ── Regex literal / vs division ──
    if (ch === "/" && !prevEndsExpression()) {
      // Scan a regex literal: /.../flags, honouring escapes and [...] classes.
      let j = i + 1;
      let ok = false;
      let inClass = false;
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break; // regex can't span a newline → not a regex
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        out.push("/");
        for (let k = i + 1; k < j; k++) out.push(" ");
        out.push("/");
        i = j + 1;
        // consume flags
        while (i < n && /[a-z]/i.test(source[i])) {
          out.push(source[i]);
          i++;
        }
        prevSignificant = "/"; // a regex value ends an expression-ish slot
        prevWord = "";
        continue;
      }
      // Not a regex — fall through, emit `/` as division.
    }

    // ── Ordinary code char ──
    out.push(ch);
    if (!/\s/.test(ch)) {
      prevSignificant = ch;
      if (/[A-Za-z0-9_$]/.test(ch)) {
        prevWord = /[A-Za-z0-9_$]/.test(source[i - 1] ?? "") ? prevWord + ch : ch;
      } else {
        prevWord = "";
      }
    }
    i++;
  }

  return out.join("");
}

function countClassesQuick(source: string): number {
  // Match class declarations: class Foo, export class Foo, abstract class Foo
  const matches = source.match(
    /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/g
  );
  return matches ? matches.length : 0;
}

function countFunctionsQuick(source: string): number {
  // Count on cleaned source so `something(...)` inside a string/regex/comment is
  // never mistaken for a method (the chief source of the old over-count).
  const clean = stripLiterals(source);
  let count = 0;
  // function declarations: function foo(, async function foo(, export function foo(
  const funcDecls = clean.match(
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/g
  );
  if (funcDecls) count += funcDecls.length;

  // Method declarations inside classes: name(, async name(, static name(, get name(, set name(
  const methods = clean.match(
    /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/g
  );
  if (methods) count += methods.length;

  // Arrow functions assigned to const/let/var
  const arrows = clean.match(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/g
  );
  if (arrows) count += arrows.length;

  return count;
}

/**
 * Pick the right directory to scan.
 *
 * If the root dir has .ts files, scan the user's project code.
 * Otherwise, scan the framework itself — so the bubble chart is never empty.
 */
function resolveRoot(root: string = "src"): string {
  const rootPath = path.resolve(root);
  if (fs.existsSync(rootPath) && walkFiles(rootPath, [".ts", ".js"]).length > 0) {
    _lastScanRoot = rootPath;
    return root;
  }
  // Fallback: scan the framework package itself
  const fwDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  _lastScanRoot = fwDir;
  return fwDir;
}

export function quickMetrics(root: string = "src"): Record<string, any> {
  root = resolveRoot(root);
  const rootPath = path.resolve(root);
  if (!fs.existsSync(rootPath)) {
    return { error: `Directory not found: ${root}` };
  }

  const tsFiles = walkFiles(rootPath, [".ts", ".js"]);
  const twigFiles = walkFiles(rootPath, [".twig", ".html"]);

  const migrationsDir = path.resolve("migrations");
  const migrationFiles = [
    ...walkFiles(migrationsDir, [".sql"]),
    ...walkFiles(migrationsDir, [".ts"]),
  ];

  const scssFiles = walkFiles(rootPath, [".scss", ".css"]);

  let totalLoc = 0;
  let totalBlank = 0;
  let totalComment = 0;
  let totalClasses = 0;
  let totalFunctions = 0;
  const fileDetails: Record<string, any>[] = [];

  for (const f of tsFiles) {
    const source = readFileSafe(f);
    if (source === null) continue;

    const counts = countLines(source);
    const classes = countClassesQuick(source);
    const functions = countFunctionsQuick(source);

    totalLoc += counts.loc;
    totalBlank += counts.blank;
    totalComment += counts.comment;
    totalClasses += classes;
    totalFunctions += functions;

    fileDetails.push({
      path: relativePath(f, rootPath),
      loc: counts.loc,
      blank: counts.blank,
      comment: counts.comment,
      classes,
      functions,
    });
  }

  // Sort by LOC descending
  fileDetails.sort((a, b) => b.loc - a.loc);

  // Route and ORM counts (scan for decorators/patterns)
  let routeCount = 0;
  let ormCount = 0;

  for (const f of tsFiles) {
    const source = readFileSafe(f);
    if (source === null) continue;

    // Count route registrations: router.get(, router.post(, @get(, @post(, etc.
    const routes = source.match(
      /(?:router\s*\.\s*(?:get|post|put|delete|patch|any)\s*\(|@(?:get|post|put|delete|patch)\s*\()/g
    );
    if (routes) routeCount += routes.length;

    // Count ORM models: extends ORM, extends Model
    const orms = source.match(
      /class\s+\w+\s+extends\s+(?:ORM|Model)\b/g
    );
    if (orms) ormCount += orms.length;
  }

  const breakdown: Record<string, number> = {
    typescript: tsFiles.filter((f) => f.endsWith(".ts")).length,
    javascript: tsFiles.filter((f) => f.endsWith(".js")).length,
    templates: twigFiles.length,
    migrations: migrationFiles.length,
    stylesheets: scssFiles.length,
  };

  return {
    file_count: tsFiles.length,
    total_loc: totalLoc,
    total_blank: totalBlank,
    total_comment: totalComment,
    lloc: totalLoc,
    classes: totalClasses,
    functions: totalFunctions,
    route_count: routeCount,
    orm_count: ormCount,
    template_count: twigFiles.length,
    migration_count: migrationFiles.length,
    avg_file_size: tsFiles.length > 0 ? Math.round((totalLoc / tsFiles.length) * 10) / 10 : 0,
    largest_files: fileDetails.slice(0, 10),
    breakdown,
  };
}

// -- The native engine (ADR-0002) --------------------------------------------

/**
 * The native metrics engine could not produce a payload.
 *
 * Thrown instead of falling back to a second implementation.
 */
export class MetricsEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsEngineError";
  }
}

const TIMEOUT_MS = 60_000;

const INSTALL_HINT = [
  "the tina4 CLI provides the metrics engine (ADR-0002). Install it with",
  "  curl -fsSL https://tina4.com/install.sh | sh",
  "or see https://tina4.com/cli",
].join("\n");

// Fields the dashboard renders. Checking for the DATA is honest where checking a
// version string is not: a user may run any CLI build, and the payload is what
// tells us what that build can actually do.
const SUMMARY_KEYS = ["files_analyzed", "total_functions", "avg_complexity", "avg_maintainability"];
const FILE_KEYS = ["path", "loc", "avg_complexity", "maintainability", "has_tests"];
const FUNCTION_KEYS = ["name", "file", "line", "complexity", "loc"];

export const SEVERITY_RANK: Record<string, number> = { error: 2, warn: 1, info: 0 };

/**
 * Return [directory to scan, scanMode] for any metrics producer.
 *
 * The engine is language-agnostic and cannot know which directory holds a
 * framework package, so root resolution and the "framework" label stay here,
 * shared by the census and the engine adapter so the two never disagree.
 */
export function resolveScanTarget(root: string = "src"): [string, string] {
  const resolved = resolveRoot(root);
  const frameworkDir = path.dirname(fileURLToPath(import.meta.url));
  const real = path.resolve(resolved);
  const scanningFramework = real === frameworkDir || real.startsWith(frameworkDir);
  return [resolved, scanningFramework ? "framework" : "project"];
}

/** Absolute path to the tina4 CLI binary, or null when it is not installed. */
export function enginePath(): string | null {
  const names = process.platform === "win32" ? ["tina4.exe", "tina4.cmd", "tina4"] : ["tina4"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
      // Skip shebang scripts: the engine is a COMPILED binary, and npm/npx put
      // JS shims on PATH that would be picked up ahead of the real thing.
      try {
        const fd = fs.openSync(candidate, "r");
        const buf = Buffer.alloc(2);
        fs.readSync(fd, buf, 0, 2, 0);
        fs.closeSync(fd);
        if (buf.toString("latin1") === "#!") continue;
      } catch {
        /* unreadable header: fall through and try running it */
      }
      return candidate;
    }
  }
  return null;
}

/** Run `tina4 metrics --json` over a path and return the raw payload. */
function runEngine(target: string): Record<string, any> {
  const binary = enginePath();
  if (binary === null) {
    throw new MetricsEngineError(`tina4 not found on PATH - ${INSTALL_HINT}`);
  }

  const proc = spawnSync(binary, ["metrics", "--path", target, "--json"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (proc.error) {
    const err = proc.error as NodeJS.ErrnoException;
    if (err.code === "ETIMEDOUT") {
      throw new MetricsEngineError(`tina4 metrics timed out after ${TIMEOUT_MS / 1000}s on ${target}`);
    }
    throw new MetricsEngineError(`could not run ${binary}: ${err.message}`);
  }
  if (proc.status !== 0) {
    const detail = (proc.stderr || proc.stdout || "").trim().split("\n")[0];
    throw new MetricsEngineError(
      `tina4 metrics failed on ${target}: ${detail || `exit code ${proc.status}`}`
    );
  }
  if (!proc.stdout || !proc.stdout.trim()) {
    throw new MetricsEngineError(`tina4 metrics produced no output for ${target}`);
  }

  let payload: any;
  try {
    payload = JSON.parse(proc.stdout);
  } catch (e) {
    throw new MetricsEngineError(`tina4 metrics returned unreadable JSON: ${(e as Error).message}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MetricsEngineError("tina4 metrics returned a non-object payload");
  }
  return payload;
}

/** Pull a key out of the payload or throw naming what the engine is missing. */
function requireKey<T>(payload: Record<string, any>, key: string, isArray: boolean): T {
  const value = payload[key];
  const ok = isArray
    ? Array.isArray(value)
    : value !== null && typeof value === "object" && !Array.isArray(value);
  if (!ok) {
    throw new MetricsEngineError(
      `engine payload has no usable '${key}' - the installed tina4 CLI predates a field ` +
        `the dashboard renders. Update it: ${INSTALL_HINT}`
    );
  }
  return value as T;
}

/** Full code analysis from the native engine, shaped for the dashboard. */
export function fullAnalysis(root: string = "src"): Record<string, any> {
  const [resolved, scanMode] = resolveScanTarget(root);
  const payload = runEngine(resolved);

  const summary = requireKey<Record<string, any>>(payload, "summary", false);
  const fileMetrics = requireKey<Record<string, any>[]>(payload, "file_metrics", true);
  const functions = requireKey<Record<string, any>[]>(payload, "most_complex_functions", true);

  const missing = SUMMARY_KEYS.filter((k) => !(k in summary));
  if (missing.length) {
    throw new MetricsEngineError(
      `engine summary is missing ${missing.join(", ")} - update the CLI: ${INSTALL_HINT}`
    );
  }
  if (fileMetrics.length) {
    const absent = FILE_KEYS.filter((k) => !(k in fileMetrics[0]));
    if (absent.length) throw new MetricsEngineError(`engine file_metrics is missing ${absent.join(", ")}`);
  }
  if (functions.length) {
    const absent = FUNCTION_KEYS.filter((k) => !(k in functions[0]));
    if (absent.length) throw new MetricsEngineError(`engine function metrics are missing ${absent.join(", ")}`);
  }

  const result: Record<string, any> = {};
  for (const key of SUMMARY_KEYS) result[key] = summary[key];
  result.file_metrics = fileMetrics;
  // Display cap only. offenders() reads the engine's own uncapped list, so a
  // 16th over-threshold function is never hidden from the gate.
  result.most_complex_functions = functions.slice(0, 15);
  result.dependency_graph = payload.dependency_graph || {};
  // The framework owns these two: the engine always reports "project" because
  // it cannot know which directory is a framework package.
  result.scan_mode = scanMode;
  result.scan_root = path.resolve(resolved);
  result.engine = "tina4-cli";
  return result;
}

export interface OffendersResult {
  offenders: Record<string, any>[];
  summary: Record<string, any>;
}

/**
 * Top code-health offenders from the native engine.
 *
 * The engine ranks and severity-tags them, and its own --fail-on gate reads the
 * same list, so the CLI and the dashboard can never disagree about what counts
 * as an offender.
 */
export function offenders(root: string = "src", top: number = 20): OffendersResult {
  const [resolved, scanMode] = resolveScanTarget(root);
  const payload = runEngine(resolved);

  const found = requireKey<Record<string, any>[]>(payload, "offenders", true);
  const summary = { ...requireKey<Record<string, any>>(payload, "summary", false) };
  summary.scan_mode = scanMode;
  summary.scan_root = path.resolve(resolved);
  summary.engine = "tina4-cli";
  if (summary.total_offenders === undefined) summary.total_offenders = found.length;
  return { offenders: found.slice(0, top), summary };
}

/**
 * Per-file metrics from the native engine.
 *
 * The engine accepts a single file for --path, so one code path serves both the
 * whole-tree scan and one file.
 */
export function fileDetail(filePath: string): Record<string, any> {
  if (!filePath) throw new MetricsEngineError("fileDetail needs a path");

  let target = filePath;
  if (!fs.existsSync(target) && _lastScanRoot) {
    // Try it relative to whatever the census last resolved, so the dashboard can
    // pass a path taken straight out of file_metrics.
    const candidate = path.join(_lastScanRoot, filePath);
    if (fs.existsSync(candidate)) target = candidate;
  }
  if (!fs.existsSync(target)) throw new MetricsEngineError(`no such file: ${filePath}`);
  if (fs.statSync(target).isDirectory()) throw new MetricsEngineError(`not a file: ${filePath}`);

  const payload = runEngine(target);
  const fileMetrics = requireKey<Record<string, any>[]>(payload, "file_metrics", true);
  if (!fileMetrics.length) {
    throw new MetricsEngineError(`engine reported no metrics for ${filePath}`);
  }
  return { ...fileMetrics[0], engine: "tina4-cli" };
}

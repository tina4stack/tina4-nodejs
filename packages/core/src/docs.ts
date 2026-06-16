/**
 * Tina4 Live API RAG — `Docs` module.
 *
 * Walks framework packages (`@tina4/core`, `@tina4/orm`, `@tina4/swagger`,
 * `@tina4/frond`) and the user project's `src/` tree via lightweight TS
 * regex parsing (no AST — works on .ts files without importing them, so
 * user-code import errors don't break reflection).
 *
 * Exposes ranked search, class/method specs, a flat index, MCP-style
 * static mirrors, and a Markdown drift/sync helper. Zero new runtime
 * dependencies — Node stdlib only.
 *
 * Spec: plan/v3/22-LIVE-API-RAG.md
 *
 * Method names follow Tina4 Node.js convention (camelCase) — see PHP
 * `Tina4\Docs` and Python `tina4_python.docs.Docs` for parity references.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────────────

export interface DocsHit {
  fqn: string;
  kind: "class" | "method" | "function" | "property";
  name: string;
  signature: string;
  summary: string;
  file: string;
  line: number;
  version: string;
  source: "framework" | "user" | "vendor";
  visibility: "public" | "protected" | "private";
  static?: boolean;
  class?: string;
  score: number;
}

export interface MethodSpec {
  name: string;
  fqn: string;
  class: string;
  kind: "method";
  signature: string;
  summary: string;
  docblock: string;
  file: string;
  line: number;
  visibility: "public" | "protected" | "private";
  static: boolean;
  source: "framework" | "user" | "vendor";
  version: string;
  params: Array<{ name: string; type: string; default?: string | null }>;
  return: string;
}

export interface ClassSpec {
  fqn: string;
  kind: "class";
  name: string;
  file: string;
  line: number;
  summary: string;
  docblock: string;
  source: "framework" | "user" | "vendor";
  version: string;
  methods: Array<Omit<MethodSpec, "params" | "return"> & { params?: unknown[]; return?: string }>;
  properties: unknown[];
}

export interface IndexEntry {
  fqn: string;
  kind: "class" | "method" | "function" | "property";
  name: string;
  signature: string;
  summary: string;
  file: string;
  line: number;
  version: string;
  source: "framework" | "user" | "vendor";
  visibility: "public" | "protected" | "private";
  static?: boolean;
  class?: string;
}

export interface DriftHit {
  method: string;
  line: number;
  block: string;
}

interface InternalEntry extends IndexEntry {
  docblock: string;
  _private: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const STDLIB_ALLOWLIST = new Set<string>([
  // JS / TS commonly referenced in docs
  "push", "pop", "shift", "unshift", "slice", "splice", "indexOf", "includes",
  "map", "filter", "reduce", "forEach", "some", "every", "find", "findIndex",
  "join", "split", "replace", "replaceAll", "trim", "toLowerCase", "toUpperCase",
  "startsWith", "endsWith", "concat", "charAt", "charCodeAt", "padStart", "padEnd",
  "keys", "values", "entries", "fromEntries", "assign", "freeze", "isArray",
  "stringify", "parse", "log", "info", "warn", "error", "debug", "table",
  "then", "catch", "finally", "all", "race", "resolve", "reject",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "JSON", "Math", "Date", "Promise", "Array", "Object", "String", "Number",
  "abs", "floor", "ceil", "round", "min", "max", "pow", "sqrt", "random",
  "bind", "call", "apply", "toString", "valueOf", "hasOwnProperty",
  // Node-ish
  "readFileSync", "writeFileSync", "existsSync", "readdirSync", "statSync",
  "createServer", "listen", "close", "on", "off", "emit", "once",
  "json", "send", "redirect", "html", "status", "end",
  // PHP / Python doc names occasionally used in cross-language docs
  "render", "save", "delete", "find", "select", "where", "all", "count",
  "exists", "fetch", "execute", "insert", "update", "commit", "rollback",
  "get", "set", "has", "put", "patch", "post", "head", "options",
  "encode", "decode", "sign", "verify", "hash",
]);

const _DOCS_CACHE = new Map<string, Docs>();

// ── Helpers ──────────────────────────────────────────────────────────

const __FILENAME = fileURLToPath(import.meta.url);
const __DIRNAME = path.dirname(__FILENAME);

/**
 * Resolve the absolute path of the framework's `packages/` root.
 *
 * When running from the monorepo, `import.meta.url` lands inside
 * `packages/core/src/docs.ts`. We walk up to find the workspace root.
 * In a published install, framework code lives under
 * `node_modules/@tina4/core/src/...` — same shape from this file.
 */
function detectFrameworkRoots(): string[] {
  const corePackageRoot = path.resolve(__DIRNAME, ".."); // packages/core
  const packagesRoot = path.resolve(corePackageRoot, "..");
  const roots: string[] = [];
  for (const pkg of ["core", "orm", "swagger", "frond"]) {
    const dir = path.join(packagesRoot, pkg, "src");
    if (fs.existsSync(dir)) roots.push(dir);
  }
  return roots;
}

/** Same set of dirs to scan under a project root for user code. */
const USER_DIRS = ["src/orm", "src/routes", "src/app", "src/services", "src/models"];

function detectVersion(projectRoot: string): string {
  for (const candidate of [
    path.join(projectRoot, "package.json"),
    path.resolve(__DIRNAME, "..", "..", "..", "package.json"),
    path.resolve(__DIRNAME, "..", "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (pkg && typeof pkg.version === "string") return pkg.version;
    } catch { /* keep looking */ }
  }
  return "0.0.0";
}

function tagSource(absPath: string, frameworkRoots: string[], userRoot: string): "framework" | "user" | "vendor" {
  const norm = path.resolve(absPath);
  for (const fw of frameworkRoots) {
    if (norm === fw || norm.startsWith(fw + path.sep)) return "framework";
  }
  if (norm.includes(`${path.sep}node_modules${path.sep}@tina4${path.sep}`)) return "framework";
  if (norm === userRoot || norm.startsWith(userRoot + path.sep)) return "user";
  return "vendor";
}

function relativePath(absPath: string, projectRoot: string, frameworkRoots: string[]): string {
  const norm = path.resolve(absPath);
  for (const fw of frameworkRoots) {
    const parent = path.dirname(fw); // …/packages/<pkg>
    if (norm.startsWith(parent + path.sep)) {
      // Strip down to "packages/<pkg>/src/foo.ts" relative to monorepo root
      const monorepo = path.resolve(parent, "..", "..");
      if (norm.startsWith(monorepo + path.sep)) return path.relative(monorepo, norm);
      return path.relative(parent, norm);
    }
  }
  if (norm.startsWith(projectRoot + path.sep)) return path.relative(projectRoot, norm);
  return norm;
}

const CAMEL_SPLIT = /([a-z0-9])([A-Z])|([A-Z]+)([A-Z][a-z])/g;

function tokenise(text: string): string[] {
  if (!text) return [];
  const expanded = text
    .replace(CAMEL_SPLIT, (_m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .toLowerCase();
  return expanded
    .split(/[\s_\-./:,;()\[\]{}\\]+/)
    .filter((p) => p.length > 0);
}

function summariseDoc(doc: string): string {
  if (!doc) return "";
  for (const raw of doc.split(/\r?\n/)) {
    const clean = raw.replace(/^\s*\/?\*+\/?\s?/, "").trim();
    if (!clean || clean.startsWith("@")) continue;
    return clean.slice(0, 240);
  }
  return "";
}

function docblockBody(doc: string): string {
  if (!doc) return "";
  const lines: string[] = [];
  for (const raw of doc.split(/\r?\n/)) {
    const clean = raw.replace(/^\s*\/?\*+\/?\s?/, "").trim();
    if (!clean) continue;
    lines.push(clean);
  }
  return lines.join(" ");
}

// ── TS regex parser ──────────────────────────────────────────────────

interface ParsedClass {
  name: string;
  line: number;
  doc: string;
  exported: boolean;
  methods: ParsedMethod[];
}

interface ParsedMethod {
  name: string;
  line: number;
  doc: string;
  signature: string;
  visibility: "public" | "protected" | "private";
  static: boolean;
}

interface ParsedFile {
  classes: ParsedClass[];
  functions: ParsedMethod[];
}

const CLASS_RE = /(?:^|\n)([ \t]*)((?:export\s+(?:default\s+)?(?:abstract\s+)?)?class\s+([A-Za-z_$][\w$]*))[\s\S]*?(?=\n[ \t]*(?:export\s+(?:default\s+)?(?:abstract\s+)?class|export\s+function|function|$))/g;

/**
 * Parse a TS source string. Lightweight — finds top-level classes and their
 * public methods, plus top-level exported functions. Captures preceding JSDoc.
 *
 * Strategy: scan token-by-token. We don't need a full AST — we only care
 * about identifying class declarations, brace depth (to find class members),
 * method/function declarations, and JSDoc comments immediately above.
 */
function parseTypeScript(source: string, _debugTag = ""): ParsedFile {
  const classes: ParsedClass[] = [];
  const functions: ParsedMethod[] = [];

  // Strip line comments and string contents (preserve length for line numbers).
  const stripped = stripStrings(source);
  const lines = source.split(/\r?\n/);

  let i = 0;
  let line = 1;
  let pendingDoc = "";
  let pendingDocLine = 0;
  const len = stripped.length;
  let braceDepth = 0;
  let classStack: { name: string; bodyStartDepth: number; entry: ParsedClass; isExport: boolean }[] = [];

  function lineOf(offset: number): number {
    // Count newlines up to offset.
    let l = 1;
    for (let k = 0; k < offset && k < source.length; k++) {
      if (source.charCodeAt(k) === 10) l++;
    }
    return l;
  }

  while (i < len) {
    const ch = stripped[i];

    // JSDoc detection
    if (ch === "/" && stripped[i + 1] === "*" && stripped[i + 2] === "*") {
      const end = stripped.indexOf("*/", i + 3);
      if (end === -1) break;
      pendingDoc = source.slice(i, end + 2);
      pendingDocLine = lineOf(i);
      i = end + 2;
      continue;
    }

    // Skip line comments (already stripped → '/' followed by '/' won't appear in stripped, but be safe)
    if (ch === "/" && stripped[i + 1] === "/") {
      while (i < len && stripped[i] !== "\n") i++;
      continue;
    }

    // Brace tracking (only outside strings; strings are zeroed in stripped)
    if (ch === "{") {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === "}") {
      braceDepth--;
      // Pop classes whose body just closed
      while (classStack.length > 0 && braceDepth <= classStack[classStack.length - 1].bodyStartDepth) {
        const cls = classStack.pop()!;
        classes.push(cls.entry);
      }
      i++;
      continue;
    }

    // Look for "class <Name>"
    if (isWordBoundary(stripped, i) && matchKeyword(stripped, i, "class")) {
      // Read modifiers backwards on this line — already covered by pendingDoc capture.
      const after = i + "class".length;
      const nameMatch = /^\s+([A-Za-z_$][\w$]*)/.exec(stripped.slice(after));
      if (nameMatch) {
        const name = nameMatch[1];
        const classLine = lineOf(i);
        // Look for opening '{' starting from after the name
        let j = after + nameMatch[0].length;
        while (j < len && stripped[j] !== "{") j++;
        if (j < len) {
          const isExport = isExportedAt(stripped, lines, classLine, name);
          const entry: ParsedClass = {
            name,
            line: classLine,
            doc: pendingDoc,
            exported: isExport,
            methods: [],
          };
          // Push class context with its bodyStartDepth = current braceDepth
          // (the upcoming '{' will increment braceDepth one above this).
          classStack.push({ name, bodyStartDepth: braceDepth, entry, isExport });
          pendingDoc = "";
          // Move past '{' and increment depth
          braceDepth++;
          i = j + 1;
          continue;
        }
      }
    }

    // Method or top-level function detection — we only care about either:
    //   * methods inside a class body (classStack non-empty AND directly inside class body)
    //   * top-level "export function" or "function" declarations
    if (classStack.length > 0
        && braceDepth === classStack[classStack.length - 1].bodyStartDepth + 1) {
      // We're directly inside a class body.
      const m = matchMethodSignature(stripped, source, i);
      if (m) {
        const methodLine = lineOf(m.nameStart ?? i);
        const cls = classStack[classStack.length - 1];
        // Skip private/protected based on TS modifier OR name prefix '_'
        const visibility = m.visibility;
        cls.entry.methods.push({
          name: m.name,
          line: methodLine,
          doc: pendingDoc,
          signature: m.signature,
          visibility,
          static: m.static,
        });
        pendingDoc = "";
        i = m.endIndex;
        continue;
      }
    } else if (braceDepth === 0) {
      // Top-level — look for "export function" or "function"
      const f = matchTopLevelFunction(stripped, source, i);
      if (f) {
        const fLine = lineOf(f.nameStart ?? i);
        functions.push({
          name: f.name,
          line: fLine,
          doc: pendingDoc,
          signature: f.signature,
          visibility: "public",
          static: false,
        });
        pendingDoc = "";
        i = f.endIndex;
        continue;
      }
    }

    // Whitespace doesn't reset pendingDoc — but most other tokens do.
    if (!/\s/.test(ch)) {
      // Non-whitespace, non-doc-comment — only reset doc if it was a long way back.
      // Be conservative: only reset on punctuation that clearly terminates.
      if (ch === ";") {
        pendingDoc = "";
      }
    }

    i++;
  }

  // Any unclosed class (shouldn't happen in valid TS) → flush.
  while (classStack.length > 0) classes.push(classStack.pop()!.entry);

  // Suppress unused-warning
  void pendingDocLine;

  return { classes, functions };
}

function isWordBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text.charCodeAt(i - 1);
  // Word chars: A-Z a-z 0-9 _ $
  if ((prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57) || prev === 95 || prev === 36) {
    return false;
  }
  return true;
}

function matchKeyword(text: string, i: number, kw: string): boolean {
  if (text.substr(i, kw.length) !== kw) return false;
  const after = i + kw.length;
  if (after >= text.length) return true;
  const nextCode = text.charCodeAt(after);
  if ((nextCode >= 65 && nextCode <= 90) || (nextCode >= 97 && nextCode <= 122) || (nextCode >= 48 && nextCode <= 57) || nextCode === 95 || nextCode === 36) {
    return false;
  }
  return true;
}

function isExportedAt(_stripped: string, lines: string[], lineNo: number, name: string): boolean {
  // Walk back up to 8 lines and look for "export class <name>" / "export default class <name>"
  const start = Math.max(0, lineNo - 1);
  const exportClass = "export class " + name;
  const exportDefaultClass = "export default class " + name;
  const exportAbstractClass = "export abstract class " + name;
  const justClass = "class " + name;
  for (let l = start; l >= Math.max(0, start - 8); l--) {
    const ln = lines[l] || "";
    if (ln.includes(exportClass) || ln.includes(exportDefaultClass) || ln.includes(exportAbstractClass)) {
      return true;
    }
    if (ln.includes(justClass)) {
      // declared but not exported
      return /\bexport\b/.test(ln);
    }
  }
  return false;
}

interface MethodMatch {
  name: string;
  signature: string;
  endIndex: number;
  nameStart: number;
  visibility: "public" | "protected" | "private";
  static: boolean;
}

const METHOD_HEAD_RE =
  /^([ \t]*)((?:public|protected|private|readonly|static|async|abstract|override|\s)*)([A-Za-z_$][\w$]*)\s*[<(]/;

function matchMethodSignature(stripped: string, source: string, i: number): MethodMatch | null {
  // Method must be at start-of-line-ish position.
  if (i > 0) {
    const prev = stripped.charCodeAt(i - 1);
    if (prev !== 10 && prev !== 32 && prev !== 9 && prev !== 123) return null;
  }
  // Take the rest of the current line + a little ahead.
  let lineEnd = stripped.indexOf("\n", i);
  if (lineEnd === -1) lineEnd = stripped.length;
  // Read up to 4 lines for multi-line signatures.
  let chunkEnd = lineEnd;
  for (let extra = 0; extra < 4 && chunkEnd < stripped.length; extra++) {
    const next = stripped.indexOf("\n", chunkEnd + 1);
    if (next === -1) break;
    chunkEnd = next;
  }
  const chunk = stripped.slice(i, chunkEnd + 1);
  const match = METHOD_HEAD_RE.exec(chunk);
  if (!match) return null;
  const modifiers = match[2] || "";
  const name = match[3];
  // Skip reserved words / control-flow that masquerade as method names.
  const reserved = new Set([
    "if", "for", "while", "switch", "return", "do", "try", "catch", "throw",
    "const", "let", "var", "import", "export", "function", "class", "interface",
    "type", "new", "yield", "await", "case", "break", "continue", "else",
  ]);
  if (reserved.has(name)) return null;

  // Determine visibility from modifiers
  let visibility: "public" | "protected" | "private" = "public";
  if (/\bprivate\b/.test(modifiers)) visibility = "private";
  else if (/\bprotected\b/.test(modifiers)) visibility = "protected";
  const isStatic = /\bstatic\b/.test(modifiers);

  // Capture signature — read from start of "name" up through matching ')' and optional return type.
  const nameStart = i + match[1].length + match[2].length;
  const result = captureSignature(stripped, source, nameStart, name);
  if (!result) return null;

  return {
    name,
    signature: result.signature,
    endIndex: result.endIndex,
    nameStart,
    visibility,
    static: isStatic,
  };
}

const FN_HEAD_RE =
  /^((?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+)([A-Za-z_$][\w$]*)\s*[<(]/;

function matchTopLevelFunction(stripped: string, source: string, i: number): MethodMatch | null {
  if (i > 0) {
    const prev = stripped.charCodeAt(i - 1);
    if (prev !== 10 && prev !== 32 && prev !== 9) return null;
  }
  let lineEnd = stripped.indexOf("\n", i);
  if (lineEnd === -1) lineEnd = stripped.length;
  let chunkEnd = lineEnd;
  for (let extra = 0; extra < 4 && chunkEnd < stripped.length; extra++) {
    const next = stripped.indexOf("\n", chunkEnd + 1);
    if (next === -1) break;
    chunkEnd = next;
  }
  const chunk = stripped.slice(i, chunkEnd + 1);
  const match = FN_HEAD_RE.exec(chunk);
  if (!match) return null;
  const name = match[2];
  const nameStart = i + match[1].length;
  const result = captureSignature(stripped, source, nameStart, name);
  if (!result) return null;
  return {
    name,
    signature: result.signature,
    endIndex: result.endIndex,
    nameStart,
    visibility: "public",
    static: false,
  };
}

interface CapturedSig {
  signature: string;
  endIndex: number;
}

function captureSignature(stripped: string, source: string, nameStart: number, name: string): CapturedSig | null {
  // Skip the name
  let j = nameStart + name.length;
  // Optional generic <...>
  while (j < stripped.length && /\s/.test(stripped[j])) j++;
  if (stripped[j] === "<") {
    let depth = 0;
    while (j < stripped.length) {
      const c = stripped[j];
      if (c === "<") depth++;
      else if (c === ">") {
        depth--;
        if (depth === 0) { j++; break; }
      }
      j++;
    }
  }
  // Whitespace
  while (j < stripped.length && /\s/.test(stripped[j])) j++;
  if (stripped[j] !== "(") return null;
  // Capture (...) balanced on parens (ignore strings — already stripped)
  const parenStart = j;
  let depth = 0;
  while (j < stripped.length) {
    const c = stripped[j];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) { j++; break; }
    }
    j++;
  }
  const parenSegment = source.slice(parenStart, j); // pull from original source for human-readable
  // Optional return type: ": Type" up to '{' or ';' or '=>' or end-of-line for arrow.
  let retStart = j;
  while (retStart < stripped.length && /[ \t]/.test(stripped[retStart])) retStart++;
  let retEnd = retStart;
  let returnType = "";
  if (stripped[retStart] === ":") {
    retEnd = retStart + 1;
    let depthBracket = 0;
    while (retEnd < stripped.length) {
      const c = stripped[retEnd];
      // Stop on a body-opening '{' or terminating ';' at the same depth.
      if (depthBracket === 0 && (c === "{" || c === ";")) break;
      if (depthBracket === 0 && c === "\n") {
        // Arrow-return on next line — stop only if the next non-space is '{'.
        let k2 = retEnd + 1;
        while (k2 < stripped.length && (stripped[k2] === " " || stripped[k2] === "\t")) k2++;
        if (stripped[k2] === "{") break;
      }
      if (c === "<" || c === "(" || c === "[") depthBracket++;
      else if (c === ">" || c === ")" || c === "]") depthBracket--;
      retEnd++;
    }
    returnType = source.slice(retStart, retEnd).trim();
  }
  const cleanedParens = parenSegment.replace(/\s+/g, " ");
  const sig = name + cleanedParens + (returnType ? " " + returnType : "");
  return { signature: sig, endIndex: retEnd };
}

/**
 * Replace string literals and template literal contents with spaces of equal
 * length so brace/paren scanning isn't fooled by characters inside strings.
 * Also strips line + block comments. Newlines are preserved so line numbers
 * line up with the original source.
 */
function stripStrings(source: string): string {
  const out: string[] = [];
  const len = source.length;
  let i = 0;
  const BACKTICK = String.fromCharCode(96);
  const DOLLAR = "$";
  const OPEN_BRACE = "{";
  const CLOSE_BRACE = "}";

  while (i < len) {
    const c = source[i];

    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        for (let k = i; k < len; k++) out.push(source[k] === "\n" ? "\n" : " ");
        return out.join("");
      }
      for (let k = i; k < end + 2; k++) out.push(source[k] === "\n" ? "\n" : " ");
      i = end + 2;
      continue;
    }

    if (c === "/" && source[i + 1] === "/") {
      while (i < len && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < len) {
        const sc = source[i];
        if (sc === "\\" && i + 1 < len) {
          out.push("  ");
          i += 2;
          continue;
        }
        if (sc === c) {
          out.push(c);
          i++;
          break;
        }
        out.push(sc === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    if (c === BACKTICK) {
      // Treat the entire template literal — including any ${...} expressions —
      // as opaque content. Replace every char inside with spaces so brace/paren
      // accounting in the outer parser isn't fooled. Newlines preserved.
      out.push(c);
      i++;
      while (i < len) {
        const tc = source[i];
        if (tc === "\\" && i + 1 < len) {
          out.push("  ");
          i += 2;
          continue;
        }
        if (tc === BACKTICK) {
          out.push(BACKTICK);
          i++;
          break;
        }
        if (tc === DOLLAR && source[i + 1] === OPEN_BRACE) {
          // Skip over the entire ${ ... } expression, replacing all chars with
          // spaces (or newlines). Track real brace depth (ignoring nested
          // template literals' own braces, but those are zeroed too).
          out.push(" ");
          out.push(" ");
          i += 2;
          let depth = 1;
          while (i < len && depth > 0) {
            const ic = source[i];
            if (ic === OPEN_BRACE) depth++;
            else if (ic === CLOSE_BRACE) depth--;
            out.push(ic === "\n" ? "\n" : " ");
            i++;
          }
          continue;
        }
        out.push(tc === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }
  return out.join("");
}

// ── Indexer ──────────────────────────────────────────────────────────

function walkTsFiles(root: string): string[] {
  const found: string[] = [];
  function visit(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "tests" || e.name === "test" || e.name === "dist" || e.name === "build") continue;
        visit(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (!e.name.endsWith(".ts") && !e.name.endsWith(".js") && !e.name.endsWith(".mjs")) continue;
        if (e.name.endsWith(".test.ts") || e.name.endsWith(".test.js")) continue;
        if (e.name.endsWith(".d.ts")) continue;
        found.push(path.join(dir, e.name));
      }
    }
  }
  visit(root);
  return found.sort();
}

function buildEntriesForFile(
  absPath: string,
  source: "framework" | "user" | "vendor",
  fwRoots: string[],
  projectRoot: string,
  version: string,
  out: Map<string, InternalEntry>,
): void {
  let text: string;
  try {
    text = fs.readFileSync(absPath, "utf-8");
  } catch {
    return;
  }
  if (text.length > 1024 * 1024) return; // skip giant generated files
  let parsed: ParsedFile;
  try {
    parsed = parseTypeScript(text);
  } catch {
    return;
  }
  const rel = relativePath(absPath, projectRoot, fwRoots);

  for (const cls of parsed.classes) {
    if (!cls.exported && source === "framework") {
      // Internal helper class — skip from framework reflection.
      continue;
    }
    const fqn = cls.name;
    const summary = summariseDoc(cls.doc);
    const docBody = docblockBody(cls.doc);
    out.set(fqn, {
      fqn,
      kind: "class",
      name: cls.name,
      signature: `class ${cls.name}`,
      summary,
      file: rel,
      line: cls.line,
      version,
      source,
      visibility: "public",
      docblock: docBody,
      _private: false,
    });

    for (const m of cls.methods) {
      const isUnderscore = m.name.startsWith("_");
      const isPrivate = m.visibility !== "public" || isUnderscore;
      const methodFqn = `${fqn}.${m.name}`;
      const summary = summariseDoc(m.doc) || summariseDoc(cls.doc);
      out.set(methodFqn, {
        fqn: methodFqn,
        kind: "method",
        name: m.name,
        class: fqn,
        signature: m.signature,
        summary,
        file: rel,
        line: m.line,
        version,
        source,
        visibility: m.visibility,
        static: m.static,
        docblock: docblockBody(m.doc),
        _private: isPrivate,
      });
    }
  }

  for (const fn of parsed.functions) {
    // Only emit user-source top-level functions; framework top-level functions are
    // surface API but they explode the index. Keep them — they're searchable.
    const fqn = fn.name;
    if (!out.has(fqn)) {
      out.set(`fn:${fqn}`, {
        fqn,
        kind: "function",
        name: fn.name,
        signature: fn.signature,
        summary: summariseDoc(fn.doc),
        file: rel,
        line: fn.line,
        version,
        source,
        visibility: "public",
        docblock: docblockBody(fn.doc),
        _private: fn.name.startsWith("_"),
      });
    }
  }
}

// ── Drift helpers ────────────────────────────────────────────────────

// Backtick-fence regex built dynamically to avoid confusing TS parsers
// (some toolchains stumble on triple-backtick literals inside regex bodies).
const FENCE_RE = new RegExp(
  String.fromCharCode(96, 96, 96) + "[a-zA-Z0-9_+-]*\\n([\\s\\S]*?)\\n" + String.fromCharCode(96, 96, 96),
  "g",
);
const CALL_RE = /(?:[A-Za-z_$][\w$]*)(?:\.|::|->)([A-Za-z_$][\w$]*)\s*\(/g;

function buildLineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ── Public Docs class ───────────────────────────────────────────────

export class Docs {
  private projectRoot: string;
  private frameworkRoots: string[];
  private version: string;

  private indexCache: Map<string, InternalEntry> | null = null;
  private frameworkEntries: Map<string, InternalEntry> | null = null;
  private userEntries: Map<string, InternalEntry> = new Map();
  private userMtime = 0;
  private frameworkMtime = 0;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.frameworkRoots = detectFrameworkRoots();
    this.version = detectVersion(this.projectRoot);
  }

  /**
   * Search the merged framework + user index for query-matching entities.
   * Source filter accepts `all` (default), `framework`, `user`, `vendor`.
   * Private/underscore methods are excluded unless `includePrivate=true`.
   */
  search(query: string, k = 5, source: string = "all", includePrivate = false): DocsHit[] {
    this.ensureIndex();
    const tokens = tokenise(query);
    if (tokens.length === 0) return [];
    const joined = query.toLowerCase().replace(/\s+/g, "");
    const results: Array<DocsHit> = [];
    for (const entry of this.indexCache!.values()) {
      if (source !== "all" && entry.source !== source) continue;
      if (source === "all" && entry.source === "vendor") continue;
      if (!includePrivate && entry._private) continue;
      let score = this.scoreEntry(entry, tokens, joined);
      if (score <= 0) continue;
      if (entry.source === "user") score *= 1.2;
      const hit: DocsHit = {
        fqn: entry.fqn,
        kind: entry.kind,
        name: entry.name,
        signature: entry.signature,
        summary: entry.summary,
        file: entry.file,
        line: entry.line,
        version: entry.version,
        source: entry.source,
        visibility: entry.visibility,
        score: Math.round(score * 10000) / 10000,
      };
      if (entry.class) hit.class = entry.class;
      if (entry.static) hit.static = entry.static;
      results.push(hit);
    }
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.fqn.localeCompare(b.fqn);
    });
    return results.slice(0, Math.max(1, k));
  }

  /**
   * Resolve a class by exact FQN, documented public import path, or bare name.
   *
   * Node stores the bare class name as the FQN (`Database`), but a developer
   * reading the docs may type the published path (`@tina4/orm.Database`,
   * `orm/Database`) or just `Database`. Match exactly first, then by class
   * name (last path segment), disambiguating by requiring the given segments
   * to appear in the stored FQN/file (framework + shortest wins). Unknown
   * names stay `null` — no false positives.
   */
  private resolveClassEntry(given: string): InternalEntry | null {
    // 1. exact stored key.
    const exact = this.indexCache!.get(given);
    if (exact && exact.kind === "class") return exact;

    // Split the request on path/namespace separators (`.`, `/`, `\`), dropping
    // a leading scope marker like `@tina4`.
    const gsegs = given.split(/[./\\]+/).filter((s) => s && s !== "@tina4" && !s.startsWith("@"));
    const gname = (gsegs.length ? gsegs[gsegs.length - 1] : given).toLowerCase();

    const classes: InternalEntry[] = [];
    for (const e of this.indexCache!.values()) {
      if (e.kind === "class") classes.push(e);
    }
    const cands = classes.filter((e) => e.name.toLowerCase() === gname);
    if (cands.length === 1) return cands[0]; // 2a. unique class-name match
    if (cands.length === 0) return null;

    // 2b. disambiguate by segment subset — the given dotted/slashed segments
    // must all appear in the stored fqn or file path. Prefer framework, then
    // the shortest fqn, then lexical order.
    const lowSegs = gsegs.map((s) => s.toLowerCase());
    const subset = cands.filter((e) => {
      const hay = `${e.fqn} ${e.file}`.toLowerCase().split(/[./\\\s]+/).filter(Boolean);
      return lowSegs.every((s) => hay.includes(s));
    });
    const pool = subset.length ? subset : cands;
    pool.sort((a, b) => {
      const fa = a.source === "framework" ? 0 : 1;
      const fb = b.source === "framework" ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (a.fqn.length !== b.fqn.length) return a.fqn.length - b.fqn.length;
      return a.fqn.localeCompare(b.fqn);
    });
    return pool[0];
  }

  /**
   * Return the full spec for a single class, or `null` if not found.
   */
  classSpec(fqn: string): ClassSpec | null {
    this.ensureIndex();
    const cls = this.resolveClassEntry(fqn);
    if (!cls || cls.kind !== "class") return null;
    const methods: ClassSpec["methods"] = [];
    const prefix = `${cls.fqn}.`;
    for (const e of this.indexCache!.values()) {
      if (e.kind !== "method") continue;
      if (!e.fqn.startsWith(prefix)) continue;
      if (e.visibility !== "public") continue;
      methods.push({
        fqn: e.fqn,
        kind: "method",
        name: e.name,
        class: e.class!,
        signature: e.signature,
        summary: e.summary,
        docblock: e.docblock,
        file: e.file,
        line: e.line,
        version: e.version,
        source: e.source,
        visibility: e.visibility,
        static: e.static ?? false,
      });
    }
    return {
      fqn: cls.fqn,
      kind: "class",
      name: cls.name,
      file: cls.file,
      line: cls.line,
      summary: cls.summary,
      docblock: cls.docblock,
      source: cls.source,
      version: cls.version,
      methods,
      properties: [],
    };
  }

  /**
   * Return the spec for a single method, or `null` if unknown.
   */
  methodSpec(classFqn: string, methodName: string): MethodSpec | null {
    this.ensureIndex();
    const cls = this.resolveClassEntry(classFqn);
    if (!cls) return null;
    const key = `${cls.fqn}.${methodName}`;
    const entry = this.indexCache!.get(key);
    if (!entry || entry.kind !== "method") return null;
    return {
      name: entry.name,
      fqn: entry.fqn,
      class: entry.class!,
      kind: "method",
      signature: entry.signature,
      summary: entry.summary,
      docblock: entry.docblock,
      file: entry.file,
      line: entry.line,
      visibility: entry.visibility,
      static: entry.static ?? false,
      source: entry.source,
      version: entry.version,
      params: [],
      return: "",
    };
  }

  /**
   * Flat list of every reflected entity (classes + methods + functions),
   * user + framework. Vendor entries are included here for completeness.
   */
  index(): IndexEntry[] {
    this.ensureIndex();
    const out: IndexEntry[] = [];
    for (const e of this.indexCache!.values()) {
      const clean: IndexEntry = {
        fqn: e.fqn,
        kind: e.kind,
        name: e.name,
        signature: e.signature,
        summary: e.summary,
        file: e.file,
        line: e.line,
        version: e.version,
        source: e.source,
        visibility: e.visibility,
      };
      if (e.class) clean.class = e.class;
      if (e.static) clean.static = e.static;
      out.push(clean);
    }
    return out;
  }

  // ── MCP-style static mirrors ─────────────────────────────────────

  static mcpSearch(query: string, k = 5, projectRoot?: string, source: string = "all", includePrivate = false): DocsHit[] {
    return Docs.cached(projectRoot).search(query, k, source, includePrivate);
  }

  static mcpMethod(classFqn: string, name: string, projectRoot?: string): MethodSpec | null {
    return Docs.cached(projectRoot).methodSpec(classFqn, name);
  }

  static mcpClass(fqn: string, projectRoot?: string): ClassSpec | null {
    return Docs.cached(projectRoot).classSpec(fqn);
  }

  // ── Drift detector + sync ────────────────────────────────────────

  static checkDocs(mdPath: string, projectRoot?: string): { drift: DriftHit[] } {
    if (!fs.existsSync(mdPath)) return { drift: [] };
    const docs = Docs.cached(projectRoot ?? path.dirname(mdPath));
    const idx = docs.index();
    const known = new Set<string>();
    for (const e of idx) known.add(e.name.toLowerCase());

    const text = fs.readFileSync(mdPath, "utf-8");
    const lineOf = buildLineIndex(text);

    const drift: DriftHit[] = [];
    let m: RegExpExecArray | null;
    FENCE_RE.lastIndex = 0;
    while ((m = FENCE_RE.exec(text)) !== null) {
      const block = m[1];
      const blockStart = (m.index ?? 0) + (m[0].length - block.length - 4);
      let cm: RegExpExecArray | null;
      CALL_RE.lastIndex = 0;
      while ((cm = CALL_RE.exec(block)) !== null) {
        const name = cm[1];
        if (known.has(name.toLowerCase())) continue;
        if (STDLIB_ALLOWLIST.has(name)) continue;
        const offset = blockStart + (cm.index ?? 0);
        const line = lineOf(offset);
        const snippetLine = (block.split(/\r?\n/)[0] || "").trim();
        drift.push({ method: name, line, block: snippetLine });
      }
    }
    return { drift };
  }

  static syncDocs(mdPath: string, projectRoot?: string): void {
    const docs = Docs.cached(projectRoot ?? (fs.existsSync(mdPath) ? path.dirname(mdPath) : process.cwd()));
    const generated = docs.renderGeneratedBlock();
    const begin = "<!-- BEGIN GENERATED API -->";
    const end = "<!-- END GENERATED API -->";
    const existing = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf-8") : "";
    if (existing.includes(begin) && existing.includes(end)) {
      const re = new RegExp(
        begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "[\\s\\S]*?" +
          end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      );
      const replaced = existing.replace(re, `${begin}\n${generated}\n${end}`);
      fs.writeFileSync(mdPath, replaced, "utf-8");
      return;
    }
    fs.writeFileSync(mdPath, `${existing.replace(/\s+$/, "")}\n\n${begin}\n${generated}\n${end}\n`, "utf-8");
  }

  // ── Internals ────────────────────────────────────────────────────

  private static cached(projectRoot?: string): Docs {
    const key = path.resolve(projectRoot ?? process.cwd());
    let inst = _DOCS_CACHE.get(key);
    if (!inst) {
      inst = new Docs(key);
      _DOCS_CACHE.set(key, inst);
    }
    return inst;
  }

  private ensureIndex(): void {
    // Framework: rebuild only if not built yet OR mtime changed.
    const fwMtime = this.maxMtime(this.frameworkRoots);
    if (this.frameworkEntries === null || fwMtime !== this.frameworkMtime) {
      this.frameworkEntries = new Map();
      for (const root of this.frameworkRoots) {
        for (const f of walkTsFiles(root)) {
          buildEntriesForFile(f, "framework", this.frameworkRoots, this.projectRoot, this.version, this.frameworkEntries);
        }
      }
      this.frameworkMtime = fwMtime;
      this.indexCache = null;
    }

    const userMtime = this.maxMtime(USER_DIRS.map((d) => path.join(this.projectRoot, d)));
    if (this.indexCache === null || userMtime !== this.userMtime) {
      this.userEntries = new Map();
      for (const sub of USER_DIRS) {
        const dir = path.join(this.projectRoot, sub);
        if (!fs.existsSync(dir)) continue;
        for (const f of walkTsFiles(dir)) {
          buildEntriesForFile(f, "user", this.frameworkRoots, this.projectRoot, this.version, this.userEntries);
        }
      }
      this.userMtime = userMtime;
      // Merge: framework first, user overrides (user has 1.2x boost anyway).
      this.indexCache = new Map();
      for (const [k, v] of this.frameworkEntries) this.indexCache.set(k, v);
      for (const [k, v] of this.userEntries) this.indexCache.set(k, v);
    }
  }

  private maxMtime(dirs: string[]): number {
    let max = 0;
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of walkTsFiles(dir)) {
        try {
          const st = fs.statSync(f);
          if (st.mtimeMs > max) max = st.mtimeMs;
        } catch { /* ignore */ }
      }
    }
    return Math.floor(max);
  }

  private scoreEntry(entry: InternalEntry, tokens: string[], joined: string): number {
    const name = entry.name.toLowerCase();
    const stripped = name.replace(/^_+/, "");
    const summary = entry.summary.toLowerCase();
    const doc = entry.docblock.toLowerCase();
    let score = 0;

    if (name === joined || stripped === joined) score += 5;

    const nameTokens = tokenise(entry.name);
    for (const tk of tokens) {
      if (!tk) continue;
      if (name.startsWith(tk) || stripped.startsWith(tk)) {
        score += 3;
        continue;
      }
      let hit = false;
      for (const nt of nameTokens) {
        if (nt === tk) { score += 3; hit = true; break; }
        if (nt.startsWith(tk)) { score += 2; hit = true; break; }
      }
      if (!hit && name.includes(tk)) score += 0.5;
    }
    for (const tk of tokens) {
      if (tk && summary.includes(tk)) score += 2;
    }
    for (const tk of tokens) {
      if (tk && doc.includes(tk)) score += 1;
    }
    // Class-qualified queries ("Frond.addTest" / "Frond addTest"): score the
    // owning class so the qualifier steers ranking instead of being dead weight.
    const parent = (entry.class ?? "").toLowerCase();
    if (parent) {
      // Normalise `.`/`:`/whitespace in the joined query to a single `.` so
      // "frond.addtest", "frond:addtest" and "frondaddtest" all compare alike.
      const qNorm = joined.replace(/[:.]+/g, ".");
      if (qNorm === `${parent}.${name}` || qNorm === `${parent}.${stripped}`) {
        score += 6; // exact "Class.method" intent — the strongest signal
      }
      for (const tk of tokens) {
        if (tk === parent) score += 2.5;
        else if (tk && parent.startsWith(tk)) score += 1;
      }
    }
    // Any token that is a whole segment of the fqn (module / class / name).
    const fqnSegs = new Set(entry.fqn.toLowerCase().split(/[.\s:]+/).filter(Boolean));
    for (const tk of tokens) {
      if (tk && fqnSegs.has(tk)) score += 1;
    }
    if (joined && score === 0 && name.includes(joined)) score += 2;
    return score;
  }

  private renderGeneratedBlock(): string {
    this.ensureIndex();
    const fwClasses: InternalEntry[] = [];
    const userClasses: InternalEntry[] = [];
    const methodCounts = new Map<string, number>();
    for (const e of this.indexCache!.values()) {
      if (e.kind === "class") {
        if (e.source === "framework") fwClasses.push(e);
        else if (e.source === "user") userClasses.push(e);
      } else if (e.kind === "method" && e.class) {
        methodCounts.set(e.class, (methodCounts.get(e.class) ?? 0) + 1);
      }
    }
    fwClasses.sort((a, b) => a.fqn.localeCompare(b.fqn));
    userClasses.sort((a, b) => a.fqn.localeCompare(b.fqn));

    const lines: string[] = [];
    lines.push(`_Generated by \`@tina4/core/docs\` — version ${this.version}._`);
    lines.push("");
    lines.push("## Framework API");
    lines.push("");
    lines.push("| Class | Summary | Methods |");
    lines.push("|---|---|---|");
    for (const c of fwClasses) {
      const summary = c.summary.replace(/\|/g, "\\|");
      lines.push(`| ${c.fqn} | ${summary} | ${methodCounts.get(c.fqn) ?? 0} |`);
    }
    if (userClasses.length > 0) {
      lines.push("");
      lines.push("## User Surface");
      lines.push("");
      lines.push("| Class | Summary | Methods |");
      lines.push("|---|---|---|");
      for (const c of userClasses) {
        const summary = c.summary.replace(/\|/g, "\\|");
        lines.push(`| ${c.fqn} | ${summary} | ${methodCounts.get(c.fqn) ?? 0} |`);
      }
    }
    return lines.join("\n");
  }
}

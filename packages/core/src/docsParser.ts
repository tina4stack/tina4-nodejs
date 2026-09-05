// ── TS regex parser ──────────────────────────────────────────────────
import { stripStrings } from "./docsScanner.js";
import { matchMethodSignature, matchTopLevelFunction } from "./docsSignatures.js";

export interface ParsedClass {
  name: string;
  line: number;
  doc: string;
  exported: boolean;
  methods: ParsedMethod[];
}

export interface ParsedMethod {
  name: string;
  line: number;
  doc: string;
  signature: string;
  visibility: "public" | "protected" | "private";
  static: boolean;
}

export interface ParsedFile {
  classes: ParsedClass[];
  functions: ParsedMethod[];
}

const CLASS_RE = /(?:^|\n)([ \t]*)((?:export\s+(?:default\s+)?(?:abstract\s+)?)?class\s+([A-Za-z_$][\w$]*))[\s\S]*?(?=\n[ \t]*(?:export\s+(?:default\s+)?(?:abstract\s+)?class|export\s+function|function|$))/g;

interface ClassContext {
  name: string;
  bodyStartDepth: number;
  entry: ParsedClass;
  isExport: boolean;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function readDocComment(stripped: string, source: string, start: number): { doc: string; next: number } | null {
  if (!(stripped[start] === "/" && stripped[start + 1] === "*" && stripped[start + 2] === "*")) return null;
  const end = stripped.indexOf("*/", start + 3);
  return end === -1
    ? { doc: "", next: -1 }
    : { doc: source.slice(start, end + 2), next: end + 2 };
}

function startClass(
  stripped: string,
  source: string,
  lines: string[],
  index: number,
  braceDepth: number,
  pendingDoc: string,
): { context: ClassContext; next: number } | null {
  if (!isWordBoundary(stripped, index) || !matchKeyword(stripped, index, "class")) return null;
  const after = index + "class".length;
  const nameMatch = /^\s+([A-Za-z_$][\w$]*)/.exec(stripped.slice(after));
  if (!nameMatch) return null;
  const name = nameMatch[1];
  let open = after + nameMatch[0].length;
  while (open < stripped.length && stripped[open] !== "{") open++;
  if (open >= stripped.length) return null;
  const entry: ParsedClass = {
    name,
    line: lineNumberAt(source, index),
    doc: pendingDoc,
    exported: isExportedAt(stripped, lines, lineNumberAt(source, index), name),
    methods: [],
  };
  return {
    context: { name, bodyStartDepth: braceDepth, entry, isExport: entry.exported },
    next: open + 1,
  };
}

function closeClasses(
  braceDepth: number,
  stack: ClassContext[],
  classes: ParsedClass[],
): void {
  while (stack.length > 0 && braceDepth <= stack[stack.length - 1].bodyStartDepth) {
    classes.push(stack.pop()!.entry);
  }
}

function recordClassMethod(
  stripped: string,
  source: string,
  index: number,
  stack: ClassContext[],
  pendingDoc: string,
): number | null {
  const match = matchMethodSignature(stripped, source, index);
  if (!match) return null;
  const cls = stack[stack.length - 1];
  cls.entry.methods.push({
    name: match.name,
    line: lineNumberAt(source, match.nameStart ?? index),
    doc: pendingDoc,
    signature: match.signature,
    visibility: match.visibility,
    static: match.static,
  });
  return match.endIndex;
}

function recordTopLevelFunction(
  stripped: string,
  source: string,
  index: number,
  functions: ParsedMethod[],
  pendingDoc: string,
): number | null {
  const match = matchTopLevelFunction(stripped, source, index);
  if (!match) return null;
  functions.push({
    name: match.name,
    line: lineNumberAt(source, match.nameStart ?? index),
    doc: pendingDoc,
    signature: match.signature,
    visibility: "public",
    static: false,
  });
  return match.endIndex;
}

/**
 * Parse a TS source string. Lightweight — finds top-level classes and their
 * public methods, plus top-level exported functions. Captures preceding JSDoc.
 *
 * Strategy: scan token-by-token. We don't need a full AST — we only care
 * about identifying class declarations, brace depth (to find class members),
 * method/function declarations, and JSDoc comments immediately above.
 */
export function parseTypeScript(source: string, _debugTag = ""): ParsedFile {
  const classes: ParsedClass[] = [];
  const functions: ParsedMethod[] = [];

  // Strip line comments and string contents (preserve length for line numbers).
  const stripped = stripStrings(source);
  const lines = source.split(/\r?\n/);

  let i = 0;
  let pendingDoc = "";
  const len = stripped.length;
  let braceDepth = 0;
  const classStack: ClassContext[] = [];

  while (i < len) {
    const ch = stripped[i];

    const doc = readDocComment(stripped, source, i);
    if (doc) {
      if (doc.next === -1) break;
      pendingDoc = doc.doc;
      i = doc.next;
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
      closeClasses(braceDepth, classStack, classes);
      i++;
      continue;
    }

    const classStart = startClass(stripped, source, lines, i, braceDepth, pendingDoc);
    if (classStart) {
      classStack.push(classStart.context);
      pendingDoc = "";
      braceDepth++;
      i = classStart.next;
      continue;
    }

    // Method or top-level function detection — we only care about either:
    //   * methods inside a class body (classStack non-empty AND directly inside class body)
    //   * top-level "export function" or "function" declarations
    if (classStack.length > 0
        && braceDepth === classStack[classStack.length - 1].bodyStartDepth + 1) {
      const next = recordClassMethod(stripped, source, i, classStack, pendingDoc);
      if (next !== null) {
        pendingDoc = "";
        i = next;
        continue;
      }
    } else if (braceDepth === 0) {
      const next = recordTopLevelFunction(stripped, source, i, functions, pendingDoc);
      if (next !== null) {
        pendingDoc = "";
        i = next;
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

/**
 * Tina4 Frond Engine — Lexer, parser, and runtime.
 * Zero-dependency Twig-like template engine.
 * Supports: variables, filters, if/elseif/else/endif, for/else/endfor,
 * extends/block, include, macro, set, comments, whitespace control, tests.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────

export type FilterFn = (value: unknown, ...args: unknown[]) => unknown;
export type TestFn = (value: unknown) => boolean;

/** Marker class for strings that should not be auto-escaped. */
class SafeString {
  constructor(public value: string) {}
  toString() { return this.value; }
}

type TokenType = "TEXT" | "VAR" | "BLOCK" | "COMMENT";
type Token = [TokenType, string];

// ── Lexer ──────────────────────────────────────────────────────

const TOKEN_RE = /(\{%-?\s*[\s\S]*?\s*-?%\})|(\{\{-?\s*[\s\S]*?\s*-?\}\})|(\{#[\s\S]*?#\})/g;

// Regex to extract {% raw %}...{% endraw %} blocks before tokenizing
const RAW_BLOCK_RE = /\{%-?\s*raw\s*-?%\}([\s\S]*?)\{%-?\s*endraw\s*-?%\}/g;

function tokenize(source: string): Token[] {
  // 1. Extract raw blocks and replace with placeholders
  const rawBlocks: string[] = [];
  source = source.replace(RAW_BLOCK_RE, (_match, content) => {
    const idx = rawBlocks.length;
    rawBlocks.push(content);
    return `\x00RAW_${idx}\x00`;
  });

  // 2. Normal tokenization
  const tokens: Token[] = [];
  let pos = 0;

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(source)) !== null) {
    const start = m.index;
    if (start > pos) {
      tokens.push(["TEXT", source.slice(pos, start)]);
    }

    const raw = m[0];
    if (raw.startsWith("{#")) {
      tokens.push(["COMMENT", raw]);
    } else if (raw.startsWith("{{")) {
      tokens.push(["VAR", raw]);
    } else if (raw.startsWith("{%")) {
      tokens.push(["BLOCK", raw]);
    }
    pos = m.index + raw.length;
  }

  if (pos < source.length) {
    tokens.push(["TEXT", source.slice(pos)]);
  }

  // 3. Restore raw block placeholders as literal TEXT
  if (rawBlocks.length > 0) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i][0] === "TEXT" && tokens[i][1].includes("\x00RAW_")) {
        let value = tokens[i][1];
        for (let idx = 0; idx < rawBlocks.length; idx++) {
          value = value.replace(`\x00RAW_${idx}\x00`, rawBlocks[idx]);
        }
        tokens[i] = ["TEXT", value];
      }
    }
  }

  return tokens;
}

function stripTag(raw: string): [string, boolean, boolean] {
  let inner: string;
  if (raw.startsWith("{{")) {
    inner = raw.slice(2, -2);
  } else if (raw.startsWith("{%")) {
    inner = raw.slice(2, -2);
  } else {
    inner = raw.slice(2, -2);
  }

  let stripBefore = false;
  let stripAfter = false;

  if (inner.startsWith("-")) {
    stripBefore = true;
    inner = inner.slice(1);
  }
  if (inner.endsWith("-")) {
    stripAfter = true;
    inner = inner.slice(0, -1);
  }

  return [inner.trim(), stripBefore, stripAfter];
}

// ── Expression Evaluator ───────────────────────────────────────

function resolveVar(expr: string, context: Record<string, unknown>): unknown {
  expr = expr.trim();

  // String literal
  if ((expr.startsWith('"') && expr.endsWith('"')) ||
      (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }

  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(expr)) {
    return expr.includes(".") ? parseFloat(expr) : parseInt(expr, 10);
  }

  // Boolean/null literals
  if (expr === "true") return true;
  if (expr === "false") return false;
  if (expr === "null" || expr === "none" || expr === "None") return null;

  // Array literal [...]
  if (expr.startsWith("[") && expr.endsWith("]")) {
    const inner = expr.slice(1, -1).trim();
    if (inner === "") return [];
    const items = splitArgs(inner);
    return items.map(item => evalExpr(item.trim(), context));
  }

  // Dotted path with bracket access
  const parts = expr.split(/\.|\[([^\]]+)\]/g).filter(p => p !== undefined && p !== "");

  let value: unknown = context;
  for (const part of parts) {
    if (value === null || value === undefined) return null;

    let key: string | number = part.replace(/^['"]|['"]$/g, "");
    const asNum = parseInt(key, 10);
    if (!isNaN(asNum) && String(asNum) === key) {
      key = asNum;
    }

    if (typeof value === "object" && value !== null) {
      if (Array.isArray(value) && typeof key === "number") {
        value = (value as unknown[])[key];
      } else if (key in (value as Record<string, unknown>)) {
        const v = (value as Record<string, unknown>)[key as string];
        value = typeof v === "function" ? v.call(value) : v;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  return value;
}

function evalExpr(expr: string, context: Record<string, unknown>): unknown {
  expr = expr.trim();

  // Ternary: condition ? true_val : false_val
  // Match carefully to handle nested ternaries
  const ternaryIdx = findTernary(expr);
  if (ternaryIdx !== -1) {
    const condPart = expr.slice(0, ternaryIdx).trim();
    const rest = expr.slice(ternaryIdx + 1);
    const colonIdx = findColon(rest);
    if (colonIdx !== -1) {
      const truePart = rest.slice(0, colonIdx).trim();
      const falsePart = rest.slice(colonIdx + 1).trim();
      const cond = evalExpr(condPart, context);
      return cond ? evalExpr(truePart, context) : evalExpr(falsePart, context);
    }
  }

  // Jinja2-style inline if: value if condition else other_value
  const inlineIfMatch = expr.match(/^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/);
  if (inlineIfMatch) {
    const cond = evalExpr(inlineIfMatch[2], context);
    return cond ? evalExpr(inlineIfMatch[1], context) : evalExpr(inlineIfMatch[3], context);
  }

  // Null coalescing: value ?? "default"
  const qqIdx = expr.indexOf("??");
  if (qqIdx !== -1) {
    const left = expr.slice(0, qqIdx).trim();
    const right = expr.slice(qqIdx + 2).trim();
    const val = evalExpr(left, context);
    if (val === null || val === undefined) {
      return evalExpr(right, context);
    }
    return val;
  }

  // String concatenation with ~
  if (expr.includes("~")) {
    const parts = splitOnTilde(expr);
    if (parts.length > 1) {
      return parts.map(p => {
        const v = evalExpr(p.trim(), context);
        return v === null || v === undefined ? "" : String(v);
      }).join("");
    }
  }

  // Check for comparison/logical operators
  for (const op of [" not in ", " in ", " is not ", " is ", "!=", "==", ">=", "<=", ">", "<", " and ", " or ", " not "]) {
    if (expr.includes(op)) {
      return evalComparison(expr, context);
    }
  }

  // Function call: name("arg1", "arg2")
  const fnMatch = expr.match(/^(\w+)\s*\(([\s\S]*)?\)$/);
  if (fnMatch) {
    const fnName = fnMatch[1];
    const rawArgs = fnMatch[2] || "";
    const fn = context[fnName] ?? resolveVar(fnName, context);
    if (typeof fn === "function") {
      if (rawArgs.trim()) {
        const parts = splitArgs(rawArgs);
        const evalArgs = parts.map(a => evalExpr(a.trim(), context));
        return fn(...evalArgs);
      }
      return fn();
    }
  }

  return resolveVar(expr, context);
}

function findTernary(expr: string): number {
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (ch === "?" && depth === 0 && expr[i + 1] !== "?") {
      return i;
    }
  }
  return -1;
}

function findColon(expr: string): number {
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (ch === ":" && depth === 0) {
      return i;
    }
  }
  return -1;
}

function splitOnTilde(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; current += ch; continue; }
    if (ch === "~") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function evalComparison(expr: string, context: Record<string, unknown>): boolean {
  expr = expr.trim();

  // Handle 'not' prefix
  if (expr.startsWith("not ")) {
    return !evalComparison(expr.slice(4), context);
  }

  // 'or' (lowest precedence)
  const orParts = splitOnKeyword(expr, " or ");
  if (orParts.length > 1) {
    return orParts.some(p => evalComparison(p, context));
  }

  // 'and'
  const andParts = splitOnKeyword(expr, " and ");
  if (andParts.length > 1) {
    return andParts.every(p => evalComparison(p, context));
  }

  // 'is not' test
  let m = expr.match(/^(.+?)\s+is\s+not\s+(\w+)(.*)$/);
  if (m) {
    return !evalTest(m[1].trim(), m[2], m[3].trim(), context);
  }

  // 'is' test
  m = expr.match(/^(.+?)\s+is\s+(\w+)(.*)$/);
  if (m) {
    return evalTest(m[1].trim(), m[2], m[3].trim(), context);
  }

  // 'not in'
  m = expr.match(/^(.+?)\s+not\s+in\s+(.+)$/);
  if (m) {
    const val = evalExpr(m[1].trim(), context);
    const collection = evalExpr(m[2].trim(), context);
    if (Array.isArray(collection)) return !collection.includes(val);
    if (typeof collection === "string") return !collection.includes(val as string);
    return true;
  }

  // 'in'
  m = expr.match(/^(.+?)\s+in\s+(.+)$/);
  if (m) {
    const val = evalExpr(m[1].trim(), context);
    const collection = evalExpr(m[2].trim(), context);
    if (Array.isArray(collection)) return collection.includes(val);
    if (typeof collection === "string") return collection.includes(val as string);
    return false;
  }

  // Binary operators
  const ops: [string, (a: unknown, b: unknown) => boolean][] = [
    ["!=", (a, b) => a !== b],
    ["==", (a, b) => a == b], // intentional loose equality to match Python
    [">=", (a, b) => (a as number) >= (b as number)],
    ["<=", (a, b) => (a as number) <= (b as number)],
    [">", (a, b) => (a as number) > (b as number)],
    ["<", (a, b) => (a as number) < (b as number)],
  ];

  for (const [op, fn] of ops) {
    const opIdx = expr.indexOf(op);
    if (opIdx !== -1) {
      const left = expr.slice(0, opIdx).trim();
      const right = expr.slice(opIdx + op.length).trim();
      const l = evalExpr(left, context);
      const r = evalExpr(right, context);
      try {
        return fn(l, r);
      } catch {
        return false;
      }
    }
  }

  // Fall through to simple eval
  const val = evalExpr(expr, context);
  return val !== null && val !== undefined && val !== false && val !== 0 && val !== "";
}

function splitOnKeyword(expr: string, keyword: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let depth = 0;
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === "(") { depth++; current += ch; i++; continue; }
    if (ch === ")") { depth--; current += ch; i++; continue; }

    if (depth === 0 && expr.slice(i, i + keyword.length) === keyword) {
      parts.push(current);
      current = "";
      i += keyword.length;
      continue;
    }
    current += ch;
    i++;
  }
  if (current) parts.push(current);
  return parts;
}

function evalTest(
  valueExpr: string,
  testName: string,
  args: string,
  context: Record<string, unknown>,
): boolean {
  const val = evalExpr(valueExpr, context);

  // Check custom tests first
  const customTests = (context as { __frond_tests__?: Record<string, TestFn> }).__frond_tests__;
  if (customTests && customTests[testName]) {
    return customTests[testName](val);
  }

  const tests: Record<string, (v: unknown) => boolean> = {
    defined: (v) => v !== null && v !== undefined,
    empty: (v) => !v || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && Object.keys(v).length === 0),
    null: (v) => v === null || v === undefined,
    none: (v) => v === null || v === undefined,
    even: (v) => typeof v === "number" && Number.isInteger(v) && v % 2 === 0,
    odd: (v) => typeof v === "number" && Number.isInteger(v) && v % 2 !== 0,
    iterable: (v) => Array.isArray(v) || (typeof v === "object" && v !== null),
    string: (v) => typeof v === "string",
    number: (v) => typeof v === "number",
    boolean: (v) => typeof v === "boolean",
  };

  // 'divisible by(n)'
  if (testName === "divisible") {
    const dm = args.match(/\s*by\s*\(\s*(\d+)\s*\)/);
    if (dm) {
      const n = parseInt(dm[1], 10);
      return typeof val === "number" && Number.isInteger(val) && val % n === 0;
    }
    return false;
  }

  if (testName in tests) {
    return tests[testName](val);
  }

  return false;
}

// ── Filters ────────────────────────────────────────────────────

function parseFilterChain(expr: string): [string, [string, string[]][]] {
  // Split on | but not inside strings or parentheses
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let depth = 0;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") { depth++; current += ch; continue; }
    if (ch === ")") { depth--; current += ch; continue; }
    if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);

  const variable = parts[0].trim();
  const filters: [string, string[]][] = [];

  for (let i = 1; i < parts.length; i++) {
    const f = parts[i].trim();
    const fm = f.match(/^(\w+)\s*\(([\s\S]*)\)$/);
    if (fm) {
      const name = fm[1];
      const rawArgs = fm[2].trim();
      const args = rawArgs ? parseArgs(rawArgs) : [];
      filters.push([name, args]);
    } else {
      filters.push([f.trim(), []]);
    }
  }

  return [variable, filters];
}

function parseArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let wasQuoted = false;
  let depth = 0;

  for (const ch of raw) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      wasQuoted = true;
      // Discard any whitespace accumulated before the opening quote
      if (current.trim() === "") current = "";
      continue;
    }
    if (ch === "(") { depth++; current += ch; continue; }
    if (ch === ")") { depth--; current += ch; continue; }
    if (ch === "," && depth === 0) {
      args.push(wasQuoted ? current : current.trim());
      current = "";
      wasQuoted = false;
      continue;
    }
    current += ch;
  }

  const final = wasQuoted ? current : current.trim();
  if (final !== "" || wasQuoted) {
    args.push(final);
  }

  return args;
}

function splitArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let depth = 0;

  for (const ch of raw) {
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") { depth++; current += ch; continue; }
    if (ch === ")" || ch === "]") { depth--; current += ch; continue; }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function htmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function dateFilter(value: unknown, fmt: string): string {
  let dt: Date;
  if (value instanceof Date) {
    dt = value;
  } else if (typeof value === "string") {
    dt = new Date(value);
    if (isNaN(dt.getTime())) return String(value);
  } else if (typeof value === "number") {
    dt = new Date(value);
  } else {
    return String(value);
  }

  // Python strftime format to manual conversion
  return fmt
    .replace(/%Y/g, String(dt.getFullYear()))
    .replace(/%m/g, String(dt.getMonth() + 1).padStart(2, "0"))
    .replace(/%d/g, String(dt.getDate()).padStart(2, "0"))
    .replace(/%H/g, String(dt.getHours()).padStart(2, "0"))
    .replace(/%M/g, String(dt.getMinutes()).padStart(2, "0"))
    .replace(/%S/g, String(dt.getSeconds()).padStart(2, "0"))
    .replace(/%I/g, String(dt.getHours() % 12 || 12).padStart(2, "0"))
    .replace(/%p/g, dt.getHours() >= 12 ? "PM" : "AM")
    .replace(/%B/g, dt.toLocaleString("en-US", { month: "long" }))
    .replace(/%b/g, dt.toLocaleString("en-US", { month: "short" }))
    .replace(/%A/g, dt.toLocaleString("en-US", { weekday: "long" }))
    .replace(/%a/g, dt.toLocaleString("en-US", { weekday: "short" }));
}

function wordwrap(text: string, width: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function numberFormat(value: unknown, decimals: number): string {
  const num = parseFloat(String(value));
  const fixed = num.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart ? `${formatted}.${decPart}` : formatted;
}

const BUILTIN_FILTERS: Record<string, FilterFn> = {
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  capitalize: (v) => { const s = String(v); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); },
  title: (v) => String(v).replace(/\b\w/g, c => c.toUpperCase()),
  trim: (v) => String(v).trim(),
  ltrim: (v) => String(v).replace(/^\s+/, ""),
  rtrim: (v) => String(v).replace(/\s+$/, ""),
  length: (v) => {
    if (Array.isArray(v)) return v.length;
    if (typeof v === "string") return v.length;
    if (typeof v === "object" && v !== null) return Object.keys(v).length;
    return 0;
  },
  reverse: (v) => Array.isArray(v) ? [...v].reverse() : String(v).split("").reverse().join(""),
  sort: (v) => Array.isArray(v) ? [...v].sort() : v,
  shuffle: (v) => {
    if (!Array.isArray(v)) return v;
    const arr = [...v];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },
  first: (v) => Array.isArray(v) ? v[0] ?? null : null,
  last: (v) => Array.isArray(v) ? v[v.length - 1] ?? null : null,
  join: (v, sep) => Array.isArray(v) ? v.map(String).join(sep !== undefined ? String(sep) : ", ") : String(v),
  split: (v, sep) => String(v).split(sep !== undefined ? String(sep) : " "),
  replace: (v, from, to) => from !== undefined && to !== undefined ? String(v).split(String(from)).join(String(to)) : String(v),
  default: (v, fallback) => (v !== null && v !== undefined && v !== "") ? v : (fallback !== undefined ? fallback : ""),
  raw: (v) => v,
  safe: (v) => v,
  escape: (v) => htmlEscape(String(v)),
  e: (v) => htmlEscape(String(v)),
  striptags: (v) => String(v).replace(/<[^>]+>/g, ""),
  nl2br: (v) => String(v).replace(/\n/g, "<br>\n"),
  abs: (v) => typeof v === "number" ? Math.abs(v) : v,
  round: (v, decimals) => {
    const d = decimals !== undefined ? parseInt(String(decimals), 10) : 0;
    return parseFloat(parseFloat(String(v)).toFixed(d));
  },
  int: (v) => v ? parseInt(String(v), 10) || 0 : 0,
  float: (v) => v ? parseFloat(String(v)) || 0.0 : 0.0,
  string: (v) => String(v),
  json_encode: (v) => JSON.stringify(v),
  json_decode: (v) => typeof v === "string" ? JSON.parse(v) : v,
  keys: (v) => (typeof v === "object" && v !== null && !Array.isArray(v)) ? Object.keys(v) : [],
  values: (v) => (typeof v === "object" && v !== null && !Array.isArray(v)) ? Object.values(v) : [],
  merge: (v, other) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v) && typeof other === "object" && other !== null) {
      return { ...(v as Record<string, unknown>), ...(other as Record<string, unknown>) };
    }
    return v;
  },
  slice: (v, start, end) => {
    if (Array.isArray(v) || typeof v === "string") {
      return v.slice(
        start !== undefined ? parseInt(String(start), 10) : 0,
        end !== undefined ? parseInt(String(end), 10) : undefined,
      );
    }
    return v;
  },
  batch: (v, size) => {
    if (!Array.isArray(v) || size === undefined) return [v];
    const s = parseInt(String(size), 10);
    const result: unknown[][] = [];
    for (let i = 0; i < v.length; i += s) {
      result.push(v.slice(i, i + s));
    }
    return result;
  },
  unique: (v) => {
    if (!Array.isArray(v)) return v;
    return [...new Set(v)];
  },
  map: (v, key) => {
    if (!Array.isArray(v) || key === undefined) return v;
    return v.map(item => {
      if (typeof item === "object" && item !== null) {
        return (item as Record<string, unknown>)[String(key)] ?? null;
      }
      return null;
    });
  },
  filter: (v) => Array.isArray(v) ? v.filter(Boolean) : v,
  column: (v, key) => {
    if (!Array.isArray(v) || key === undefined) return v;
    return v.map(row => {
      if (typeof row === "object" && row !== null) {
        return (row as Record<string, unknown>)[String(key)] ?? null;
      }
      return null;
    });
  },
  number_format: (v, decimals) => numberFormat(v, decimals !== undefined ? parseInt(String(decimals), 10) : 0),
  date: (v, fmt) => dateFilter(v, fmt !== undefined ? String(fmt) : "%Y-%m-%d"),
  truncate: (v, length) => {
    const s = String(v);
    if (length !== undefined && s.length > parseInt(String(length), 10)) {
      return s.slice(0, parseInt(String(length), 10)) + "...";
    }
    return s;
  },
  wordwrap: (v, width) => wordwrap(String(v), width !== undefined ? parseInt(String(width), 10) : 75),
  slug: (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  md5: (v) => createHash("md5").update(String(v)).digest("hex"),
  sha256: (v) => createHash("sha256").update(String(v)).digest("hex"),
  base64_encode: (v) => Buffer.isBuffer(v) ? v.toString("base64") : Buffer.from(String(v)).toString("base64"),
  base64_decode: (v) => Buffer.from(String(v), "base64").toString("utf-8"),
  data_uri: (v) => {
    if (v && typeof v === "object" && "content" in v) {
      const ct = (v as any).type ?? "application/octet-stream";
      const raw = Buffer.isBuffer((v as any).content) ? (v as any).content : Buffer.from(String((v as any).content));
      return `data:${ct};base64,${raw.toString("base64")}`;
    }
    return String(v);
  },
  url_encode: (v) => encodeURIComponent(String(v)),
  format: (v, ...args) => {
    let s = String(v);
    // Simple %s / %d replacement like Python's % operator
    let idx = 0;
    s = s.replace(/%[sd]/g, () => {
      const val = idx < args.length ? String(args[idx]) : "";
      idx++;
      return val;
    });
    return s;
  },
  dump: (v) => JSON.stringify(v),
  formToken: (v?: unknown) => _generateFormToken(v != null ? String(v) : ""),
  form_token: (v?: unknown) => _generateFormToken(v != null ? String(v) : ""),
};

// ── Form Token ────────────────────────────────────────────────

function _b64url(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a JWT form token and return a hidden input element.
 *
 * @param descriptor - Optional string to enrich the token payload.
 *   - Empty: payload is {"type":"form"}
 *   - "admin_panel": payload is {"type":"form","context":"admin_panel"}
 *   - "checkout|order_123": payload is {"type":"form","context":"checkout","ref":"order_123"}
 *
 * @returns `<input type="hidden" name="formToken" value="TOKEN">`
 */
function _generateFormToken(descriptor: string = ""): SafeString {
  const secret = process.env.SECRET || "tina4-default-secret";
  const ttlMinutes = parseInt(process.env.TINA4_TOKEN_LIMIT || "30", 10);

  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { type: "form", iat: now, exp: now + ttlMinutes * 60 };

  if (descriptor) {
    if (descriptor.includes("|")) {
      const [ctx, ref] = descriptor.split("|", 2);
      payload.context = ctx;
      payload.ref = ref;
    } else {
      payload.context = descriptor;
    }
  }

  const h = _b64url(Buffer.from(JSON.stringify(header)));
  const p = _b64url(Buffer.from(JSON.stringify(payload)));
  const sigInput = `${h}.${p}`;
  const sig = _b64url(createHmac("sha256", secret).update(sigInput).digest());

  const token = `${h}.${p}.${sig}`;
  const escaped = token.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new SafeString(`<input type="hidden" name="formToken" value="${escaped}">`);
}

// ── Frond Engine ───────────────────────────────────────────────

export class Frond {
  private templateDir: string;
  private filters: Record<string, FilterFn>;
  private globals: Record<string, unknown>;
  private tests: Record<string, TestFn>;
  private _sandbox: boolean;
  private _allowedFilters: Set<string> | null;
  private _allowedTags: Set<string> | null;
  private _allowedVars: Set<string> | null;
  private fragmentCache: Map<string, [string, number]>;
  private _autoEscape: boolean;
  /** Token pre-compilation cache for file templates */
  private compiled = new Map<string, { tokens: Token[]; mtime: number }>();
  /** Token pre-compilation cache for string templates */
  private compiledStrings = new Map<string, Token[]>();

  constructor(templateDir: string = "src/templates") {
    this.templateDir = resolve(templateDir);
    this.filters = { ...BUILTIN_FILTERS };
    this.globals = {};
    this.tests = {};
    this._sandbox = false;
    this._allowedFilters = null;
    this._allowedTags = null;
    this._allowedVars = null;
    this.fragmentCache = new Map();
    this._autoEscape = true;

    // Built-in global functions
    this.globals.formToken = (descriptor?: string) => _generateFormToken(descriptor || "");
    this.globals.form_token = (descriptor?: string) => _generateFormToken(descriptor || "");
  }

  sandbox(filters?: string[], tags?: string[], vars?: string[]): Frond {
    this._sandbox = true;
    this._allowedFilters = filters ? new Set(filters) : null;
    this._allowedTags = tags ? new Set(tags) : null;
    this._allowedVars = vars ? new Set(vars) : null;
    return this;
  }

  unsandbox(): Frond {
    this._sandbox = false;
    this._allowedFilters = null;
    this._allowedTags = null;
    this._allowedVars = null;
    return this;
  }

  addFilter(name: string, fn: FilterFn): void {
    this.filters[name] = fn;
  }

  addGlobal(name: string, value: unknown): void {
    this.globals[name] = value;
  }

  addTest(name: string, fn: TestFn): void {
    this.tests[name] = fn;
  }

  render(template: string, data?: Record<string, unknown>): string {
    const context = { ...this.globals, ...(data || {}) };
    const filePath = join(this.templateDir, template);

    if (!existsSync(filePath)) {
      throw new Error(`Template not found: ${filePath}`);
    }

    const debugMode = (process.env.TINA4_DEBUG || "").toLowerCase() === "true";
    const cached = this.compiled.get(template);

    if (cached) {
      if (debugMode) {
        // Dev mode: check if file changed
        const mtime = statSync(filePath).mtimeMs;
        if (cached.mtime === mtime) {
          return this.executeCached(cached.tokens, context);
        }
      } else {
        // Production: skip mtime check, cache is permanent
        return this.executeCached(cached.tokens, context);
      }
    }

    // Cache miss — load, tokenize, cache
    const source = readFileSync(filePath, "utf-8");
    const mtime = statSync(filePath).mtimeMs;
    const tokens = tokenize(source);
    this.compiled.set(template, { tokens, mtime });
    return this.executeWithSource(source, tokens, context);
  }

  renderString(source: string, data?: Record<string, unknown>): string {
    const context = { ...this.globals, ...(data || {}) };

    const key = createHash("md5").update(source).digest("hex");
    const cachedTokens = this.compiledStrings.get(key);
    if (cachedTokens) {
      return this.executeCached(cachedTokens, context);
    }

    const tokens = tokenize(source);
    this.compiledStrings.set(key, tokens);
    return this.executeCached(tokens, context);
  }

  /** Clear all compiled template caches. */
  clearCache(): void {
    this.compiled.clear();
    this.compiledStrings.clear();
  }

  private load(name: string): string {
    const filePath = join(this.templateDir, name);
    if (!existsSync(filePath)) {
      throw new Error(`Template not found: ${filePath}`);
    }
    return readFileSync(filePath, "utf-8");
  }

  /** Execute pre-tokenized template against context. */
  private executeCached(tokens: Token[], context: Record<string, unknown>): string {
    if (Object.keys(this.tests).length > 0) {
      context.__frond_tests__ = this.tests;
    }

    // Check if first non-text token is an extends block
    for (const [ttype, raw] of tokens) {
      if (ttype === "TEXT") {
        if (raw.trim()) break;
        continue;
      }
      if (ttype === "BLOCK") {
        const [content] = stripTag(raw);
        if (content.startsWith("extends ")) {
          // Extends requires source-based execution for block extraction
          const source = tokens.map(([, v]) => v).join("");
          return this.execute(source, context);
        }
      }
      break;
    }
    return this.renderTokens(tokens, context);
  }

  /** Execute with both source and pre-tokenized tokens available. */
  private executeWithSource(source: string, tokens: Token[], context: Record<string, unknown>): string {
    if (Object.keys(this.tests).length > 0) {
      context.__frond_tests__ = this.tests;
    }

    const extendsMatch = source.match(/\{%[-\s]*extends\s+["'](.+?)["']\s*[-]?%\}/);
    if (extendsMatch) {
      const parentName = extendsMatch[1];
      const parentSource = this.load(parentName);
      const childBlocks = this.extractBlocks(source);
      return this.renderWithBlocks(parentSource, context, childBlocks);
    }

    return this.renderTokens(tokens, context);
  }

  private execute(source: string, context: Record<string, unknown>): string {
    // Inject custom tests into context for evalTest to find
    if (Object.keys(this.tests).length > 0) {
      context.__frond_tests__ = this.tests;
    }

    // Handle extends first
    const extendsMatch = source.match(/\{%[-\s]*extends\s+["'](.+?)["']\s*[-]?%\}/);
    if (extendsMatch) {
      const parentName = extendsMatch[1];
      const parentSource = this.load(parentName);
      const childBlocks = this.extractBlocks(source);
      return this.renderWithBlocks(parentSource, context, childBlocks);
    }

    return this.renderTokens(tokenize(source), context);
  }

  private extractBlocks(source: string): Record<string, string> {
    const blocks: Record<string, string> = {};
    const pattern = /\{%[-\s]*block\s+(\w+)\s*[-]?%\}([\s\S]*?)\{%[-\s]*endblock\s*[-]?%\}/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
      blocks[m[1]] = m[2];
    }
    return blocks;
  }

  private renderWithBlocks(
    parentSource: string,
    context: Record<string, unknown>,
    childBlocks: Record<string, string>,
  ): string {
    const pattern = /\{%[-\s]*block\s+(\w+)\s*[-]?%\}([\s\S]*?)\{%[-\s]*endblock\s*[-]?%\}/g;

    const result = parentSource.replace(pattern, (_match, name: string, defaultContent: string) => {
      const blockSource = childBlocks[name] ?? defaultContent;
      return this.renderTokens(tokenize(blockSource), context);
    });

    return this.renderTokens(tokenize(result), context);
  }

  private renderTokens(tokens: Token[], context: Record<string, unknown>): string {
    const output: string[] = [];
    let i = 0;

    while (i < tokens.length) {
      const [ttype, raw] = tokens[i];

      if (ttype === "TEXT") {
        output.push(raw);
        i++;
      } else if (ttype === "COMMENT") {
        i++;
      } else if (ttype === "VAR") {
        const [content, stripB, stripA] = stripTag(raw);
        if (stripB && output.length > 0) {
          output[output.length - 1] = output[output.length - 1].replace(/\s+$/, "");
        }

        const result = this.evalVar(content, context);
        output.push(result !== null && result !== undefined ? String(result) : "");

        if (stripA && i + 1 < tokens.length && tokens[i + 1][0] === "TEXT") {
          tokens[i + 1] = ["TEXT", tokens[i + 1][1].replace(/^\s+/, "")];
        }
        i++;
      } else if (ttype === "BLOCK") {
        const [content, stripB, stripA] = stripTag(raw);
        if (stripB && output.length > 0) {
          output[output.length - 1] = output[output.length - 1].replace(/\s+$/, "");
        }

        const parts = content.split(/\s+/);
        const tag = parts[0] || "";

        // Apply stripA before handlers consume body tokens
        if (stripA && i + 1 < tokens.length && tokens[i + 1][0] === "TEXT") {
          tokens[i + 1] = ["TEXT", tokens[i + 1][1].replace(/^\s+/, "")];
        }

        if (tag === "if") {
          // Sandbox check
          if (this._sandbox && this._allowedTags !== null && !this._allowedTags.has("if")) {
            const skip = this.skipBlock(tokens, i, "if", "endif");
            i = skip;
          } else {
            const [result, skip] = this.handleIf(tokens, i, context);
            output.push(result);
            i = skip;
          }
        } else if (tag === "for") {
          if (this._sandbox && this._allowedTags !== null && !this._allowedTags.has("for")) {
            const skip = this.skipBlock(tokens, i, "for", "endfor");
            i = skip;
          } else {
            const [result, skip] = this.handleFor(tokens, i, context);
            output.push(result);
            i = skip;
          }
        } else if (tag === "set") {
          if (this._sandbox && this._allowedTags !== null && !this._allowedTags.has("set")) {
            i++;
          } else {
            this.handleSet(content, context);
            i++;
          }
        } else if (tag === "include") {
          if (this._sandbox && this._allowedTags !== null && !this._allowedTags.has("include")) {
            i++;
          } else {
            const result = this.handleInclude(content, context);
            output.push(result);
            i++;
          }
        } else if (tag === "macro") {
          const skip = this.handleMacro(tokens, i, context);
          i = skip;
        } else if (tag === "from") {
          this.handleFromImport(content, context);
          i++;
        } else if (tag === "cache") {
          const [result, skip] = this.handleCache(tokens, i, context);
          output.push(result);
          i = skip;
        } else if (tag === "spaceless") {
          const [result, skip] = this.handleSpaceless(tokens, i, context);
          output.push(result);
          i = skip;
        } else if (tag === "autoescape") {
          const [result, skip] = this.handleAutoescape(tokens, i, context);
          output.push(result);
          i = skip;
        } else if (tag === "block" || tag === "endblock" || tag === "extends") {
          i++; // Already handled
        } else {
          i++;
        }

        if (stripA && i < tokens.length && tokens[i][0] === "TEXT") {
          tokens[i] = ["TEXT", tokens[i][1].replace(/^\s+/, "")];
        }
      } else {
        i++;
      }
    }

    return output.join("");
  }

  private skipBlock(tokens: Token[], start: number, openTag: string, closeTag: string): number {
    let depth = 0;
    let i = start + 1;
    while (i < tokens.length) {
      if (tokens[i][0] === "BLOCK") {
        const [content] = stripTag(tokens[i][1]);
        const tag = content.split(/\s+/)[0] || "";
        if (tag === openTag) depth++;
        else if (tag === closeTag) {
          if (depth === 0) return i + 1;
          depth--;
        }
      }
      i++;
    }
    return i;
  }

  private evalVar(expr: string, context: Record<string, unknown>): unknown {
    // Check for top-level ternary BEFORE splitting filters so that
    // expressions like ``products|length != 1 ? "s" : ""`` work correctly.
    const ternaryIdx = findTernary(expr);
    if (ternaryIdx !== -1) {
      const condPart = expr.slice(0, ternaryIdx).trim();
      const rest = expr.slice(ternaryIdx + 1);
      const colonIdx = findColon(rest);
      if (colonIdx !== -1) {
        const truePart = rest.slice(0, colonIdx).trim();
        const falsePart = rest.slice(colonIdx + 1).trim();
        const cond = this.evalVarRaw(condPart, context);
        return cond ? this.evalVar(truePart, context) : this.evalVar(falsePart, context);
      }
    }

    return this.evalVarInner(expr, context);
  }

  private evalVarRaw(expr: string, context: Record<string, unknown>): unknown {
    const [varName, filters] = parseFilterChain(expr);
    let value = evalExpr(varName, context);
    for (const [fname, args] of filters) {
      if (fname === "raw" || fname === "safe") continue;
      const fn = this.filters[fname];
      if (fn) {
        value = fn(value, ...args);
      } else {
        // The filter name may include a trailing comparison operator,
        // e.g. "length != 1".  Extract the real filter name and the
        // comparison suffix, apply the filter, then evaluate the comparison.
        const m = fname.match(/^(\w+)\s*(!=|==|>=|<=|>|<)\s*(.+)$/);
        if (m) {
          const realFilter = m[1];
          const op = m[2];
          const rightExpr = m[3].trim();
          const fn2 = this.filters[realFilter];
          if (fn2) {
            value = fn2(value, ...args);
          }
          const right = evalExpr(rightExpr, context);
          switch (op) {
            case "!=": value = value !== right; break;
            case "==": value = value === right; break;
            case ">=": value = (value as number) >= (right as number); break;
            case "<=": value = (value as number) <= (right as number); break;
            case ">":  value = (value as number) > (right as number); break;
            case "<":  value = (value as number) < (right as number); break;
          }
        } else {
          value = evalExpr(fname, context);
        }
      }
    }
    return value;
  }

  private evalVarInner(expr: string, context: Record<string, unknown>): unknown {
    const [varName, filters] = parseFilterChain(expr);

    // Sandbox: check variable access
    if (this._sandbox && this._allowedVars !== null) {
      const rootVar = varName.split(".")[0].split("[")[0].trim();
      if (rootVar && !this._allowedVars.has(rootVar) && rootVar !== "loop") {
        return ""; // Silently block
      }
    }

    let value = evalExpr(varName, context);

    let isSafe = false;
    for (const [fname, args] of filters) {
      if (fname === "raw" || fname === "safe") {
        isSafe = true;
        continue;
      }
      // escape/e filter marks output as safe (already escaped)
      if (fname === "escape" || fname === "e") {
        isSafe = true;
      }

      // Sandbox: check filter access
      if (this._sandbox && this._allowedFilters !== null) {
        if (!this._allowedFilters.has(fname)) {
          continue; // Silently skip blocked filter
        }
      }

      const fn = this.filters[fname];
      if (fn) {
        value = fn(value, ...args);
      }
    }

    // SafeString instances are already rendered/safe
    if (value instanceof SafeString) {
      return value.value;
    }

    // Auto-escape HTML unless marked safe or auto-escape is disabled
    if (!isSafe && this._autoEscape && typeof value === "string") {
      value = htmlEscape(value);
    }

    return value;
  }

  private handleIf(tokens: Token[], start: number, context: Record<string, unknown>): [string, number] {
    const [content] = stripTag(tokens[start][1]);
    const conditionExpr = content.slice(3).trim(); // Remove 'if '

    // Collect branches: [condition, tokens][]
    const branches: [string | null, Token[]][] = [];
    let currentTokens: Token[] = [];
    let currentCond: string | null = conditionExpr;
    let depth = 0;
    let i = start + 1;

    while (i < tokens.length) {
      const [ttype, raw] = tokens[i];
      if (ttype === "BLOCK") {
        const [tagContent, tagStripB, tagStripA] = stripTag(raw);
        const tag = tagContent.split(/\s+/)[0] || "";

        if (tag === "if") {
          depth++;
          currentTokens.push(tokens[i]);
        } else if (tag === "endif" && depth > 0) {
          depth--;
          currentTokens.push(tokens[i]);
        } else if (tag === "endif" && depth === 0) {
          // Strip trailing whitespace from last body token if endif has strip_before
          if (tagStripB && currentTokens.length > 0 && currentTokens[currentTokens.length - 1][0] === "TEXT") {
            currentTokens[currentTokens.length - 1] = ["TEXT", currentTokens[currentTokens.length - 1][1].replace(/\s+$/, "")];
          }
          branches.push([currentCond, currentTokens]);
          // Apply stripA on token after endif
          if (tagStripA && i + 1 < tokens.length && tokens[i + 1][0] === "TEXT") {
            tokens[i + 1] = ["TEXT", tokens[i + 1][1].replace(/^\s+/, "")];
          }
          i++;
          break;
        } else if ((tag === "elseif" || tag === "elif") && depth === 0) {
          if (tagStripB && currentTokens.length > 0 && currentTokens[currentTokens.length - 1][0] === "TEXT") {
            currentTokens[currentTokens.length - 1] = ["TEXT", currentTokens[currentTokens.length - 1][1].replace(/\s+$/, "")];
          }
          branches.push([currentCond, currentTokens]);
          currentCond = tagContent.slice(tag.length).trim();
          currentTokens = [];
        } else if (tag === "else" && depth === 0) {
          if (tagStripB && currentTokens.length > 0 && currentTokens[currentTokens.length - 1][0] === "TEXT") {
            currentTokens[currentTokens.length - 1] = ["TEXT", currentTokens[currentTokens.length - 1][1].replace(/\s+$/, "")];
          }
          branches.push([currentCond, currentTokens]);
          currentCond = null; // else branch
          currentTokens = [];
        } else {
          currentTokens.push(tokens[i]);
        }
      } else {
        currentTokens.push(tokens[i]);
      }
      i++;
    }

    // Evaluate branches
    for (const [cond, branchTokens] of branches) {
      if (cond === null || evalComparison(cond, context)) {
        return [this.renderTokens([...branchTokens], context), i];
      }
    }

    return ["", i];
  }

  private handleFor(tokens: Token[], start: number, context: Record<string, unknown>): [string, number] {
    const [content] = stripTag(tokens[start][1]);
    const forMatch = content.match(/^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+)/);
    if (!forMatch) return ["", start + 1];

    const var1 = forMatch[1];
    const var2 = forMatch[2] || null;
    const iterableExpr = forMatch[3].trim();

    // Collect body and else tokens
    const bodyTokens: Token[] = [];
    const elseTokens: Token[] = [];
    let inElse = false;
    let forDepth = 0;
    let ifDepth = 0;
    let i = start + 1;

    while (i < tokens.length) {
      const [ttype, raw] = tokens[i];
      if (ttype === "BLOCK") {
        const [tagContent] = stripTag(raw);
        const tag = tagContent.split(/\s+/)[0] || "";

        if (tag === "for") {
          forDepth++;
          (inElse ? elseTokens : bodyTokens).push(tokens[i]);
        } else if (tag === "endfor" && forDepth > 0) {
          forDepth--;
          (inElse ? elseTokens : bodyTokens).push(tokens[i]);
        } else if (tag === "endfor" && forDepth === 0) {
          i++;
          break;
        } else if (tag === "if") {
          ifDepth++;
          (inElse ? elseTokens : bodyTokens).push(tokens[i]);
        } else if (tag === "endif") {
          ifDepth--;
          (inElse ? elseTokens : bodyTokens).push(tokens[i]);
        } else if (tag === "else" && forDepth === 0 && ifDepth === 0) {
          inElse = true;
        } else {
          (inElse ? elseTokens : bodyTokens).push(tokens[i]);
        }
      } else {
        (inElse ? elseTokens : bodyTokens).push(tokens[i]);
      }
      i++;
    }

    // Evaluate iterable
    const iterable = evalExpr(iterableExpr, context);

    if (!iterable || (Array.isArray(iterable) && iterable.length === 0) ||
        (typeof iterable === "object" && !Array.isArray(iterable) && Object.keys(iterable as object).length === 0)) {
      if (elseTokens.length > 0) {
        return [this.renderTokens([...elseTokens], context), i];
      }
      return ["", i];
    }

    // Iterate
    const output: string[] = [];
    const isDict = typeof iterable === "object" && !Array.isArray(iterable);
    const items = isDict
      ? Object.entries(iterable as Record<string, unknown>)
      : Array.isArray(iterable) ? iterable : [];
    const total = items.length;

    for (let idx = 0; idx < total; idx++) {
      const item = items[idx];
      const loopCtx: Record<string, unknown> = { ...context };
      loopCtx.loop = {
        index: idx + 1,
        index0: idx,
        first: idx === 0,
        last: idx === total - 1,
        length: total,
        revindex: total - idx,
        revindex0: total - idx - 1,
        even: (idx + 1) % 2 === 0,
        odd: (idx + 1) % 2 !== 0,
      };

      if (isDict) {
        const [key, value] = item as [string, unknown];
        if (var2) {
          loopCtx[var1] = key;
          loopCtx[var2] = value;
        } else {
          loopCtx[var1] = key;
        }
      } else {
        if (var2) {
          loopCtx[var1] = idx;
          loopCtx[var2] = item;
        } else {
          loopCtx[var1] = item;
        }
      }

      output.push(this.renderTokens([...bodyTokens], loopCtx));
    }

    return [output.join(""), i];
  }

  private handleSet(content: string, context: Record<string, unknown>): void {
    const m = content.match(/^set\s+(\w+)\s*=\s*([\s\S]+)/);
    if (m) {
      const name = m[1];
      const expr = m[2].trim();
      context[name] = evalExpr(expr, context);
    }
  }

  private handleInclude(content: string, context: Record<string, unknown>): string {
    const ignoreMissing = content.includes("ignore missing");
    const cleanContent = content.replace("ignore missing", "").trim();

    const m = cleanContent.match(/^include\s+["'](.+?)["'](?:\s+with\s+(.+))?/);
    if (!m) return "";

    const filename = m[1];
    const withExpr = m[2];

    let source: string;
    try {
      source = this.load(filename);
    } catch {
      if (ignoreMissing) return "";
      throw new Error(`Template not found: ${join(this.templateDir, filename)}`);
    }

    const incContext = { ...context };
    if (withExpr) {
      const extra = evalExpr(withExpr, context);
      if (typeof extra === "object" && extra !== null) {
        Object.assign(incContext, extra);
      }
    }

    return this.execute(source, incContext);
  }

  private handleMacro(tokens: Token[], start: number, context: Record<string, unknown>): number {
    const [content] = stripTag(tokens[start][1]);
    const m = content.match(/^macro\s+(\w+)\s*\(([^)]*)\)/);
    if (!m) {
      // Skip to endmacro
      let i = start + 1;
      while (i < tokens.length) {
        if (tokens[i][0] === "BLOCK" && tokens[i][1].includes("endmacro")) {
          return i + 1;
        }
        i++;
      }
      return i;
    }

    const macroName = m[1];
    const paramNames = m[2].split(",").map(p => p.trim()).filter(Boolean);

    // Collect body tokens
    const bodyTokens: Token[] = [];
    let i = start + 1;
    while (i < tokens.length) {
      if (tokens[i][0] === "BLOCK" && tokens[i][1].includes("endmacro")) {
        i++;
        break;
      }
      bodyTokens.push(tokens[i]);
      i++;
    }

    // Register macro as callable
    const engine = this;
    const capturedContext = { ...context };
    context[macroName] = (...args: unknown[]) => {
      const macroCtx: Record<string, unknown> = { ...capturedContext };
      for (let pi = 0; pi < paramNames.length; pi++) {
        macroCtx[paramNames[pi]] = pi < args.length ? args[pi] : null;
      }
      return new SafeString(engine.renderTokens([...bodyTokens], macroCtx));
    };

    return i;
  }

  private handleFromImport(content: string, context: Record<string, unknown>): void {
    const m = content.match(/^from\s+["'](.+?)["']\s+import\s+(.+)/);
    if (!m) return;

    const filename = m[1];
    const names = m[2].split(",").map(n => n.trim()).filter(Boolean);

    const source = this.load(filename);
    const tokens = tokenize(source);

    let i = 0;
    while (i < tokens.length) {
      const [ttype, raw] = tokens[i];
      if (ttype === "BLOCK") {
        const [tagContent] = stripTag(raw);
        const tag = tagContent.split(/\s+/)[0] || "";
        if (tag === "macro") {
          const macroM = tagContent.match(/^macro\s+(\w+)\s*\(([^)]*)\)/);
          if (macroM && names.includes(macroM[1])) {
            const macroName = macroM[1];
            const paramNames = macroM[2].split(",").map(p => p.trim()).filter(Boolean);

            const bodyTokens: Token[] = [];
            i++;
            while (i < tokens.length) {
              if (tokens[i][0] === "BLOCK" && tokens[i][1].includes("endmacro")) {
                i++;
                break;
              }
              bodyTokens.push(tokens[i]);
              i++;
            }

            // Create closure with its own copy of captured values
            const capturedBody = [...bodyTokens];
            const capturedParams = [...paramNames];
            const capturedCtx = { ...context };
            const engine = this;

            context[macroName] = (...args: unknown[]) => {
              const macroCtx: Record<string, unknown> = { ...capturedCtx };
              for (let pi = 0; pi < capturedParams.length; pi++) {
                macroCtx[capturedParams[pi]] = pi < args.length ? args[pi] : null;
              }
              return new SafeString(engine.renderTokens([...capturedBody], macroCtx));
            };
            continue;
          }
        }
      }
      i++;
    }
  }

  private handleCache(tokens: Token[], start: number, context: Record<string, unknown>): [string, number] {
    const [content] = stripTag(tokens[start][1]);
    const m = content.match(/^cache\s+["'](.+?)["']\s*(\d+)?/);
    const cacheKey = m ? m[1] : "default";
    const ttl = m && m[2] ? parseInt(m[2], 10) : 60;

    // Check cache
    const cached = this.fragmentCache.get(cacheKey);
    if (cached) {
      const [htmlContent, expiresAt] = cached;
      if (Date.now() < expiresAt) {
        // Skip to endcache
        let i = start + 1;
        let depth = 0;
        while (i < tokens.length) {
          if (tokens[i][0] === "BLOCK") {
            const [tagContent] = stripTag(tokens[i][1]);
            const tag = tagContent.split(/\s+/)[0] || "";
            if (tag === "cache") depth++;
            else if (tag === "endcache") {
              if (depth === 0) return [htmlContent, i + 1];
              depth--;
            }
          }
          i++;
        }
        return [htmlContent, i];
      }
    }

    // Collect body tokens
    const bodyTokens: Token[] = [];
    let i = start + 1;
    let depth = 0;
    while (i < tokens.length) {
      if (tokens[i][0] === "BLOCK") {
        const [tagContent] = stripTag(tokens[i][1]);
        const tag = tagContent.split(/\s+/)[0] || "";
        if (tag === "cache") {
          depth++;
          bodyTokens.push(tokens[i]);
        } else if (tag === "endcache") {
          if (depth === 0) {
            i++;
            break;
          }
          depth--;
          bodyTokens.push(tokens[i]);
        } else {
          bodyTokens.push(tokens[i]);
        }
      } else {
        bodyTokens.push(tokens[i]);
      }
      i++;
    }

    // Render and cache
    const rendered = this.renderTokens([...bodyTokens], context);
    this.fragmentCache.set(cacheKey, [rendered, Date.now() + ttl * 1000]);
    return [rendered, i];
  }

  private handleSpaceless(tokens: Token[], start: number, context: Record<string, unknown>): [string, number] {
    const bodyTokens: Token[] = [];
    let i = start + 1;
    let depth = 0;
    while (i < tokens.length) {
      if (tokens[i][0] === "BLOCK") {
        const [tagContent] = stripTag(tokens[i][1]);
        const tag = tagContent.split(/\s+/)[0] || "";
        if (tag === "spaceless") {
          depth++;
          bodyTokens.push(tokens[i]);
        } else if (tag === "endspaceless") {
          if (depth === 0) {
            i++;
            break;
          }
          depth--;
          bodyTokens.push(tokens[i]);
        } else {
          bodyTokens.push(tokens[i]);
        }
      } else {
        bodyTokens.push(tokens[i]);
      }
      i++;
    }

    let rendered = this.renderTokens([...bodyTokens], context);
    rendered = rendered.replace(/>\s+</g, "><");
    return [rendered, i];
  }

  private handleAutoescape(tokens: Token[], start: number, context: Record<string, unknown>): [string, number] {
    const [content] = stripTag(tokens[start][1]);
    const modeMatch = content.match(/^autoescape\s+(false|true)/);
    const autoEscapeOn = !(modeMatch && modeMatch[1] === "false");

    const bodyTokens: Token[] = [];
    let i = start + 1;
    let depth = 0;
    while (i < tokens.length) {
      if (tokens[i][0] === "BLOCK") {
        const [tagContent] = stripTag(tokens[i][1]);
        const tag = tagContent.split(/\s+/)[0] || "";
        if (tag === "autoescape") {
          depth++;
          bodyTokens.push(tokens[i]);
        } else if (tag === "endautoescape") {
          if (depth === 0) {
            i++;
            break;
          }
          depth--;
          bodyTokens.push(tokens[i]);
        } else {
          bodyTokens.push(tokens[i]);
        }
      } else {
        bodyTokens.push(tokens[i]);
      }
      i++;
    }

    if (!autoEscapeOn) {
      const oldAutoEscape = this._autoEscape;
      this._autoEscape = false;
      const rendered = this.renderTokens([...bodyTokens], context);
      this._autoEscape = oldAutoEscape;
      return [rendered, i];
    }

    return [this.renderTokens([...bodyTokens], context), i];
  }
}

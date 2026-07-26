/**
 * Tina4 Frond Engine — Lexer, parser, and runtime.
 * Zero-dependency Twig-like template engine.
 * Supports: variables, filters, if/elseif/else/endif, for/else/endfor,
 * extends/block, include, macro, set, comments, whitespace control, tests.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────

export type FilterFn = (value: unknown, ...args: unknown[]) => unknown;
export type TestFn = (value: unknown) => boolean;

/** A minimal request shape a {% live %} data provider receives. */
export interface LiveRequest {
  headers?: Record<string, unknown>;
  params?: Record<string, string>;
}
/** A {% live %} data provider — re-runs with the live request each refresh. */
export type LiveProvider = (req: LiveRequest) => Record<string, unknown>;
/** Result of respondLive — a pure {status, body} descriptor a route applies. */
export interface LiveResponse {
  status: number;
  body: string;
}
/** WebSocket broadcaster hook wired by @tina4/core so pushLive can broadcast. */
export type LiveBroadcaster = (wsPath: string | null, name: string, envelope: string) => void;

/** Marker class for strings that should not be auto-escaped. */
class SafeString {
  constructor(public value: string) {}
  toString() { return this.value; }
}

/**
 * Produce a human-readable, debugger-friendly inspection of any value.
 *
 * Equivalent to PHP's var_dump, Python's repr, and Ruby's inspect. Unlike
 * JSON.stringify (the previous implementation) this handles:
 *   - Circular references (marked as [Circular])
 *   - BigInt (shown as `123n`)
 *   - undefined, Symbol, and function values (shown inline, not dropped)
 *   - Date, Map, Set, Error, RegExp (shown with their type and contents)
 *   - Class instances (shown with the class name prefix)
 *
 * Used by both the `|dump` filter and the `dump()` global function.
 * Output is a plain string; callers wrap it in <pre> and mark it safe so
 * the template engine doesn't double-escape.
 */
function inspectValue(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): string {
  // Primitives
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    const name = value.name || "(anonymous)";
    return `[Function: ${name}]`;
  }

  // value is now object (including arrays, Date, Map, Set, etc.)
  const obj = value as object;

  // Cycle detection
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);

  // Depth cap — prevents runaway recursion on enormous graphs
  if (depth > 8) return "[...]";

  try {
    // Date
    if (obj instanceof Date) {
      return `Date(${obj.toISOString()})`;
    }

    // RegExp
    if (obj instanceof RegExp) {
      return obj.toString();
    }

    // Error
    if (obj instanceof Error) {
      return `${obj.constructor.name}(${JSON.stringify(obj.message)})`;
    }

    // Map
    if (obj instanceof Map) {
      if (obj.size === 0) return "Map(0) {}";
      const entries: string[] = [];
      for (const [k, v] of obj) {
        entries.push(`${inspectValue(k, seen, depth + 1)} => ${inspectValue(v, seen, depth + 1)}`);
      }
      return `Map(${obj.size}) { ${entries.join(", ")} }`;
    }

    // Set
    if (obj instanceof Set) {
      if (obj.size === 0) return "Set(0) {}";
      const items: string[] = [];
      for (const v of obj) {
        items.push(inspectValue(v, seen, depth + 1));
      }
      return `Set(${obj.size}) { ${items.join(", ")} }`;
    }

    // Array
    if (Array.isArray(obj)) {
      if (obj.length === 0) return "[]";
      const items = obj.map((v) => inspectValue(v, seen, depth + 1));
      return `[${items.join(", ")}]`;
    }

    // Plain object or class instance
    const keys = Object.keys(obj);
    const className = obj.constructor && obj.constructor.name !== "Object"
      ? `${obj.constructor.name} `
      : "";
    if (keys.length === 0) return `${className}{}`;
    const props = keys.map((k) => {
      const v = (obj as Record<string, unknown>)[k];
      return `${k}: ${inspectValue(v, seen, depth + 1)}`;
    });
    return `${className}{ ${props.join(", ")} }`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Render a value as a pre-formatted, HTML-escaped dump wrapped in <pre> tags.
 * Returns a SafeString so the template engine does not double-escape the
 * entities. Shared by the `|dump` filter and the `dump()` global function.
 *
 * Gated on TINA4_DEBUG=true. In production (TINA4_DEBUG unset or false)
 * dump output is suppressed entirely to avoid leaking internal state,
 * stack-traceable object shapes, or sensitive values into rendered HTML.
 */
function renderDump(value: unknown): SafeString {
  const debugMode = (process.env.TINA4_DEBUG ?? "").toLowerCase() === "true";
  if (!debugMode) {
    return new SafeString("");
  }
  const dumped = inspectValue(value);
  const escaped = dumped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return new SafeString(`<pre>${escaped}</pre>`);
}

type TokenType = "TEXT" | "VAR" | "BLOCK" | "COMMENT";
type Token = [TokenType, string];

// ── Pre-compiled Regexes (module level) ────────────────────────

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const METHOD_CALL_RE = /^(\w+)\s*\(([\s\S]*)?\)$/;
const FN_CALL_RE = /^([\w.]+)\s*\(([\s\S]*)?\)$/;
const IS_NOT_RE = /^(.+?)\s+is\s+not\s+(\w+)(.*)$/;
const IS_RE = /^(.+?)\s+is\s+(\w+)(.*)$/;
const NOT_IN_RE = /^(.+?)\s+not\s+in\s+(.+)$/;
const IN_RE = /^(.+?)\s+in\s+(.+)$/;
const DIVISIBLE_BY_RE = /\s*by\s*\(\s*(\d+)\s*\)/;
const FILTER_WITH_ARGS_RE = /^(\w+)\s*\(([\s\S]*)\)$/;
const FILTER_COMPARISON_RE = /^(\w+)\s*(!=|==|>=|<=|>|<)\s*(.+)$/;
const TITLE_WORD_RE = /\b\w/g;
const STRIP_TAGS_RE = /<[^>]+>/g;
// printf-style conversions: %%, plus %[flags][width][.precision]type for the
// common types. Matches PHP sprintf / Python % / Ruby format so the `format`
// filter renders e.g. `{{ '%.2f' | format(n) }}` as "3.14" across all engines.
const FORMAT_RE = /%%|%([-+ 0]*)(\d+)?(?:\.(\d+))?([sdifFeEgGxXob])/g;
const LEADING_WS_RE = /^\s+/;
const TRAILING_WS_RE = /\s+$/;
const THOUSANDS_RE = /\B(?=(\d{3})+(?!\d))/g;
// {% live "name" poll N | sse | ws "path" [src "url"] %}
const LIVE_RE = /^live\s+["']([^"']+)["']([\s\S]*)$/;
const LIVE_WS_RE = /ws\s+["']([^"']+)["']/;
const LIVE_SRC_RE = /src\s+["']([^"']+)["']/;

/** Escape a value for a live-marker HTML attribute. Byte-identical order to
 * the Python master / PHP liveAttr / Ruby live_attr so the emitted marker
 * element matches across all four frameworks (& " < > — no apostrophe). */
function liveAttr(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Caches (module level) ─────────────────────────────────────

/** Cache for parsed filter chains: expr string -> [variable, filters] */
const filterChainCache = new Map<string, [string, [string, unknown[]][]]>();

/** Cache for parsed dotted/bracket paths: expr string -> [parts, fromBracket] */
const pathParseCache = new Map<string, [string[], boolean[]]>();

/**
 * Hard cap on the template caches — `compiled` and `compiledStrings`
 * (ADR-0004, parity with PHP/Python/Ruby TEMPLATE_CACHE_MAX).
 *
 * An entry here is a whole token list, so the cap sits well below what a
 * per-expression memo would justify. 256 is far above any real application's
 * template count, so a normal app never evicts. The cap exists for the
 * workload that genuinely grows without limit for the life of a worker:
 * `renderString` keys on md5(source), so an app that builds template strings
 * dynamically adds an entry per distinct string.
 */
export const TEMPLATE_CACHE_MAX = 256;

/**
 * Keep a memo cache bounded. Call immediately before inserting a new entry.
 *
 * Eviction is insertion-ordered (oldest first), not true LRU: a `Map`
 * preserves insertion order, so dropping from the front is cheap, whereas
 * refreshing recency on every cache HIT would add writes to the hottest path
 * in a render and cost more than it saves. Half the cache is dropped at once
 * so the sweep amortises to O(1) per insert.
 *
 * Evicting can never change what a render produces: every read site treats a
 * miss as "recompute", so a swept entry is rebuilt on next use.
 */
function capCache(cache: Map<string, unknown>, maxEntries: number): void {
  if (cache.size < maxEntries) return;
  let drop = Math.floor(maxEntries / 2);
  for (const key of cache.keys()) {
    cache.delete(key);
    if (--drop <= 0) break;
  }
}

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
  if (NUMERIC_RE.test(expr)) {
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

  // Dotted path with bracket access — split on . and [...] but not . inside parentheses
  // Track which parts came from bracket access (need variable resolution)
  let parts: string[];
  let fromBracket: boolean[];

  const cachedPath = pathParseCache.get(expr);
  if (cachedPath) {
    [parts, fromBracket] = cachedPath;
  } else {
    parts = [];
    fromBracket = [];
    {
      let current = "";
      let depth = 0;
      let inQuote: string | null = null;
      for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (inQuote) {
          current += ch;
          if (ch === inQuote) inQuote = null;
          continue;
        }
        if (ch === '"' || ch === "'") { inQuote = ch; current += ch; continue; }
        if (ch === '(') { depth++; current += ch; continue; }
        if (ch === ')') { depth--; current += ch; continue; }
        if (ch === '.' && depth === 0) {
          if (current) { parts.push(current); fromBracket.push(false); }
          current = "";
          continue;
        }
        if (ch === '[' && depth === 0) {
          if (current) { parts.push(current); fromBracket.push(false); }
          current = "";
          const end = expr.indexOf(']', i + 1);
          if (end !== -1) {
            parts.push(expr.slice(i + 1, end));
            fromBracket.push(true);
            i = end;
          }
          continue;
        }
        current += ch;
      }
      if (current) { parts.push(current); fromBracket.push(false); }
    }
    pathParseCache.set(expr, [parts, fromBracket]);
  }

  let value: unknown = context;
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const isBracket = fromBracket[pi];
    if (value === null || value === undefined) return null;

    // Check for method call: name(args)
    const methodMatch = part.match(METHOD_CALL_RE);
    if (methodMatch) {
      const methodName = methodMatch[1];
      const rawArgs = methodMatch[2] || "";
      if (typeof value === "object" && value !== null && methodName in (value as Record<string, unknown>)) {
        const fn = (value as Record<string, unknown>)[methodName];
        if (typeof fn === "function") {
          if (rawArgs.trim()) {
            const argParts = splitArgs(rawArgs);
            const evalArgs = argParts.map(a => evalExpr(a.trim(), context));
            value = fn.apply(value, evalArgs);
          } else {
            value = fn.call(value);
          }
          continue;
        }
      }
      return null;
    }

    // Slice syntax: value[1:5], value[:10], value[start:end]
    const isQuotedPart = (part.startsWith('"') && part.endsWith('"')) ||
                         (part.startsWith("'") && part.endsWith("'"));
    if (isBracket && part.includes(":") && !isQuotedPart) {
      const sliceParts = part.split(":", 2);
      const sStart = sliceParts[0].trim() ? parseInt(String(evalExpr(sliceParts[0].trim(), context)), 10) : undefined;
      const sEnd = sliceParts[1].trim() ? parseInt(String(evalExpr(sliceParts[1].trim(), context)), 10) : undefined;
      if (Array.isArray(value)) {
        value = (value as unknown[]).slice(sStart ?? 0, sEnd);
      } else if (typeof value === "string") {
        value = (value as string).slice(sStart ?? 0, sEnd);
      } else {
        return null;
      }
      continue;
    }

    let key: string | number;
    // Check if this part came from bracket access and needs variable resolution
    if (isQuotedPart) {
      // Quoted string literal — strip quotes
      key = part.slice(1, -1);
    } else {
      const asNum = parseInt(part, 10);
      if (!isNaN(asNum) && String(asNum) === part) {
        key = asNum;
      } else if (isBracket) {
        // Only resolve as a variable from context for bracket-derived parts
        const resolved = evalExpr(part, context);
        key = resolved !== undefined ? String(resolved) : part;
      } else {
        // Dot-derived parts or root — use the part name directly as the key
        key = part;
      }
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

function findOutsideQuotes(expr: string, needle: string): number {
  // Fast path. This is the hottest function in a render: profiling the Python
  // twin showed 415,200 calls and 53% of render time for one 20-row loop
  // template, and the overwhelming majority return -1 because the needle simply
  // is not in the expression. includes() is a native scan, so bailing here skips
  // the whole JS character loop. Exact, not a heuristic: a needle absent from
  // the string cannot be present outside quotes either.
  if (!expr.includes(needle)) return -1;

  let inQuote: string | null = null;
  let depth = 0;
  let bracketDepth = 0;
  let i = 0;
  // Hoisted out of the loop condition -- both lengths were recomputed on every
  // single iteration.
  const needleLen = needle.length;
  const lastStart = expr.length - needleLen;
  while (i <= lastStart) {
    const ch = expr[i];
    if ((ch === '"' || ch === "'") && depth === 0 && bracketDepth === 0) {
      if (inQuote === null) {
        inQuote = ch;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      i++;
      continue;
    }
    if (inQuote) { i++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
    // startsWith(needle, i) rather than slice(i, i + needleLen) === needle: the
    // slice allocated a throwaway string at every character position.
    if (depth === 0 && bracketDepth === 0 && expr.startsWith(needle, i)) {
      return i;
    }
    i++;
  }
  return -1;
}

function splitOutsideQuotes(expr: string, sep: string): string[] {
  // Fast path, same reasoning as findOutsideQuotes: no separator anywhere means
  // no split, and includes() is a native scan versus a JS character loop.
  if (!expr.includes(sep)) return [expr];

  const parts: string[] = [];
  let currentStart = 0;
  let inQuote: string | null = null;
  let depth = 0;
  let bracketDepth = 0;
  let i = 0;
  // Hoisted out of the loop condition -- recomputed every iteration before.
  const sepLen = sep.length;
  const lastStart = expr.length - sepLen;
  while (i <= lastStart) {
    const ch = expr[i];
    if ((ch === '"' || ch === "'") && depth === 0 && bracketDepth === 0) {
      if (inQuote === null) {
        inQuote = ch;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      i++;
      continue;
    }
    if (inQuote) { i++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
    // startsWith avoids allocating a throwaway slice at every position.
    if (depth === 0 && bracketDepth === 0 && expr.startsWith(sep, i)) {
      parts.push(expr.slice(currentStart, i));
      i += sepLen;
      currentStart = i;
      continue;
    }
    i++;
  }
  parts.push(expr.slice(currentStart));
  return parts;
}

function evalExpr(expr: string, context: Record<string, unknown>): unknown {
  expr = expr.trim();

  // String literal early-return: if the entire expression is a single quoted
  // string with no unescaped matching quotes inside, return its content.
  if (expr.length >= 2) {
    const q = expr[0];
    if ((q === '"' || q === "'") && expr.endsWith(q) && !expr.slice(1, -1).includes(q)) {
      return expr.slice(1, -1);
    }
  }

  // Parenthesized sub-expression: (expr) — strip parens and evaluate inner
  if (expr.length >= 2 && expr[0] === "(" && expr.endsWith(")")) {
    let depth = 0;
    let matched = true;
    for (let pi = 0; pi < expr.length; pi++) {
      if (expr[pi] === "(") depth++;
      else if (expr[pi] === ")") depth--;
      if (depth === 0 && pi < expr.length - 1) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return evalExpr(expr.slice(1, -1), context);
    }
  }

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

  // Jinja2-style inline if: value if condition else other_value — quote-aware
  const ifIdx = findOutsideQuotes(expr, " if ");
  if (ifIdx >= 0) {
    const elseIdx = findOutsideQuotes(expr, " else ");
    if (elseIdx >= 0 && elseIdx > ifIdx) {
      const valuePart = expr.slice(0, ifIdx).trim();
      const condPart = expr.slice(ifIdx + 4, elseIdx).trim();
      const elsePart = expr.slice(elseIdx + 6).trim();
      const cond = evalExpr(condPart, context);
      return cond ? evalExpr(valuePart, context) : evalExpr(elsePart, context);
    }
  }

  // Null coalescing: value ?? "default"
  const qqIdx = findOutsideQuotes(expr, "??");
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
  if (findOutsideQuotes(expr, "~") >= 0) {
    const parts = splitOutsideQuotes(expr, "~");
    if (parts.length > 1) {
      return parts.map(p => {
        const v = evalExpr(p.trim(), context);
        return v === null || v === undefined ? "" : String(v);
      }).join("");
    }
  }

  // Check for comparison/logical operators
  for (const op of [" not in ", " in ", " is not ", " is ", "!=", "==", ">=", "<=", ">", "<", " and ", " or ", " not "]) {
    if (findOutsideQuotes(expr, op) >= 0) {
      return evalComparison(expr, context);
    }
  }

  // Arithmetic operators: +, -, *, //, /, %, ** (lowest to highest precedence)
  for (const op of [" + ", " - ", " * ", " // ", " / ", " % ", " ** "]) {
    const pos = findOutsideQuotes(expr, op);
    if (pos >= 0) {
      const left = expr.slice(0, pos).trim();
      const right = expr.slice(pos + op.length).trim();
      const lVal = evalExpr(left, context);
      const rVal = evalExpr(right, context);
      try {
        let lNum = lVal != null ? Number(lVal) : 0;
        let rNum = rVal != null ? Number(rVal) : 0;
        if (isNaN(lNum)) lNum = 0;
        if (isNaN(rNum)) rNum = 0;
        const opS = op.trim();
        // Preserve int type when both operands are int-like (except for / which returns float)
        const bothInt = Number.isInteger(lNum) && Number.isInteger(rNum) && opS !== "/";
        let result: number;
        switch (opS) {
          case "+": result = lNum + rNum; break;
          case "-": result = lNum - rNum; break;
          case "*": result = lNum * rNum; break;
          case "//": result = rNum !== 0 ? Math.floor(lNum / rNum) : 0; break;
          case "/": result = rNum !== 0 ? lNum / rNum : 0; break;
          case "%": result = rNum !== 0 ? lNum % rNum : 0; break;
          case "**": result = lNum ** rNum; break;
          default: result = 0;
        }
        return bothInt && Number.isInteger(result) ? result : result;
      } catch {
        return null;
      }
    }
  }

  // Filter pipe: value | filter1 | filter2(args). In Twig `|` binds TIGHTER than
  // concat (`~`), comparisons and arithmetic, but looser than member/function
  // access — so it is resolved here, AFTER those operators have had a chance to
  // split the expression. Handling it inside the expression evaluator (not only
  // at the {{ }} output layer) makes filters work at any nesting depth: concat
  // operands, ternary branches, and parenthesised sub-expressions. This fixes
  // both the `|`-vs-`~` precedence bug and the "pipe inside parens returns empty"
  // defect. (#171)
  if (findOutsideQuotes(expr, "|") >= 0) {
    const [baseExpr, filters] = parseFilterChain(expr);
    if (filters.length > 0) {
      const baseValue = evalExpr(baseExpr, context);
      const applier = (context as {
        __frond_apply_filters__?: (
          value: unknown,
          filters: [string, unknown[]][],
          context: Record<string, unknown>,
        ) => unknown;
      }).__frond_apply_filters__;
      if (applier) {
        return applier(baseValue, filters, context);
      }
      // No Frond instance in context (evalExpr used stand-alone) — apply the
      // built-in filters directly so common cases still resolve.
      let value = baseValue;
      for (const [fname, rawArgs] of filters) {
        if (fname === "raw" || fname === "safe") continue;
        const args = rawArgs.map((a) => (a instanceof VarRef ? evalExpr(a.name, context) : a));
        const fn = BUILTIN_FILTERS[fname];
        if (fn) value = fn(value, ...args);
      }
      return value;
    }
  }

  // Function call: name("arg1", "arg2") — supports dotted names like user.t("key")
  const fnMatch = expr.match(FN_CALL_RE);
  if (fnMatch) {
    const fnName = fnMatch[1];
    const rawArgs = fnMatch[2] || "";

    // Dotted function name: resolve object, then call method
    if (fnName.includes(".")) {
      const lastDot = fnName.lastIndexOf(".");
      const objPath = fnName.slice(0, lastDot);
      const methodName = fnName.slice(lastDot + 1);
      const obj = resolveVar(objPath, context);
      if (obj && typeof obj === "object" && methodName in (obj as Record<string, unknown>)) {
        const method = (obj as Record<string, unknown>)[methodName];
        if (typeof method === "function") {
          if (rawArgs.trim()) {
            const parts = splitArgs(rawArgs);
            const evalArgs = parts.map(a => evalExpr(a.trim(), context));
            return method.apply(obj, evalArgs);
          }
          return method.call(obj);
        }
      }
    } else {
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

function evalComparison(
  expr: string,
  context: Record<string, unknown>,
  evalFn?: (expr: string, context: Record<string, unknown>) => unknown,
): boolean {
  const ev = evalFn ?? evalExpr;
  expr = expr.trim();

  // Handle 'not' prefix
  if (expr.startsWith("not ")) {
    return !evalComparison(expr.slice(4), context, evalFn);
  }

  // 'or' (lowest precedence)
  const orParts = splitOnKeyword(expr, " or ");
  if (orParts.length > 1) {
    return orParts.some(p => evalComparison(p, context, evalFn));
  }

  // 'and'
  const andParts = splitOnKeyword(expr, " and ");
  if (andParts.length > 1) {
    return andParts.every(p => evalComparison(p, context, evalFn));
  }

  // 'is not' test
  let m = expr.match(IS_NOT_RE);
  if (m) {
    return !evalTest(m[1].trim(), m[2], m[3].trim(), context, evalFn);
  }

  // 'is' test
  m = expr.match(IS_RE);
  if (m) {
    return evalTest(m[1].trim(), m[2], m[3].trim(), context, evalFn);
  }

  // 'not in'
  m = expr.match(NOT_IN_RE);
  if (m) {
    const val = ev(m[1].trim(), context);
    const collection = ev(m[2].trim(), context);
    if (Array.isArray(collection)) return !collection.includes(val);
    if (typeof collection === "string") return !collection.includes(val as string);
    return true;
  }

  // 'in'
  m = expr.match(IN_RE);
  if (m) {
    const val = ev(m[1].trim(), context);
    const collection = ev(m[2].trim(), context);
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
      const l = ev(left, context);
      const r = ev(right, context);
      try {
        return fn(l, r);
      } catch {
        return false;
      }
    }
  }

  // Fall through to simple eval
  const val = ev(expr, context);
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
  evalFn?: (expr: string, context: Record<string, unknown>) => unknown,
): boolean {
  const ev = evalFn ?? evalExpr;
  const val = ev(valueExpr, context);

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
    const dm = args.match(DIVISIBLE_BY_RE);
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

/**
 * Split `"first.groupSummary"` into `["first", "groupSummary"]` so a
 * filter segment followed by property access — `{{ x | first.name }}`
 * — can apply the filter then traverse the path on the result. Returns
 * `[fname, ""]` when no structural `.` is present.
 *
 * The split point sits outside parens/brackets/braces and quotes so
 * filter args like `round(1.5)` or `date("Y.m.d")` don't false-trigger.
 * Parity with tina4-python and tina4-php.
 */
function splitFilterNameAndPath(fname: string): [string, string] {
  let depth = 0;
  let inQ: string | null = null;
  for (let i = 0; i < fname.length; i++) {
    const ch = fname[i];
    if (inQ !== null) {
      if (ch === inQ && (i === 0 || fname[i - 1] !== "\\")) inQ = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQ = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
    if (ch === "." && depth === 0) {
      return [fname.slice(0, i), fname.slice(i + 1)];
    }
  }
  return [fname, ""];
}

function parseFilterChain(expr: string): [string, [string, unknown[]][]] {
  // Check cache first
  const cached = filterChainCache.get(expr);
  if (cached) return cached;

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
  const filters: [string, unknown[]][] = [];

  for (let i = 1; i < parts.length; i++) {
    const f = parts[i].trim();
    const fm = f.match(FILTER_WITH_ARGS_RE);
    if (fm) {
      const name = fm[1];
      const rawArgs = fm[2].trim();
      const args = rawArgs ? parseArgs(rawArgs) : [];
      filters.push([name, args]);
    } else {
      filters.push([f.trim(), []]);
    }
  }

  const result: [string, [string, unknown[]][]] = [variable, filters];
  filterChainCache.set(expr, result);
  return result;
}

/**
 * An UNQUOTED bareword filter argument — a variable reference (or dotted/bracket
 * path), not a literal. Resolved against the render context at apply-time so
 * `{{ '%.2f' | format(price) }}` binds `price` to its value. Quoted literals
 * (`default('fb')`) stay plain strings and are never resolved.
 */
class VarRef {
  constructor(public name: string) {}
}

/** Coerce an unquoted arg token to a typed value, or a VarRef if it's a name. */
function coerceArg(t: string): unknown {
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "none" || t === "nil") return null;
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { return JSON.parse(t); } catch { /* not JSON — fall through */ }
  }
  return new VarRef(t); // bareword / path → resolve at apply-time
}

function parseArgs(raw: string): unknown[] {
  const args: unknown[] = [];
  let current = "";
  let inQuote: string | null = null;
  let wasQuoted = false;
  let depth = 0;

  const flush = (): void => {
    if (wasQuoted) args.push(current);
    else { const t = current.trim(); if (t !== "") args.push(coerceArg(t)); }
    current = "";
    wasQuoted = false;
  };

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
    if (ch === "," && depth === 0) { flush(); continue; }
    current += ch;
  }
  flush();

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

function numberFormat(
  value: unknown,
  decimals: number,
  decimalPoint = ".",
  thousandsSep = ",",
): string {
  const num = parseFloat(String(value));
  const fixed = num.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const formatted = intPart.replace(THOUSANDS_RE, thousandsSep);
  return decPart ? `${formatted}${decimalPoint}${decPart}` : formatted;
}

const BUILTIN_FILTERS: Record<string, FilterFn> = {
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  capitalize: (v) => { const s = String(v); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); },
  title: (v) => String(v).replace(TITLE_WORD_RE, c => c.toUpperCase()),
  trim: (v) => String(v).trim(),
  ltrim: (v) => String(v).replace(LEADING_WS_RE, ""),
  rtrim: (v) => String(v).replace(TRAILING_WS_RE, ""),
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
  replace: (v: unknown, from?: unknown, to?: unknown) => {
    const s = String(v);
    if (from !== undefined && typeof from === 'object' && from !== null && !Array.isArray(from)) {
      let result = s;
      for (const [old, newVal] of Object.entries(from as Record<string, unknown>)) {
        result = result.split(old).join(String(newVal));
      }
      return result;
    }
    if (from !== undefined && to !== undefined) {
      return s.split(String(from)).join(String(to));
    }
    return s;
  },
  default: (v, fallback) => (v !== null && v !== undefined && v !== "") ? v : (fallback !== undefined ? fallback : ""),
  raw: (v) => v,
  safe: (v) => v,
  escape: (v) => htmlEscape(String(v)),
  e: (v) => htmlEscape(String(v)),
  striptags: (v) => String(v).replace(STRIP_TAGS_RE, ""),
  nl2br: (v) => new SafeString(htmlEscape(String(v)).replace(/\n/g, "<br />\n")),
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
  // Twig signature: number_format(decimals=0, decimalPoint='.', thousandsSep=',').
  // 1-arg (or no-arg) calls keep the original output; args 2/3 enable localized
  // formats like `1.234,50`. (#170)
  number_format: (v, decimals, decimalPoint, thousandsSep) => numberFormat(
    v,
    decimals !== undefined ? parseInt(String(decimals), 10) : 0,
    decimalPoint !== undefined ? String(decimalPoint) : ".",
    thousandsSep !== undefined ? String(thousandsSep) : ",",
  ),
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
  base64encode: (v) => Buffer.isBuffer(v) ? v.toString("base64") : Buffer.from(String(v)).toString("base64"),
  base64_decode: (v) => Buffer.from(String(v), "base64").toString("utf-8"),
  base64decode: (v) => Buffer.from(String(v), "base64").toString("utf-8"),
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
    let idx = 0;
    return String(v).replace(FORMAT_RE, (m, flags, width, prec, type) => {
      if (m === "%%") return "%";
      const arg = args[idx++];
      const p = prec !== undefined ? parseInt(String(prec), 10) : undefined;
      let out: string;
      switch (type) {
        case "s": out = String(arg ?? ""); break;
        case "d": case "i": out = String(Math.trunc(Number(arg) || 0)); break;
        case "f": case "F": out = Number(arg).toFixed(p !== undefined ? p : 6); break;
        case "e": case "E": {
          out = Number(arg).toExponential(p !== undefined ? p : 6);
          if (type === "E") out = out.toUpperCase();
          break;
        }
        case "g": case "G": out = String(Number(arg)); break;
        case "x": out = Math.trunc(Number(arg) || 0).toString(16); break;
        case "X": out = Math.trunc(Number(arg) || 0).toString(16).toUpperCase(); break;
        case "o": out = Math.trunc(Number(arg) || 0).toString(8); break;
        case "b": out = Math.trunc(Number(arg) || 0).toString(2); break;
        default:  out = String(arg ?? "");
      }
      if (width) {
        const w = parseInt(String(width), 10);
        if (out.length < w) {
          const f = String(flags || "");
          if (f.includes("-")) out = out.padEnd(w, " ");
          else out = out.padStart(w, f.includes("0") ? "0" : " ");
        }
      }
      return out;
    });
  },
  dump: (v) => JSON.stringify(v),
  formToken: (v?: unknown) => _generateFormToken(v != null ? String(v) : ""),
  form_token: (v?: unknown) => _generateFormToken(v != null ? String(v) : ""),
  formTokenValue: (v?: unknown) => _generateFormTokenValue(v != null ? String(v) : ""),
  form_token_value: (v?: unknown) => _generateFormTokenValue(v != null ? String(v) : ""),
  tojson: (v, indent) => new SafeString(indent !== undefined ? JSON.stringify(v, null, parseInt(String(indent), 10)) : JSON.stringify(v)),
  to_json: (v, indent) => new SafeString(indent !== undefined ? JSON.stringify(v, null, parseInt(String(indent), 10)) : JSON.stringify(v)),
  js_escape: (v) => new SafeString(String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")),
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
/**
 * Module-level session ID holder — set by the server before rendering
 * templates so that form_token() can bind tokens to the current session.
 */
let _formTokenSessionId: string = "";

/**
 * Set the session ID used by formToken() / form_token() for CSRF session binding.
 */
export function setFormTokenSessionId(sessionId: string): void {
  _formTokenSessionId = sessionId || "";
}

function _buildFormTokenJwt(descriptor: string = ""): string {
  const secret = process.env.TINA4_SECRET || "tina4-default-secret";
  const ttlMinutes = parseInt(process.env.TINA4_TOKEN_LIMIT || "60", 10);

  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { type: "form", nonce: randomBytes(8).toString("hex"), iat: now, exp: now + ttlMinutes * 60 };

  if (descriptor) {
    if (descriptor.includes("|")) {
      const [ctx, ref] = descriptor.split("|", 2);
      payload.context = ctx;
      payload.ref = ref;
    } else {
      payload.context = descriptor;
    }
  }

  // Include session_id for CSRF session binding
  if (_formTokenSessionId) {
    payload.session_id = _formTokenSessionId;
  }

  const h = _b64url(Buffer.from(JSON.stringify(header)));
  const p = _b64url(Buffer.from(JSON.stringify(payload)));
  const sigInput = `${h}.${p}`;
  const sig = _b64url(createHmac("sha256", secret).update(sigInput).digest());

  return `${h}.${p}.${sig}`;
}

function _generateFormToken(descriptor: string = ""): SafeString {
  const token = _buildFormTokenJwt(descriptor);
  const escaped = token.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new SafeString(`<input type="hidden" name="formToken" value="${escaped}">`);
}

/**
 * Generate a JWT form token and return just the raw JWT string (no HTML wrapper).
 */
function _generateFormTokenValue(descriptor: string = ""): SafeString {
  return new SafeString(_buildFormTokenJwt(descriptor));
}

// ── Frond Engine ───────────────────────────────────────────────

export class Frond {
  // ── Class-level registries ──────────────────────────────────
  // Persist globals, filters, and tests across hot-reloads and at
  // app-startup before any instance exists. When app.ts calls
  // ``Frond.addFilter("money", fn)`` once, the class remembers it
  // and every future ``new Frond()`` inherits it automatically.
  // Mirrors Python's _class_globals / _class_filters / _class_tests.
  private static classFilters: Map<string, FilterFn> = new Map();
  private static classGlobals: Map<string, unknown> = new Map();
  private static classTests: Map<string, TestFn> = new Map();

  // ── Live-block registries (server-rendered {% live %} regions) ──
  // A {% live %} block registers three things when its page first renders:
  //   liveFragments[name] -> the raw body source, re-rendered on every
  //                          refresh by GET /__frond/live/<name> or pushLive
  //   liveSources[name]   -> an optional data provider (liveSource) that
  //                          re-runs with the LIVE request each refresh, so
  //                          auth re-applies (IDOR guard)
  //   liveWsPaths[name]   -> the ws path a `ws "path"` block declared, the
  //                          pushLive broadcast target
  // Static so they persist across requests in the long-lived server. Mirrors
  // the Python master's class-level dicts and PHP/Ruby static registries.
  private static liveFragments: Map<string, string> = new Map();
  private static liveSources: Map<string, LiveProvider> = new Map();
  private static liveWsPaths: Map<string, string> = new Map();
  // Best-effort WebSocket broadcaster wired by @tina4/core at boot (frond is a
  // zero-dep leaf package and cannot import core). pushLive calls it if set.
  private static liveBroadcaster: LiveBroadcaster | null = null;

  /**
   * Register a custom filter at the class level — available to every
   * future ``new Frond()`` instance. Callable as ``Frond.addFilter()``
   * (static) or ``frond.addFilter()`` (instance). See instance method
   * below for the dual-call semantics.
   */
  static addFilter(name: string, fn: FilterFn): void {
    Frond.classFilters.set(name, fn);
  }

  /**
   * Register a global variable available in all templates of every
   * future instance. Callable as ``Frond.addGlobal()`` (static) or
   * ``frond.addGlobal()`` (instance).
   */
  static addGlobal(name: string, value: unknown): void {
    Frond.classGlobals.set(name, value);
  }

  /**
   * Register a custom test (``{% if x is positive %}``) at the class
   * level. Callable as ``Frond.addTest()`` (static) or
   * ``frond.addTest()`` (instance).
   */
  static addTest(name: string, fn: TestFn): void {
    Frond.classTests.set(name, fn);
  }

  /**
   * Clear the class-level globals/filters/tests registries.
   * Useful in test fixtures to prevent leaking state between tests.
   * Does NOT affect built-in filters or globals — only user-registered
   * ones via Frond.addFilter / addGlobal / addTest.
   */
  static clearRegistry(): void {
    Frond.classFilters.clear();
    Frond.classGlobals.clear();
    Frond.classTests.clear();
    Frond.liveFragments.clear();
    Frond.liveSources.clear();
    Frond.liveWsPaths.clear();
  }

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
  /**
   * Token pre-compilation cache for file templates.
   *
   * `cachedAt` is captured so the TINA4_TEMPLATE_CACHE_TTL env var can
   * force re-compilation after N seconds even in production. TTL of 0
   * means "no time-based invalidation" — entries live forever.
   */
  private compiled = new Map<string, { tokens: Token[]; mtime: number; cachedAt: number }>();
  /** Token pre-compilation cache for string templates */
  private compiledStrings = new Map<string, { tokens: Token[]; cachedAt: number }>();

  /**
   * Bound reference to `applyFilters`, stashed into the render context as
   * `__frond_apply_filters__` so the module-level `evalExpr` can resolve a
   * filter pipe using THIS instance's registered filters. Bound once. (#171)
   */
  private readonly _applyFiltersBound = this.applyFilters.bind(this);

  getTemplateDir(): string { return this.templateDir; }

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
    this.globals.formTokenValue = (descriptor?: string) => _generateFormTokenValue(descriptor || "");
    this.globals.form_token_value = (descriptor?: string) => _generateFormTokenValue(descriptor || "");

    // Debug helper: {{ dump(x) }} — gated on TINA4_DEBUG, see renderDump().
    // Available alongside the |dump filter so both styles work:
    //   {{ user|dump }}   and   {{ dump(user) }}
    this.globals.dump = (value: unknown) => renderDump(value);

    // Drain the class-level registry. This is the key to surviving
    // hot-reloads AND the static-facade pattern: app.ts calls
    // Frond.addFilter("money", fn) once, the class remembers it,
    // and every future Frond() instance picks it up automatically.
    for (const [k, v] of Frond.classFilters) this.filters[k] = v;
    for (const [k, v] of Frond.classGlobals) this.globals[k] = v;
    for (const [k, v] of Frond.classTests) this.tests[k] = v;
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

  /**
   * Register a custom filter. The filter is persisted at class level
   * so new instances created by hot-reload inherit it automatically;
   * the live instance's local filter map also receives the addition
   * immediately. Mirrors Python's _ClassOrInstanceMethod dual-call.
   */
  addFilter(name: string, fn: FilterFn): void {
    Frond.classFilters.set(name, fn);
    this.filters[name] = fn;
  }

  /**
   * Register a global variable available in all templates. Persisted
   * at class level — see ``addFilter`` for the dual-call semantics.
   */
  addGlobal(name: string, value: unknown): void {
    Frond.classGlobals.set(name, value);
    this.globals[name] = value;
  }

  /**
   * Register a custom test. Persisted at class level — see
   * ``addFilter`` for the dual-call semantics.
   */
  addTest(name: string, fn: TestFn): void {
    Frond.classTests.set(name, fn);
    this.tests[name] = fn;
  }

  /**
   * Read the cache TTL in seconds. `TINA4_TEMPLATE_CACHE_TTL=0` (the
   * default) keeps the existing "cache forever in prod" behaviour — any
   * positive value invalidates compiled tokens after N seconds, useful
   * when running long-lived servers behind a slow file sync where mtime
   * isn't a reliable freshness signal.
   */
  private cacheTtlSeconds(): number {
    const raw = process.env.TINA4_TEMPLATE_CACHE_TTL;
    if (raw === undefined) return 0;
    const n = parseInt(raw, 10);
    return isNaN(n) || n < 0 ? 0 : n;
  }

  render(template: string, data?: Record<string, unknown>): string {
    const context = { ...this.globals, ...(data || {}) };
    const filePath = join(this.templateDir, template);

    if (!existsSync(filePath)) {
      throw new Error(`Template not found: ${filePath}`);
    }

    const debugMode = (process.env.TINA4_DEBUG || "").toLowerCase() === "true";
    const ttlMs = this.cacheTtlSeconds() * 1000;

    if (!debugMode) {
      // Production: use permanent cache (no filesystem checks)
      const cached = this.compiled.get(template);
      if (cached) {
        // TTL=0 means cache forever; any positive value invalidates the
        // compiled tokens after N seconds.
        if (ttlMs === 0 || (Date.now() - cached.cachedAt) < ttlMs) {
          return this.executeCached(cached.tokens, context);
        }
      }
    }
    // Dev mode: skip cache entirely — always re-read and re-tokenize
    // so edits to partials and extended base templates are detected

    // Cache miss — load, tokenize, cache
    const source = readFileSync(filePath, "utf-8");
    const mtime = statSync(filePath).mtimeMs;
    const tokens = tokenize(source);
    capCache(this.compiled as Map<string, unknown>, TEMPLATE_CACHE_MAX);
    this.compiled.set(template, { tokens, mtime, cachedAt: Date.now() });
    return this.executeWithSource(source, tokens, context);
  }

  renderString(source: string, data?: Record<string, unknown>): string {
    const context = { ...this.globals, ...(data || {}) };

    const key = createHash("md5").update(source).digest("hex");
    const ttlMs = this.cacheTtlSeconds() * 1000;
    const cached = this.compiledStrings.get(key);
    if (cached) {
      if (ttlMs === 0 || (Date.now() - cached.cachedAt) < ttlMs) {
        return this.executeCached(cached.tokens, context);
      }
    }

    const tokens = tokenize(source);
    capCache(this.compiledStrings as Map<string, unknown>, TEMPLATE_CACHE_MAX);
    this.compiledStrings.set(key, { tokens, cachedAt: Date.now() });
    return this.executeCached(tokens, context);
  }

  /** Clear all compiled template caches. */
  clearCache(): void {
    this.compiled.clear();
    this.compiledStrings.clear();
  }

  /** Render a debug dump of a value as HTML — parity with PHP/Ruby/Python.
   * Gated on TINA4_DEBUG=true. Returns empty string in production. */
  renderDump(value: unknown): string {
    return renderDump(value).toString();
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
    const blockOpen = /\{%[-\s]*block\s+(\w+)\s*[-]?%\}/g;
    const blockClose = /\{%[-\s]*endblock\s*[-]?%\}/g;

    let pos = 0;
    while (pos < source.length) {
      blockOpen.lastIndex = pos;
      const mOpen = blockOpen.exec(source);
      if (!mOpen) break;

      const name = mOpen[1];
      const contentStart = mOpen.index + mOpen[0].length;
      let depth = 1;
      let scan = contentStart;

      while (depth > 0 && scan < source.length) {
        blockOpen.lastIndex = scan;
        blockClose.lastIndex = scan;
        const nextOpen = blockOpen.exec(source);
        const nextClose = blockClose.exec(source);

        if (!nextClose) break; // malformed — no matching endblock

        if (nextOpen && nextOpen.index < nextClose.index) {
          depth++;
          scan = nextOpen.index + nextOpen[0].length;
        } else {
          depth--;
          if (depth === 0) {
            blocks[name] = source.slice(contentStart, nextClose.index);
            pos = nextClose.index + nextClose[0].length;
            break;
          }
          scan = nextClose.index + nextClose[0].length;
        }
      }

      if (depth > 0) {
        // malformed, skip forward
        pos = contentStart;
      }
    }
    return blocks;
  }

  private renderWithBlocks(
    parentSource: string,
    context: Record<string, unknown>,
    childBlocks: Record<string, string>,
  ): string {
    // --- Multi-level extends: check if parent itself extends a grandparent ---
    const extendsMatch = parentSource.trimStart().match(/\{%[-\s]*extends\s+["'](.+?)["']\s*[-]?%\}/);
    if (extendsMatch) {
      const grandparentName = extendsMatch[1];
      const grandparentSource = this.load(grandparentName);

      // Extract block defaults defined in the parent template
      const parentBlocks = this.extractBlocks(parentSource);

      // Child blocks override parent blocks at the same name
      const mergedBlocks: Record<string, string> = { ...parentBlocks, ...childBlocks };

      // Resolve nested blocks: if a block value contains {% block inner %} tags,
      // replace them with mergedBlocks values too
      const nestedBlockRe = /\{%[-\s]*block\s+(\w+)\s*[-]?%\}([\s\S]*?)\{%[-\s]*endblock\s*[-]?%\}/g;
      let changed = true;
      while (changed) {
        changed = false;
        for (const name of Object.keys(mergedBlocks)) {
          const resolved = mergedBlocks[name].replace(nestedBlockRe, (_m, innerName: string, innerDefault: string) => {
            return mergedBlocks[innerName] ?? innerDefault;
          });
          if (resolved !== mergedBlocks[name]) {
            mergedBlocks[name] = resolved;
            changed = true;
          }
        }
      }

      // Recurse up the chain (handles 3+, 4+, ... levels)
      return this.renderWithBlocks(grandparentSource, context, mergedBlocks);
    }

    // --- Leaf parent (no extends) — resolve blocks and render ---
    const pattern = /\{%[-\s]*block\s+(\w+)\s*[-]?%\}([\s\S]*?)\{%[-\s]*endblock\s*[-]?%\}/g;
    const engine = this;

    const result = parentSource.replace(pattern, (_match, name: string, parentContent: string) => {
      const blockSource = childBlocks[name] ?? parentContent;

      // Make parent() and super() available inside child blocks
      let renderedParent: SafeString | null = null;
      const getParent = (): SafeString => {
        if (renderedParent === null) {
          renderedParent = new SafeString(
            engine.renderTokens(tokenize(parentContent), context),
          );
        }
        return renderedParent;
      };

      const blockCtx = { ...context, parent: getParent, super: getParent };
      return this.renderTokens(tokenize(blockSource), blockCtx);
    });

    return this.renderTokens(tokenize(result), context);
  }

  private renderTokens(tokens: Token[], context: Record<string, unknown>): string {
    // Expose this instance's filter engine to the module-level evalExpr so a
    // filter pipe resolves at any expression depth with the right (custom)
    // filters. The currently-rendering engine always wins — an included/macro
    // template rendered by another engine re-stamps its own here. (#171)
    (context as { __frond_apply_filters__?: unknown }).__frond_apply_filters__ = this._applyFiltersBound;

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
          output[output.length - 1] = output[output.length - 1].replace(TRAILING_WS_RE, "");
        }

        const result = this.evalVar(content, context);
        output.push(result !== null && result !== undefined ? String(result) : "");

        if (stripA && i + 1 < tokens.length && tokens[i + 1][0] === "TEXT") {
          tokens[i + 1] = ["TEXT", tokens[i + 1][1].replace(LEADING_WS_RE, "")];
        }
        i++;
      } else if (ttype === "BLOCK") {
        const [content, stripB, stripA] = stripTag(raw);
        if (stripB && output.length > 0) {
          output[output.length - 1] = output[output.length - 1].replace(TRAILING_WS_RE, "");
        }

        const parts = content.split(/\s+/);
        const tag = parts[0] || "";

        // Apply stripA before handlers consume body tokens
        if (stripA && i + 1 < tokens.length && tokens[i + 1][0] === "TEXT") {
          tokens[i + 1] = ["TEXT", tokens[i + 1][1].replace(LEADING_WS_RE, "")];
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
        } else if (tag === "live") {
          const [result, skip] = this.handleLive(tokens, i, context);
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
          tokens[i] = ["TEXT", tokens[i][1].replace(LEADING_WS_RE, "")];
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

  /**
   * Apply a parsed filter chain to an already-evaluated value. This is the
   * instance-aware filter engine used by `evalExpr` (via the
   * `__frond_apply_filters__` hook in the render context) so filters resolve
   * with this Frond's registered/custom filters at ANY nesting depth — inside
   * concat operands, ternary branches, and parenthesised sub-expressions — not
   * only at the top-level {{ }} output. Mirrors the filter loop in
   * `evalVarRaw`: `first`/`last` tail-paths, registered `this.filters`, and the
   * trailing-comparison form (`length != 1`). Auto-escaping stays the caller's
   * concern (`evalVarInner`). (#171)
   */
  private applyFilters(
    value: unknown,
    filters: [string, unknown[]][],
    context: Record<string, unknown>,
  ): unknown {
    for (const [fname, rawArgs] of filters) {
      const args = rawArgs.map((a) => (a instanceof VarRef ? evalExpr(a.name, context) : a));
      if (fname === "raw" || fname === "safe") continue;

      // Sandbox: a blocked filter is silently skipped (value passes through
      // unchanged) — same gate as evalVarInner. applyFilters is reached by the
      // folded filter pipe in evalExpr (`x|f ~ y`, #171), so without this gate a
      // non-allow-listed filter would run in sandbox mode.
      if (this._sandbox && this._allowedFilters !== null && !this._allowedFilters.has(fname)) continue;

      const [realFname, tailPath] = splitFilterNameAndPath(fname);
      if (tailPath) {
        let applied = false;
        if (realFname === "first") {
          value = Array.isArray(value) ? value[0] ?? null : null;
          applied = true;
        } else if (realFname === "last") {
          value = Array.isArray(value) ? value[value.length - 1] ?? null : null;
          applied = true;
        } else if (this.filters[realFname]) {
          value = this.filters[realFname](value, ...args);
          applied = true;
        }
        if (applied) {
          value = evalExpr("__frondFilterTmp." + tailPath, { __frondFilterTmp: value });
          continue;
        }
      }

      const fn = this.filters[fname];
      if (fn) {
        value = fn(value, ...args);
      } else {
        // The filter name may carry a trailing comparison operator, e.g.
        // "length != 1" — apply the real filter, then evaluate the comparison.
        const m = fname.match(FILTER_COMPARISON_RE);
        if (m) {
          const fn2 = this.filters[m[1]];
          if (fn2) value = fn2(value, ...args);
          const right = evalExpr(m[3].trim(), context);
          switch (m[2]) {
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
    for (const [fname, rawArgs] of filters) {
      const args = rawArgs.map((a) => (a instanceof VarRef ? evalExpr(a.name, context) : a));
      if (fname === "raw" || fname === "safe") continue;

      // Sandbox: a blocked filter is silently skipped (value passes through
      // unchanged) — same gate as evalVarInner. evalVarRaw is reached by a
      // ternary condition (`x|f ? a : b`), evalComparison, and set, none of
      // which gated filters before, so a non-allow-listed filter could run.
      if (this._sandbox && this._allowedFilters !== null && !this._allowedFilters.has(fname)) continue;

      // Filter + property-access chain: `first.groupSummary` — apply
      // the filter, then traverse the path on the result via a
      // synthetic context so evalExpr's dotted resolution does the
      // work. Parity with tina4-python + tina4-php. `first` and
      // `last` are inlined because they're in the fast-path switch
      // rather than `this.filters`.
      const [realFname, tailPath] = splitFilterNameAndPath(fname);
      if (tailPath) {
        let applied = false;
        if (realFname === "first") {
          value = Array.isArray(value) ? value[0] ?? null : null;
          applied = true;
        } else if (realFname === "last") {
          value = Array.isArray(value) ? value[value.length - 1] ?? null : null;
          applied = true;
        } else if (this.filters[realFname]) {
          value = this.filters[realFname](value, ...args);
          applied = true;
        }
        if (applied) {
          value = evalExpr("__frondFilterTmp." + tailPath,
                           { __frondFilterTmp: value });
          continue;
        }
      }

      const fn = this.filters[fname];
      if (fn) {
        value = fn(value, ...args);
      } else {
        // The filter name may include a trailing comparison operator,
        // e.g. "length != 1".  Extract the real filter name and the
        // comparison suffix, apply the filter, then evaluate the comparison.
        const m = fname.match(FILTER_COMPARISON_RE);
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

    // Concat precedence (#171): a top-level `~` means the whole expression is a
    // concatenation, and `|` binds TIGHTER than `~`. parseFilterChain above
    // wrongly glued the trailing `~ ...` onto the last filter, so evaluate the
    // WHOLE expression through evalExpr (which resolves the filter pipe at the
    // correct precedence, at any depth) and only auto-escape the result here.
    if (findOutsideQuotes(expr, "~") >= 0) {
      let concatValue = evalExpr(expr, context);
      if (concatValue instanceof SafeString) return concatValue.value;
      if (this._autoEscape && typeof concatValue === "string") {
        concatValue = htmlEscape(concatValue);
      }
      return concatValue;
    }

    let value = evalExpr(varName, context);

    let isSafe = false;
    for (const [fname, rawArgs] of filters) {
      const args = rawArgs.map((a) => (a instanceof VarRef ? evalExpr(a.name, context) : a));
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

      // Filter + property-access chain: `first.groupSummary` — apply
      // the filter, then traverse the path on the result via evalExpr.
      // Done BEFORE the inline fast-path so `items|first.name` works
      // whether or not `first` is in the fast-path list.
      //
      // We inline `first` and `last` here because they're defined by
      // the fast-path switch below, not in `this.filters` — without
      // this explicit branch, the chain would fall through and we'd
      // return the unfiltered array. All other registered filters
      // route through `this.filters[realFname]`.
      const [realFname, tailPath] = splitFilterNameAndPath(fname);
      if (tailPath) {
        let applied = false;
        if (realFname === "first") {
          value = Array.isArray(value) ? value[0] ?? null : null;
          applied = true;
        } else if (realFname === "last") {
          value = Array.isArray(value) ? value[value.length - 1] ?? null : null;
          applied = true;
        } else if (this.filters[realFname]) {
          value = this.filters[realFname](value, ...args);
          applied = true;
        }
        if (applied) {
          value = evalExpr("__frondFilterTmp." + tailPath,
                           { __frondFilterTmp: value });
          continue;
        }
      }

      // Inline fast-path for common no-arg filters — avoids generic dispatch
      if (args.length === 0) {
        switch (fname) {
          case "upper":      value = String(value).toUpperCase(); continue;
          case "lower":      value = String(value).toLowerCase(); continue;
          case "trim":       value = String(value).trim(); continue;
          case "length":
            if (Array.isArray(value)) { value = value.length; }
            else if (typeof value === "string") { value = value.length; }
            else if (typeof value === "object" && value !== null) { value = Object.keys(value).length; }
            else { value = 0; }
            continue;
          case "capitalize": { const s = String(value); value = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); continue; }
          case "title":      value = String(value).replace(TITLE_WORD_RE, c => c.toUpperCase()); continue;
          case "string":     value = String(value); continue;
          case "int":        value = value ? parseInt(String(value), 10) || 0 : 0; continue;
          case "float":      value = value ? parseFloat(String(value)) || 0.0 : 0.0; continue;
          case "abs":        value = typeof value === "number" ? Math.abs(value) : value; continue;
          case "striptags":  value = String(value).replace(STRIP_TAGS_RE, ""); continue;
          case "first":      value = Array.isArray(value) ? value[0] ?? null : null; continue;
          case "last":       value = Array.isArray(value) ? value[value.length - 1] ?? null : null; continue;
          case "keys":       value = (typeof value === "object" && value !== null && !Array.isArray(value)) ? Object.keys(value) : []; continue;
          case "values":     value = (typeof value === "object" && value !== null && !Array.isArray(value)) ? Object.values(value) : []; continue;
          case "json_encode": value = JSON.stringify(value); continue;
          case "dump":
            // Delegates to renderDump(), which is gated on TINA4_DEBUG.
            // In production this emits an empty SafeString (no leaked state).
            value = renderDump(value);
            continue;
          case "nl2br":      value = new SafeString(htmlEscape(String(value)).replace(/\n/g, "<br />\n")); continue;
          case "unique":     value = Array.isArray(value) ? [...new Set(value)] : value; continue;
          case "sort":       value = Array.isArray(value) ? [...value].sort() : value; continue;
          case "reverse":    value = Array.isArray(value) ? [...value].reverse() : String(value).split("").reverse().join(""); continue;
          case "filter":     value = Array.isArray(value) ? value.filter(Boolean) : value; continue;
          // Not a fast-path filter — fall through to generic dispatch
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
            currentTokens[currentTokens.length - 1] = ["TEXT", currentTokens[currentTokens.length - 1][1].replace(TRAILING_WS_RE, "")];
          }
          branches.push([currentCond, currentTokens]);
          // Apply stripA on token after endif
          if (tagStripA && i + 1 < tokens.length && tokens[i + 1][0] === "TEXT") {
            tokens[i + 1] = ["TEXT", tokens[i + 1][1].replace(LEADING_WS_RE, "")];
          }
          i++;
          break;
        } else if ((tag === "elseif" || tag === "elif") && depth === 0) {
          if (tagStripB && currentTokens.length > 0 && currentTokens[currentTokens.length - 1][0] === "TEXT") {
            currentTokens[currentTokens.length - 1] = ["TEXT", currentTokens[currentTokens.length - 1][1].replace(TRAILING_WS_RE, "")];
          }
          branches.push([currentCond, currentTokens]);
          currentCond = tagContent.slice(tag.length).trim();
          currentTokens = [];
        } else if (tag === "else" && depth === 0) {
          if (tagStripB && currentTokens.length > 0 && currentTokens[currentTokens.length - 1][0] === "TEXT") {
            currentTokens[currentTokens.length - 1] = ["TEXT", currentTokens[currentTokens.length - 1][1].replace(TRAILING_WS_RE, "")];
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
      if (cond === null || evalComparison(cond, context, this.evalVarRaw.bind(this))) {
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

    // Reusable loop object — mutated each iteration to avoid allocation
    const loopObj = {
      index: 0,
      index0: 0,
      first: false,
      last: false,
      length: total,
      revindex: 0,
      revindex0: 0,
      even: false,
      odd: false,
    };

    for (let idx = 0; idx < total; idx++) {
      const item = items[idx];

      // Update loop object in-place
      loopObj.index = idx + 1;
      loopObj.index0 = idx;
      loopObj.first = idx === 0;
      loopObj.last = idx === total - 1;
      loopObj.revindex = total - idx;
      loopObj.revindex0 = total - idx - 1;
      loopObj.even = (idx + 1) % 2 === 0;
      loopObj.odd = (idx + 1) % 2 !== 0;

      // Lazy overlay context: reads from local overrides first, then parent
      const locals: Record<string, unknown> = { loop: loopObj };

      if (isDict) {
        const [key, value] = item as [string, unknown];
        locals[var1] = key;
        if (var2) locals[var2] = value;
      } else {
        if (var2) {
          locals[var1] = idx;
          locals[var2] = item;
        } else {
          locals[var1] = item;
        }
      }

      const loopCtx = new Proxy(locals, {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          return (context as Record<string, unknown>)[prop];
        },
        set(target, prop: string, value) {
          target[prop] = value;
          return true;
        },
        has(target, prop: string) {
          return prop in target || prop in context;
        },
        ownKeys() {
          return [...new Set([...Object.keys(locals), ...Object.keys(context)])];
        },
        getOwnPropertyDescriptor(target, prop: string) {
          if (prop in target) return { configurable: true, enumerable: true, value: target[prop] };
          if (prop in context) return { configurable: true, enumerable: true, value: (context as Record<string, unknown>)[prop] };
          return undefined;
        },
      }) as Record<string, unknown>;

      output.push(this.renderTokens([...bodyTokens], loopCtx));
    }

    return [output.join(""), i];
  }

  private handleSet(content: string, context: Record<string, unknown>): void {
    const m = content.match(/^set\s+(\w+)\s*=\s*([\s\S]+)/);
    if (m) {
      const name = m[1];
      const expr = m[2].trim();
      context[name] = this.evalVarRaw(expr, context);
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

  /**
   * Handle {% live "name" poll N | sse | ws "path" [src "url"] %}...{% endlive %}.
   *
   * Server-rendered live region. The body renders once for first paint, is
   * registered under <name> so GET /__frond/live/<name> (or a liveSource
   * provider) can re-render it, and is wrapped in a marker element that
   * frond.js wires to the chosen transport (poll / sse / ws). Mirrors the
   * Python master's _handle_live and PHP/Ruby handleLive.
   */
  private handleLive(tokens: Token[], start: number, context: Record<string, unknown>): [string, number] {
    const [content] = stripTag(tokens[start][1]);
    const m = content.match(LIVE_RE);
    if (!m) {
      throw new Error('live: expected {% live "name" poll N | sse | ws "path" %}');
    }
    const name = m[1];
    const rest = (m[2] || "").trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const mode = parts[0] || "";

    const sm = rest.match(LIVE_SRC_RE);
    const src = sm ? sm[1] : null;
    if (src && (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//"))) {
      throw new Error("live: src must be a same-origin path, not an absolute URL");
    }

    let interval: number | null = null;
    let wsPath: string | null = null;
    if (mode === "poll") {
      if (!parts[1] || !/^\d+$/.test(parts[1])) {
        throw new Error('live: poll requires seconds, e.g. {% live "x" poll 5 %}');
      }
      interval = parseInt(parts[1], 10);
    } else if (mode === "sse") {
      // no extra config
    } else if (mode === "ws") {
      const wm = rest.match(LIVE_WS_RE);
      if (!wm) {
        throw new Error('live: ws requires a path, e.g. {% live "x" ws "/ws/x" %}');
      }
      wsPath = wm[1];
    } else {
      throw new Error(`live: unknown transport "${mode}" (use poll N, sse, or ws "path")`);
    }

    // Collect body tokens up to {% endlive %}. Nested live is unsupported.
    const bodyTokens: Token[] = [];
    let i = start + 1;
    while (i < tokens.length) {
      if (tokens[i][0] === "BLOCK") {
        const [tagContent] = stripTag(tokens[i][1]);
        const tag = tagContent.split(/\s+/)[0] || "";
        if (tag === "live") throw new Error("live: nested live blocks are not supported");
        if (tag === "endlive") {
          i++;
          break;
        }
        bodyTokens.push(tokens[i]);
      } else {
        bodyTokens.push(tokens[i]);
      }
      i++;
    }

    // Register the raw body source so the auto endpoint can re-render it.
    Frond.liveFragments.set(name, bodyTokens.map((t) => t[1]).join(""));

    const endpoint = src || `/__frond/live/${name}`;
    const attrs = [`data-frond-live="${liveAttr(name)}"`, `id="live-${liveAttr(name)}"`];
    if (mode === "poll") {
      attrs.push('data-mode="poll"', `data-interval="${interval}"`, `data-src="${liveAttr(endpoint)}"`);
    } else if (mode === "sse") {
      attrs.push('data-mode="sse"', `data-src="${liveAttr(endpoint)}"`);
    } else if (mode === "ws") {
      Frond.liveWsPaths.set(name, wsPath as string);
      attrs.push('data-mode="ws"', `data-ws="${liveAttr(wsPath)}"`);
    }

    const firstPaint = this.renderTokens([...bodyTokens], context);
    return [`<div ${attrs.join(" ")}>${firstPaint}</div>`, i];
  }

  // ── Live-block class API (mirrors Python master + PHP/Ruby facades) ──

  /**
   * Re-render a registered {% live %} fragment by name with fresh data.
   * Returns the rendered HTML, or null if no fragment is registered under that
   * name yet (its page has not rendered). GET /__frond/live/<name> calls this
   * after resolving the provider data.
   */
  static renderLive(name: string, data?: Record<string, unknown>): string | null {
    const source = Frond.liveFragments.get(name);
    if (source === undefined) return null;
    return new Frond().renderString(source, data || {});
  }

  /** Register a data provider for a {% live %} block. Invoked with the live
   * request on every refresh so auth re-applies. Mirrors Python's @live_source. */
  static liveSource(name: string, fn: LiveProvider): void {
    Frond.liveSources.set(name, fn);
  }

  /** The provider registered for a live block, or null. */
  static getLiveSource(name: string): LiveProvider | null {
    return Frond.liveSources.get(name) ?? null;
  }

  /** Whether a live fragment has been registered (its page rendered). */
  static hasLiveFragment(name: string): boolean {
    return Frond.liveFragments.has(name);
  }

  /** The ws path a live block declared (data-ws), or null. */
  static getLiveWsPath(name: string): string | null {
    return Frond.liveWsPaths.get(name) ?? null;
  }

  /**
   * Resolve GET /__frond/live/{name}: run the provider with the live request
   * (auth re-applies), re-render the fragment, and return a pure {status, body}
   * descriptor the route handler applies to the response. 404 for an unknown
   * name / unrendered fragment. Mirrors Python's live_endpoint / PHP respondLive.
   */
  static respondLive(req: LiveRequest, name: string): LiveResponse {
    const provider = Frond.liveSources.get(name);
    if (!Frond.liveFragments.has(name) && provider === undefined) {
      return { status: 404, body: `live block not found: ${name}` };
    }
    let context: Record<string, unknown> = {};
    if (provider !== undefined) {
      const result = provider(req);
      context = result && typeof result === "object" ? result : {};
    }
    const html = Frond.renderLive(name, context);
    if (html === null) {
      return { status: 404, body: `live fragment not registered yet: ${name}` };
    }
    return { status: 200, body: html };
  }

  /** Wire the WebSocket broadcaster used by pushLive. Called once by @tina4/core
   * at server boot (frond is a zero-dep leaf and cannot import core). */
  static setLiveBroadcaster(fn: LiveBroadcaster | null): void {
    Frond.liveBroadcaster = fn;
  }

  /**
   * Re-render the '<name>' live fragment and push it to connected clients.
   * Broadcasts a {type,name,html} envelope over WebSocket to the block's
   * declared data-ws path (else a room named <name>). Returns the rendered
   * HTML, or null if the fragment is not registered. Mirrors Python push_live
   * / PHP pushLive. The broadcast is best-effort — a missing/failed broadcaster
   * never throws into the caller.
   */
  static pushLive(name: string, data?: Record<string, unknown>): string | null {
    const html = Frond.renderLive(name, data);
    if (html === null) return null;

    if (Frond.liveBroadcaster) {
      try {
        const envelope = JSON.stringify({ type: "live", name, html });
        Frond.liveBroadcaster(Frond.getLiveWsPath(name), name, envelope);
      } catch {
        // best-effort — never let a broadcast failure escape pushLive
      }
    }
    return html;
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

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
import { parseTypeScript, type ParsedFile } from "./docsParser.js";

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

function scoreNameToken(name: string, stripped: string, nameTokens: string[], token: string): number {
  if (!token) return 0;
  if (name.startsWith(token) || stripped.startsWith(token)) return 3;
  for (const nameToken of nameTokens) {
    if (nameToken === token) return 3;
    if (nameToken.startsWith(token)) return 2;
  }
  return name.includes(token) ? 0.5 : 0;
}

function scoreName(name: string, stripped: string, nameTokens: string[], tokens: string[], joined: string): number {
  let score = name === joined || stripped === joined ? 5 : 0;
  for (const token of tokens) score += scoreNameToken(name, stripped, nameTokens, token);
  return score;
}

function scoreText(text: string, tokens: string[], weight: number): number {
  let score = 0;
  for (const token of tokens) {
    if (token && text.includes(token)) score += weight;
  }
  return score;
}

function scoreClassQualifier(entry: InternalEntry, name: string, tokens: string[], joined: string): number {
  const parent = (entry.class ?? "").toLowerCase();
  if (!parent) return 0;
  let score = 0;
  const normalized = joined.replace(/[:.]+/g, ".");
  if (normalized === `${parent}.${name}` || normalized === `${parent}.${name.replace(/^_+/, "")}`) score += 6;
  for (const token of tokens) {
    if (token === parent) score += 2.5;
    else if (token && parent.startsWith(token)) score += 1;
  }
  return score;
}

function scoreFqn(entry: InternalEntry, tokens: string[]): number {
  const segments = new Set(entry.fqn.toLowerCase().split(/[.\s:]+/).filter(Boolean));
  let score = 0;
  for (const token of tokens) {
    if (token && segments.has(token)) score += 1;
  }
  return score;
}

// ── Public Docs class ───────────────────────────────────────────────

/**
 * Framework-wide reflection index, shared across every `Docs` instance in
 * this process (keyed by frameworkRoots + version — both are baked into the
 * built entries, see buildEntriesForFile's `rel`/`version` fields).
 *
 * `detectFrameworkRoots()` never depends on `projectRoot` (it walks up from
 * THIS module's own file location), so the framework source tree is the same
 * for every instance that resolves the same roots+version — re-walking and
 * re-parsing it per INSTANCE was pure waste. Measured: docs.test.ts alone
 * constructs ~17 fresh `Docs` instances, each paying a full AST walk over
 * packages/{core,orm,swagger,frond}/src on first use — fast on an idle
 * machine (~1s total on the lab), but it blew the test runner's 60s
 * per-file budget on a CI runner under load (many concurrent service
 * containers sharing 2 vCPUs), landing as "died before reporting" with no
 * useful diagnostic. Still mtime-gated exactly as before (see `ensureIndex`),
 * so a framework source edit during a live dev session is still picked up —
 * this changes WHEN the scan is shared, never WHETHER the index stays fresh.
 */
const sharedFrameworkIndex = new Map<string, { entries: Map<string, InternalEntry>; mtime: number }>();

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
    // Framework: shared process-wide, rebuilt only if not built yet OR mtime
    // changed (see `sharedFrameworkIndex` above for why this is safe to share).
    const fwKey = `${this.frameworkRoots.join("|")}@${this.version}`;
    const fwMtime = this.maxMtime(this.frameworkRoots);
    let shared = sharedFrameworkIndex.get(fwKey);
    if (!shared || fwMtime !== shared.mtime) {
      const entries = new Map<string, InternalEntry>();
      for (const root of this.frameworkRoots) {
        for (const f of walkTsFiles(root)) {
          buildEntriesForFile(f, "framework", this.frameworkRoots, this.projectRoot, this.version, entries);
        }
      }
      shared = { entries, mtime: fwMtime };
      sharedFrameworkIndex.set(fwKey, shared);
    }
    if (this.frameworkEntries !== shared.entries) {
      this.frameworkEntries = shared.entries;
      this.frameworkMtime = shared.mtime;
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
    const nameTokens = tokenise(entry.name);
    let score = scoreName(name, stripped, nameTokens, tokens, joined);
    score += scoreText(entry.summary.toLowerCase(), tokens, 2);
    score += scoreText(entry.docblock.toLowerCase(), tokens, 1);
    score += scoreClassQualifier(entry, name, tokens, joined);
    score += scoreFqn(entry, tokens);
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

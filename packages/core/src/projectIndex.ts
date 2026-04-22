/**
 * Project index — lightweight, persistent "where is what" map.
 *
 * Ported from tina4_python/dev_admin/project_index.py (master reference).
 *
 * Storage: .tina4/project_index.json at the project root.
 * Freshness: lazy-refreshes on read via mtime compare — no watchers.
 * Extractors: per-language symbol extraction (TS/JS, Twig/HTML, SQL, Markdown,
 * Python) using regex. No LLM involvement — pure static analysis.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const INDEX_DIRNAME = ".tina4";
const INDEX_FILENAME = "project_index.json";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
  ".mypy_cache", ".ruff_cache", ".pytest_cache", "dist", "build",
  ".tina4", "logs", ".idea", ".vscode",
]);

const INDEX_EXT = new Set([
  ".py", ".twig", ".html", ".sql", ".scss", ".css", ".js", ".ts",
  ".mjs", ".md", ".json", ".yml", ".yaml", ".toml", ".env",
]);

const MAX_FILE_BYTES = 256 * 1024;

export interface FileRoute {
  method: string;
  path: string;
  handler: string;
}

export interface FileEntry {
  path?: string;
  size?: number;
  mtime?: number;
  language?: string;
  sha256?: string;
  skipped?: string;
  extraction_error?: string;
  summary?: string;
  symbols?: string[];
  imports?: string[];
  routes?: FileRoute[];
  docstring?: string;
  exports?: string[];
  extends?: string[];
  blocks?: string[];
  includes?: string[];
  creates?: string[];
  alters?: string[];
  title?: string;
  sections?: string[];
  first_line?: string;
  error?: string;
}

interface IndexData {
  version: number;
  files: Record<string, FileEntry>;
  generated_at: number;
}

function projectRoot(): string {
  return path.resolve(process.cwd());
}

function indexPath(): string {
  const d = path.join(projectRoot(), INDEX_DIRNAME);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, INDEX_FILENAME);
}

// ── Per-language extractors ──────────────────────────────────

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "any_method", "any"]);

// TypeScript/JavaScript: grab exports and imports + route decorator calls
const JS_EXPORT_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const JS_IMPORT_RE = /^\s*import\s+[^'"]+?['"]([^'"]+)['"]/gm;
// Calls like: get("/api/foo", ...) or router.post("/api/foo", ...)
const JS_ROUTE_RE = /(?:^|\W)(?:(?:[A-Za-z_$][\w$]*)\.)?(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]/g;

function extractJsTs(text: string): FileEntry {
  const exports: string[] = [];
  const imports: string[] = [];
  const routes: FileRoute[] = [];
  let m: RegExpExecArray | null;

  JS_EXPORT_RE.lastIndex = 0;
  while ((m = JS_EXPORT_RE.exec(text)) !== null) {
    if (!exports.includes(m[1])) exports.push(m[1]);
  }
  JS_IMPORT_RE.lastIndex = 0;
  while ((m = JS_IMPORT_RE.exec(text)) !== null) {
    if (!imports.includes(m[1])) imports.push(m[1]);
  }
  JS_ROUTE_RE.lastIndex = 0;
  while ((m = JS_ROUTE_RE.exec(text)) !== null) {
    const method = m[1].toUpperCase();
    const routePath = m[2];
    if (ROUTE_METHODS.has(m[1].toLowerCase()) && !routes.some((r) => r.method === method && r.path === routePath)) {
      routes.push({ method, path: routePath, handler: "" });
    }
  }

  exports.sort();
  imports.sort();
  return { exports, imports, routes };
}

const TWIG_EXTENDS_RE = /\{%\s*extends\s+['"]([^'"]+)['"]\s*%\}/g;
const TWIG_BLOCK_RE = /\{%\s*block\s+([A-Za-z_][\w-]*)/g;
const TWIG_INCLUDE_RE = /\{%\s*include\s+['"]([^'"]+)['"]/g;

function extractTwig(text: string): FileEntry {
  const extendsList: string[] = [];
  const blocks = new Set<string>();
  const includes = new Set<string>();
  let m: RegExpExecArray | null;

  TWIG_EXTENDS_RE.lastIndex = 0;
  while ((m = TWIG_EXTENDS_RE.exec(text)) !== null) extendsList.push(m[1]);
  TWIG_BLOCK_RE.lastIndex = 0;
  while ((m = TWIG_BLOCK_RE.exec(text)) !== null) blocks.add(m[1]);
  TWIG_INCLUDE_RE.lastIndex = 0;
  while ((m = TWIG_INCLUDE_RE.exec(text)) !== null) includes.add(m[1]);

  return {
    extends: extendsList,
    blocks: Array.from(blocks).sort(),
    includes: Array.from(includes).sort(),
  };
}

const SQL_CREATE_RE = /create\s+(?:unique\s+)?(table|index|view|trigger|sequence|procedure|function)\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)/gi;
const SQL_ALTER_RE = /alter\s+(table|index|view)\s+([A-Za-z_][\w.]*)/gi;

function extractSql(text: string): FileEntry {
  const creates: string[] = [];
  const alters: string[] = [];
  let m: RegExpExecArray | null;
  SQL_CREATE_RE.lastIndex = 0;
  while ((m = SQL_CREATE_RE.exec(text)) !== null) creates.push(`${m[1].toUpperCase()} ${m[2]}`);
  SQL_ALTER_RE.lastIndex = 0;
  while ((m = SQL_ALTER_RE.exec(text)) !== null) alters.push(`${m[1].toUpperCase()} ${m[2]}`);
  return { creates, alters };
}

const MD_H1_RE = /^#\s+(.+)$/m;
const MD_H2_RE = /^##\s+(.+)$/gm;

function extractMd(text: string): FileEntry {
  const h1 = MD_H1_RE.exec(text);
  const sections: string[] = [];
  let m: RegExpExecArray | null;
  MD_H2_RE.lastIndex = 0;
  while ((m = MD_H2_RE.exec(text)) !== null && sections.length < 30) {
    sections.push(m[1]);
  }
  return { title: (h1 ? h1[1] : "").trim(), sections };
}

// Python: cheap regex — no AST in Node.js. Good enough for search.
const PY_CLASS_RE = /^class\s+([A-Za-z_][\w]*)/gm;
const PY_FUNC_RE = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm;
const PY_IMPORT_RE = /^(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm;
const PY_DECOR_RE = /^@(?:[A-Za-z_][\w]*\.)?(get|post|put|patch|delete|any_method)\s*\(\s*['"]([^'"]+)['"]/gm;

function extractPython(text: string): FileEntry {
  const symbols: string[] = [];
  const imports: string[] = [];
  const routes: FileRoute[] = [];
  let m: RegExpExecArray | null;
  PY_CLASS_RE.lastIndex = 0;
  while ((m = PY_CLASS_RE.exec(text)) !== null) symbols.push(m[1]);
  PY_FUNC_RE.lastIndex = 0;
  while ((m = PY_FUNC_RE.exec(text)) !== null) symbols.push(m[1]);
  PY_IMPORT_RE.lastIndex = 0;
  while ((m = PY_IMPORT_RE.exec(text)) !== null) imports.push(m[1] || m[2]);
  PY_DECOR_RE.lastIndex = 0;
  while ((m = PY_DECOR_RE.exec(text)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], handler: "" });
  }
  // Best-effort docstring
  const doc = text.match(/^\s*"""\s*([^\n]+)/);
  return {
    symbols,
    imports,
    routes,
    docstring: doc ? doc[1].trim().slice(0, 200) : "",
  };
}

function extractGeneric(text: string): FileEntry {
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("<!--")) continue;
    return { first_line: s.slice(0, 200) };
  }
  return {};
}

const EXTRACTORS: Record<string, (t: string) => FileEntry> = {
  ".ts": extractJsTs,
  ".js": extractJsTs,
  ".mjs": extractJsTs,
  ".twig": extractTwig,
  ".html": extractTwig,
  ".sql": extractSql,
  ".md": extractMd,
  ".py": extractPython,
};

function languageFor(p: string): string {
  const ext = path.extname(p);
  const map: Record<string, string> = {
    ".py": "python", ".twig": "twig", ".html": "html", ".sql": "sql",
    ".scss": "scss", ".css": "css", ".js": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".md": "markdown", ".json": "json", ".yml": "yaml",
    ".yaml": "yaml", ".toml": "toml", ".env": "env",
  };
  return map[ext] || "text";
}

function summarise(entry: FileEntry): string {
  if (entry.skipped) return entry.skipped;
  if (entry.docstring) return entry.docstring;
  if (entry.title) return entry.title;
  if (entry.routes && entry.routes.length) {
    const r = entry.routes[0];
    const extra = entry.routes.length > 1 ? ` (+${entry.routes.length - 1} more)` : "";
    return `${r.method} ${r.path}${extra}`;
  }
  if (entry.symbols && entry.symbols.length) {
    return "defines " + entry.symbols.slice(0, 4).join(", ");
  }
  if (entry.exports && entry.exports.length) {
    return "exports " + entry.exports.slice(0, 4).join(", ");
  }
  if (entry.creates && entry.creates.length) {
    return "schema: " + entry.creates.slice(0, 3).join(", ");
  }
  if (entry.extends && entry.extends.length) {
    return `template, extends ${entry.extends[0]}`;
  }
  if (entry.first_line) return entry.first_line;
  return "";
}

function extract(fullPath: string): FileEntry {
  let st: fs.Stats;
  try {
    st = fs.statSync(fullPath);
  } catch {
    return {};
  }
  const entry: FileEntry = {
    path: path.relative(projectRoot(), fullPath),
    size: st.size,
    mtime: Math.floor(st.mtimeMs / 1000),
    language: languageFor(fullPath),
  };
  if (st.size > MAX_FILE_BYTES) {
    entry.skipped = `too large (${st.size} bytes)`;
    return entry;
  }
  let text: string;
  try {
    text = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return entry;
  }
  entry.sha256 = crypto.createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
  const extractor = EXTRACTORS[path.extname(fullPath)] || extractGeneric;
  try {
    Object.assign(entry, extractor(text));
  } catch (e) {
    entry.extraction_error = (e as Error).message.slice(0, 200);
  }
  entry.summary = summarise(entry);
  return entry;
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      if (e.name.startsWith(".") && e.name !== ".env") continue;
      const ext = path.extname(e.name);
      if (!INDEX_EXT.has(ext) && e.name !== ".env") continue;
      out.push(path.join(dir, e.name));
    }
  }
}

function loadRaw(): IndexData {
  const p = indexPath();
  if (!fs.existsSync(p)) return { version: 1, files: {}, generated_at: 0 };
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as IndexData;
  } catch {
    return { version: 1, files: {}, generated_at: 0 };
  }
}

function saveRaw(data: IndexData): void {
  data.generated_at = Math.floor(Date.now() / 1000);
  fs.writeFileSync(indexPath(), JSON.stringify(data, null, 2), "utf-8");
}

export const ProjectIndex = {
  refresh(): { added: number; updated: number; removed: number; total: number; path: string } {
    const data = loadRaw();
    const files = data.files || {};
    let added = 0;
    let updated = 0;
    const seen = new Set<string>();
    const root = projectRoot();
    const found: string[] = [];
    walk(root, found);
    for (const fp of found) {
      const rel = path.relative(root, fp);
      seen.add(rel);
      let mtime: number;
      try {
        mtime = Math.floor(fs.statSync(fp).mtimeMs / 1000);
      } catch {
        continue;
      }
      const existing = files[rel];
      if (existing && existing.mtime === mtime) continue;
      files[rel] = extract(fp);
      if (existing) updated++;
      else added++;
    }
    const removed: string[] = [];
    for (const k of Object.keys(files)) {
      if (!seen.has(k)) removed.push(k);
    }
    for (const k of removed) delete files[k];
    data.files = files;
    saveRaw(data);
    return {
      added,
      updated,
      removed: removed.length,
      total: Object.keys(files).length,
      path: path.relative(root, indexPath()),
    };
  },

  search(query: string, limit = 20): Array<{ path: string; summary: string; score: number; language: string }> {
    ProjectIndex.refresh();
    const data = loadRaw();
    const q = (query || "").toLowerCase().trim();
    if (!q) return [];
    const hits: Array<[number, { path: string; summary: string; score: number; language: string }]> = [];
    for (const [rel, entry] of Object.entries(data.files)) {
      let score = 0;
      if (rel.toLowerCase().includes(q)) score += 10;
      for (const s of entry.symbols || []) {
        if (q === s.toLowerCase()) score += 8;
        else if (s.toLowerCase().includes(q)) score += 4;
      }
      for (const r of entry.routes || []) {
        if (`${r.path || ""} ${r.handler || ""}`.toLowerCase().includes(q)) score += 5;
      }
      if ((entry.summary || "").toLowerCase().includes(q)) score += 3;
      for (const imp of entry.imports || []) {
        if (imp.toLowerCase().includes(q)) score += 1;
      }
      if (score > 0) {
        hits.push([
          score,
          {
            path: rel,
            summary: entry.summary || "",
            score,
            language: entry.language || "",
          },
        ]);
      }
    }
    hits.sort((a, b) => b[0] - a[0]);
    return hits.slice(0, Math.max(1, limit)).map((h) => h[1]);
  },

  fileEntry(relPath: string): FileEntry {
    ProjectIndex.refresh();
    const data = loadRaw();
    return data.files[relPath] || { error: `Not in index: ${relPath}` };
  },

  overview(): Record<string, unknown> {
    ProjectIndex.refresh();
    const data = loadRaw();
    const files = data.files;
    const langs: Record<string, number> = {};
    let routeCount = 0;
    let modelCount = 0;
    for (const entry of Object.values(files)) {
      const lang = entry.language || "other";
      langs[lang] = (langs[lang] || 0) + 1;
      routeCount += (entry.routes || []).length;
      const p = entry.path || "";
      if (
        (p.startsWith("src/orm/") || p.startsWith("src/models/")) &&
        (((entry.symbols || []).length > 0) || ((entry.exports || []).length > 0))
      ) {
        modelCount++;
      }
    }
    const recent = Object.values(files)
      .map((e) => ({ path: e.path, summary: e.summary || "", mtime: e.mtime || 0 }))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
      .slice(0, 10);
    return {
      total_files: Object.keys(files).length,
      by_language: langs,
      routes_declared: routeCount,
      orm_models: modelCount,
      recently_changed: recent,
      index_generated_at: data.generated_at || 0,
    };
  },
};

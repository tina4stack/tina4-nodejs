import * as path from "node:path";
import type { FileEntry, FileRoute } from "./projectIndex.js";

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "any_method", "any"]);

const JS_EXPORT_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const JS_IMPORT_RE = /^\s*import\s+[^'"]+?['"]([^'"]+)['"]/gm;
const JS_ROUTE_RE = /(?:^|\W)(?:(?:[A-Za-z_$][\w$]*)\.)?(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]/g;

function extractJsTs(text: string): FileEntry {
  const exports: string[] = [];
  const imports: string[] = [];
  const routes: FileRoute[] = [];
  let m: RegExpExecArray | null;
  JS_EXPORT_RE.lastIndex = 0;
  while ((m = JS_EXPORT_RE.exec(text)) !== null) if (!exports.includes(m[1])) exports.push(m[1]);
  JS_IMPORT_RE.lastIndex = 0;
  while ((m = JS_IMPORT_RE.exec(text)) !== null) if (!imports.includes(m[1])) imports.push(m[1]);
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
  return { extends: extendsList, blocks: Array.from(blocks).sort(), includes: Array.from(includes).sort() };
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
  while ((m = MD_H2_RE.exec(text)) !== null && sections.length < 30) sections.push(m[1]);
  return { title: (h1 ? h1[1] : "").trim(), sections };
}

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
  while ((m = PY_DECOR_RE.exec(text)) !== null) routes.push({ method: m[1].toUpperCase(), path: m[2], handler: "" });
  const doc = text.match(/^\s*"""\s*([^\n]+)/);
  return { symbols, imports, routes, docstring: doc ? doc[1].trim().slice(0, 200) : "" };
}

function extractGeneric(text: string): FileEntry {
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("<!--")) continue;
    return { first_line: s.slice(0, 200) };
  }
  return {};
}

const EXTRACTORS: Record<string, (text: string) => FileEntry> = {
  ".ts": extractJsTs, ".js": extractJsTs, ".mjs": extractJsTs,
  ".twig": extractTwig, ".html": extractTwig, ".sql": extractSql,
  ".md": extractMd, ".py": extractPython,
};

export function extractForPath(filePath: string, text: string): FileEntry {
  return (EXTRACTORS[path.extname(filePath)] || extractGeneric)(text);
}

export function languageFor(filePath: string): string {
  const ext = path.extname(filePath);
  const map: Record<string, string> = {
    ".py": "python", ".twig": "twig", ".html": "html", ".sql": "sql",
    ".scss": "scss", ".css": "css", ".js": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".md": "markdown", ".json": "json", ".yml": "yaml",
    ".yaml": "yaml", ".toml": "toml", ".env": "env",
  };
  return map[ext] || "text";
}

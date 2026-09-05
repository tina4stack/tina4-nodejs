import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { extractForPath, languageFor } from "./projectIndexExtractors.js";
import type { FileEntry } from "./projectIndex.js";

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

export interface IndexData {
  version: number;
  files: Record<string, FileEntry>;
  generated_at: number;
}

export function projectRoot(): string {
  return path.resolve(process.cwd());
}

export function indexPath(): string {
  const d = path.join(projectRoot(), INDEX_DIRNAME);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, INDEX_FILENAME);
}

function routeSummary(entry: FileEntry): string {
  const route = entry.routes?.[0];
  if (!route) return "";
  const extra = entry.routes!.length > 1 ? ` (+${entry.routes!.length - 1} more)` : "";
  return `${route.method} ${route.path}${extra}`;
}

export function summarise(entry: FileEntry): string {
  if (entry.skipped) return entry.skipped;
  if (entry.docstring) return entry.docstring;
  if (entry.title) return entry.title;
  const route = routeSummary(entry);
  if (route) return route;
  if (entry.symbols?.length) return "defines " + entry.symbols.slice(0, 4).join(", ");
  if (entry.exports?.length) return "exports " + entry.exports.slice(0, 4).join(", ");
  if (entry.creates?.length) return "schema: " + entry.creates.slice(0, 3).join(", ");
  if (entry.extends?.length) return `template, extends ${entry.extends[0]}`;
  return entry.first_line || "";
}

export function extract(fullPath: string): FileEntry {
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
  try {
    Object.assign(entry, extractForPath(fullPath, text));
  } catch (error) {
    entry.extraction_error = (error as Error).message.slice(0, 200);
  }
  entry.summary = summarise(entry);
  return entry;
}

export function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      const ext = path.extname(entry.name);
      if (!INDEX_EXT.has(ext) && entry.name !== ".env") continue;
      out.push(path.join(dir, entry.name));
    }
  }
}

export function loadRaw(): IndexData {
  const p = indexPath();
  if (!fs.existsSync(p)) return { version: 1, files: {}, generated_at: 0 };
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as IndexData;
  } catch {
    return { version: 1, files: {}, generated_at: 0 };
  }
}

export function saveRaw(data: IndexData): void {
  data.generated_at = Math.floor(Date.now() / 1000);
  fs.writeFileSync(indexPath(), JSON.stringify(data, null, 2), "utf-8");
}

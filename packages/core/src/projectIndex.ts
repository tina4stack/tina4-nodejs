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

import * as path from "node:path";
import * as fs from "node:fs";
import { extract, indexPath, loadRaw, projectRoot, saveRaw, walk } from "./projectIndexStorage.js";
import type { IndexData } from "./projectIndexStorage.js";

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

function scoreSearchEntry(query: string, rel: string, entry: FileEntry): number {
  let score = rel.toLowerCase().includes(query) ? 10 : 0;
  for (const symbol of entry.symbols || []) {
    if (query === symbol.toLowerCase()) score += 8;
    else if (symbol.toLowerCase().includes(query)) score += 4;
  }
  for (const route of entry.routes || []) {
    if (`${route.path || ""} ${route.handler || ""}`.toLowerCase().includes(query)) score += 5;
  }
  if ((entry.summary || "").toLowerCase().includes(query)) score += 3;
  for (const imported of entry.imports || []) {
    if (imported.toLowerCase().includes(query)) score += 1;
  }
  return score;
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
      const score = scoreSearchEntry(q, rel, entry);
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

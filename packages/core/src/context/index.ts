// Tina4 Node.js
//
// Context — a native, zero-dependency code/doc grounding index.
//
// Lets a Tina4 app ground its own AI assistant on its own source, offline:
// it walks the project, chunks code on def/class boundaries and docs as prose,
// and answers keyword/fuzzy queries over a SQLite FTS5 index (Node's built-in
// `node:sqlite` — FTS5 + `bm25()` are compiled in, so NO new dependency; the
// same module the ORM/session/docstore subsystems already use).
//
//   import { Context } from "@tina4/core";
//   const ctx = new Context(".tina4/context.db");
//   ctx.indexRoot("src");
//   ctx.search("where is the auth token issued?", 5);
//   //  -> [{ path: "src/auth.ts", score: 2.31, snippet: "..." }, ...]
//
// A faithful TypeScript port of tina4-python's tina4_python/context/__init__.py
// (the proven slice of neemee's SqliteFTS + source-over-tests / definition-first
// reordering). It COMPLEMENTS the api_* reflection tools: api_* is exact
// structural lookup, Context is fuzzy/semantic FTS over source + docs.
//
// On-disk index defaults to `.tina4/context.db` (gitignored). Guards a sqlite
// build without FTS5: if absent, the Context degrades to safe no-ops rather than
// crashing the app.
//
// node:sqlite is synchronous and JavaScript is single-threaded, so — unlike the
// Python port — no lock is needed: every method runs to completion before the
// event loop can dispatch another.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { chunkCode, chunkText, fold, lightStem, terms } from "./chunker.js";

// File classification — mirrors neemee's repo walk.
const CODE_EXTS = new Set([
  ".py", ".php", ".js", ".mjs", ".ts", ".rb",
  ".pas", ".dpr", ".dpk", ".inc", ".dfm", ".fmx",
]);
const DOC_EXTS = new Set([".md", ".txt", ".rst", ".twig", ".html"]);
// deploy/CLI/env answers live in config files, not sources — chunk as code
// (line windows), since sentence chunking shreds YAML/Dockerfiles.
const CONFIG_EXTS = new Set([".toml", ".yml", ".yaml"]);
const SPECIAL_FILES = new Set([
  "dockerfile", "makefile", "docker-compose.yml",
  "package.json", "composer.json",
  ".env.example", ".env.sample",
]);
// Same dirs neemee skips, plus Tina4 runtime dirs that hold no source of truth
// (our own index/backups, session blobs, logs).
const SKIP_DIRS = new Set([
  ".git", "__pycache__", "node_modules", "vendor", "dist",
  "build", "coverage", ".idea", ".venv", "venv", ".pytest_cache",
  ".tina4", "sessions", "logs",
]);

// generic question/code vocabulary that never NAMES a symbol — kept small.
const DEF_STOP = new Set(
  ("the and what how does can which where when who why list all available " +
    "module class function functions method methods def get set new return " +
    "import from with that this are is was for into use used").split(" "),
);

// a chunk that DEFINES a queried symbol ('def get_token', 'class Widget') should
// out-rank one that merely USES it. Matched against the folded body.
const DEF_KW = "(?:async def|def|class|function|fn|func|interface|trait)";

/** True if this build of node:sqlite supports FTS5. */
export function fts5Supported(): boolean {
  try {
    const conn = new DatabaseSync(":memory:");
    try {
      conn.exec("CREATE VIRTUAL TABLE _probe USING fts5(x)");
      return true;
    } finally {
      conn.close();
    }
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve `abs` to its canonical (symlink-free) form, matching Python's
 * `Path.resolve()`. If the file itself doesn't exist yet (a delete event), fall
 * back to canonicalising the parent directory and re-joining the basename, then
 * to the lexical path. Needed because macOS temp dirs (and /var) are symlinks,
 * so a raw `process.cwd()` (already real) and a lexically-resolved index root
 * would otherwise mismatch and drop every reindex as "outside root".
 */
function realResolve(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    /* not created (deleted file) — fall through */
  }
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

export interface SearchHit {
  path: string;
  score: number;
  snippet: string;
}

interface ChunkRow {
  path: string;
  raw: string;
  body: string;
  s: number;
}

/**
 * A SQLite FTS5 index over a project's source + docs.
 *
 * - indexPath(file, label?)  upsert one file (delete-by-path, re-chunk, insert)
 * - indexRoot(root)          walk a tree, index every eligible file
 * - search(query, k)         [{path, score, snippet}] ranked by bm25() with
 *                            source-over-tests + definition-first reordering
 * - reindexFile(changed)     upsert one changed file against the indexed root
 */
export class Context {
  path: string;
  root: string | null = null;
  available: boolean;
  private conn: DatabaseSync | null = null;

  /**
   * @param dbPath    on-disk index file (its parent dir is created).
   * @param fts5Check overrides FTS5 detection (used by tests to exercise the
   *                  graceful-degradation path); defaults to a real probe.
   */
  constructor(dbPath = "./.tina4/context.db", fts5Check?: () => boolean) {
    this.path = String(dbPath);
    const check = fts5Check ?? fts5Supported;
    this.available = Boolean(check());
    if (!this.available) return;
    const parent = dirname(this.path);
    if (parent !== "" && parent !== ".") {
      mkdirSync(parent, { recursive: true });
    }
    this.conn = new DatabaseSync(this.path);
    this.ensureTable();
  }

  /** Whether this Node build's node:sqlite supports FTS5. */
  static fts5Available(): boolean {
    return fts5Supported();
  }

  private ensureTable(): void {
    // `body` holds fold(text) so query/index tokenization is symmetric; `raw`
    // (UNINDEXED) keeps the original text to return as a snippet; `path`/`cid`
    // (UNINDEXED) are metadata used for upsert + citation.
    this.conn!.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS chunks " +
        "USING fts5(cid UNINDEXED, path UNINDEXED, raw UNINDEXED, body)",
    );
  }

  /** Drop and recreate the index (full rebuild starting point). */
  reset(): void {
    if (!this.available) return;
    this.conn!.exec("DROP TABLE IF EXISTS chunks");
    this.ensureTable();
  }

  // ── indexing ───────────────────────────────────────────────
  private static chunksFor(label: string, text: string): Array<[number, string]> {
    const ext = extname(label).toLowerCase();
    const special = SPECIAL_FILES.has(basename(label).toLowerCase());
    if (CODE_EXTS.has(ext) || CONFIG_EXTS.has(ext) || special) {
      return chunkCode(text, label);
    }
    return chunkText(text);
  }

  /**
   * UPSERT one file into the index: delete this path's existing chunks,
   * re-chunk the current contents, insert. `label` is the stored/citation path
   * (defaults to `file`) and MUST be stable across calls for the same file so
   * the delete targets the right rows. Returns rows inserted.
   */
  indexPath(file: string, label?: string): number {
    if (!this.available) return 0;
    const stored = label != null ? String(label) : String(file);
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      return 0;
    }
    const rows = Context.chunksFor(stored, text).map(
      ([i, chunk]): [string, string, string, string] => [`${stored}:${i}`, stored, chunk, fold(chunk)],
    );
    this.conn!.prepare("DELETE FROM chunks WHERE path = ?").run(stored);
    if (rows.length) {
      const ins = this.conn!.prepare("INSERT INTO chunks(cid, path, raw, body) VALUES (?, ?, ?, ?)");
      for (const r of rows) ins.run(r[0], r[1], r[2], r[3]);
    }
    return rows.length;
  }

  /**
   * The per-file filter used by both indexRoot and reindexFile. Directory
   * skipping is handled separately.
   */
  private static eligible(filename: string): boolean {
    const fn = filename.toLowerCase();
    if (fn.endsWith(".min.js")) return false;
    const ext = extname(fn);
    return CODE_EXTS.has(ext) || DOC_EXTS.has(ext) || CONFIG_EXTS.has(ext) || SPECIAL_FILES.has(fn);
  }

  /**
   * Walk `root`, indexing every eligible file (skips vendor/build/runtime
   * dirs). Paths are stored RELATIVE to `root` for clean citations. Records
   * `root` so reindexFile can relabel a changed file consistently. Returns the
   * total number of chunks inserted.
   */
  indexRoot(root: string): number {
    if (!this.available) return 0;
    const rootAbs = realResolve(resolve(String(root)));
    this.root = rootAbs;
    let total = 0;
    const walk = (dir: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      const subdirs: string[] = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) subdirs.push(e.name);
        } else if (e.isFile()) {
          files.push(e.name);
        }
      }
      files.sort();
      for (const fn of files) {
        if (!Context.eligible(fn)) continue;
        const full = join(dir, fn);
        const rel = relative(rootAbs, full);
        total += this.indexPath(full, rel);
      }
      for (const d of subdirs) walk(join(dir, d));
    };
    walk(rootAbs);
    return total;
  }

  /**
   * Re-index a single changed file into the LIVE index — the hook the dev
   * WebSocket reload trigger (POST /__dev/api/reload) calls so code_search
   * tracks edits without a rebuild. Resolves `changedPath` against the indexed
   * root, then: outside root / under a skip-or-dot dir / ineligible → skip (-1);
   * deleted → drop its chunks (0); otherwise UPSERT (rows). No-op (-1) until
   * indexRoot has run (nothing to keep fresh yet).
   */
  reindexFile(changedPath: string): number {
    if (!this.available || this.root === null) return -1;
    const raw = String(changedPath);
    // the reload trigger reports paths relative to the project root (cwd during
    // `tina4 serve`); the index root may be a subdir like src/.
    const abs = isAbsolute(raw) ? raw : join(process.cwd(), raw);
    const resolved = realResolve(resolve(abs));
    const rel = relative(this.root, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return -1; // outside the indexed root
    }
    const parts = rel.split(/[\\/]/);
    const dirParts = parts.slice(0, -1);
    if (parts.some((seg) => SKIP_DIRS.has(seg)) || dirParts.some((seg) => seg.startsWith("."))) {
      return -1; // under a skipped / dot dir
    }
    if (!Context.eligible(basename(rel))) return -1;
    const stored = rel;
    if (!existsSync(abs)) {
      // deleted → drop its chunks
      this.conn!.prepare("DELETE FROM chunks WHERE path = ?").run(stored);
      return 0;
    }
    return this.indexPath(abs, stored);
  }

  // ── query ──────────────────────────────────────────────────
  private matchExpr(query: string): { expr: string | null; toks: Set<string> } {
    const toks = new Set<string>();
    for (const t of terms(query)) {
      toks.add(t);
      toks.add(lightStem(t));
    }
    toks.delete("");
    if (toks.size === 0) return { expr: null, toks };
    // Quoting keeps each term injection-safe inside the FTS5 MATCH string.
    const expr = [...toks].sort().map((t) => `"${t}"`).join(" OR ");
    return { expr, toks };
  }

  private static isTestlike(path: string): boolean {
    const s = (path || "").toLowerCase();
    return ["/test", "test/", "test_", "_test.", ".test.", "/example", "example/"].some((p) => s.includes(p));
  }

  private static defines(foldedBody: string, symbols: Set<string>): boolean {
    if (symbols.size === 0) return false;
    const alt = [...symbols].map(escapeRegex).join("|");
    const pat = new RegExp(`${DEF_KW}\\s+(?:${alt})(?![a-z0-9])`);
    return pat.test(foldedBody);
  }

  /**
   * Return the top-`k` chunks as `[{path, score, snippet}]`, ranked by `bm25()`
   * then reordered with two stable, proven passes:
   *   - source-over-tests: a test that merely mentions a symbol sinks below the
   *     source that defines it (skipped when the query is about tests);
   *   - definition-first: a chunk that DEFINES a queried symbol rises above
   *     chunks that only use it.
   * Score is a higher-is-better float (sqlite's bm25 sign flipped).
   */
  search(query: string, k = 5): SearchHit[] {
    if (!this.available) return [];
    const { expr } = this.matchExpr(query);
    if (expr === null) return [];
    const poolN = Math.max(k * 3, 15);
    const rows = this.conn!
      .prepare("SELECT path, raw, body, bm25(chunks) AS s FROM chunks WHERE chunks MATCH ? ORDER BY s LIMIT ?")
      .all(expr, poolN) as unknown as ChunkRow[];
    if (rows.length === 0) return [];

    // candidate symbol names from the query (drop generic vocab).
    const symbols = new Set(terms(query).filter((t) => t.length >= 3 && !DEF_STOP.has(t)));
    const aboutTests = query.toLowerCase().includes("test");

    const isTest = (p: string): number => (!aboutTests && Context.isTestlike(p) ? 1 : 0);
    const isDef = (b: string): number => (Context.defines(b, symbols) ? 0 : 1);

    const ordered = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const at = isTest(a.r.path);
        const bt = isTest(b.r.path);
        if (at !== bt) return at - bt;
        const ad = isDef(a.r.body);
        const bd = isDef(b.r.body);
        if (ad !== bd) return ad - bd;
        return a.i - b.i; // bm25 order breaks ties
      });

    return ordered.slice(0, k).map(({ r }) => ({
      path: r.path,
      score: Math.round(-Number(r.s) * 1e6) / 1e6, // bm25: more negative = better
      snippet: Context.snippet(r.raw),
    }));
  }

  private static snippet(raw: string, limit = 280): string {
    const text = (raw || "").trim();
    if (text.length <= limit) return text;
    return text.slice(0, limit).replace(/\s+$/, "") + " ...";
  }

  // ── misc ───────────────────────────────────────────────────
  count(): number {
    if (!this.available) return 0;
    const row = this.conn!.prepare("SELECT count(*) AS c FROM chunks").get() as { c: number };
    return row.c;
  }

  isEmpty(): boolean {
    return this.count() === 0;
  }

  close(): void {
    if (this.conn !== null) {
      this.conn.close();
      this.conn = null;
    }
  }
}

// ── process-wide shared index ──────────────────────────────────
// code_search (dev MCP) and the dev-reload reindex hook must share ONE index so
// a saved file is immediately searchable. Keyed by resolved db path.
export const _sharedContexts = new Map<string, Context>();

function dbKey(db?: string): string {
  return resolve(db ? String(db) : join(process.cwd(), ".tina4", "context.db"));
}

/**
 * Get (or create) the process-wide Context at `db` (default
 * `<cwd>/.tina4/context.db`). If `root` is given and the index is empty, builds
 * it once. This is what code_search uses so the reload hook can keep the SAME
 * index fresh.
 */
export function defaultContext(root?: string, db?: string): Context {
  const key = dbKey(db);
  let ctx = _sharedContexts.get(key);
  if (ctx === undefined) {
    ctx = new Context(key);
    _sharedContexts.set(key, ctx);
  }
  if (root != null && ctx.available && ctx.isEmpty()) {
    ctx.indexRoot(root);
  }
  return ctx;
}

/**
 * Return the already-created shared Context for `db` (or undefined). Used by the
 * reload hook so a file change reindexes an EXISTING index but never creates one
 * on its own (nothing to keep fresh until code_search runs).
 */
export function existingContext(db?: string): Context | undefined {
  return _sharedContexts.get(dbKey(db));
}

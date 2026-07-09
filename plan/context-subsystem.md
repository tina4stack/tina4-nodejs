# Context Subsystem — Design & Parity Notes

A native, **zero-dependency** code/doc grounding index for tina4-nodejs. Lets a
Tina4 app ground its own AI assistant on its own source, offline: it walks the
project, chunks code on def/class boundaries and docs as prose, and answers
keyword/fuzzy queries over a SQLite **FTS5** index — ranked by `bm25()` with a
stable *source-over-tests* + *definition-first* reorder.

This is a faithful TypeScript port of the tina4-python reference
(`tina4_python/context/`). It COMPLEMENTS the structural `api_*` reflection
tools: `api_*` is exact signature lookup; `code_search` is fuzzy/semantic FTS
over the project's own source + docs.

## Why node:sqlite, not better-sqlite3

The maintainer brief named `better-sqlite3` as "Node's one accepted dep" and to
"confirm it's already in package.json". **It is not** — `package.json` advertises
*"zero dependencies"* and has no `dependencies` block, and the whole codebase
already uses Node's built-in **`node:sqlite`** (`DatabaseSync`) everywhere:
`packages/orm/src/adapters/sqlite.ts`, `packages/orm/src/docstore.ts`,
`packages/core/src/sessionHandlers/databaseHandler.ts`. Node's bundled SQLite
ships FTS5 + `bm25()` (verified on this build).

Adding `better-sqlite3` would have **broken the framework's zero-dependency
guarantee** for no gain. The correct maintainer decision — verify against live
source, add no dep — was to build on `node:sqlite`, matching the existing
subsystems. (The stale `better-sqlite3` mentions in code comments are
pre-existing and inaccurate; the imports are all `node:sqlite`.)

## Files

| File | Role |
|------|------|
| `packages/core/src/context/chunker.ts` | `fold` / `lightStem` / `terms` + `chunkCode` (def/class boundaries) + `chunkText` (sentence boundary, no code-shredding). Port of `context/chunker.py`. |
| `packages/core/src/context/index.ts` | `Context` class (`indexPath` / `indexRoot` / `search` / `reindexFile` / `reset` / `count`), FTS5-absence guard, process-wide shared singleton (`defaultContext` / `existingContext`). Port of `context/__init__.py`. |
| `packages/core/src/mcp.ts` | Registers the dev-MCP `code_search` tool (sibling of `api_search`/`api_class`/`api_method`). |
| `packages/core/src/devAdmin.ts` | `handleReload` (`POST /__dev/api/reload`) reindexes the changed file into the shared index (guarded). |
| `packages/core/src/index.ts` | Public exports: `Context`, `defaultContext`, `existingContext`, `fts5Supported`, `SearchHit`. |
| `test/context.test.ts` | 46 real, no-mock assertions (real `node:sqlite` file + real temp trees). |

## API (camelCase, same semantics as Python)

```ts
import { Context } from "@tina4/core";
const ctx = new Context(".tina4/context.db");
ctx.indexRoot("src");                       // walk + index eligible files
ctx.search("where is the auth token issued?", 5);
//  -> [{ path: "auth.ts", score: 2.31, snippet: "..." }, ...]
ctx.reindexFile("src/auth.ts");             // UPSERT one changed file
```

- **Result shape:** `{ path, score, snippet }` — `score` is higher-is-better
  (sqlite's `bm25` sign flipped), results sorted descending.
- **Ranking:** raw `bm25()` pool, then a stable two-pass reorder — a test file
  that merely mentions a symbol sinks below the source that defines it (skipped
  when the query itself is about tests), and a chunk that DEFINES a queried
  symbol rises above chunks that only use it.
- **FTS5 guard:** a real probe (`CREATE VIRTUAL TABLE ... USING fts5`); if the
  build lacks FTS5 the Context degrades to safe no-ops (`indexRoot`/`indexPath`
  return `0`, `search` returns `[]`) instead of crashing the app.
- **No lock:** `node:sqlite` is synchronous and JS is single-threaded, so the
  Python port's threading lock is unnecessary — every method runs to completion
  before the event loop dispatches another.

## Integration points

**dev-MCP `code_search`** — registered in `registerDevTools()`
(`packages/core/src/mcp.ts`) immediately after `api_method`, matching the exact
pattern of the `api_*` tools (`req("./context/index.js")`, same
`server.registerTool(name, handler, description, schemaFromParams([...]))`
shape). It indexes `src/` when present (falls back to the project root), holds a
PROCESS-WIDE shared `Context` at `<projectRoot>/.tina4/context.db`, supports a
`rebuild` arg, and returns `{ error }` when FTS5 is unavailable. Mirrors the
Python master's `code_search`.

**Reindex-on-change** — `handleReload` in `packages/core/src/devAdmin.ts` (the
`POST /__dev/api/reload` handler the CLI fires on file save, the direct analogue
of Python's `dev_admin._api_reload`) now, after route re-discovery, calls
`existingContext()?.reindexFile(changedFile)` inside a guard. It only touches an
already-built index (`existingContext` never creates one), so it is a no-op until
`code_search` has run — and a context failure can never break the reload. Shares
the SAME index as `code_search` because both key off `<cwd>/.tina4/context.db`.

## Chunking

- **Code / config / special files** (`.ts .js .mjs .py .php .rb .pas …`,
  `.toml .yml .yaml`, `dockerfile`, `package.json`, `.env.example`, …) chunk on
  top-level `function`/`class`/`export`/decorator boundaries, packed to ≤60
  lines, each chunk prefixed with a `# file: <path>` line so path tokens are
  searchable ("where is the router?" matches `core/router.ts` by name).
- **Docs** (`.md .txt .rst .twig .html`) chunk as prose on sentence boundaries
  (≤350 words), never shredding embedded code (`db.fetch()` stays intact).
- **`fold`** lowercases, strips diacritics (NFKD → ASCII), joins comma-grouped
  numbers, and splits camelCase — applied symmetrically to indexed body and
  query tokens so `field` reaches `IntegerField`. `lightStem` folds simple
  plurals (query-side only).
- **Skipped dirs:** `.git __pycache__ node_modules vendor dist build coverage
  .idea .venv venv .pytest_cache .tina4 sessions logs` + any dotdir; `*.min.js`
  excluded.

## Tests

`npx tsx test/context.test.ts` — 46 assertions, all real (real `node:sqlite`
file, real temp source trees, non-overlapping symbols so no FTS cross-match).
Covers the same behaviours as `tina4-python/tests/test_context.py`: ranking,
UPSERT reindex (new found / old gone / no dupes), FTS5 detection + graceful
degradation, result shape + score ordering, doc-as-prose + vendor-dir skipping,
empty/stopword → `[]`, `reindexFile` against a subdir root (+ skip / ineligible /
delete), the shared singleton, the dev-MCP `code_search` tool over a real temp
project, and the `handleReload` trigger reindexing end-to-end.

`test/mcp.test.ts` bumped 48 → 49 tools and adds `code_search` to the expected
tool-name set.

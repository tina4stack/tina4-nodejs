# Changelog

Tina4 keeps ONE version across all four frameworks (Python, PHP, Ruby, Node.js), so a version
number means the same thing everywhere.

**The authoritative release notes for every shipped version live in the documentation:**
https://tina4.com/nodejs/36-releases

This file is deliberately NOT a copy of those notes. Duplicating them is exactly how a
changelog rots into claiming a version that was never cut, so this file records only
UNRELEASED work. When a version ships, its notes go to the release notes above.

## Unreleased

### Changed

- **Breaking: every ORM read path that takes a `limit` now defaults to 100 rows, and
  four of them had no cap at all.** `db.fetch()`, `all()`, `select()` and `withTrashed()`
  took an optional `limit` with NO default, and the adapters only append a `LIMIT` clause
  when one is given, so each returned every row. `where()`, `cached()` and a
  `scope()`-generated method defaulted to 20. All seven now default to 100
  (`DEFAULT_ROW_CAP`, exported from `@tina4/orm` so the ORM and the DB layer cannot drift
  apart on the number).

  Migration: this one can change results in both directions. A caller relying (knowingly
  or not) on an unbounded read must now ask for it: `Model.where(sql, [], 10000)`. A
  caller relying on the old 20 gets 100. Code that already passes a limit is unaffected.
  `all()` and `select()` gained `limit`/`offset` parameters, appended after the existing
  ones, so positional callers keep working.

  `QueryBuilder.get()` and `db.fetchAll()` are deliberately UNCHANGED and stay uncapped.
  Neither takes a `limit`, so a cap there can only ever be silent, and that silent
  `LIMIT 100` was the data-loss-on-read footgun removed in 3.13.39. `fetchAll` needed a
  structural change to keep that promise: Node's adapters read `limit: 0` as `LIMIT 0`
  (zero rows) rather than as the "no truncation" sentinel Python and PHP use, so the cap
  could not live on `fetch`'s parameter default without `fetchAll()` silently inheriting
  it. Both now share one internal body; `fetch` applies the cap, `fetchAll` passes the
  limit through untouched.

- Internal: the SQL dialect-translation module is renamed
  `packages/orm/src/sqlTranslation.ts` -> `packages/orm/src/sqlTranslator.ts`, so the filename
  matches the `SQLTranslator` class it exports (and the sibling frameworks). Consumers import the
  class by name from the package barrel (`export { SQLTranslator, QueryCache }`), and no exports
  map ever pointed at the file path, so this is a filename alignment with no API change.

### Fixed

- **`tina4 deploy docker` produced images that could not start.** Of the eight
  Dockerfile generators in the stack (four templates in the `tina4` CLI plus one
  in each framework's own CLI), exactly one was correct. Python named
  `python -m tina4_python.cli`, a package with no `__main__.py`, so the container
  died on startup; PHP ran `php index.php <addr>`, but `App::run(?host, port)`
  never reads argv so the address was dropped and production never engaged;
  Node named a path that exists only inside the tina4-nodejs monorepo and
  depended on tsx, which `npm ci --omit=dev` strips. Every generator now names a
  published entry point and requests production. Verified by scaffolding,
  generating, building and running a container for all four languages.
- **`serve` no longer kills PID 1.** The port-reclaim step read `lsof -ti`
  without validating it. Where lsof prints a different shape, a non-numeric field
  coerced to 0 or 1 -- and signalling PID 0 hits every process in the caller's
  own process group. In a container the server IS PID 1, so it killed itself
  (Node logged "Killed existing process on port 7148 (PID: 1 ...)" then exited
  143; PHP logged the same attempt and survived by luck). Reclaiming is now
  skipped inside a container, only all-digit PIDs are accepted, and PID 0, PID 1
  and the current process are never signalled.
- **The npm package ships built JavaScript.** `bin` pointed at a shell script
  running `npx tsx src/bin.ts`, and the package published TypeScript sources
  only -- so a production container had to fetch tsx from the network at start.
  `bin` is now `packages/cli/dist/bin.js`, a self-contained bundle importing only
  Node built-ins; `prepublishOnly` guarantees dist/ is in the tarball and
  `prepare` builds it in a fresh checkout. Verified with `--network none`.

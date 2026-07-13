# Task: #32 — `tina4-nodejs/orm` subpath unimportable from an installed app (bare `@tina4/*`)

## Goal
A consumer that installs `tina4-nodejs` from npm can import every documented entrypoint
(`tina4-nodejs`, `/orm`, `/swagger`, `/frond`) AND deploy any gallery example into their
own `src/` and have it run — no `ERR_MODULE_NOT_FOUND: Cannot find package '@tina4/*'`.

## Context
The published `tina4-nodejs` is the ONLY npm package (dependencies: {}) and ships raw `.ts`.
Bare workspace specifiers `@tina4/{core,orm,frond,swagger}` only resolve in the monorepo via
`node_modules/@tina4/*` symlinks, so they throw in a consumer install (#32).

- The reporter's headline repro (`import ... from "tina4-nodejs/orm"`) was ALREADY fixed at
  HEAD by `8c38590` (shipped 3.13.70): internal cross-package imports were rewritten to
  relative paths, and `test/packInstall.test.ts` locks it in (real pack+install, no mock).
- RESIDUAL found this pass: the **gallery examples** (`packages/core/gallery/**`, shipped in
  `files`) still used bare `@tina4/core`/`@tina4/orm`. The dev-admin "Deploy" button
  (`POST /__dev/api/gallery/deploy` → `handleGalleryDeploy`) copies a gallery example's
  `src/**` VERBATIM into the consumer's `src/`, so a user deploying the database/queue example
  gets the exact `Cannot find package '@tina4/orm'` in their own code (proven live: 500).
- SECOND defect, previously MASKED by the first: the database gallery called
  `orm.initDatabase(...)` WITHOUT `await` (it returns `Promise<Database>`), so once the import
  resolved, `db.execute/fetch/insert` were `undefined`. No monorepo test executes gallery
  route bodies, so it shipped undetected.

## Scope
- [x] Reproduce #32 headline repro at HEAD (pack+install+import) — already GREEN (8c38590)
- [x] Audit all shipped code for residual bare `@tina4/*` specifiers → found gallery (19 files)
- [x] Prove the residual live: deploy database gallery into a consumer → 500 `Cannot find package '@tina4/orm'`
- [x] Fix: rewrite gallery `@tina4/core`→`tina4-nodejs`, `@tina4/orm`→`tina4-nodejs/orm` (matches scaffold generators)
- [x] Fix the masked `await orm.initDatabase(...)` bug in the 3 database gallery files
- [x] Prove the fix: re-pack, install, deploy database gallery → real SQLite round-trip (create/insert/list)
- [x] Lock in (real, no-mock, in the pack-install path since the monorepo symlink hides it):
      (a) static scan — no gallery file may reference a bare `@tina4/*` specifier
      (b) functional — deployed database gallery real SQLite round-trip
- [x] Negative-verify both guards fail against the reintroduced bug, then restore
- [x] `npm run typecheck` green
- [ ] Full suite green at HEAD (pre-existing 9 PG/Valkey service-gated failures excepted)
- [ ] Commit to v3 referencing #32 (do NOT tag/push tags)

## Parity
Node-only surface (gallery examples are a Node-specific `/_dev/` deploy feature; no twin in
Python/PHP/Ruby). The underlying bare-specifier class was fixed for the ORM subpath in 8c38590.

## Files
- `packages/core/gallery/**/*.ts` — 19 files: bare `@tina4/*` → public `tina4-nodejs` / `tina4-nodejs/orm`;
  3 database files also gained the missing `await` on `initDatabase`.
- `test/packInstall.test.ts` — 2 new real guards (static scan + deployed-gallery SQLite round-trip).

## Out of scope (flag separately)
- A suite test mutates the repo-tracked `CLAUDE.md` during `npm test` (docs-sync leak from a
  conformance test) — test-hygiene bug, unrelated to #32.

## Status: In Progress

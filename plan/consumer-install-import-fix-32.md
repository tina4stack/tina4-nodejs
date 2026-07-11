# Task: Fix consumer-install import break (#32) — 3.13.70

## Goal
A `tina4-nodejs` app installed from npm must be able to `import` from `tina4-nodejs`,
`tina4-nodejs/orm`, `tina4-nodejs/frond`, `tina4-nodejs/swagger` without
`ERR_MODULE_NOT_FOUND`. Today the shipped `.ts` sources cross-import bare
`@tina4/{core,orm,frond,swagger}` specifiers that only resolve via monorepo
`node_modules/@tina4/*` symlinks — absent in a consumer install.

## Context / root cause (diagnosed)
Root `tina4-nodejs` is the only published package (`dependencies: {}`) and ships
raw `packages/*/src/**/*`. Internal cross-package imports use the bare workspace
specifier `@tina4/*` → resolves in the monorepo (symlinks), throws in a consumer.

## Scope (this pass — Node only, branch v3, local commit, no push, no version bump)
- [x] Rewrite every real bare `@tina4/*` specifier (static import / import type /
      await import / require) in packages/{core,orm,swagger,frond}/src to a RELATIVE
      path into the target package's entry (`.js` extension = repo convention;
      frond entry = `engine.ts`).
- [x] `optionalDependencies` in root package.json for lazily-imported drivers:
      mongodb, pg, redis, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner.
- [x] Real pack-install regression test (npm pack -> install tarball into throwaway
      ESM project -> import all four entrypoints + drive response.render()).
- [x] Wire pack-install test into the runner.

## Decisions / drift notes
- migration.ts generated-migration string `import type ... from "@tina4/orm"` →
  `tina4-nodejs/orm` (consumer-facing generated file; a relative path is nonsense in
  a user project; the public subpath is correct and fixes a consumer tsc typecheck).
- ai.ts has NO real runtime `@tina4/core` import (the orchestrator's premise). The
  only `@tina4/core` occurrences are one JSDoc comment + generated AI-context doc
  strings installed into user projects; a user copying them reproduces #32, so they
  are rewritten to the public `tina4-nodejs` specifier.
- mcp.ts `reqSibling` bare `@tina4/${pkg}` attempt only ever resolved via symlinks;
  collapsed to the relative source require it already fell back to.
- Monorepo test files keep importing `@tina4/*` (symlinks still present) — unchanged.

## Parity
| Concern | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| Single published package, no internal bare self-import | N/A | N/A | N/A | (this fix) |

Node ships as ONE npm package with internal src; Python/PHP/Ruby package differently
(PyPI/Packagist/RubyGems single dist) and do not have this @tina4/* symlink shape.
This is a Node-packaging bug, not a cross-language logic feature — no parity port.

## Verification (macOS darwin 25.5.0, Node v24.9.0)
- `npm install` exit 0; lockfile gained pg 8.20.0, redis 4.7.1, @aws-sdk/client-s3
  3.1085.0, @aws-sdk/s3-request-presigner 3.1085.0, mongodb 6.21.0.
- `npm run build` exit 0 (all 5 workspaces).
- `npm run typecheck` exit 0.
- Full suite: 5343 passed, 9 failed across 151 files. The 9 failures are
  pre-existing service-gated env issues (4 PG files crash on `role "tina4"
  does not exist`; sessionHandlers 9 Valkey-unreachable) — IDENTICAL on the
  pre-fix baseline (stash-and-rerun confirmed). ZERO module-resolution errors
  run-wide. New packInstall.test: 11/11.
- Negative proof: reintroducing bare `@tina4/core` into the installed tarball's
  baseModel.ts reproduces the exact #32 error (ERR_MODULE_NOT_FOUND).

## Specifiers rewritten (28 total; frond had 0 real imports)
- orm (9): migration.ts x2 (Log import + generated `import type` -> tina4-nodejs/orm),
  baseModel, seeder, realtime/storage, realtime/realtime, autoCrud, cachedDatabase x2.
- core (16): response.ts x3 (frond dynamic), cache.ts x1 (orm dynamic),
  devAdmin.ts x7 (orm dynamic), mcp.ts x1 (reqSibling require), ai.ts x4 (installed-doc examples).
- swagger (3): ui.ts x1, generator.ts x2.

## Status: Done (committed locally to v3, unreleased — central 3.13.70 bump later)

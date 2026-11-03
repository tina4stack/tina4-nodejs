# Task: Clear the dev-tree CVEs from tina4-nodejs's committed lockfile

## Problem
GitHub Dependabot flagged the repo: 4 high + 3 moderate in the committed
`package-lock.json`. None ship (`npm audit --omit=dev --omit=optional` = 0):
- `@azure/identity` + `@azure/msal-node` (high) ← `tedious` (MSSQL driver)
- `@grpc/grpc-js` (high) ← `tina4-ultipa` (Ultipa graph driver)
- `vite` (high) + `@vitest/mocker` + `fast-uri` (moderate) ← `vitest` (test runner)

## Root cause (measured)
The committed `package-lock.json` was **stale** — it pinned OLD, vulnerable
transitive versions that newer PATCHED releases already supersede within the
existing semver ranges. A plain `rm package-lock.json && npm install` re-resolves
them to fixed versions. Two devDep ranges also needed a nudge (the vulnerable
version sat at the bottom of the range): `vitest` and the `fast-uri` override.

Dead end ruled out: moving `@tina4/orm`'s driver `optionalDependencies` to optional
`peerDependencies` (to drop them from the lockfile) breaks the no-mock suite —
npm 11 will NOT install a declared optional peer via `npm install --no-save`
(`--legacy-peer-deps`/`--save=false`/`--force` all no-ops), and ADR-0067's own note
says the orm `optionalDependencies` deliberately feed the monorepo's live-DB tests.
So the drivers STAY as orm optionalDependencies; only the stale pins were the bug.

## Fix
- [x] `vitest` `^4.1.9`→`^4.1.12` (patched `@vitest/mocker`; stays on 4.x, no major bump)
- [x] `fast-uri` override `^3.1.8`→`^3.1.9` (patched)
- [x] Regenerate `package-lock.json` → patched transitives pulled in:
      `@azure/identity` 4.13.2→**4.14.1**, `@azure/msal-node` 5.6.0→**7.1.2**,
      `@grpc/grpc-js` 1.14.4→**1.14.7**, `vite`→**8.3.5**, `fast-uri`→**3.1.9**,
      `@vitest/mocker`→**4.1.12**.
- [x] Add CodeQL (`javascript-typescript`, build-mode none) — repo had no code scanning.
- orm `optionalDependencies` and CI `test.yml`: UNCHANGED (drivers still install for
  the no-mock suite).

## Verification (no mocks)
| Check | Before | After |
|-------|--------|-------|
| `npm audit` full tree | 4 high + 3 moderate (7) | **0** |
| `npm audit --omit=dev --omit=optional` (shipped) | 0 | 0 |
| `databaseConnectTimeout.test` (needs drivers present) | regressed in the detour | **20 passed, 0 failed** |
| `databaseDrivers.test` | regressed in the detour | **59 passed, 0 failed** |
| drivers resolvable (orm optionalDeps intact) | yes | yes |
| full live-DB matrix | CI | CI confirms (services + orm optionalDeps) |

## Parity note
nodejs-specific lockfile hygiene; not a cross-framework contract change. Shipped
surface was always clean (root optional peerDeps + bundled dist +
`test/zeroDependencyInstall.test.ts`); this clears the committed lockfile that
Dependabot reads.

## Status: Done — verified locally (audit 0, regressed files green); PR off v3

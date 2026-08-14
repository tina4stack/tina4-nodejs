# Node 3.13.100 version consistency

## Outcome

The root package, all published workspaces, and the npm lockfile report the same
release version.

## Scope

- [x] Inspect the versions emitted by the lab workspace build.
- [x] Add a release-consistency regression before changing package metadata.
- [x] Update all workspace manifests and the lockfile to `3.13.100`.
- [x] Update the current-version markers in the AI-facing guide.
- [x] Re-run the regression, typecheck, and workspace build.

## Parity

| Package surface | Status |
|---|---|
| Root package | ✅ `3.13.100` |
| AI-facing guide | ✅ `3.13.100` |
| Published workspaces | ✅ `3.13.100` |
| npm lockfile | ✅ `3.13.100` |

## Tests

- [x] `npx tsx test/versionConsistency.test.ts` - 15 passed, 0 failed.
- [x] `npm run typecheck`
- [x] `npm run build --workspaces`

## Bugs

- [x] The release bump changed only the root package manifest.

## Commits

- This change: complete the Node `3.13.100` workspace and lockfile bump.

## Status: Complete

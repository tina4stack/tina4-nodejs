# Releasing tina4-nodejs

This repo is an npm workspaces monorepo. A single release version lives in
**11 places** that must move together. The publish workflow is triggered by a
pushed tag (`3.13.NNN`), so a mismatch that reaches the tag has already shipped
to npm by the time anything notices.

## Run the pre-tag precheck BEFORE you tag

```bash
# after bumping every version location to the intended version:
npm run release:precheck 3.13.NNN
# then only if it exits 0:
git tag 3.13.NNN
git push origin v3 --tags
```

`release:precheck` runs the version-consistency guard
(`test/versionConsistency.test.ts`) with the version you are about to tag. It
exits non-zero and names any file still on a different version. It is the same
guard the CI publish gate runs, moved earlier so drift is caught on your machine
BEFORE the tag exists rather than after it is public.

Three equivalent invocations (all pass the intended version to the guard):

```bash
npm run release:precheck 3.13.NNN         # npm 7+ forwards the arg
npm run release:precheck -- 3.13.NNN      # explicit passthrough, any npm
RELEASE_VERSION=3.13.NNN npm run release:precheck
```

With no version given, the guard runs in self-consistency mode: it takes root
`package.json` as the source of truth and checks every other location against
it. That is what the CI gate and `npm test` (which runs the guard as a normal
test) do. Passing the intended version additionally asserts that root itself was
bumped, which is the miss described below.

## The 11 version locations the guard enforces

| # | Location |
|---|----------|
| 1 | `package.json` -> `version` (root, the source of truth) |
| 2-6 | `packages/{cli,core,frond,orm,swagger}/package.json` -> `version` |
| 7 | `package-lock.json` -> `version` (top level) |
| 8 | `package-lock.json` -> `packages[""].version` (root package entry) |
| 9-13* | `package-lock.json` -> `packages["packages/<name>"].version` for each of the 5 workspaces |
| 14* | `CLAUDE.md` title: `tina4-nodejs (v<version>)` |
| 15* | `CLAUDE.md` intro: `Tina4 for Node.js/TypeScript v<version> -` |

(*The table numbers the checks, not 11 lines: the lockfile contributes 7 checks
and CLAUDE.md contributes 2. The point is that a bump is NOT just the five
`packages/*/package.json` files.)

## Why this exists: the 3.13.120 incident

3.13.120 bumped the five workspace `packages/*/package.json` files but MISSED:

- root `package.json`,
- root `package-lock.json` (its own `version`, the `packages[""]` root entry,
  and the five workspace entries), and
- the guard's own hardcoded expected-version literal.

The guard existed and caught it, but only on the CI publish gate AFTER the tag
was pushed, which forced a tag delete and re-push
(`0745295 release: 3.13.120` -> `436ca76 release: fix 3.13.120
version-consistency (root + lockfile + test)`).

Two changes closed the gap:

1. **The guard no longer hardcodes the version.** It reads the intended version
   from the `release:precheck` arg / `RELEASE_VERSION`, falling back to root
   `package.json`. Bumping the version no longer edits the test file (that
   literal was itself one of the things that drifted).
2. **`release:precheck` runs the guard BEFORE the tag.** Run it as the last step
   before `git tag`, per the recipe above.

`test/versionPrecheckDrift.test.ts` locks both in with a real-subprocess
regression: it proves the guard passes at HEAD, fails while naming the drifted
file (workspace, root, and lockfile misses), and honours the version arg.

## Release flow (branch policy)

The active release line for the 3.13.x series is the **`v3`** branch; the tag is
cut there. Do fewer, bigger releases. In outline:

1. Bump all 11 locations to `3.13.NNN` (all `package.json` files, regenerate /
   update `package-lock.json`, update the two `CLAUDE.md` strings).
2. `npm install` so the lockfile is coherent, `npm run build`, `npm run typecheck`,
   `npm test` all green at the exact HEAD you will tag.
3. `npm run release:precheck 3.13.NNN` exits 0.
4. `git tag 3.13.NNN && git push origin v3 --tags`. The tag triggers the npm
   publish workflow; merging alone never publishes.

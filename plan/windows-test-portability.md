# Task: Make the Node suite portable to Windows (test bugs only)

Outcome: `npx tsx test/run-all.ts` on Windows fails only for real framework bugs
on Windows, a missing local service, or one Node runtime bug, never because a
TEST assumed POSIX. Each changed test still fails when the behaviour it guards
breaks. Framework bugs found on the way are REPORTED, not fixed here. Branch
`fix/windows-test-portability`.

Measured on Windows 11 (10.0.26300), Node v25.2.1, no local services. The
baseline is plain `origin/v3` @ 7a9c057 in a separate worktree: 88 tsx files
FAIL plus the whole vitest group (the runner could not start vitest).

## Scope
- [x] Baseline full run on plain origin/v3, then each FAIL re-run alone on pristine v3
- [x] Classify each failure: test portability / framework bug / service missing / Node bug
- [x] Fix the test-portability causes (below)
- [x] Mutation-prove the changed tests that guard behaviour
- [x] Full Windows run on the branch; compare against baseline (104 failed files -> 49; vitest group now runs: 229/232)
- [ ] PR against v3 (DCO sign-off)

## Causes fixed (test side)
| Cause | Fix | Files |
|---|---|---|
| Windows path passed where ESM needs a URL (`--import D:\...`, `import "D:\..."`, `file://${path}`) | `pathToFileURL().href` / `moduleUrl()` / `TSX_LOADER_URL` | authTokenContract, autocrud, cors x3, entryPointSecurityParity, gracefulShutdown, id/ident/ormIdentifier, legacyEnvGuard, logger x2, mcpMigrationCreateEnvelope, migrationConcurrency277, packageExports, routeDiscoveryReload, spawned-app tests |
| Path interpolated into a JS string literal (`'${dir}'` - backslashes become escapes) | `JSON.stringify(path)` | browserOpenGate, clusterMode, devToolbarGzip, dotenvSettings, fileUpload, gracefulShutdown, httpHardening, loopBlockWatchdog, rawTcp, requestBodyCap, swagger x2, tina4cssServed |
| `.bin/tsx`, `npx`, `npm` are `.cmd` shims spawn() cannot start (ENOENT/EINVAL) | `process.execPath` + the tool's JS entry (`TSX_CLI`, `TSC_CLI`, `VITEST_CLI`, `npmCommand()`) in `test/_portableSpawn.ts` | ~40 sites incl. **run-all.ts** (vitest never ran on Windows) |
| `process.kill(-pid)` - no process groups on Windows; children leaked and held their cwd | `killProcessTree()` (POSIX: group kill; Windows: `taskkill /T /F`) | 16 files; testProcessHygiene invariant accepts it |
| Native separators compared with `/` | normalise to `/` / `join()` | ai, generateEnvelopeV11, generateResolution, migrateCreateEnvelopeParity, testEnvContract |
| Shared temp dir: `a/b` and `a\b` are the same file on Windows | one session dir per hostile id | authSessionContract |
| Temp dir removed while this process holds a SQLite file open | close the DB first; `removeTempDir()` only where no close API exists | autocrud, idArgumentLockIn, identifierAllowList, migrateCli, cli, 4 session tests |
| Symlink creation needs Developer Mode/admin (EPERM) | stage mode 120000 in the git index (checkNoSymlinks); else probe + visible `SKIP` (`test/_symlinkSupport.ts`) | checkNoSymlinks, devSurface, fileUpload, frondtags, mcp, static |
| Fake `tina4` client was a `#!/bin/sh` script | real `tina4.cmd` -> node program on Windows | cliDelegatedCommands |
| POSIX-only semantics (signals, mode bits, async pipes, orphaned grandchild, EACCES) | Windows equivalent where one exists (EPERM, bounded slow-client rounds), else a visible `SKIP` naming the reason | gracefulShutdown, rawTcp, sqlitePathContract, runnerExitFlush, testProcessHygiene, sessionBackendFailure, websocketHardening |
| `cliHelpFlags` passed `shell: true`, mangling `C:\Program Files\...` | drop the shell | cliHelpFlags |
| Fake browser opener was a `#!/bin/sh` script; PATH joined with `:`, duplicated as `Path`+`PATH` | a real `rundll32.exe` (copy of node) earlier on PATH, `path.delimiter`, one PATH key | browserOpenGate |
| pty fallback did not recognise "no `script` binary" (ENOENT) | treat it as the same no-pty limitation | loggerFixtureContract |
| `.bin/esbuild` shim | esbuild's `buildSync` API, same options | docstoreSubstitutability |
| `packages/cli` build quoted its banner with `'...'` (cmd.exe has no single quotes): `npm ci` / `npm run build` failed on Windows | escaped double quotes; same `#!/usr/bin/env node` banner under sh | packages/cli/package.json |

## Bugs found - REAL framework bugs on Windows (reported, not fixed here)
- [ ] `getFrameworkFrond()` (packages/core/src/response.ts:111) strips `file://` by string replace -> `/D:/...` -> framework templates not found -> a browser gets JSON, not the 401/403/500 error page. Fix: `fileURLToPath(import.meta.url)`. Red: errorNegotiation401Middleware500, errorPagesContract.
- [ ] `recordBrokenImport()` (routeDiscovery.ts) slugs the ABSOLUTE path -> `C:` in the filename -> write throws, swallowed -> discovery failures never reach /health on Windows. Python slugs a relative path. Red: routeDiscoveryReload.
- [ ] `tina4nodejs lint` spawns `npm.cmd` without a shell -> EINVAL -> eslint can never be installed on Windows. Red: cliLint.
- [ ] `delegateToClient()` accepts `tina4.cmd`/`.bat` on Windows, then spawns them without a shell -> EINVAL (`tina4.exe` works). Red: cliDelegatedCommands (4 cases).
- [ ] `FakeData.seedDir()` imports a raw Windows path and swallows the error -> seed files silently never run on Windows.
- [ ] ProjectIndex keys files by native separators (Python too) -> `fileEntry("src/routes/users.ts")` misses on Windows. Cross-framework. Red: projectIndex.
- [ ] `DatabaseSessionHandler` opens a SQLite file and has no close(); SessionHandler has no close() at all.
- [ ] Production cluster mode never sets `cluster.schedulingPolicy = SCHED_RR`. Node's default is round-robin everywhere EXCEPT Windows, so there one worker answers every request while the banner claims N. Proven: `NODE_CLUSTER_SCHED_POLICY=rr` makes the case pass. Red: clusterMode (vitest).

## Not test bugs, not framework bugs
- Node/libuv: `fetch` keep-alive + `server.close()` + `process.exit()` aborts with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c` (exit 127). Pure-Node repro (3 sequential fetches): reproduces on v25.2.1. Red: aiFetchRetry, devAdminVersionCheck, globalAfterMiddleware, globalMiddlewareSplit, optionsAllowConformance, responseFileTraversal, routeGroupAuth, ssoFirstVisitCookie - all their cases pass first.
- Timing-sensitive on a loaded host (fail identically on pristine v3 at the same moment, passed in the baseline run): docs `test_search_response_under_50ms` (57ms), databaseConnectTimeout mongodb bound (3347ms vs 3000ms).
- No local services (Postgres/MySQL/MSSQL/Mongo/Redis/Memcached/Kafka/GreenMail): service SKIPs, and the files that FAIL or print no summary without one (sessionHandlers, kafkaErrorCodes, queue*, sessionMemcached, ...).
- Pre-existing, noted only: static.test uses `mockReq`/`mockRes` doubles; the testProcessHygiene invariant never matched `.bin/tsx` spawns, so loggerFixtureContract, migrationConcurrency277 and sessionDatabaseEngines spawn tsx undetached; run-all's TMPDIR sandbox does not apply on Windows (os.tmpdir() reads TEMP/TMP).

## Commits
- (filled at commit time)

## Status: In Progress

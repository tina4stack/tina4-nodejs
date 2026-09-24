# Task: tina4-nodejs genuinely zero-dependency (optional drivers become optional peers)

**Outcome:** `npm install tina4-nodejs` adds exactly ONE package. The five driver
packages (`pg`, `mongodb`, `redis`, `@aws-sdk/client-s3`,
`@aws-sdk/s3-request-presigner`) move from `optionalDependencies` (which npm
installs by default) to optional `peerDependencies` (which it does not). Every
lazy-load site fails with an actionable error naming the exact `npm install`
command. Governing decision: ADR-0067 (database drivers and optional servers are
application dependencies, never framework runtime dependencies).

| Plain `npm install <tarball>` into an empty project | packages | node_modules |
|------|------|------|
| before (3.13.137 as released) | **64** | 43 MB |
| after (this branch) | **1** | 11 MB |

## Scope
- [x] package.json: 5 packages optionalDependencies -> peerDependencies + peerDependenciesMeta optional
- [x] devDependencies keep what the suite imports (mongodb already; pg added explicitly; redis / aws-sdk not imported by any test -> not added, and they leave the dev lockfile)
- [x] S3Storage: bare require -> actionable "npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner" (constructor checks both; any non-missing load error re-thrown untouched)
- [x] Queue MongoBackend: resolve at construction, throw actionable error (parity: Python raises in the constructor); child imports the resolved driver URL
- [x] Cache Mongo/Database backends: fallback warning appends the install command when the cause is a missing driver
- [x] Redis/NATS backplanes: throw from the constructor; failed connect observed (no unhandled rejection)
- [x] Audited the rest: postgres/mysql/mssql/firebird/odbc/mongodb adapters, docstore, session sqlClient already actionable; session mongoClient + Redis/Valkey/Memcached handlers are zero-dep (wire protocol)
- [x] README / CLAUDE.md / BENCHMARK.md / tina4-developer-nodejs skill references (.claude/.cursor/.agents)
- [x] tina4 CLI checked: `tina4 init nodejs` writes `dependencies: { "tina4-nodejs" }` only, and `setup.rs` already says `npm i pg` - no change needed
- [x] tina4-documentation: Node pages updated on `docs/node-drivers-are-app-deps`

## Parity ("driver not installed" wording)
| Site | Python | PHP | Ruby | Node |
|------|--------|-----|------|------|
| Postgres adapter | ✅ Install one of | ✅ ext-pgsql hint | ✅ Install one of | ✅ Install one of |
| Mongo adapter | ✅ | ✅ | ✅ | ✅ |
| Mongo queue | ✅ raises in ctor | ✅ pecl hint | ✅ gem install hint | ✅ (was swallowed) |
| Mongo cache fallback warning | ⚠️ generic | ⚠️ generic | ⚠️ generic | ✅ names the command |
| DocStore | ✅ | ✅ | ✅ | ✅ |
| Redis backplane | ✅ | n/a | ✅ | ✅ (was an unhandled rejection) |
| S3 storage | ⚠️ bare `import boto3` | ⚠️ names pkg, no command | ⚠️ bare `require "aws-sdk-s3"` | ✅ (was bare require) |

## Tests (written first, real - no mocks, positive + negative)
- [x] test/zeroDependencyInstall.test.ts: real `npm pack` + plain `npm install` -> exactly 1 package, none of the 5 present (red on the old package.json: 64)
- [x] consumer (plain node, the published dist) boots startServer + serves a route and /health; SQLite round-trip
- [x] NEGATIVE: postgres / mongodb ORM / docstore / queue mongodb / cache mongodb / session database-on-postgres / redis backplane / S3Storage / selectStorage each name `npm install <pkg>`; no unhandled rejection
- [x] POSITIVE: `npm install pg mongodb redis` in the consumer, run from OUTSIDE the app dir: real PostgreSQL (ORM + database sessions), real MongoDB queue push -> pop, real Redis backplane publish -> subscribe; a dead Redis rejects publish() without an unhandled rejection
- [x] Mutation proof: reverting each of mongoBackend / websocketBackplane / storage / cache turns its assertions red; bare `import("mongodb")` in the queue child -> red when run outside the app dir; dropping observeConnectFailure -> red
- [x] S3 positive (manual, lab MinIO :9100): app installs the SDK, S3Storage put/exists/get/presigned url/delete on a throwaway bucket - all correct

## Bugs
- [x] Queue MongoBackend swallowed the missing-driver error (push "MongoDB push failed", pop silently null) - 1cabeec
- [x] Queue MongoBackend child resolved `mongodb` from process.cwd(): a server started outside the app dir could not find an installed driver - 1cabeec
- [x] RedisBackplane/NATSBackplane: missing package or failed connect became an UNHANDLED rejection (Node's default: crash the process) - 1cabeec
- [x] S3Storage.url() needed the presigner but a missing presigner surfaced as a bare MODULE_NOT_FOUND on first download - 1cabeec

## Verification
- Lab (Ubuntu 24.04, Node v24.18.0, TINA4_REQUIRE_SERVICES=1, TINA4_REQUIRE_OIDC=1, graph env sourced) at 4044b50:
  **9326 passed, 0 failed, 0 skipped** across 357 files; i18n 44/44; typecheck exit 0.
- Earlier lab run at 4044b50 hit one failure: `requestBodyCap` RSS threshold (12.04 MB vs < 12). Proven a load-sensitive flake, not this change: interleaved probes on the lab measured growth 3.9-8.9 MB on this branch and 2.0-15.3 MB on base d89998c (base also crossed 12).
- Local (macOS, Node 26.9.0, no lab credentials): zeroDependencyInstall 44/44 with local PG creds; full run's failures are all environment (no `tina4` PG role; Node 26 removed `--experimental-transform-types`, which `_driverlessTree.ts` uses).

## Commits
- 1cabeec  fix(deps): drivers become optional peers - npm install adds one package (ADR-0067)
- 4044b50  test(lazy-loading): core eager graph ceiling 79 -> 80 for optionalPackage.ts
- tina4-documentation b891937  docs(nodejs): drivers are the app's dependencies

## Status: Complete (PR open, not merged)

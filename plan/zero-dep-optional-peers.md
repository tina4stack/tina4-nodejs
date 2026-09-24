# Task: tina4-nodejs genuinely zero-dependency (optional drivers become optional peers)

**Outcome:** `npm install tina4-nodejs` adds exactly ONE package. The five driver
packages (`pg`, `mongodb`, `redis`, `@aws-sdk/client-s3`,
`@aws-sdk/s3-request-presigner`) move from `optionalDependencies` (which npm
installs by default) to optional `peerDependencies` (which it does not). Every
lazy-load site fails with an actionable error naming the exact `npm install`
command. Governing decision: ADR-0067 (database drivers and optional servers are
application dependencies, never framework runtime dependencies).

Measured before (3.13.137 tarball, plain `npm install` into an empty project):
**64 packages**. Target: **1**.

## Scope
- [ ] package.json: 5 packages optionalDependencies -> peerDependencies + peerDependenciesMeta optional
- [ ] devDependencies keep what the suite imports (mongodb already; pg added explicitly; redis / aws-sdk not imported by any test -> not added)
- [ ] S3Storage: bare require -> actionable "npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner" (constructor AND url() presigner)
- [ ] Queue MongoBackend: missing driver was SWALLOWED (push -> "MongoDB push failed", pop -> null). Resolve at construction, throw actionable error (parity: Python raises ImportError in the constructor)
- [ ] Cache MongoBackend: fallback warning names `npm install mongodb` when the driver is missing
- [ ] Audit every other load site: postgres adapter, mongodb adapter, docstore, websocket backplane, session sqlClient, session mongoClient (raw fallback, zero-dep)
- [ ] README / CLAUDE.md / docs in repo describe drivers as app-installed
- [ ] tina4 CLI scaffold checked (`tina4 init nodejs` package.json)
- [ ] tina4-documentation updated on its own branch

## Parity ("driver not installed" wording)
| Site | Python | PHP | Ruby | Node |
|------|--------|-----|------|------|
| Postgres adapter | ✅ Install one of | ✅ ext-pgsql hint | ✅ Install one of | ✅ Install one of |
| Mongo adapter | ✅ | ✅ | ✅ | ✅ |
| Mongo queue | ✅ raises in ctor | ✅ pecl hint | ? | ❌ swallowed -> fix |
| Mongo cache fallback warning | ⚠️ generic | ⚠️ generic | ⚠️ generic | ⚠️ generic -> fix |
| DocStore | ✅ | ✅ | ✅ | ✅ |
| Redis backplane | ✅ | n/a | ✅ | ✅ |
| S3 storage | ⚠️ bare import | ⚠️ names pkg, no command | ⚠️ bare require | ❌ bare require -> fix |

## Tests (written first, real - no mocks, positive + negative)
- [ ] test/zeroDependencyInstall.test.ts: real `npm pack` + plain `npm install` -> exactly 1 package, none of the 5 present
- [ ] consumer (plain node, the published dist) boots startServer + serves a route; SQLite round-trip
- [ ] NEGATIVE: postgres / mongodb ORM / docstore / queue mongodb / cache mongodb / session database-on-postgres / redis backplane / S3Storage each name `npm install <pkg>`
- [ ] POSITIVE: `npm install pg` in the consumer, then a real PostgreSQL round-trip
- [ ] Mutation proof: revert each fix -> its assertion goes red

## Bugs
- [ ] Queue MongoBackend swallowed the missing-driver error (push "MongoDB push failed", pop silently null)
- [ ] S3Storage.url() needed the presigner but a missing presigner surfaced as a bare MODULE_NOT_FOUND

## Commits
-

## Status: In Progress

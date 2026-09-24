# Task: follow-ups from the zero-dependency worker (redaction, driver messages, body-cap test, Node 26, optional peers)

**Outcome:** no connection password reaches a log line; every missing optional driver names the package and the
install command; the body-cap test measures the cap, not RSS noise; the driverless test helper runs on Node 24/25/26;
mysql2 / tedious / node-firebird / odbc are optional peers and a plain install still adds exactly one package.

Based on tina4-nodejs#67 (merged into v3 during this work; origin/v3 merged back in).

## Scope
- [x] 1. Backplane "connected" log redacts the URL (Redis + NATS share one `logConnected()` using `redactCredentials`); graph URL parse error redacts too
- [x] 2. Node already at the standard via #67; Python/PHP/Ruby brought to it in their own PRs
- [x] 3. requestBodyCap: flake measured (isolated + loaded), test now asserts the property from the socket, not RSS
- [x] 4. test/_driverlessTree.ts precompiles with esbuild; no `--experimental-transform-types`; framework + CLI templates checked (no use)
- [x] 5. mysql2, tedious, node-firebird, odbc as optional peerDependencies (ranges from packages/orm); plain install = 1 package
- [ ] 7/8. WSDL + mail (ADR-0071) - worker branch `fix/followups-wsdl-mail`, merged in before the PR
- [x] (a) "Database connected" leak check: Node logs no connection URL on connect; `redactCredentials` keeps only the user for `u:s3:cret@` and `u:s3@cret@` (userinfo ends at the LAST `@`)
- [x] (c) websocketHardening: FakeBackplane + MockSocket replaced by real servers, real clients and the real Redis backplane
- [x] (d) Kafka push to a dead broker: already throws in Node, pinned by kafkaErrorCodes.test.ts against a real closed port (10/10) - no change
- [ ] (e) OWED: NATS backplane redaction has no real test - no NATS server on the lab (the code path shares `logConnected()` with Redis)

## Parity
| Item | Python | PHP | Ruby | Node |
|------|--------|-----|------|------|
| 1 backplane log redaction | own PR | own PR (no URL logged; AUTH bug fixed) | own PR (no URL logged) | ✅ |
| 2 driver message standard | own PR | own PR | own PR | ✅ (#67) |

## Tests (written first, real - no mocks)
- [x] backplane_log_never_prints_the_redis_password - zeroDependencyInstall, real password Redis, child's real stdout+stderr (red at f9818a6, green at 73ef062)
- [x] graph_url_parse_error_never_prints_the_password - graph.test.ts (red, then green)
- [x] refuses_a_declared_oversized_body_before_reading_any_of_it - requestBodyCap (mutation: no declared check -> no answer)
- [x] refuses_a_chunked_body_at_the_cap_not_at_the_end - requestBodyCap (mutation: measure at end -> no answer after 128MB)
- [x] published manifest declares the four SQL drivers as optional peers - zeroDependencyInstall (red at 4724ae4, green at b1d6c0e)
- [x] websocketHardening real relay: 40/40 x3 on the lab; mutations: origin guard removed -> "A delivers locally exactly once" red; relay re-publishes -> red (cluster loop)
- [x] driverless helper: Node 26.9 local (was "bad option"), Node 24.18 lab; instrument mutation (tree inside repo) -> resolvable=4, FAIL

## Measurements
- Old RSS assertion on the fixed code: lab Node 24 isolated 1.9-8.4MB, under 24 busy loops 1.5-8.0MB (20/20 pass, 12MB line);
  macOS Node 26 1.0-3.5MB (10/10). Not reproducible as a failure here; 15.3MB reported elsewhere. The variance is GC timing:
  256MB sent after the 413 grew the fixed server by 138.8MB of already-dropped chunks.
- New chunked case: 413 arrived after 2.5-11.0MB written (lab, 20 runs, 10 loaded), line 33MB, mutation never answers.

## Bugs
- [x] websocketBackplane.ts logged `connected to ${resolvedUrl}` with the password (73ef062)
- [x] graphUrl.ts `Unsupported graph URL '${url}'` carried the raw URL (73ef062)
- [x] _driverlessTree.ts used a flag Node 26 removed (76054d9)
- [x] TINA4_TEST_REDIS_AUTH_URL was not canonical in test_env_contract.json (b7dfa50; same edit in all four)
- [ ] Observation, not fixed here: after a 413 the Node server keeps reading (and dropping) the rest of the body until the
      client stops; ADR-0068 section 4 (`Connection: close`, bounded drain) is listed as owed for Node.

## Commits
- 76054d9 test(driverless): compile the copied tree with esbuild so the helper runs on Node 24, 25 and 26
- f9818a6 test(backplane): the Redis backplane's log lines never print the password (red)
- 73ef062 fix(security): backplane 'connected' log and graph URL error redact the password
- 4724ae4 test(deps): mysql2, tedious, node-firebird, odbc must be declared optional peers (red)
- b1d6c0e fix(deps): declare mysql2, tedious, node-firebird and odbc as optional peers
- 764e908 docs: npm refuses (ERESOLVE) an untested driver major - measured, not 'warns'
- b7dfa50 test(env-contract): TINA4_TEST_REDIS_AUTH_URL is canonical (REDIS AUTH_URL)
- da9acbd test(body-cap): measure the cap from the socket, not the server's RSS

## Status: In Progress (waiting on the WSDL/mail merge and the lab full suite)

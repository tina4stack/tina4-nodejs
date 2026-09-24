# Identifier allow-list for AutoCrud, ORM find() and DocStore (ADR-0069)

## Outcome

Identifiers that reach SQL come from the model, never from the request. AutoCrud
accepts only declared model fields in filter and sort (400 `UNKNOWN_FIELD`
otherwise), `BaseModel.find(object)` accepts only declared fields as filter keys
(Error otherwise), and the DocStore SQLite fallback validates every field path
segment against `[A-Za-z0-9_-]+` before any SQL is built. The resolved column is
emitted through the bound adapter's dialect quoting (same as the Python master's
`quote_identifier`).

## Scope

- [x] A. AutoCrud list route: every `filter[KEY]` / `filter[KEY][OP]` key and every
      `sort` part resolves against the model's declared fields (property name or its
      mapped column) to the model's DB column; an unknown key returns HTTP 400
      `UNKNOWN_FIELD` before any SQL runs. Any bracket key is captured (a non-`\w`
      key is rejected, not silently ignored). Empty sort parts are skipped. Operator
      allow-list unchanged (now own keys only).
- [x] B. `BaseModel.find(object)`: same resolver; unknown key throws
      `Error("Unknown filter field 'KEY' for model <ModelName>")` before any SQL.
      `where()`, `select()`, `load()`, QueryBuilder and the raw `orderBy` string
      argument are unchanged.
- [x] One resolver (`resolveFieldColumn` in `packages/orm/src/query.ts`) used by
      both AutoCrud and find().
- [x] C. DocStore SQLite fallback: the single path-building chokepoint (`jsonPath`)
      validates every dot segment; covers filter keys at any depth, `$or`/`$and`
      members, operator fields and sort keys.
- [x] `buildQuery()` (public export) takes the resolver as an optional 5th argument;
      with no resolver, any filter or sort key is rejected (secure default).
- [x] Found on the way (separate commit): BaseModel/AutoCrud hard-coded `"name"`
      identifiers, which broke every BaseModel query on MySQL (string literal) and
      Firebird (case-sensitive lower-case name). The adapter now owns identifier
      quoting (`quoteIdentifier`), and the AutoCrud list pages through
      `adapterFetch` (MSSQL/Firebird rejected the literal `LIMIT ? OFFSET ?`).
- [x] D (addendum 2). Wrong-shaped query values on the AutoCrud list are 400
      `INVALID_QUERY_PARAMETER`: `sort[...]`, `filter[KEY][]`, `filter[KEY][x]`,
      nested `filter[KEY][a][b]`; an operator outside the map is now this 400.
- [x] E (addendum 2). AutoCrud routes use the model's named connection
      (`static _db`), as BaseModel.getDb() does, not the global default.
- [x] F (addendum 2). Runner gate: under TINA4_REQUIRE_SERVICES a skip passes only
      with an excusable `[needs:X]` tag (optional engine while its coordinate is
      unset; always-provisioned service never; platform tag always); untagged
      fails; vitest skips counted. Optional-engine skip sites tagged; postgis
      joined the optional-engine map and CI provisions PostGIS.
- [x] G1 (addendum 3). AutoCrud POST/PUT bodies keep only declared fields, by
      property or mapped column, via the same resolver (resolveField).
- [x] G2 (addendum 3). BaseModel save() writes only declared fields - verified,
      locked in on all five engines.
- [x] G3 (addendum 3). Database insert/update/delete (+batch, +filter list) and
      the sqlDialect builders refuse non-identifier keys: "Invalid column name 'KEY'".
      db.delete(table, [filters]) now works on every engine.
- [x] Lock-ins: AutoCrud id routes and fromOrm GraphQL id arguments address one row.
- [x] Found on the way: fromOrm create/update mutations wrote undeclared arguments
      as columns - now declared fields only.
- [x] GraphQL commas are insignificant (spec 2.1.7) - fixed at the tokenizer.

## Parity

| Rule | Python | PHP | Ruby | Node.js |
|------|--------|-----|------|---------|
| AutoCrud filter allow-list (400) | n/a (no filter) | other worker | other worker | ✅ |
| AutoCrud sort allow-list (400)   | n/a (no sort)   | other worker | other worker | ✅ |
| ORM find(filter-map) allow-list  | other worker | other worker | other worker | ✅ |
| DocStore path segment validation | other worker | other worker | other worker | ✅ |
| Adapter-owned identifier quoting | ✅ (master) | not checked | not checked | ✅ |
| Wrong-shaped query value -> 400  | n/a | other worker | other worker | ✅ |
| AutoCrud uses model's connection | n/a | other worker | other worker | ✅ |
| [needs:X] require-services gate  | other worker | other worker | other worker | ✅ |
| AutoCrud write-body allow-list   | n/a | other worker | other worker | ✅ |
| save() writes declared only      | other worker | other worker | other worker | ✅ (lock-in) |
| Write helpers reject bad keys    | other worker | other worker | other worker | ✅ |
| Id route / GraphQL id bound      | n/a | other worker | n/a | ✅ (lock-in) |
| GraphQL commas insignificant     | not checked | not checked | other worker | ✅ |

## Tests (written first, real - no mocks, positive + negative)

File: `test/identifierAllowListContract.test.ts` (auto-discovered by `test/run-all.ts`).

- [x] unknown_filter_field_returns_400 - real startServer + real SQLite; an
      undeclared-but-real column and non-identifier keys -> 400 + exact body
- [x] unknown_sort_field_returns_400 - same for sort, incl. `-undeclared`
- [x] declared_filter_and_sort_still_work - declared field, mapped field by property
      and by column, `-field` DESC, multi-field sort, sort without filter, operator
      filter on a declared field, empty sort parts
- [x] orm_find_rejects_undeclared_filter_key - SQLite, PostgreSQL, MySQL, MSSQL,
      Firebird; negative + positive (declared + mapped field)
- [x] docstore_rejects_unsafe_field_path - filter key, nested `$or`/`$and` key,
      operator field, sort key, count/update/delete -> raises, collection unchanged
- [x] docstore_accepts_safe_field_paths - `a_b`, `a-b`, `A1`, `nested.key`, `_id`
- [x] docstore_safe_paths_match_on_real_mongo - same data + queries, identical
      results on the fallback and a real MongoDB (unique db, dropped after)
- [x] Mutation-proved: each guard disabled -> red, restored -> green

File: `test/ormIdentifierQuoting.test.ts`.

- [x] pure quoting cases (idempotent, dot-aware, expressions untouched, Firebird
      upper-case, MySQL backticks)
- [x] BaseModel save/findById/find/all/count/where/update/delete and AutoCrud
      list/get over a real startServer() on SQLite, PostgreSQL, MySQL, MSSQL, Firebird
- [x] Red on origin/v3 (MySQL + Firebird CRUD, MSSQL + Firebird list); mutation-proved

Addendum 2:

- [x] odd_typed_query_values_return_400 (identifierAllowListContract) - red, green, mutation-proved
- [x] autocrud_list_uses_the_registered_connection (identifierAllowListContract) - two real
      SQLite files; red, green, mutation-proved
- [x] test/serviceGateContract.test.ts - untagged fails, optional engine excused only while
      its coordinate is unset, always-provisioned never, platform tag excused, gate off
      unchanged; mutation-proved (5 mutations)

Addendum 3 and follow-ups:

- [x] autocrud_write_body_accepts_only_declared_fields - red (column-named field not written,
      inherited-name key 500), green, mutation-proved
- [x] orm_save_writes_only_declared_fields - lock-in on 5 engines, mutation-proved
- [x] db_write_helpers_reject_non_identifier_keys - 5 engines, red, green; Database layer and
      builder layer each mutation-proved separately
- [x] autocrud_id_route_addresses_only_that_row, graphql_id_argument_addresses_only_that_row -
      lock-ins (test/idArgumentLockIn.test.ts), mutation-proved
- [x] graphql_orm_mutations_write_only_declared_fields - red, green, mutation-proved
- [x] commas_are_insignificant_between_arguments_and_fields (test/graphqlCommas.test.ts) -
      4/7 red, green, mutation-proved

## Bugs

- [x] AutoCrud filter keys were restricted to `\w+` but not to declared fields, and
      a non-`\w` key was silently ignored; filter keys were used raw (not mapped to
      the DB column).
- [x] AutoCrud sort parts were quoted without validation; an empty part was a 500.
- [x] `BaseModel.find(object)` emitted any object key as a column.
- [x] DocStore fallback quoted non-identifier path segments without validation.
- [x] BaseModel/AutoCrud identifiers broke every query on MySQL and Firebird.
- [x] AutoCrud list used `LIMIT ? OFFSET ?`, rejected by MSSQL and Firebird.
- [ ] Pre-existing, not in this branch: `test/_driverlessTree.ts` launches the
      child with `--experimental-transform-types`, which Node 26.9 rejects
      ("bad option"), so databaseDrivers' driverless cases fail locally on
      origin/v3 too.

- [ ] Pre-existing, environment: cacheMemcachedExptime and sessionTtlUnits fail on the
      local tunnel to the lab memcached (server reports ~65 s less remaining TTL than
      requested - clock offset between this Mac and the memcached host); same on origin/v3.
- [ ] Pre-existing, environment: kafkaIntegration / queueBackends skip (no local
      `tina4-lab-kafka` container for `docker exec`), mqttAuthTls TLS skip (CA file absent
      locally); both old and new gate fail them.
- [ ] Contract note: the gate rule lists TINA4_TEST_POSTGRES_URL as a postgres coordinate,
      but ADR-0038's shared test_env_contract.json makes it non-canonical, so Node's gate
      reads TINA4_TEST_PG_URL only.

## Commits

- 52b57c2  ORM emits identifiers through the adapter's dialect quoting (+ AutoCrud list pages via adapterFetch)
- accf663  AutoCrud and find() accept only declared model fields; DocStore validates field paths
- aac1ecb  AutoCrud list rejects wrong-shaped query values with 400 INVALID_QUERY_PARAMETER
- 7e74a84  AutoCrud queries the connection its model is bound to
- c42d087  Tag optional-engine skips with a machine-readable [needs:X] reason
- 64ea164  Require-services gate fails every skip without an excusable [needs:X] tag
- a04cca4  Plan update
- 3aa9d39  AutoCrud write bodies accept only declared fields, by property or column
- f2c12e2  Lock in: BaseModel save() writes only declared fields
- 70df81d  Database write helpers refuse data and filter keys that are not plain column names
- 4b96310  Gate treats PostGIS as an optional engine; CI provisions it
- 237a82d  Lock in: AutoCrud id routes and ORM GraphQL id arguments address only that row
- 2864863  GraphQL fromOrm mutations write only the model's declared fields
- 2fcc6fa  GraphQL treats commas as insignificant, as the spec requires

## Status: Complete locally (lab verification by the lead); remaining red items above are pre-existing / environmental

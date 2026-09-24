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

## Parity

| Rule | Python | PHP | Ruby | Node.js |
|------|--------|-----|------|---------|
| AutoCrud filter allow-list (400) | n/a (no filter) | other worker | other worker | ✅ |
| AutoCrud sort allow-list (400)   | n/a (no sort)   | other worker | other worker | ✅ |
| ORM find(filter-map) allow-list  | other worker | other worker | other worker | ✅ |
| DocStore path segment validation | other worker | other worker | other worker | ✅ |
| Adapter-owned identifier quoting | ✅ (master) | not checked | not checked | ✅ |

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

## Commits

- (pending)

## Status: In Progress

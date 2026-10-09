# Task: Fix 3 CI failures on PR #125 (feature/crud-html-page)

## Scope
- [x] F1 lazy ceiling: move crud.ts core -> orm; drop core-barrel re-export; export from orm; static-import AutoCrud (no dynamic import). Graph <= 87.
- [x] F1b update importers: crud/crudCsp tests, CLI scaffold import string (-> tina4-nodejs/orm), orm barrel. No circular import (orm->frond acyclic).
- [x] F2 metrics: split crud.ts by concern (kill too_many_functions + large_file); toCrud & buildCustomField CC<=10 -> crud.ts 0 offenders. Extract search+sort(+filter) helpers from query.ts -> buildQuery<=15, parseQueryString<=10, query.ts no regression.
- [x] F3 ReDoS (8): crud extractColumns; mongodb.ts 71,195,211,261,271,285 (pre-existing); sqlTranslator.ts:805 (pre-existing). Rewrite linear/string-ops.

## Tests (real, no mocks)
- [x] npx tsx test/lazyFeatureLoading.test.ts passes (core graph <= 87)
- [x] tina4 metrics --path packages --fail-on-regression : no regression
- [x] crud, crudCsp, autoCrud, autoCrudSearchSort, cliGenerateCrud, generateCrudPluralisation, cli, mongosqlFailClosed, sqlTranslator(+Contract), docstore green
- [x] npm run typecheck exit 0

## Bugs
- (pre-existing ReDoS: mongodb.ts x6, sqlTranslator.ts x1 - fix-on-discovery)

## Commits
- (see commit)

## Status: Complete (local gates green)

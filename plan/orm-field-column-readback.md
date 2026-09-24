# Task: ORM field column read-back (fieldMapping round-trips on every engine)

**Outcome:** parity with tina4-python's fix. Node has no per-field column option;
`static fieldMapping` is the one resolver and already round-trips. Reproducing the scenario on
five real engines exposed that an auto-increment `save()` never worked on MySQL / MSSQL
(RETURNING is a syntax error there) or returned no key on Firebird; fixed.

Depends on `fix/identifier-allow-list`: rebased onto it (its dialect quoting is what makes
the ORM's identifiers valid on MySQL and Firebird at all).

## Scope
- [x] Reproduce on origin/v3 (45 of 80 red) and on fix/identifier-allow-list (39 of 80 red)
- [x] Insert key clause per engine from `getDatabaseType()` (the ORM holds the cache wrapper, whose constructor.name never names the engine): PostgreSQL/Firebird RETURNING, MSSQL OUTPUT INSERTED, SQLite/MySQL lastInsertId
- [x] Firebird adapter `executeAsync` returns the RETURNING rows
- [x] MySQL all-defaults insert (`() VALUES ()`) now actually selected
- [x] Full suite: lab 9670 passed / 0 failed / 4 skipped (all [needs:graph]), typecheck clean; local macOS 9618 passed, 8 env-only failures (driverless probe, MQTT TLS, session fallback, queue timing under load)

## Tests (written first, real, no mocks, positive + negative)
- [x] test/ormFieldColumnReadback.test.ts: 17 cases x 5 engines = 85 green; mutation-proved (7 mutations, all red)

## Bugs
- [x] MySQL / MSSQL: BaseModel.save() on an auto-increment model failed ("near RETURNING")
- [x] Firebird: auto-increment save() left the key unset (execute discarded the RETURNING row)
- [x] MySQL: an all-defaults insert emitted DEFAULT VALUES (constructor.name check never matched)

## Commits
- f625c5d  ORM save() returns the generated key on MySQL, MSSQL and Firebird (on fix/identifier-allow-list, #71)

## Status: Complete

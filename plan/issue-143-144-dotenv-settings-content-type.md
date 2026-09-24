# Task: tina4-python#143 / #144 parity - header Content-Type, settings read when used (Node)

**Outcome:** a Content-Type set with `header()` is the response's one Content-Type
(any name case; an explicit content-type argument still wins), and a setting in
`.env` applies. Governed by `tina4-documentation/plan/v3/decisions/ADR-0072.md`;
the cross-framework plan is `tina4-python/plan/issue-143-144-dotenv-settings-content-type.md`.

## Scope
- [x] Reproduce #144 and #143 for real on origin/v3 (Node)
- [x] Scan for settings read at load time
- [x] response(data) keeps a header()-set Content-Type for string and object bodies (buffers already did)
- [x] maxUploadSize() reads TINA4_MAX_UPLOAD_SIZE per request; a bad value warns once and uses the default (was NaN = no cap)
- [x] health path already honoured: locked in
- [x] Regression suite `test/dotenvSettingsAndContentType.test.ts`, red first, mutation-proved
- [x] Full suite on the lab (Linux, Node 24.18.0, sudo -E, TINA4_REQUIRE_SERVICES=1) at 4c518bb: 9338 passed, 1 failed, 0 skipped; typecheck 0.
      The one failure, firebirdRollback "Update conflicts with concurrent update", came from another worker on the shared Firebird: 7/7 green twice in isolation.
      An earlier parallel run's flakes (Mongo queue reclaim, MySQL provider table dropped by another worker) were each green in isolation and on pristine v3

## Tests (real server booted from a project whose .env carries the settings, no mocks)
- [x] header content type replaces the detected type
- [x] a lowercase content type header is the same header
- [x] header content type survives a string body
- [x] an explicit content type argument wins over the header
- [x] without a header the detected type is used (negative)
- [x] max upload size from dotenv is enforced
- [x] a body under the dotenv limit is accepted (negative)
- [x] health path from dotenv is served
- [x] max upload size follows the environment
- [x] a bad max upload size falls back to the default

## Commits
- 4c518bb  fix: header Content-Type survives response(data); upload cap read when used

## Status: Complete (PR open, not merged)

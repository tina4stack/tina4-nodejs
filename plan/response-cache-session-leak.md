# Task: ResponseCache session-leak fix (port of Python #117)

Outcome: Node's `responseCache` no longer stores/replays a session-scoped
response to another caller. Port of tina4-python #117 for parity.

## Scope
- [x] Read Python reference (350777a `tina4_python/cache/__init__.py` `_may_store`) + its tests
- [x] Read Node target (`packages/core/src/cache.ts` `mayStore` / `varyFields` / `SHARED_CACHE_DIRECTIVES`)
- [x] Port decision: add `cacheControlTokens`, honour no-store/private/no-cache, gate Cookie + Set-Cookie
- [x] Add regression tests to `test/cacheRfc9111.test.ts` (mutation-proven gates)
- [x] Run cache suite green + typecheck

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| Cookie/Set-Cookie/no-store store-guard | ✅ (#117) | — | — | ✅ |

(PHP/Ruby tracked separately; this task is the Node port for parity with the shipped Python fix.)

## The bug
`mayStore` guarded only Vary `*` and Authorization. A GET carrying a Cookie
(Tina4 sessions ARE a cookie) with no Authorization fell through to `return true`,
so a signed-in user's body was stored keyed on method+URL and replayed to the
next caller (X-Cache: HIT, handler never runs). No way to opt out either:
no-store/private/no-cache were ignored.

## The fix (cache.ts)
`mayStore` now, in order: Vary `*` -> false; response Cache-Control tokens
intersect {no-store, private, no-cache} -> false; Authorization present ->
sharedCacheAllowed; Cookie request header present -> sharedCacheAllowed;
Set-Cookie response header present -> sharedCacheAllowed; else true.
New `cacheControlTokens(raw): Set<string>` parses comma-separated directive
names, stripping `=value`, so `no-cache="Set-Cookie"` counts as `no-cache`.
`sharedCacheAllowed(cacheControl)` reuses it against `SHARED_CACHE_DIRECTIVES`.

## Tests (written real — real middleware + real in-memory backend, no mocks)
- [x] a response that sets Set-Cookie is not replayed to another session (MISS, handler runs)
- [x] one session's response is not replayed to another cookie/anon caller
- [x] responses marked private / no-store / no-cache are not cached
- [x] no-cache="Set-Cookie" read as a token not a substring
- [x] CONTROL: cookie-bearing request marked public still hits the cache
- [x] CONTROL: cookieless public traffic still hits the cache (X-Cache: HIT)
Each mutation-proven: reverted `mayStore` to old body, saw the new tests go red, restored.

## Bugs
- [x] Session response replay via ResponseCache (fixed; regression tests green)

## Bugs (discovered)
- [x] Test doubles in `test/cache.test.ts` (20 sites) and `test/router.test.ts`
  (2 sites) had a lying `getHeader` (`VAR[n] || "application/json"`) that returned
  a content-type for EVERY header name, including Set-Cookie. Harmless while
  `mayStore` only read Cache-Control; once it reads Set-Cookie the fake made every
  response look session-installing, turning 17 HITs into MISSes. Fixed the doubles
  to return the content-type fallback ONLY for content-type (matching real
  `ServerResponse.getHeader` and the `cacheRfc9111.test.ts` harness). Assertions
  unchanged; both suites restored to baseline (73/0, 80/0).

## Commits
- (hash  fix(cache): stop ResponseCache replaying one session's response to another)

## Status: Complete

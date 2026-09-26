# Task: Medium security findings (Sept 2026 audit) — fix/medium-security

Outcome: verify each Sept-2026 Medium finding against **current v3** (not the audit's stale
line numbers), fix the ones genuinely still present, red-first + mutation-proved with real
services on the lab, at parity across Python/PHP/Ruby/Node, one PR per repo against v3.

## Scope (Node)
- [x] Verify all findings against origin/v3 HEAD (audit targeted stale heads)
- [x] F1 WSDL ReDoS — ALREADY FIXED on v3 (7eef555 replaced regex XML parsing with a DOM parser; no `new RegExp(tag)` remains). No action.
- [x] F5 Api host confusion / token leak — present; fix (same-origin auth/cookie gate)
- [x] F6 X-Forwarded-Host trusted without a trusted-proxy check — present; fix (gate on isTrustedProxy)
- [ ] F2 GraphQL fan-out (node-count/alias/complexity limit; depth-only today) — needs ADR
- [ ] Lab: full suite green at HEAD, TINA4_REQUIRE_SERVICES=1, 0 failed / 0 skipped
- [ ] PR against v3

## Parity (current v3 state — verified)
| Finding | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| F1 WSDL ReDoS | n/a | n/a | n/a | ✅ already fixed |
| F2 GraphQL fan-out | present | present (+parser OOM) | present (+SystemStackError) | present (depth-only) |
| F3 trailing-slash redirect | present | present | confirm | ✅ not-affected (matches routes only) |
| F4 GraphQL CSRF | check | present | present (GET mutations) | n/a |
| F5 api token leak | present | present | present | ✅ fixed |
| F6 X-Forwarded-Host | present | present | present | ✅ fixed |

## Tests (written first, real — no mocks, positive + negative; proven RED before fix)
- [x] test/forwardedHostTrust.test.ts — untrusted peer: XFH/XFP ignored for request.url (RED→GREEN); trusted peer: honoured (positive)
- [x] test/apiCrossOriginToken.test.ts — absolute off-origin path drops the token (RED→GREEN); same-origin keeps it (positive)

## Bugs
- [x] F6 request.ts:60 honoured X-Forwarded-Host/Proto from any peer → forged absolute request.url
- [x] F5 api.ts buildRequest attached Authorization/Cookie to an absolute off-origin request target

## Commits
- (pending push)

## Status: In Progress

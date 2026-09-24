# Task: ADR-0068 response-header refusal - Node regression tests + contract runner

**Outcome:** prove with real-server tests that a header, redirect or cookie carrying
CR, LF or NUL cannot reach the wire from tina4-nodejs; close what the proof found
(cookie attribute `;` injection, ADR wording for broken names); add the Node runner
for the http_hardening contract fixture.

Governing decision: `tina4-documentation/plan/v3/decisions/ADR-0068.md`
Fixture: `tina4-documentation/plan/v3/fixtures/http_hardening_contract.json`

## Scope
- [x] Measure Node against every fixture case on a real server (2026-09-24, macOS, Node 26.9)
- [x] Runner `test/httpHardeningContract.test.ts` (real ServerResponse + real Tina4 child server, raw sockets)
- [x] Red on v3 HEAD d89998c: 3 of 11 cases
- [x] response.ts: every header set goes through one check with the exact ADR-0068 wording
- [x] response.ts: cookie attribute values refuse CR, LF, NUL and `;` (name/value keep being percent-encoded)
- [x] redirect() checks the location before changing the status
- [x] Browser-open gate (ADR-0070): dev only, TINA4_NO_BROWSER truthy, --no-browser / noBrowser, CI (false set false/0/no/off; CI plus documented extra vetoes), TINA4_PRODUCTION and cluster workers never open
- [x] Runner test/browserOpenContract.test.ts for browser_open_contract.json (42 cases) + real-boot test/browserOpenGate.test.ts (9 cases)
- [x] Full suite + typecheck on the lab at 731af84 (Linux, Node 24.18, TINA4_REQUIRE_SERVICES=1): 9296 passed, 0 failed, 4 skipped (graph-live: Ultipa/Neo4j/Memgraph/Arango not provisioned on the lab); typecheck clean

## Parity (Node)
| ADR-0068 invariant                     | Node |
|----------------------------------------|------|
| response-header-refuses-crlf-nul       | ✅ carried in full |
| cookie-refuses-injection               | ✅ carried in full |
| builtin-server-refuses-unsafe-header   | ✅ node:http refuses natively; transport.ts turns it into the fixture's 500 JSON (maintainer decision: parity wins) |
| builtin-server-body-cap-before-read    | ✅ all 5 cases (memory measured as bytes read, server-side and client-side) |
| builtin-server-malformed-framing       | ✅ transport.ts (clientError mapping, headersTimeout + body idle watchdog, maxHeaderSize) |
| transport-rejection-shape              | ✅ one shape for 400/408/413/431/500 |

## Bugs
- [x] cookie({ path }) with `;` added attributes (`Set-Cookie: pref=v; Path=/a; Domain=evil.com`)
- [x] Broken header names quoted raw (CR/LF in the message and log line) instead of the ADR JSON literal
- [x] redirect() set 302 before the header was refused
- [x] 400s carried no body or security headers (node:http's default clientError answer)
- [x] TINA4_MAX_REQUEST_HEADER (431) and TINA4_REQUEST_TIMEOUT (408) were not read
- [x] A refused upload stayed open and was read to the end (64MB read per client after a 413; RSS +44MB for six)
- [x] A header set on the raw response past the call-site check answered the route error page, not the fixture's 500 JSON
- [x] TINA4_MAX_UPLOAD_SIZE in .env was ignored (read at import, before .env loads); a non-numeric value disabled the cap (NaN)
- [x] Two agreeing Content-Length headers: maintainer ruling - refused (400) in all four; Node already did (llhttp), PHP fixed on tina4-php#217

## Commits
- 226c817  test(response): refuse CR/LF in response headers - ADR-0068 regression tests
- b539e15  fix(server): open a browser only for a development boot
- 731af84  fix(server): browser gate follows ADR-0070; runner for browser_open_contract
- 215611a  test(server): browser-open runner follows the final ADR-0070 fixture
- 05a9ee4  fix(server): ADR-0068 transport limits and rejection shape for node:http
- 856890a  Merge origin/v3
- decf858  refactor(core): fold the request limits into request.ts; core graph ceiling 81

- [x] lazyFeatureLoading ceiling: transport.ts took the core barrel graph to 81 (limits folded into request.ts; ceiling raised with the measurement)

## Verification
- Lab (Linux, Node 24.18, TINA4_REQUIRE_SERVICES=1) at decf858: npm test 9404 passed, 0 failed, 4 skipped (graph-live, not provisioned); typecheck clean

## Status: Complete

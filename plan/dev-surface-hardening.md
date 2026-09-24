# Task: Dev-surface hardening (ADR-0078)

**Outcome:** every /__dev request, the MCP endpoints and the dev reload socket pass one gate
(loopback or TINA4_HOST Host, same-origin only, loopback peer or TINA4_MCP_TOKEN); dev file
paths are resolved before the secret check; health hides the version outside debug.

## Scope
- [x] Resolve dev file paths (realpath + trailing-separator root check) before the secret denylist
- [x] Gate GET /__dev/api/* reads like writes
- [x] Host allow-list on /__dev, MCP and /__dev_reload; Sec-Fetch-Site same-site refused
- [x] metrics/file containment
- [x] TINA4_API_KEY no longer unlocks the dev surface or MCP
- [x] /__dev/api/table validates the name against real tables and quotes it
- [x] Template auto-routing refuses `.`/`..` segments
- [x] /health omits `version` outside debug (ADR-0078 supersedes the ADR-0016 key set)
- [x] Python-only register() fix is not applicable here (n/a)


## Tests (real ASGI dispatch, no mocks, mutation-proved)
- [x] test/devSurfaceContract.test.ts (fixture devsurface_contract.json)

## Commits
- (see PR)

## Status: In Review

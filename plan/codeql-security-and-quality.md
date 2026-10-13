# Task: Clear tina4-nodejs CodeQL alerts + remaining quality offenders

Outcome: tina4-nodejs has **0 open CodeQL alerts** (13 → 0) and its error-severity
`tina4 metrics` offenders decomposed, verified by the local `tina4 codeql` pre-check
and `tina4 metrics`, green on CI. **Node.js only this session** (parity to py/php/ruby
is OWED and noted, not done here).

## Scope
### Vulnerability — CodeQL (13 open alerts, all in packages/core/src)
- [ ] `js/remote-property-injection` ×11 in `request.ts` (88,101,127,357,359,524,529,564,565,582,589)
      — code is already runtime-safe (isUnsafeFieldName guard + Object.create(null) form
      containers); CodeQL does not model the helper/null-proto as a barrier. Make the
      sanitizer CodeQL-legible (genuine defense-in-depth), not a suppression.
- [ ] `js/indirect-command-line-injection` ×1 `server.ts:408` (openBrowser execFile on env host/port)
- [ ] `js/shell-command-constructed-from-input` ×1 `server.ts:2463` (openBrowser call site)
- [ ] Regression tests: property-injection rejected on query/cookies/files/nested-form (real HTTP, no mocks)
- [ ] Local `tina4 codeql` (javascript-security-extended) = clean

### Quality — tina4 metrics error offenders (396 offenders / 482 dup)
- [~] placeholderPositions CC27 + MIME dedupe — DONE in open PR #148 (quality/node-batch, green)
- [ ] `core/src/wsdl.ts` low-maintainability 11.8 + `parseXmlDocument` CC29
- [ ] `core/src/devAdmin.ts` handleSeed CC31, proxyToSupervisor CC25, handleFiles CC23
- [ ] re-baseline `.tina4-metrics.json` DOWN, commit with code; `--fail-on-regression` passes

## Parity
| Item | Python | PHP | Ruby | Node |
|------|--------|-----|------|------|
| property-injection legibility | OWED | OWED | OWED | 🔨 |
| command-injection legibility  | OWED | OWED | OWED | 🔨 |
| quality decomposition         | n/a  | n/a | OWED | 🔨 |

## Tests (real, no mocks, positive + negative)
- [ ] POST form with `__proto__[x]`, `constructor`, `prototype` keys → never pollutes Object.prototype
- [ ] query `?__proto__=x` / cookie `__proto__=x` → dropped, prototype intact
- [ ] nested form `a[__proto__][b]=c` → dropped, prototype intact

## Bugs
- (none yet)

## Commits
- (log hash + description here)

## Status: In Progress

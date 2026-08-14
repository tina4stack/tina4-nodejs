# Node AI skill-download retry status

## Outcome

Node retries transport failures and transient HTTP responses, but treats permanent
4xx responses as final answers, matching Python, PHP, and Ruby.

## Scope

- [x] Measure the existing Node retry behavior.
- [x] Compare the retryable status set with Python, PHP, and Ruby.
- [x] Change the real-socket negative test first and prove it fails.
- [x] Retry only transport failures and HTTP 429/500/502/503/504.
- [x] Re-run the focused real-socket test and TypeScript typecheck.

## Parity

| Rule | Python | PHP | Ruby | Node.js |
|---|---|---|---|---|
| Transient status retries | ✅ | ✅ | ✅ | ✅ |
| Permanent 4xx fails fast | ✅ | ✅ | ✅ | ✅ |

## Tests

- [x] 503 then 200 performs two requests and writes the fetched body.
- [x] Persistent 404 performs one request and writes no file.
- [x] Focused real-socket suite: 8 passed, 0 failed.
- [x] `npm run typecheck`: passed.

## Bugs

- [x] Node retried every permanent HTTP failure once.

## Commits

- This change: status-aware Node skill-download retry.

## Status: Complete

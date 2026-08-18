# Task: Safer production rate-limit defaults

**Outcome:** A normal browser application can load and poll through Tina4 without exhausting the
default limiter, while explicit low limits and trusted-proxy client isolation continue to work.

## Scope
- [x] Raise the default per-minute request allowance to 1,000
- [x] Keep explicit `TINA4_RATE_LIMIT` authoritative

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| lenient default | — | — | — | ✅ |

## Tests (written first, real — no mocks)
- [x] Default permits representative browser traffic above 100 requests/minute
- [x] Explicit configured limit still returns 429 at the configured boundary

## Bugs
- [x] The 100/minute default can blank asset-backed pages and reject ordinary app actions

## Commits
- this commit — raise the Tina4 Node default while preserving explicit limits

## Status: Complete

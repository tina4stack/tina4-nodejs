# Task: ServiceRunner.stop() ignores class-based instances (port of Python #118)

Outcome: Node `ServiceRunner.stop()` calls `Tina4Service.stop()` on every
stashed instance, so `shouldStop()` flips and the daemon loop exits. Port of
tina4-python #118 (`7a3608b`).

## Scope
- [x] Read Python reference (`tina4_python/service/__init__.py:352-376`) + `test_service.py`
- [x] Read Node target (`packages/core/src/service.ts` `registerService` / `stop`)
- [x] Regression tests in `test/service.test.ts` (red on stock, green on fix)
- [x] Call `instance.stop()` in `ServiceRunner.stop()`, swallow + log like Python
- [x] Service suite green — `npx tsx test/service.test.ts` 56 passed, 0 failed, 0 skipped (Linux, Node local)

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| `stop()` routes to class instance | ✅ (#118) | ❌ | ❌ | ✅ (local branch) |

## Tests (written first, real — no mocks)
- [x] class-based `while (!this.shouldStop())` loop freezes after `ServiceRunner.stop()`
- [x] `run()` exits after `ServiceRunner.stop()`
- [x] raising `instance.stop()` does not throw out of `ServiceRunner.stop()` and does not skip a sibling
- [x] plain callable still stops via `ctx.running` (existing daemon test)

## Bugs
- [x] `f-svc-01` Node: `registerService` stashed `instance`, `stop()` never called it

## Commits
- (uncommitted on `fix/service-runner-stop-ignores-instance`)

## Status: Complete (local, not filed)

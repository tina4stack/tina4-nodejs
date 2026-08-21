# Task: Graph data layer (Feature 139) — Node/TypeScript port

Outcome: a URL-selected graph data layer shaped exactly like the relational
`Database` layer — `GraphDatabase.create(url)` / `.fromEnv()`, a common
`GraphAdapter` surface, neutral `GraphNode`/`GraphEdge`/`GraphResult` shapes, and
an Ultipa adapter over the `tina4-ultipa` driver (optional, lazily imported). Ported
from the PROVEN Python reference (`tina4-python/tina4_python/graph/`), idiomatic TS
(camelCase, ESM, async surface). Verified no-mock against the live lab Ultipa.

## Scope
- [x] Read the Python reference (graph_url, __init__ shapes, adapter, adapters/ultipa) + test_graph.py + ADR-0059 / feature 139 / graph_contract.json
- [x] Read the ultipa-node driver source for the exact API (fromUrl/connect/query/execute, UltipaResult, UltipaError/UltipaConnectError)
- [x] `packages/orm/src/graph/graphUrl.ts` — scheme→engine, default ports (60061/7687/8529), TLS, creds, fromEnv
- [x] `packages/orm/src/graph/shapes.ts` — GraphNode/GraphEdge/GraphResult
- [x] `packages/orm/src/graph/errors.ts` — GraphError, GraphConnectTimeout
- [x] `packages/orm/src/graph/connectTimeout.ts` — TINA4_GRAPH_CONNECT_TIMEOUT resolver (default 10, <=0 unbounded)
- [x] `packages/orm/src/graph/graphAdapter.ts` — GraphAdapter interface + option types
- [x] `packages/orm/src/graph/graphDatabase.ts` — factory, lazy dynamic-import driver, actionable install error
- [x] `packages/orm/src/graph/adapters/ultipa.ts` — UltipaGraphAdapter (GQL core over tina4-ultipa)
- [x] Export graph core through the `@tina4/orm` barrel (NOT the driver-bound adapter — zero-dep core rule)
- [x] Declare `tina4-ultipa` as an optionalDependency of `@tina4/orm` (parity with pg/mysql2/…)
- [x] `test/graph.test.ts` — 11 contract cases, no mocks, live-gated on TINA4_TEST_ULTIPA_URL

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| graph data layer (Feature 139, Ultipa) | ✅ | ❌ BUILD | ❌ BUILD | ✅ |

## Tests (written first, real — no mocks, positive + negative). Lab: live Ultipa `ultipa://…@192.168.88.99:60071/default`, EDGE_ID enabled.
- [x] graph-connect-by-url (scheme→adapter; unknown scheme rejected)
- [x] graph-add-node
- [x] graph-add-edge
- [x] graph-get-node (round-trip + miss→null)
- [x] graph-update-delete-node (merge + remove, verified by re-read)
- [x] graph-neighbors (direction/edge-type; unmatched→empty)
- [x] graph-traverse-depth (GQL quantified path {1,N})
- [x] graph-raw-query (bound params)
- [x] graph-write-fails-loud (execute bad GQL throws GraphError, getError() set)
- [x] graph-driver-optional (core imports driver-free; missing driver → actionable install error, simulated absence)
- [x] graph-connect-timeout (10.255.255.1:60071 → GraphConnectTimeout < 2s, names host/port)

Lab result (2026-08-21, live Ultipa, tina4-ultipa@0.1.0 installed): **18 passed, 0 failed, 0 skipped**
(11 cases; several carry positive+negative assertions). `tsc -p tsconfig.typecheck.json` exit 0.

## Bugs
- (none)

## Notes / deltas vs Python
- Node surface is ASYNC (the tina4-ultipa driver is gRPC/async): every adapter method + `GraphDatabase.create`/`fromEnv` returns a Promise. Python is sync.
- "Unbounded" connect (<=0) passes a far-future finite deadline (~10y) to the driver, because the gRPC `waitForReady` deadline reads 0 as an instant, already-past deadline (Python's driver treats 0 as unbounded).
- Driver-optional is proven by a deterministic monkeypatch of the exported `ENGINE_ADAPTERS` registry (mirrors Python swapping `_ENGINE_ADAPTERS["ultipa"]`), so the assertion holds whether or not the real driver is installed.
- `tina4-ultipa` added to `@tina4/orm` optionalDependencies. package-lock.json intentionally NOT touched (hand-maintained) — needs a maintainer regen to include it.

## Status: Complete (Node). PHP/Ruby still owed for full Feature-139 parity.

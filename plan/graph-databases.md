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

## Scope — Bolt (Neo4j/Memgraph) + ArangoDB adapters (2026-08-21)
- [x] Read the PROVEN Python reference (adapters/bolt.py, adapters/arango.py) + parametrised tests/test_graph.py
- [x] `packages/orm/src/graph/adapters/bolt.ts` — BoltGraphAdapter (Cypher over neo4j-driver; Neo4j AND Memgraph)
- [x] `packages/orm/src/graph/adapters/arango.ts` — ArangoGraphAdapter (AQL over arangojs; lazy collection ensure)
- [x] Register engine `bolt` → BoltGraphAdapter, engine `arango` → ArangoGraphAdapter in ENGINE_ADAPTERS
- [x] Declare `neo4j-driver` + `arangojs` as optionalDependencies of `@tina4/orm`
- [x] Rewrite `test/graph.test.ts` to the PROVIDER MATRIX — parametrised over every engine whose TINA4_TEST_<ENGINE>_URL is set (ultipa/neo4j/memgraph/arango), per-engine raw dialect + cleanup, same 11 case names
- [x] Lab-proven no-mock against live Neo4j + Memgraph + ArangoDB; tsc typecheck exit 0

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| graph data layer (Feature 139, Ultipa) | ✅ | ❌ BUILD | ❌ BUILD | ✅ |
| graph — Bolt (Neo4j/Memgraph) | ✅ | ❌ BUILD | ❌ BUILD | ✅ |
| graph — ArangoDB | ✅ | ❌ BUILD | ❌ BUILD | ✅ |

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

### Bolt + Arango matrix run (2026-08-21, lab 192.168.88.99)
Drivers on lab work checkout (`npm i --no-save`): neo4j-driver@6.2.0, arangojs@10.4.0, tina4-ultipa@0.1.0.
Engines: Neo4j `bolt://…@:7687`, Memgraph `bolt://:7688` (no auth), ArangoDB `arango://root@:8529/_system`.

| Engine | Live cases | Result |
|--------|-----------|--------|
| Neo4j    | 11 (12 assertions) | ✅ all pass |
| Memgraph | 11 (12 assertions) | ✅ all pass |
| ArangoDB | 11 (12 assertions) | ✅ all pass |
| Ultipa   | — | SKIP (no TINA4_TEST_ULTIPA_URL for this run; proven separately above) |

Full run: **44 passed, 0 failed, 1 skipped** (the skip is ultipa-live, env-gated).
`tsc -p tsconfig.typecheck.json` exit 0.

### Deltas vs the Python reference (Bolt/Arango)
- Bolt driver configured with `disableLosslessIntegers: true` so `id(n)` + integer
  props return native JS numbers (Python's neo4j driver returns ints natively). The
  neutral GraphNode.id is a string, so a Cypher `WHERE id(n) = $id` is fed
  `Number(id)` back (a non-numeric id → -1, matches nothing → clean null miss).
- neo4j-driver is imported via `(await import(pkg)).default ?? mod` (CJS/ESM interop);
  the Cypher statements are byte-for-byte the Python master's.
- Arango collections are ensured LAZILY on first query (Node adapter constructor is
  sync and the driver opens no socket in it), vs Python ensuring them in `__init__`.
  Raw AQL is passed as `db.query({ query, bindVars })` per arangojs.
- `neo4j-driver` + `arangojs` added to `@tina4/orm` optionalDependencies.
  package-lock.json intentionally NOT touched (maintainer regenerates it).

## Bugs
- (none)

## Notes / deltas vs Python
- Node surface is ASYNC (the tina4-ultipa driver is gRPC/async): every adapter method + `GraphDatabase.create`/`fromEnv` returns a Promise. Python is sync.
- "Unbounded" connect (<=0) passes a far-future finite deadline (~10y) to the driver, because the gRPC `waitForReady` deadline reads 0 as an instant, already-past deadline (Python's driver treats 0 as unbounded).
- Driver-optional is proven by a deterministic monkeypatch of the exported `ENGINE_ADAPTERS` registry (mirrors Python swapping `_ENGINE_ADAPTERS["ultipa"]`), so the assertion holds whether or not the real driver is installed.
- `tina4-ultipa` added to `@tina4/orm` optionalDependencies. package-lock.json intentionally NOT touched (hand-maintained) — needs a maintainer regen to include it.

## Status: Complete (Node — Ultipa + Bolt/Neo4j/Memgraph + ArangoDB). PHP/Ruby still owed for full Feature-139 parity.

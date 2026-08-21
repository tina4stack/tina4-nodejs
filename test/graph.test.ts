/**
 * Contract suite for the graph data layer (Feature 139) — against REAL engines.
 *
 * No mocks. Every live case runs a real connection and real round-trips, and is
 * PARAMETERISED over every provisioned engine (provider substitutability, exactly
 * like the relational engine matrix): Ultipa, Neo4j, Memgraph, ArangoDB. Each
 * engine's URL comes from its own TINA4_TEST_<ENGINE>_URL; an engine whose URL is
 * unset / unreachable / whose driver is absent is skipped. Case names match
 * tina4-documentation/plan/v3/fixtures/graph_contract.json.
 *
 * Only the raw-query dialect and the cleanup differ per engine (GQL vs Cypher vs
 * AQL) — the portable node/edge/traverse surface is identical everywhere, which is
 * the whole point of the layer.
 *
 * Notes per engine:
 * - Ultipa: edge ids need EDGE_ID enabled on the graph
 *   (`ALTER GRAPH <g> SET EDGE_ID ENABLED`) — a one-time per-graph setting the lab
 *   provisions.
 * - Bolt (Neo4j/Memgraph): `id(n)` is an integer; the driver runs with
 *   disableLosslessIntegers so it comes back as a native number.
 */
import net from "node:net";

import {
  GraphDatabase,
  GraphUrl,
  GraphNode,
  GraphEdge,
  GraphResult,
  GraphError,
  GraphConnectTimeout,
} from "../packages/orm/src/index.ts";
import { ENGINE_ADAPTERS } from "../packages/orm/src/graph/graphDatabase.ts";
import type { GraphAdapter } from "../packages/orm/src/index.ts";

// Unique per run so concurrent runs never collide; cleaned before AND after.
const LABEL = `T4GraphContractTest_${Date.now().toString(36)}`;

const CYPHER_RAW = `MATCH (n:\`${LABEL}\`) WHERE n.name = $nm RETURN n.name AS name`;
const CYPHER_CLEAN = `MATCH (n:\`${LABEL}\`) DETACH DELETE n`;

interface EngineConfig {
  env: string;
  driver: string;
  adapterClass: string;
  raw: string;
  rawParams: Record<string, unknown>;
  clean: string;
}

// Per engine: URL env var, driver npm package, expected adapter class, the raw
// read (native dialect) that finds a node by name, and the cleanup statement.
const ENGINES: Record<string, EngineConfig> = {
  ultipa: {
    env: "TINA4_TEST_ULTIPA_URL",
    driver: "tina4-ultipa",
    adapterClass: "UltipaGraphAdapter",
    raw: CYPHER_RAW,
    rawParams: { nm: "Bob" },
    clean: CYPHER_CLEAN,
  },
  neo4j: {
    env: "TINA4_TEST_NEO4J_URL",
    driver: "neo4j-driver",
    adapterClass: "BoltGraphAdapter",
    raw: CYPHER_RAW,
    rawParams: { nm: "Bob" },
    clean: CYPHER_CLEAN,
  },
  memgraph: {
    env: "TINA4_TEST_MEMGRAPH_URL",
    driver: "neo4j-driver",
    adapterClass: "BoltGraphAdapter",
    raw: CYPHER_RAW,
    rawParams: { nm: "Bob" },
    clean: CYPHER_CLEAN,
  },
  arango: {
    env: "TINA4_TEST_ARANGO_URL",
    driver: "arangojs",
    adapterClass: "ArangoGraphAdapter",
    raw: "FOR n IN tina4_nodes FILTER n.name == @nm RETURN {name: n.name}",
    rawParams: { nm: "Bob" },
    clean: `FOR n IN tina4_nodes FILTER '${LABEL}' IN n._labels REMOVE n IN tina4_nodes`,
  },
};

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, why: string): void {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${why}`);
}

async function reachable(url: string): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = u.port ? parseInt(u.port, 10) : 0;
  } catch {
    return false;
  }
  if (!port) return false;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function driverInstalled(pkg: string): Promise<boolean> {
  try {
    // Variable specifier: keep tsc/tsx from resolving an optional package that is
    // only present when the engine is used.
    const specifier = pkg;
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

// ── driver-optional + connect-by-url run WITHOUT a live engine ───────────────

// graph-connect-by-url: a URL scheme selects the right adapter; unknown rejected.
function testConnectByUrl(): void {
  ok(
    "graph-connect-by-url: ultipa scheme selects the ultipa engine",
    new GraphUrl("ultipa://h:60061/g").engine === "ultipa",
  );
  ok(
    "graph-connect-by-url: neo4j scheme selects the bolt engine",
    new GraphUrl("neo4j://h/db").engine === "bolt",
  );
  ok(
    "graph-connect-by-url: memgraph scheme selects the bolt engine",
    new GraphUrl("memgraph://h/db").engine === "bolt",
  );
  ok(
    "graph-connect-by-url: arango scheme selects the arango engine",
    new GraphUrl("arango://h/db").engine === "arango",
  );
  let rejected = false;
  try {
    new GraphUrl("mysql://h/db");
  } catch {
    rejected = true;
  }
  ok("graph-connect-by-url: an unsupported scheme is rejected", rejected);
}

// graph-driver-optional: the core imports with NO engine driver, and a missing
// driver raises an actionable install error naming the package + command.
async function testDriverOptional(): Promise<void> {
  ok(
    "graph-driver-optional: the graph core imports driver-free",
    typeof GraphDatabase === "function"
      && typeof GraphUrl === "function"
      && typeof GraphNode === "function"
      && typeof GraphEdge === "function"
      && typeof GraphResult === "function",
  );

  // Simulate absence exactly like the Python master swaps _ENGINE_ADAPTERS:
  // point the ultipa loader at a module that cannot resolve, so the assertion
  // holds whether or not the real driver is installed (no skip on the lab).
  const saved = ENGINE_ADAPTERS.ultipa;
  ENGINE_ADAPTERS.ultipa = {
    load: () => import("./_graph_absent_driver_probe.js"),
    className: "X",
    package: "tina4-ultipa",
    installCommand: "npm install tina4-ultipa",
  };
  try {
    await GraphDatabase.create("ultipa://h:60061/g");
    ok("graph-driver-optional: a missing driver raises an actionable install error", false, "no throw");
  } catch (err) {
    const message = (err as Error).message ?? "";
    ok(
      "graph-driver-optional: a missing driver raises an actionable install error",
      err instanceof GraphError && /tina4-ultipa/.test(message) && /install/i.test(message),
      message,
    );
  } finally {
    ENGINE_ADAPTERS.ultipa = saved;
  }
}

// graph-connect-timeout: an unreachable host throws GraphConnectTimeout within the
// bound, naming host and port. Needs the ultipa driver (constructs the client) but
// no live engine (10.255.255.1 is a black hole — a handshake that never completes).
async function testConnectTimeout(hasUltipaDriver: boolean): Promise<void> {
  const name = "graph-connect-timeout: an unreachable host times out within the bound, naming host and port";
  if (!hasUltipaDriver) {
    skip(name, "tina4-ultipa package absent (needed to construct the client)");
    return;
  }
  const savedEnv = process.env.TINA4_GRAPH_CONNECT_TIMEOUT;
  process.env.TINA4_GRAPH_CONNECT_TIMEOUT = "2";
  const started = Date.now();
  try {
    const adapter = await GraphDatabase.create("ultipa://admin:x@10.255.255.1:60071/default");
    await adapter.getNode("x");
    ok(name, false, "no throw");
  } catch (err) {
    const elapsed = (Date.now() - started) / 1000;
    const message = (err as Error).message ?? "";
    ok(
      name,
      err instanceof GraphConnectTimeout
        && elapsed < 6
        && message.includes("10.255.255.1")
        && message.includes("60071"),
      `elapsed=${elapsed.toFixed(2)}s type=${(err as Error).name} msg=${message}`,
    );
  } finally {
    if (savedEnv === undefined) delete process.env.TINA4_GRAPH_CONNECT_TIMEOUT;
    else process.env.TINA4_GRAPH_CONNECT_TIMEOUT = savedEnv;
  }
}

// ── the portable core + raw pass-through, per LIVE engine ────────────────────

async function runLive(engine: string, cfg: EngineConfig, graph: GraphAdapter): Promise<void> {
  const tag = `[${engine}] `;
  const clean = () => graph.execute(cfg.clean);

  // graph-connect-by-url (live): the factory returns the right connected adapter.
  ok(
    `${tag}graph-connect-by-url: create() returns a live ${cfg.adapterClass}`,
    graph.constructor.name === cfg.adapterClass,
    graph.constructor.name,
  );

  // graph-add-node
  {
    await clean();
    const node = await graph.addNode(LABEL, { name: "Ada", age: 36 });
    ok(
      `${tag}graph-add-node: addNode returns a node with an id, labels and properties`,
      node instanceof GraphNode
        && !!node.id
        && node.labels.includes(LABEL)
        && node.properties.name === "Ada"
        && Number(node.properties.age) === 36,
      JSON.stringify(node?.toDict()),
    );
  }

  // graph-add-edge
  {
    await clean();
    const a = await graph.addNode(LABEL, { name: "Ada" });
    const b = await graph.addNode(LABEL, { name: "Bob" });
    const edge = await graph.addEdge(a!.id, b!.id, "KNOWS", { since: 2020 });
    ok(
      `${tag}graph-add-edge: addEdge links two nodes with a type and properties`,
      edge instanceof GraphEdge
        && !!edge.id
        && edge.type === "KNOWS"
        && edge.from === a!.id
        && edge.to === b!.id
        && Number(edge.properties.since) === 2020,
      JSON.stringify(edge?.toDict()),
    );
  }

  // graph-get-node (round-trip + miss → null)
  {
    await clean();
    const a = await graph.addNode(LABEL, { name: "Ada", age: 36 });
    const got = await graph.getNode(a!.id);
    const roundTrip = got !== null && got.properties.name === "Ada" && Number(got.properties.age) === 36;
    const tmp = await graph.addNode(LABEL, { x: 1 });
    await graph.deleteNode(tmp!.id);
    const miss = await graph.getNode(tmp!.id);
    ok(
      `${tag}graph-get-node: getNode round-trips the stored properties`,
      roundTrip,
      JSON.stringify(got?.toDict()),
    );
    ok(`${tag}graph-get-node: getNode of a missing id returns null, not an error`, miss === null, String(miss));
  }

  // graph-update-delete-node
  {
    await clean();
    const a = await graph.addNode(LABEL, { name: "Ada", age: 36 });
    await graph.updateNode(a!.id, { name: "Ada Lovelace", city: "London" });
    const updated = await graph.getNode(a!.id);
    ok(
      `${tag}graph-update-delete-node: updateNode merges properties, verified by re-read`,
      updated !== null
        && updated.properties.name === "Ada Lovelace"
        && updated.properties.city === "London"
        && Number(updated.properties.age) === 36, // merge, not replace
      JSON.stringify(updated?.toDict()),
    );
    await graph.deleteNode(a!.id);
    const afterDelete = await graph.getNode(a!.id);
    ok(
      `${tag}graph-update-delete-node: deleteNode removes the node, verified by re-read`,
      afterDelete === null,
      String(afterDelete),
    );
  }

  // graph-neighbors
  {
    await clean();
    const a = await graph.addNode(LABEL, { name: "Ada" });
    const b = await graph.addNode(LABEL, { name: "Bob" });
    await graph.addEdge(a!.id, b!.id, "KNOWS", {});
    const out = new Set(
      (await graph.neighbors(a!.id, { direction: "out", edgeType: "KNOWS" })).map((n) => n.id),
    );
    const unmatched = await graph.neighbors(a!.id, { edgeType: "NOPE" });
    ok(
      `${tag}graph-neighbors: neighbors returns the connected nodes for a direction and edge type`,
      out.has(b!.id) && !out.has(a!.id),
      `out=${[...out].join(",")}`,
    );
    ok(
      `${tag}graph-neighbors: an unmatched edge-type filter returns empty, not an error`,
      Array.isArray(unmatched) && unmatched.length === 0,
    );
  }

  // graph-traverse-depth
  {
    await clean();
    const a = await graph.addNode(LABEL, { name: "A" });
    const b = await graph.addNode(LABEL, { name: "B" });
    const c = await graph.addNode(LABEL, { name: "C" });
    await graph.addEdge(a!.id, b!.id, "KNOWS", {});
    await graph.addEdge(b!.id, c!.id, "KNOWS", {});
    const reached = new Set(
      (await graph.traverse(a!.id, { depth: 2, direction: "out", edgeType: "KNOWS" })).map((n) => n.id),
    );
    ok(
      `${tag}graph-traverse-depth: traverse to depth 2 returns the reachable set`,
      reached.has(b!.id) && reached.has(c!.id),
      `reached=${[...reached].join(",")}`,
    );
  }

  // graph-raw-query (bound params)
  {
    await clean();
    await graph.addNode(LABEL, { name: "Bob" });
    const result = await graph.query(cfg.raw, cfg.rawParams);
    ok(
      `${tag}graph-raw-query: a native-dialect query round-trips through query() with bound params`,
      result instanceof GraphResult && result.length >= 1 && result.records[0].name === "Bob",
      JSON.stringify(result?.records),
    );
  }

  // graph-write-fails-loud
  {
    let threw = false;
    try {
      await graph.execute("THIS IS NOT A VALID STATEMENT");
    } catch (err) {
      threw = err instanceof GraphError;
    }
    ok(
      `${tag}graph-write-fails-loud: a bad raw statement raises and records the cause on getError()`,
      threw && graph.getError() !== null,
      `error=${graph.getError()}`,
    );
  }
}

// ── driver-run ───────────────────────────────────────────────────────────────

(async () => {
  const hasUltipaDriver = await driverInstalled("tina4-ultipa");

  testConnectByUrl();
  await testDriverOptional();
  await testConnectTimeout(hasUltipaDriver);

  for (const [engine, cfg] of Object.entries(ENGINES)) {
    const url = process.env[cfg.env];
    const liveName = `graph-live cases [${engine}]`;
    if (!url) {
      skip(liveName, `${cfg.env} not set`);
      continue;
    }
    if (!(await reachable(url))) {
      skip(liveName, `${cfg.env} not reachable`);
      continue;
    }
    if (!(await driverInstalled(cfg.driver))) {
      skip(liveName, `${cfg.driver} package absent`);
      continue;
    }
    const graph = await GraphDatabase.create(url);
    try {
      await runLive(engine, cfg, graph);
    } catch (err) {
      ok(liveName, false, `threw: ${(err as Error).message}`);
    } finally {
      try {
        await graph.execute(cfg.clean);
      } catch { /* best effort */ }
      await graph.close();
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

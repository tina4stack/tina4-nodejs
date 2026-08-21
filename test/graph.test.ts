/**
 * Contract suite for the graph data layer (Feature 139) — against a REAL engine.
 *
 * No mocks. Every live case runs a real connection and real round-trips against a
 * provisioned graph engine. Ultipa community edition is the first engine; the URL
 * comes from TINA4_TEST_ULTIPA_URL (the suite skips the live cases when it is unset
 * or unreachable, exactly like the relational live-database tests). Case names
 * match tina4-documentation/plan/v3/fixtures/graph_contract.json.
 *
 * Ultipa note: edge ids need EDGE_ID enabled on the graph
 * (`ALTER GRAPH <g> SET EDGE_ID ENABLED`) — a one-time per-graph setting the lab
 * provisions.
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

const ULTIPA_URL = process.env.TINA4_TEST_ULTIPA_URL;
// Unique per run so concurrent runs never collide; cleaned before AND after.
const LABEL = `T4GraphContractTest_${Date.now().toString(36)}`;

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
    port = u.port ? parseInt(u.port, 10) : 60061;
  } catch {
    return false;
  }
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

async function driverInstalled(): Promise<boolean> {
  try {
    // Variable specifier: same reason as the adapter — keep tsc from resolving
    // an optional package that is only present when the engine is used.
    const pkg = "tina4-ultipa";
    await import(pkg);
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

// graph-connect-timeout: an unreachable host throws GraphConnectTimeout within
// the bound, naming host and port. Needs the driver (constructs the client) but
// no live engine (10.255.255.1 is a black hole — a handshake that never completes).
async function testConnectTimeout(hasDriver: boolean): Promise<void> {
  const name = "graph-connect-timeout: an unreachable host times out within the bound, naming host and port";
  if (!hasDriver) {
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

// ── the portable core + raw pass-through, against LIVE Ultipa ────────────────

async function cleanLabel(graph: GraphAdapter): Promise<void> {
  await graph.execute(`MATCH (n:\`${LABEL}\`) DETACH DELETE n`);
}

async function runLive(graph: GraphAdapter): Promise<void> {
  // graph-connect-by-url (live): the factory returns a connected Ultipa adapter.
  ok(
    "graph-connect-by-url: create() returns a live UltipaGraphAdapter",
    graph.constructor.name === "UltipaGraphAdapter",
  );

  // graph-add-node
  {
    await cleanLabel(graph);
    const node = await graph.addNode(LABEL, { name: "Ada", age: 36 });
    ok(
      "graph-add-node: addNode returns a node with an id, labels and properties",
      node instanceof GraphNode
        && !!node.id
        && node.labels.includes(LABEL)
        && node.properties.name === "Ada",
      JSON.stringify(node?.toDict()),
    );
  }

  // graph-add-edge
  {
    await cleanLabel(graph);
    const a = await graph.addNode(LABEL, { name: "Ada" });
    const b = await graph.addNode(LABEL, { name: "Bob" });
    const edge = await graph.addEdge(a!.id, b!.id, "KNOWS", { since: 2020 });
    ok(
      "graph-add-edge: addEdge links two nodes with a type and properties",
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
    await cleanLabel(graph);
    const a = await graph.addNode(LABEL, { name: "Ada", age: 36 });
    const got = await graph.getNode(a!.id);
    const roundTrip = got !== null && got.properties.name === "Ada" && Number(got.properties.age) === 36;
    const miss = await graph.getNode("no-such-id");
    ok(
      "graph-get-node: getNode round-trips the stored properties",
      roundTrip,
      JSON.stringify(got?.toDict()),
    );
    ok("graph-get-node: getNode of a missing id returns null, not an error", miss === null, String(miss));
  }

  // graph-update-delete-node
  {
    await cleanLabel(graph);
    const a = await graph.addNode(LABEL, { name: "Ada", age: 36 });
    await graph.updateNode(a!.id, { name: "Ada Lovelace", city: "London" });
    const updated = await graph.getNode(a!.id);
    ok(
      "graph-update-delete-node: updateNode merges properties, verified by re-read",
      updated !== null
        && updated.properties.name === "Ada Lovelace"
        && updated.properties.city === "London"
        && Number(updated.properties.age) === 36, // merge, not replace
      JSON.stringify(updated?.toDict()),
    );
    await graph.deleteNode(a!.id);
    const afterDelete = await graph.getNode(a!.id);
    ok(
      "graph-update-delete-node: deleteNode removes the node, verified by re-read",
      afterDelete === null,
      String(afterDelete),
    );
  }

  // graph-neighbors
  {
    await cleanLabel(graph);
    const a = await graph.addNode(LABEL, { name: "Ada" });
    const b = await graph.addNode(LABEL, { name: "Bob" });
    await graph.addEdge(a!.id, b!.id, "KNOWS", {});
    const out = new Set(
      (await graph.neighbors(a!.id, { direction: "out", edgeType: "KNOWS" })).map((n) => n.id),
    );
    const unmatched = await graph.neighbors(a!.id, { edgeType: "NOPE" });
    ok(
      "graph-neighbors: neighbors returns the connected nodes for a direction and edge type",
      out.has(b!.id) && !out.has(a!.id),
      `out=${[...out].join(",")}`,
    );
    ok(
      "graph-neighbors: an unmatched edge-type filter returns empty, not an error",
      Array.isArray(unmatched) && unmatched.length === 0,
    );
  }

  // graph-traverse-depth
  {
    await cleanLabel(graph);
    const a = await graph.addNode(LABEL, { name: "A" });
    const b = await graph.addNode(LABEL, { name: "B" });
    const c = await graph.addNode(LABEL, { name: "C" });
    await graph.addEdge(a!.id, b!.id, "KNOWS", {});
    await graph.addEdge(b!.id, c!.id, "KNOWS", {});
    const reached = new Set(
      (await graph.traverse(a!.id, { depth: 2, direction: "out", edgeType: "KNOWS" })).map((n) => n.id),
    );
    ok(
      "graph-traverse-depth: traverse to depth 2 returns the reachable set",
      reached.has(b!.id) && reached.has(c!.id),
      `reached=${[...reached].join(",")}`,
    );
  }

  // graph-raw-query (bound params)
  {
    await cleanLabel(graph);
    await graph.addNode(LABEL, { name: "Bob" });
    const result = await graph.query(
      `MATCH (n:\`${LABEL}\`) WHERE n.name = $nm RETURN n.name AS name`,
      { nm: "Bob" },
    );
    ok(
      "graph-raw-query: a native-dialect query round-trips through query() with bound params",
      result instanceof GraphResult && result.length >= 1 && result.records[0].name === "Bob",
      JSON.stringify(result?.records),
    );
  }

  // graph-write-fails-loud
  {
    let threw = false;
    try {
      await graph.execute("THIS IS NOT GQL");
    } catch (err) {
      threw = err instanceof GraphError;
    }
    ok(
      "graph-write-fails-loud: a bad raw statement raises and records the cause on getError()",
      threw && graph.getError() !== null,
      `error=${graph.getError()}`,
    );
  }
}

// ── driver-run ───────────────────────────────────────────────────────────────

(async () => {
  const hasDriver = await driverInstalled();

  testConnectByUrl();
  await testDriverOptional();
  await testConnectTimeout(hasDriver);

  if (!ULTIPA_URL) {
    skip("graph-live cases", "TINA4_TEST_ULTIPA_URL not set (needs a live Ultipa)");
  } else if (!(await reachable(ULTIPA_URL))) {
    skip("graph-live cases", "TINA4_TEST_ULTIPA_URL not reachable");
  } else if (!hasDriver) {
    skip("graph-live cases", "tina4-ultipa package absent");
  } else {
    const graph = await GraphDatabase.create(ULTIPA_URL);
    try {
      await runLive(graph);
    } catch (err) {
      ok("graph-live cases", false, `threw: ${(err as Error).message}`);
    } finally {
      try {
        await cleanLabel(graph);
      } catch { /* best effort */ }
      graph.close();
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

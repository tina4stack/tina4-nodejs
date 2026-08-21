/**
 * Bolt graph adapter — Neo4j AND Memgraph (both speak Bolt + Cypher).
 *
 * Wraps the community `neo4j-driver` npm package (an OPTIONAL dependency — imported
 * at the top of THIS module only, so `import "@tina4/orm"` stays driver-free; the
 * GraphDatabase factory dynamically imports this module and turns a missing driver
 * into the actionable install error). Neo4j and Memgraph share this ONE adapter;
 * the URL scheme only picks the engine label and the default port.
 *
 * Cypher note (verified against live Neo4j + Memgraph on the lab, no mocks):
 * `id(n)` is the portable node/edge id (an INTEGER on both — Neo4j's `elementId`
 * is Neo4j-only, Memgraph has none); variable-length traversal is Cypher's
 * `[*1..N]` (the OPPOSITE of Ultipa's GQL `{1,N}`); `SET n += $props` merges.
 *
 * The driver is configured with `disableLosslessIntegers: true`, so `id(n)` and
 * integer properties come back as native JS numbers instead of the driver's
 * `Integer` wrapper. Node ids are engine integers; the neutral GraphNode carries
 * them as strings, so a Cypher `WHERE id(n) = $id` is fed `Number(id)` back.
 */
import { GraphNode, GraphEdge, GraphResult } from "../shapes.js";
import { GraphError, GraphConnectTimeout } from "../errors.js";
import {
  resolveGraphConnectTimeout,
  GRAPH_CONNECT_TIMEOUT_VARIABLE,
} from "../connectTimeout.js";
import type { GraphUrl } from "../graphUrl.js";
import type { GraphCredentials } from "../graphDatabase.js";
import type {
  GraphAdapter,
  NeighborOptions,
  TraverseOptions,
} from "../graphAdapter.js";

/**
 * The driver package name as a VARIABLE, so TypeScript does not try to resolve a
 * package that is only installed when the Bolt engine is actually used. This
 * top-level await is what makes an absent driver surface as the factory's
 * actionable install error (the dynamic import of this module rejects).
 */
const DRIVER_PACKAGE = "neo4j-driver";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const driverModule: any = await import(DRIVER_PACKAGE);
// neo4j-driver is CJS with a default export carrying driver()/auth/error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const neo4j: any = driverModule.default ?? driverModule;

interface DriverRow {
  id?: unknown;
  labels?: unknown;
  props?: unknown;
  type?: unknown;
  f?: unknown;
  t?: unknown;
  [key: string]: unknown;
}

function errorMessage(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

/**
 * A neutral GraphNode id back to the engine's integer form. Non-numeric ids
 * (e.g. a deliberate miss lookup) become -1, which matches nothing — an empty
 * result, never a driver NaN-parameter error.
 */
function boltId(id: string): number {
  const value = Number(id);
  return Number.isNaN(value) ? -1 : value;
}

export class BoltGraphAdapter implements GraphAdapter {
  private readonly url: GraphUrl;
  private readonly database: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly driver: any;
  private lastError: string | null = null;

  constructor(graphUrl: GraphUrl, credentials: GraphCredentials = {}) {
    this.url = graphUrl;
    this.database = graphUrl.graph || null;
    const user = graphUrl.username || credentials.username || "neo4j";
    const pwd = graphUrl.password || credentials.password || "";
    const scheme = graphUrl.useTls ? "bolt+s" : "bolt";
    const uri = `${scheme}://${graphUrl.host}:${graphUrl.port}`;
    const timeout = resolveGraphConnectTimeout();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: Record<string, any> = { disableLosslessIntegers: true };
    if (timeout !== null) {
      const ms = Math.max(1, Math.ceil(timeout * 1000));
      config.connectionTimeout = ms;
      config.connectionAcquisitionTimeout = ms;
      config.maxTransactionRetryTime = ms;
    }
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, pwd), config);
  }

  // -- connection + raw pass-through -------------------------------------
  private async run(
    cypher: string,
    params: Record<string, unknown> | null = null,
  ): Promise<DriverRow[]> {
    const session = this.database
      ? this.driver.session({ database: this.database })
      : this.driver.session();
    try {
      const result = await session.run(cypher, params ?? {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result.records.map((record: any) => record.toObject() as DriverRow);
    } catch (exc) {
      this.lastError = errorMessage(exc);
      const code = (exc as { code?: string })?.code ?? "";
      const message = this.lastError.toLowerCase();
      // An unreachable host surfaces here as a service-unavailable / timeout.
      if (
        code === "ServiceUnavailable"
        || code === neo4j.error?.SERVICE_UNAVAILABLE
        || message.includes("timed out")
        || message.includes("timeout")
      ) {
        throw new GraphConnectTimeout(
          `Graph connect to ${this.url.host}:${this.url.port} timed out `
          + `(${GRAPH_CONNECT_TIMEOUT_VARIABLE}). Raise ${GRAPH_CONNECT_TIMEOUT_VARIABLE} if the server `
          + `is simply slow, or set it to 0 to wait indefinitely.`,
          exc,
        );
      }
      throw new GraphError(this.lastError, exc);
    } finally {
      await session.close();
    }
  }

  async query(text: string, params: Record<string, unknown> | null = null): Promise<GraphResult> {
    const rows = await this.run(text, params);
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return new GraphResult(rows as Record<string, unknown>[], columns);
  }

  async execute(text: string, params: Record<string, unknown> | null = null): Promise<GraphResult> {
    return this.query(text, params);
  }

  // -- portable node/edge/traverse core (Cypher) -------------------------
  private nodeFromRow(row: DriverRow | undefined | null): GraphNode | null {
    if (row === null || row === undefined) return null;
    return new GraphNode(
      String(row.id),
      (row.labels as string[]) ?? [],
      (row.props as Record<string, unknown>) ?? {},
    );
  }

  async addNode(
    label: string,
    properties: Record<string, unknown> | null = null,
  ): Promise<GraphNode | null> {
    const cypher =
      `CREATE (n:\`${label}\` $props) `
      + `RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props`;
    const rows = await this.run(cypher, { props: properties ?? {} });
    return rows.length ? this.nodeFromRow(rows[0]) : null;
  }

  async addEdge(
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> | null = null,
  ): Promise<GraphEdge | null> {
    const cypher =
      `MATCH (a), (b) WHERE id(a) = $from_id AND id(b) = $to_id `
      + `CREATE (a)-[e:\`${type}\` $props]->(b) `
      + `RETURN id(e) AS id, type(e) AS type, id(a) AS f, id(b) AS t, properties(e) AS props`;
    const rows = await this.run(cypher, {
      from_id: boltId(fromId),
      to_id: boltId(toId),
      props: properties ?? {},
    });
    if (rows.length === 0) return null;
    const row = rows[0];
    return new GraphEdge(
      String(row.id),
      String(row.type),
      String(row.f),
      String(row.t),
      (row.props as Record<string, unknown>) ?? {},
    );
  }

  async getNode(nodeId: string): Promise<GraphNode | null> {
    const cypher =
      `MATCH (n) WHERE id(n) = $id `
      + `RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props`;
    const rows = await this.run(cypher, { id: boltId(nodeId) });
    return rows.length ? this.nodeFromRow(rows[0]) : null;
  }

  async updateNode(
    nodeId: string,
    properties: Record<string, unknown>,
  ): Promise<GraphNode | null> {
    const cypher =
      `MATCH (n) WHERE id(n) = $id SET n += $props `
      + `RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props`;
    const rows = await this.run(cypher, { id: boltId(nodeId), props: properties ?? {} });
    return rows.length ? this.nodeFromRow(rows[0]) : null;
  }

  async deleteNode(nodeId: string): Promise<boolean> {
    await this.run("MATCH (n) WHERE id(n) = $id DETACH DELETE n", { id: boltId(nodeId) });
    return true;
  }

  async neighbors(nodeId: string, options: NeighborOptions = {}): Promise<GraphNode[]> {
    const direction = options.direction ?? "both";
    const limit = options.limit ?? 100;
    const edge = options.edgeType ? `:\`${options.edgeType}\`` : "";
    const pattern = {
      out: `(n)-[${edge}]->(m)`,
      in: `(n)<-[${edge}]-(m)`,
      both: `(n)-[${edge}]-(m)`,
    }[direction];
    const cypher =
      `MATCH ${pattern} WHERE id(n) = $id `
      + `RETURN DISTINCT id(m) AS id, labels(m) AS labels, properties(m) AS props `
      + `LIMIT ${Math.trunc(limit)}`;
    const rows = await this.run(cypher, { id: boltId(nodeId) });
    return rows.map((row) => this.nodeFromRow(row)!).filter((node) => node !== null);
  }

  async traverse(startId: string, options: TraverseOptions = {}): Promise<GraphNode[]> {
    // Cypher variable-length path `[*1..N]` — Neo4j AND Memgraph.
    const depth = options.depth ?? 1;
    const direction = options.direction ?? "both";
    const limit = options.limit ?? 1000;
    const edge = options.edgeType ? `:\`${options.edgeType}\`` : "";
    const range = `*1..${Math.trunc(depth)}`;
    const arrow = {
      out: `-[${edge}${range}]->`,
      in: `<-[${edge}${range}]-`,
      both: `-[${edge}${range}]-`,
    }[direction];
    const cypher =
      `MATCH (n)${arrow}(m) WHERE id(n) = $start `
      + `RETURN DISTINCT id(m) AS id, labels(m) AS labels, properties(m) AS props `
      + `LIMIT ${Math.trunc(limit)}`;
    const rows = await this.run(cypher, { start: boltId(startId) });
    return rows.map((row) => this.nodeFromRow(row)!).filter((node) => node !== null);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  getError(): string | null {
    return this.lastError;
  }
}

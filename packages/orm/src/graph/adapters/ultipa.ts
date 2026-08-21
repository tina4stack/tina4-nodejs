/**
 * Ultipa graph adapter — the portable core built in GQL over the tina4-ultipa driver.
 *
 * Wraps the standalone `tina4-ultipa` driver (an OPTIONAL dependency — imported at
 * the top of THIS module only, so `import "@tina4/orm"` stays driver-free; the
 * GraphDatabase factory dynamically imports this module and turns a missing driver
 * into the actionable install error). The portable node/edge/traverse surface is
 * expressed in Ultipa GQL on top of the driver's query()/execute(); raw
 * query()/execute() send GQL straight through.
 *
 * GQL note: the exact statements are verified against the live Ultipa community
 * edition on the lab (no mocks). Ultipa node ids are the engine's own UUID strings;
 * we echo back whatever id(n)/id(e) returns without assuming a type. Reads go via
 * query() (readOnly=true); writes via execute() (readOnly=false) — a write through
 * query() is rejected by Ultipa.
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
 * package that is only installed when the Ultipa engine is actually used. This
 * top-level await is what makes an absent driver surface as the factory's
 * actionable install error (the dynamic import of this module rejects).
 */
const DRIVER_PACKAGE = "tina4-ultipa";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const driver: any = await import(DRIVER_PACKAGE);
const UltipaClient = driver.UltipaClient;
const UltipaConnectError = driver.UltipaConnectError;

/**
 * Seconds handed to the driver when the bound is disabled (resolver returns null).
 * The driver arms a real gRPC deadline (now + seconds*1000), so "unbounded" is a
 * far-future finite deadline rather than 0 — which the driver would read as an
 * instant, already-past deadline.
 */
const UNBOUNDED_CONNECT_SECONDS = 315_360_000; // ~10 years

interface DriverRow {
  id?: unknown;
  labels?: unknown;
  props?: unknown;
  type?: unknown;
  f?: unknown;
  t?: unknown;
  [key: string]: unknown;
}

/**
 * Build a GQL property map `{k1: $p_k1, ...}` plus the param dict for it.
 *
 * Params are BOUND (never interpolated), matching the relational ?-placeholder
 * rule. Keys are namespaced (`p_`) so they never collide with an id param.
 */
function propClause(
  properties: Record<string, unknown> | null | undefined,
): { clause: string; params: Record<string, unknown> } {
  const props = properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) return { clause: "{}", params: {} };
  const pairs = keys.map((key) => `${key}: $p_${key}`).join(", ");
  const params: Record<string, unknown> = {};
  for (const key of keys) params[`p_${key}`] = props[key];
  return { clause: `{${pairs}}`, params };
}

function errorMessage(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

export class UltipaGraphAdapter implements GraphAdapter {
  private readonly url: GraphUrl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private lastError: string | null = null;

  constructor(graphUrl: GraphUrl, credentials: GraphCredentials = {}) {
    this.url = graphUrl;
    const timeout = resolveGraphConnectTimeout();
    this.client = new UltipaClient({
      host: graphUrl.host,
      port: graphUrl.port,
      username: graphUrl.username || credentials.username || null,
      password: graphUrl.password || credentials.password || null,
      graph: graphUrl.graph,
      connectTimeout: timeout ?? UNBOUNDED_CONNECT_SECONDS,
      useTls: graphUrl.useTls,
    });
  }

  // -- connection + raw pass-through -------------------------------------
  private async run(
    gql: string,
    params: Record<string, unknown> | null = null,
    readOnly = true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    try {
      await this.client.connect();
    } catch (exc) {
      this.lastError = errorMessage(exc);
      if (exc instanceof UltipaConnectError || (exc as { name?: string })?.name === "UltipaConnectError") {
        const elapsed = typeof (exc as { elapsed?: number })?.elapsed === "number"
          ? (exc as { elapsed: number }).elapsed
          : 0;
        throw new GraphConnectTimeout(
          `Graph connect to ${this.url.host}:${this.url.port} timed out after ${elapsed.toFixed(1)}s `
          + `(${GRAPH_CONNECT_TIMEOUT_VARIABLE}). Raise ${GRAPH_CONNECT_TIMEOUT_VARIABLE} if the server `
          + `is simply slow, or set it to 0 to wait indefinitely.`,
          exc,
        );
      }
      // A non-timeout connect failure (auth, protocol) still fails loud.
      throw new GraphError(this.lastError, exc);
    }
    try {
      return await this.client.query(gql, { params: params ?? null, readOnly });
    } catch (exc) {
      this.lastError = errorMessage(exc);
      throw new GraphError(this.lastError, exc);
    }
  }

  async query(text: string, params: Record<string, unknown> | null = null): Promise<GraphResult> {
    const result = await this.run(text, params, true);
    return new GraphResult(result.dicts(), result.columns);
  }

  async execute(text: string, params: Record<string, unknown> | null = null): Promise<GraphResult> {
    const result = await this.run(text, params, false);
    return new GraphResult(result.dicts(), result.columns);
  }

  // -- portable node/edge/traverse core (GQL) ----------------------------
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
    const { clause, params } = propClause(properties);
    const gql =
      `INSERT (n:\`${label}\` ${clause}) `
      + `RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props`;
    const rows = (await this.run(gql, params, false)).dicts() as DriverRow[];
    return rows.length ? this.nodeFromRow(rows[0]) : null;
  }

  async addEdge(
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> | null = null,
  ): Promise<GraphEdge | null> {
    // id(e) requires EDGE_ID enabled on the Ultipa graph
    // (`ALTER GRAPH <g> SET EDGE_ID ENABLED`), a one-time per-graph setting.
    const { clause, params } = propClause(properties);
    params.from_id = fromId;
    params.to_id = toId;
    const gql =
      `MATCH (a), (b) WHERE id(a) = $from_id AND id(b) = $to_id `
      + `INSERT (a)-[e:\`${type}\` ${clause}]->(b) `
      + `RETURN id(e) AS id, type(e) AS type, id(a) AS f, id(b) AS t, properties(e) AS props`;
    const rows = (await this.run(gql, params, false)).dicts() as DriverRow[];
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
    const gql =
      `MATCH (n) WHERE id(n) = $id `
      + `RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props`;
    const rows = (await this.run(gql, { id: nodeId }, true)).dicts() as DriverRow[];
    return rows.length ? this.nodeFromRow(rows[0]) : null;
  }

  async updateNode(
    nodeId: string,
    properties: Record<string, unknown>,
  ): Promise<GraphNode | null> {
    const props = properties ?? {};
    const keys = Object.keys(props);
    const sets = keys.map((key) => `n.${key} = $p_${key}`).join(", ");
    const params: Record<string, unknown> = { id: nodeId };
    for (const key of keys) params[`p_${key}`] = props[key];
    const gql =
      `MATCH (n) WHERE id(n) = $id SET ${sets} `
      + `RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props`;
    const rows = (await this.run(gql, params, false)).dicts() as DriverRow[];
    return rows.length ? this.nodeFromRow(rows[0]) : null;
  }

  async deleteNode(nodeId: string): Promise<boolean> {
    const gql = "MATCH (n) WHERE id(n) = $id DETACH DELETE n";
    await this.run(gql, { id: nodeId }, false);
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
    const gql =
      `MATCH ${pattern} WHERE id(n) = $id `
      + `RETURN DISTINCT id(m) AS id, labels(m) AS labels, properties(m) AS props `
      + `LIMIT ${Math.trunc(limit)}`;
    const rows = (await this.run(gql, { id: nodeId }, true)).dicts() as DriverRow[];
    return rows.map((row) => this.nodeFromRow(row)!).filter((node) => node !== null);
  }

  async traverse(startId: string, options: TraverseOptions = {}): Promise<GraphNode[]> {
    // Ultipa GQL uses the ISO quantified-path form `-[]->{1,N}`, NOT Cypher's
    // `-[*1..N]->` (which is a parse error on gqldb).
    const depth = options.depth ?? 1;
    const direction = options.direction ?? "both";
    const limit = options.limit ?? 1000;
    const edge = options.edgeType ? `:\`${options.edgeType}\`` : "";
    const quant = `{1,${Math.trunc(depth)}}`;
    const pattern = {
      out: `(n)-[${edge}]->${quant}(m)`,
      in: `(n)<-[${edge}]-${quant}(m)`,
      both: `(n)-[${edge}]-${quant}(m)`,
    }[direction];
    const gql =
      `MATCH ${pattern} WHERE id(n) = $start `
      + `RETURN DISTINCT id(m) AS id, labels(m) AS labels, properties(m) AS props `
      + `LIMIT ${Math.trunc(limit)}`;
    const rows = (await this.run(gql, { start: startId }, true)).dicts() as DriverRow[];
    return rows.map((row) => this.nodeFromRow(row)!).filter((node) => node !== null);
  }

  close(): void {
    this.client.close();
  }

  getError(): string | null {
    return this.lastError;
  }
}

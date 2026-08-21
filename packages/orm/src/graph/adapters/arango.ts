/**
 * ArangoDB graph adapter — the document/AQL engine behind the same surface.
 *
 * Wraps the community `arangojs` npm package (an OPTIONAL dependency — imported at
 * the top of THIS module only, so `import "@tina4/orm"` stays driver-free; the
 * GraphDatabase factory dynamically imports this module and turns a missing driver
 * into the actionable install error). Arango is a document store, not a labelled-
 * property graph, so the portable core maps onto ONE vertex collection + ONE edge
 * collection: a node's `labels` and an edge's `type` are stored as document fields,
 * ids are Arango `_id` handles (e.g. `tina4_nodes/123`), and traversal uses AQL
 * `FOR v IN 1..N OUTBOUND ...`. Raw query()/execute() take AQL directly.
 *
 * The two collections are ensured lazily on the first query (the driver's
 * constructor is synchronous and opens no connection), mirroring the Ultipa
 * adapter's lazy connect.
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
 * package that is only installed when the Arango engine is actually used. This
 * top-level await is what makes an absent driver surface as the factory's
 * actionable install error (the dynamic import of this module rejects).
 */
const DRIVER_PACKAGE = "arangojs";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const driverModule: any = await import(DRIVER_PACKAGE);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ArangoDatabase: any = driverModule.Database ?? driverModule.default?.Database;

const VERTEX_COLLECTION = "tina4_nodes";
const EDGE_COLLECTION = "tina4_edges";
const RESERVED = new Set(["_id", "_key", "_rev", "_from", "_to", "_labels", "_type"]);

interface ArangoDoc {
  _id?: unknown;
  _labels?: unknown;
  _from?: unknown;
  _to?: unknown;
  _type?: unknown;
  [key: string]: unknown;
}

function cleanProps(doc: ArangoDoc): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!RESERVED.has(key)) props[key] = value;
  }
  return props;
}

function errorMessage(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

export class ArangoGraphAdapter implements GraphAdapter {
  private readonly url: GraphUrl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private ensured = false;
  private lastError: string | null = null;

  constructor(graphUrl: GraphUrl, credentials: GraphCredentials = {}) {
    this.url = graphUrl;
    const scheme = graphUrl.useTls ? "https" : "http";
    const user = graphUrl.username || credentials.username || "root";
    const pwd = graphUrl.password || credentials.password || "";
    const database = graphUrl.graph || "_system";
    const timeout = resolveGraphConnectTimeout();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: Record<string, any> = {
      url: `${scheme}://${graphUrl.host}:${graphUrl.port}`,
      databaseName: database,
      auth: { username: user, password: pwd },
    };
    if (timeout !== null) config.timeout = Math.max(1, Math.ceil(timeout * 1000));
    this.db = new ArangoDatabase(config);
  }

  private connectOrError(exc: unknown): GraphError {
    const text = errorMessage(exc).toLowerCase();
    if (
      text.includes("timed out")
      || text.includes("timeout")
      || text.includes("connection")
      || text.includes("econnrefused")
      || text.includes("etimedout")
      || text.includes("max retries")
    ) {
      return new GraphConnectTimeout(
        `Graph connect to ${this.url.host}:${this.url.port} timed out `
        + `(${GRAPH_CONNECT_TIMEOUT_VARIABLE}). Raise ${GRAPH_CONNECT_TIMEOUT_VARIABLE} if the server `
        + `is simply slow, or set it to 0 to wait indefinitely.`,
        exc,
      );
    }
    return new GraphError(errorMessage(exc), exc);
  }

  private async ensureCollections(): Promise<void> {
    if (this.ensured) return;
    try {
      const nodes = this.db.collection(VERTEX_COLLECTION);
      if (!(await nodes.exists())) await this.db.createCollection(VERTEX_COLLECTION);
      const edges = this.db.collection(EDGE_COLLECTION);
      if (!(await edges.exists())) await this.db.createEdgeCollection(EDGE_COLLECTION);
      this.ensured = true;
    } catch (exc) {
      this.lastError = errorMessage(exc);
      throw this.connectOrError(exc);
    }
  }

  private async aql(
    query: string,
    bind: Record<string, unknown> | null = null,
  ): Promise<ArangoDoc[]> {
    await this.ensureCollections();
    try {
      const cursor = await this.db.query({ query, bindVars: bind ?? {} });
      return (await cursor.all()) as ArangoDoc[];
    } catch (exc) {
      this.lastError = errorMessage(exc);
      throw this.connectOrError(exc);
    }
  }

  async query(text: string, params: Record<string, unknown> | null = null): Promise<GraphResult> {
    const rows = await this.aql(text, params);
    const first = rows[0];
    const columns = rows.length && first && typeof first === "object" ? Object.keys(first) : [];
    return new GraphResult(rows as Record<string, unknown>[], columns);
  }

  async execute(text: string, params: Record<string, unknown> | null = null): Promise<GraphResult> {
    return this.query(text, params);
  }

  // -- portable node/edge/traverse core (AQL) ----------------------------
  private nodeFromDoc(doc: ArangoDoc | undefined | null): GraphNode | null {
    if (doc === null || doc === undefined) return null;
    return new GraphNode(
      String(doc._id),
      (doc._labels as string[]) ?? [],
      cleanProps(doc),
    );
  }

  async addNode(
    label: string,
    properties: Record<string, unknown> | null = null,
  ): Promise<GraphNode | null> {
    const doc: ArangoDoc = { ...(properties ?? {}), _labels: [label] };
    const rows = await this.aql(`INSERT @doc INTO ${VERTEX_COLLECTION} RETURN NEW`, { doc });
    return rows.length ? this.nodeFromDoc(rows[0]) : null;
  }

  async addEdge(
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> | null = null,
  ): Promise<GraphEdge | null> {
    const doc: ArangoDoc = { ...(properties ?? {}), _from: fromId, _to: toId, _type: type };
    const rows = await this.aql(`INSERT @doc INTO ${EDGE_COLLECTION} RETURN NEW`, { doc });
    if (rows.length === 0) return null;
    const row = rows[0];
    return new GraphEdge(
      String(row._id),
      String(row._type),
      String(row._from),
      String(row._to),
      cleanProps(row),
    );
  }

  async getNode(nodeId: string): Promise<GraphNode | null> {
    const rows = await this.aql("RETURN DOCUMENT(@id)", { id: nodeId });
    return rows.length && rows[0] ? this.nodeFromDoc(rows[0]) : null;
  }

  async updateNode(
    nodeId: string,
    properties: Record<string, unknown>,
  ): Promise<GraphNode | null> {
    const rows = await this.aql(
      `UPDATE PARSE_IDENTIFIER(@id).key WITH @props IN ${VERTEX_COLLECTION} RETURN NEW`,
      { id: nodeId, props: properties ?? {} },
    );
    return rows.length ? this.nodeFromDoc(rows[0]) : null;
  }

  async deleteNode(nodeId: string): Promise<boolean> {
    // Remove the node and any edges touching it, so a re-read is a clean miss.
    await this.aql(
      `FOR e IN ${EDGE_COLLECTION} FILTER e._from == @id OR e._to == @id REMOVE e IN ${EDGE_COLLECTION}`,
      { id: nodeId },
    );
    await this.aql(
      `REMOVE PARSE_IDENTIFIER(@id).key IN ${VERTEX_COLLECTION}`,
      { id: nodeId },
    );
    return true;
  }

  async neighbors(nodeId: string, options: NeighborOptions = {}): Promise<GraphNode[]> {
    const direction = options.direction ?? "both";
    const limit = options.limit ?? 100;
    const arangoDir = { out: "OUTBOUND", in: "INBOUND", both: "ANY" }[direction];
    const typeFilter = options.edgeType ? "FILTER e._type == @etype " : "";
    const bind: Record<string, unknown> = { start: nodeId, limit: Math.trunc(limit) };
    if (options.edgeType) bind.etype = options.edgeType;
    const rows = await this.aql(
      `FOR v, e IN 1..1 ${arangoDir} @start ${EDGE_COLLECTION} ${typeFilter}LIMIT @limit RETURN DISTINCT v`,
      bind,
    );
    return rows.map((doc) => this.nodeFromDoc(doc)!).filter((node) => node !== null);
  }

  async traverse(startId: string, options: TraverseOptions = {}): Promise<GraphNode[]> {
    const depth = options.depth ?? 1;
    const direction = options.direction ?? "both";
    const limit = options.limit ?? 1000;
    const arangoDir = { out: "OUTBOUND", in: "INBOUND", both: "ANY" }[direction];
    const typeFilter = options.edgeType ? "FILTER e._type == @etype " : "";
    const bind: Record<string, unknown> = { start: startId, limit: Math.trunc(limit) };
    if (options.edgeType) bind.etype = options.edgeType;
    const rows = await this.aql(
      `FOR v, e IN 1..${Math.trunc(depth)} ${arangoDir} @start ${EDGE_COLLECTION} ${typeFilter}LIMIT @limit RETURN DISTINCT v`,
      bind,
    );
    return rows.map((doc) => this.nodeFromDoc(doc)!).filter((node) => node !== null);
  }

  async close(): Promise<void> {
    // arangojs closes its connection pool synchronously; wrap defensively.
    if (typeof this.db.close === "function") this.db.close();
  }

  getError(): string | null {
    return this.lastError;
  }
}

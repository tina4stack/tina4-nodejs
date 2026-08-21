/**
 * Graph connection URL parser — the DatabaseUrl sibling for graph engines.
 *
 * Parse a graph connection URL into its parts, the same way DatabaseUrl does for
 * SQL. `engine` is the CANONICAL name the factory selects an adapter by; a scheme
 * alias (bolt/neo4j/memgraph all speak Bolt/Cypher and share ONE adapter) resolves
 * to its engine here. See tina4-documentation/plan/v3/features/139-graph-databases.md.
 */

/** The canonical graph engine names. */
export type GraphEngine = "ultipa" | "bolt" | "arango";

/**
 * URL scheme to canonical engine. bolt/neo4j/memgraph share ONE adapter ("bolt");
 * the engine label only tunes per-engine defaults. The `…s` schemes are the TLS
 * variants.
 */
const SCHEME_ENGINE: Record<string, GraphEngine> = {
  ultipa: "ultipa",
  ultipas: "ultipa", // TLS variant
  neo4j: "bolt",
  "neo4j+s": "bolt",
  bolt: "bolt",
  "bolt+s": "bolt",
  memgraph: "bolt",
  arango: "arango",
  arangodb: "arango",
};

/** Default port per engine when the URL omits one. */
const ENGINE_DEFAULT_PORT: Record<GraphEngine, number> = {
  ultipa: 60061,
  bolt: 7687,
  arango: 8529,
};

/** A parsed graph URL: engine, host, port, graph, credentials, params. */
export class GraphUrl {
  readonly raw: string;
  readonly scheme: string;
  readonly engine: GraphEngine;
  readonly host: string;
  readonly port: number;
  /** The graph/database name (leading slash stripped), or null when absent. */
  readonly graph: string | null;
  readonly username: string | null;
  readonly password: string | null;
  readonly params: Record<string, string>;
  readonly useTls: boolean;

  constructor(url: string) {
    this.raw = url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(
        `Unsupported graph URL '${url}' — expected scheme://[user[:password]@]host[:port]/graph `
        + `(e.g. ultipa://host:60061/mygraph).`,
      );
    }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    const engine = SCHEME_ENGINE[scheme];
    if (engine === undefined) {
      throw new Error(
        `Unsupported graph URL scheme '${scheme}'. Supported: `
        + `${Object.keys(SCHEME_ENGINE).sort().join(", ")} `
        + `(e.g. ultipa://host:60061/mygraph).`,
      );
    }
    this.scheme = scheme;
    this.engine = engine;
    this.host = parsed.hostname || "localhost";
    this.port = parsed.port ? parseInt(parsed.port, 10) : ENGINE_DEFAULT_PORT[engine];
    const path = (parsed.pathname || "").replace(/^\//, "");
    this.graph = path === "" ? null : path;
    this.username = parsed.username ? decodeURIComponent(parsed.username) : null;
    this.password = parsed.password ? decodeURIComponent(parsed.password) : null;
    this.params = {};
    for (const [key, value] of parsed.searchParams) {
      // First value wins, matching Python's parse_qs[0].
      if (!(key in this.params)) this.params[key] = value;
    }
    // TLS if the scheme says so (…s) or ?tls=1|true.
    this.useTls = scheme.endsWith("s") || this.params.tls === "1" || this.params.tls === "true";
  }

  /** host:port/graph — for messages, never carrying credentials. */
  getDsn(): string {
    const target = this.port ? `${this.host}:${this.port}` : this.host;
    return this.graph ? `${target}/${this.graph}` : target;
  }

  static fromEnv(envKey = "TINA4_GRAPH_URL"): GraphUrl | null {
    const url = (process.env[envKey] ?? "").trim();
    return url === "" ? null : new GraphUrl(url);
  }
}

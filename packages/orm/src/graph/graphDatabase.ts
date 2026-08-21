/**
 * The GraphAdapter URL-selected factory — the GraphDatabase sibling of Database.
 *
 * GraphDatabase.create picks an adapter by URL scheme and imports its driver
 * lazily (dynamic import): a missing driver raises an actionable install error,
 * never a bare module-not-found, and the graph CORE imports with no driver
 * present (the zero-dependency-core rule). The barrel deliberately does NOT
 * re-export any engine adapter, so importing @tina4/orm pulls in no graph driver.
 */
import { GraphUrl, type GraphEngine } from "./graphUrl.js";
import { GraphError } from "./errors.js";
import type { GraphAdapter } from "./graphAdapter.js";

/** Credentials passed alongside the URL when it carries none. */
export interface GraphCredentials {
  username?: string;
  password?: string;
}

export interface AdapterRegistration {
  /** Dynamic import of the adapter module — the ONLY place a driver is pulled. */
  load: () => Promise<Record<string, unknown>>;
  className: string;
  /** npm package that provides the engine driver. */
  package: string;
  /** The command that installs it. */
  installCommand: string;
}

/**
 * engine -> adapter registration. Selected lazily so importing this module pulls
 * in NO engine driver. bolt (Neo4j/Memgraph) and arango land later — declared so
 * the factory gives an actionable message rather than a bare KeyError.
 */
export const ENGINE_ADAPTERS: Partial<Record<GraphEngine, AdapterRegistration>> = {
  ultipa: {
    load: () => import("./adapters/ultipa.js") as Promise<Record<string, unknown>>,
    className: "UltipaGraphAdapter",
    package: "tina4-ultipa",
    installCommand: "npm install tina4-ultipa",
  },
  bolt: {
    // Neo4j AND Memgraph — both speak Bolt/Cypher over the neo4j-driver package.
    load: () => import("./adapters/bolt.js") as Promise<Record<string, unknown>>,
    className: "BoltGraphAdapter",
    package: "neo4j-driver",
    installCommand: "npm install neo4j-driver",
  },
  arango: {
    load: () => import("./adapters/arango.js") as Promise<Record<string, unknown>>,
    className: "ArangoGraphAdapter",
    package: "arangojs",
    installCommand: "npm install arangojs",
  },
};

type AdapterConstructor = new (
  graphUrl: GraphUrl,
  credentials: GraphCredentials,
) => GraphAdapter;

export class GraphDatabase {
  /**
   * Parse the URL, pick the engine adapter, connect lazily.
   *
   * The engine driver is imported only here (first use of that engine); if it is
   * absent the error names the package and the install command. Async because the
   * driver import is dynamic — the connect itself still happens lazily on first
   * operation (mirroring the relational adapters).
   */
  static async create(
    url: string,
    credentials: GraphCredentials = {},
  ): Promise<GraphAdapter> {
    const graphUrl = new GraphUrl(url);
    const registration = ENGINE_ADAPTERS[graphUrl.engine];
    if (registration === undefined) {
      throw new GraphError(
        `No graph adapter for engine '${graphUrl.engine}' yet (scheme '${graphUrl.scheme}'). `
        + `Available: ${Object.keys(ENGINE_ADAPTERS).sort().join(", ")}.`,
      );
    }
    let module: Record<string, unknown>;
    try {
      // The adapter module imports its driver at the top; a missing driver
      // surfaces here as an actionable install error.
      module = await registration.load();
    } catch (cause) {
      throw new GraphError(
        `The graph driver for '${graphUrl.engine}' is not installed (${registration.package}). `
        + `Install it with:\n    ${registration.installCommand}`,
        cause,
      );
    }
    const AdapterClass = module[registration.className] as AdapterConstructor | undefined;
    if (AdapterClass === undefined) {
      throw new GraphError(
        `The graph adapter '${registration.className}' is missing from its module `
        + `for engine '${graphUrl.engine}'.`,
      );
    }
    return new AdapterClass(graphUrl, credentials);
  }

  /** Build from TINA4_GRAPH_URL (+ TINA4_GRAPH_USERNAME/_PASSWORD). */
  static async fromEnv(envKey = "TINA4_GRAPH_URL"): Promise<GraphAdapter | null> {
    const url = (process.env[envKey] ?? "").trim();
    if (url === "") return null;
    return GraphDatabase.create(url, {
      username: process.env.TINA4_GRAPH_USERNAME,
      password: process.env.TINA4_GRAPH_PASSWORD,
    });
  }
}

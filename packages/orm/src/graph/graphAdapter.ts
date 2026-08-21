/**
 * The one surface every graph engine implements.
 *
 * The portable node/edge/traverse core PLUS a raw query()/execute() pass-through
 * in the engine's native dialect, and lifecycle. Every method is async — the
 * Node graph drivers are async (gRPC/Bolt/HTTP), so the surface is async
 * everywhere, matching the relational Database wrapper. See ADR-0059.
 */
import type { GraphNode, GraphEdge, GraphResult } from "./shapes.js";

/** Direction of an edge relative to the anchor node. */
export type GraphDirection = "out" | "in" | "both";

/** Options for the one-hop neighbours read. */
export interface NeighborOptions {
  direction?: GraphDirection;
  edgeType?: string;
  limit?: number;
}

/** Options for the bounded multi-hop traversal. */
export interface TraverseOptions {
  depth?: number;
  direction?: GraphDirection;
  edgeType?: string;
  limit?: number;
}

export interface GraphAdapter {
  // -- portable node/edge/traverse core ----------------------------------
  addNode(label: string, properties?: Record<string, unknown> | null): Promise<GraphNode | null>;
  addEdge(
    fromId: string,
    toId: string,
    type: string,
    properties?: Record<string, unknown> | null,
  ): Promise<GraphEdge | null>;
  getNode(nodeId: string): Promise<GraphNode | null>;
  updateNode(nodeId: string, properties: Record<string, unknown>): Promise<GraphNode | null>;
  deleteNode(nodeId: string): Promise<boolean>;
  neighbors(nodeId: string, options?: NeighborOptions): Promise<GraphNode[]>;
  traverse(startId: string, options?: TraverseOptions): Promise<GraphNode[]>;

  // -- raw pass-through (engine-native dialect) --------------------------
  query(text: string, params?: Record<string, unknown> | null): Promise<GraphResult>;
  execute(text: string, params?: Record<string, unknown> | null): Promise<GraphResult>;

  // -- lifecycle ---------------------------------------------------------
  close(): Promise<void> | void;

  /** Cause of the last failed operation, or null. */
  getError(): string | null;
}

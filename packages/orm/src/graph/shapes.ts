/**
 * Engine-neutral graph shapes — the mirror of the relational DatabaseResult.
 *
 * GraphNode / GraphEdge are the portable node/edge core the unified surface
 * returns; GraphResult is the raw-query result (records + columns), the same
 * shape as `DatabaseResult`, so a graph read feels exactly like a SQL read.
 * See tina4-documentation/plan/v3/decisions/ADR-0059.md and features/139.
 */

/** Engine-neutral vertex: id, labels, properties. */
export class GraphNode {
  readonly id: string;
  readonly labels: string[];
  readonly properties: Record<string, unknown>;

  constructor(
    id: string,
    labels: string[] | null | undefined = null,
    properties: Record<string, unknown> | null | undefined = null,
  ) {
    this.id = id;
    this.labels = [...(labels ?? [])];
    this.properties = { ...(properties ?? {}) };
  }

  toDict(): Record<string, unknown> {
    return { id: this.id, labels: this.labels, properties: this.properties };
  }
}

/** Engine-neutral edge: id, type, from/to node ids, properties. */
export class GraphEdge {
  readonly id: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly properties: Record<string, unknown>;

  constructor(
    id: string,
    type: string,
    from: string,
    to: string,
    properties: Record<string, unknown> | null | undefined = null,
  ) {
    this.id = id;
    this.type = type;
    this.from = from;
    this.to = to;
    this.properties = { ...(properties ?? {}) };
  }

  toDict(): Record<string, unknown> {
    return {
      id: this.id,
      type: this.type,
      from: this.from,
      to: this.to,
      properties: this.properties,
    };
  }
}

/** A raw-query result — records + columns, same shape as DatabaseResult. */
export class GraphResult implements Iterable<Record<string, unknown>> {
  readonly records: Record<string, unknown>[];
  readonly columns: string[];

  constructor(
    records: Record<string, unknown>[] | null | undefined = null,
    columns: string[] | null | undefined = null,
  ) {
    this.records = [...(records ?? [])];
    this.columns = [...(columns ?? [])];
  }

  toArray(): Record<string, unknown>[] {
    return this.records;
  }

  /** The first value of the first record, or null. */
  scalar(): unknown {
    if (this.records.length === 0) return null;
    const values = Object.values(this.records[0]);
    return values.length ? values[0] : null;
  }

  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    return this.records[Symbol.iterator]();
  }

  get length(): number {
    return this.records.length;
  }
}

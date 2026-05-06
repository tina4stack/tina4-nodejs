/**
 * Tina4 GraphQL — Zero-dependency GraphQL engine.
 *
 * Recursive-descent parser, schema builder, and query executor.
 *
 *   import { GraphQL } from "@tina4/core";
 *
 *   const gql = new GraphQL();
 *   gql.addType("User", { id: { type: "ID" }, name: { type: "String" } });
 *   gql.addQuery("user", { id: "ID!" }, "User", (root, args) => getUser(args.id));
 *   const result = gql.execute('{ user(id: "1") { name } }');
 *
 * Supported:
 *   - Queries, mutations
 *   - Variables, default values
 *   - Aliases
 *   - Nested selections
 *   - List types ([Type])
 *   - Non-null types (Type!)
 *   - Error capture (resolver exceptions become GraphQL errors)
 */

// ── Types ────────────────────────────────────────────────────

export interface GraphQLField {
  type: string;
  description?: string;
}

export type ResolverFn = (
  root: unknown,
  args: Record<string, unknown>,
  context?: Record<string, unknown>,
) => unknown;

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: string[] }>;
}

// ── Token ────────────────────────────────────────────────────

interface Token {
  type: string;
  value: string;
  pos: number;
}

const TOKEN_PATTERNS: Array<[string, RegExp]> = [
  ["SPREAD", /\.\.\./y],
  ["LBRACE", /\{/y],
  ["RBRACE", /\}/y],
  ["LPAREN", /\(/y],
  ["RPAREN", /\)/y],
  ["LBRACKET", /\[/y],
  ["RBRACKET", /\]/y],
  ["COLON", /:/y],
  ["BANG", /!/y],
  ["EQUALS", /=/y],
  ["AT", /@/y],
  ["DOLLAR", /\$/y],
  ["COMMA", /,/y],
  ["STRING", /"(?:[^"\\]|\\.)*"/y],
  ["NUMBER", /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
  ["BOOL", /\b(?:true|false)\b/y],
  ["NULL", /\bnull\b/y],
  ["NAME", /[_a-zA-Z]\w*/y],
  ["SKIP", /[\s,]+/y],
  ["COMMENT", /#[^\n]*/y],
];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < source.length) {
    let matched = false;

    for (const [type, regex] of TOKEN_PATTERNS) {
      regex.lastIndex = pos;
      const m = regex.exec(source);
      if (m) {
        if (type !== "SKIP" && type !== "COMMENT") {
          tokens.push({ type, value: m[0], pos });
        }
        pos = regex.lastIndex;
        matched = true;
        break;
      }
    }

    if (!matched) {
      throw new ParseError(`Unexpected character: ${source[pos]} at position ${pos}`);
    }
  }

  return tokens;
}

// ── Parser ───────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

interface ParsedField {
  kind: "field";
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  directives: ParsedDirective[];
  selections: ParsedSelection[] | null;
}

interface ParsedDirective {
  name: string;
  args: Record<string, unknown>;
}

interface ParsedOperation {
  kind: "operation";
  operation: string;
  name: string | null;
  variables: ParsedVariableDef[];
  directives: ParsedDirective[];
  selections: ParsedSelection[];
}

interface ParsedVariableDef {
  name: string;
  type: string;
  default: unknown;
}

type ParsedSelection = ParsedField;

class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
  }

  advance(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  expect(type: string, value?: string): Token {
    const t = this.peek();
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      const expected = value ? `${type}(${value})` : type;
      const got = t ? `${t.type}(${t.value})` : "EOF";
      throw new ParseError(`Expected ${expected}, got ${got}`);
    }
    return this.advance();
  }

  match(type: string, value?: string): Token | null {
    const t = this.peek();
    if (t && t.type === type && (value === undefined || t.value === value)) {
      return this.advance();
    }
    return null;
  }

  parse(): { definitions: ParsedOperation[] } {
    const doc: { definitions: ParsedOperation[] } = { definitions: [] };
    while (this.pos < this.tokens.length) {
      doc.definitions.push(this.parseOperation());
    }
    return doc;
  }

  private parseOperation(): ParsedOperation {
    const t = this.peek();
    let opType = "query";
    let name: string | null = null;
    let variables: ParsedVariableDef[] = [];

    if (t && t.type === "NAME" && (t.value === "query" || t.value === "mutation")) {
      opType = this.advance().value;
      if (this.peek() && this.peek()!.type === "NAME") {
        name = this.advance().value;
      }
      if (this.match("LPAREN")) {
        variables = this.parseVariableDefs();
        this.expect("RPAREN");
      }
    }

    const directives = this.parseDirectives();
    const selections = this.parseSelectionSet();

    return {
      kind: "operation",
      operation: opType,
      name,
      variables,
      directives,
      selections,
    };
  }

  private parseSelectionSet(): ParsedSelection[] {
    this.expect("LBRACE");
    const selections: ParsedSelection[] = [];
    while (!this.match("RBRACE")) {
      selections.push(this.parseField());
    }
    return selections;
  }

  private parseField(): ParsedField {
    const nameToken = this.expect("NAME");
    let name = nameToken.value;
    let alias: string | null = null;

    if (this.match("COLON")) {
      alias = name;
      name = this.expect("NAME").value;
    }

    let args: Record<string, unknown> = {};
    if (this.match("LPAREN")) {
      args = this.parseArguments();
      this.expect("RPAREN");
    }

    const directives = this.parseDirectives();

    let selections: ParsedSelection[] | null = null;
    if (this.peek() && this.peek()!.type === "LBRACE") {
      selections = this.parseSelectionSet();
    }

    return {
      kind: "field",
      name,
      alias,
      args,
      directives,
      selections,
    };
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    while (this.peek() && this.peek()!.type !== "RPAREN") {
      const name = this.expect("NAME").value;
      this.expect("COLON");
      args[name] = this.parseValue();
      this.match("COMMA");
    }
    return args;
  }

  private parseValue(): unknown {
    const t = this.peek();
    if (!t) throw new ParseError("Unexpected EOF in value");

    if (t.type === "STRING") {
      this.advance();
      return t.value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (t.type === "NUMBER") {
      this.advance();
      return t.value.includes(".") || t.value.toLowerCase().includes("e")
        ? parseFloat(t.value)
        : parseInt(t.value, 10);
    }
    if (t.type === "BOOL") {
      this.advance();
      return t.value === "true";
    }
    if (t.type === "NULL") {
      this.advance();
      return null;
    }
    if (t.type === "NAME") {
      this.advance();
      return t.value;
    }
    if (t.type === "DOLLAR") {
      this.advance();
      const name = this.expect("NAME").value;
      return { $var: name };
    }
    if (t.type === "LBRACKET") {
      this.advance();
      const items: unknown[] = [];
      while (!this.match("RBRACKET")) {
        items.push(this.parseValue());
      }
      return items;
    }
    if (t.type === "LBRACE") {
      this.advance();
      const obj: Record<string, unknown> = {};
      while (!this.match("RBRACE")) {
        const key = this.expect("NAME").value;
        this.expect("COLON");
        obj[key] = this.parseValue();
      }
      return obj;
    }

    throw new ParseError(`Unexpected token: ${t.type}(${t.value})`);
  }

  private parseDirectives(): ParsedDirective[] {
    const directives: ParsedDirective[] = [];
    while (this.peek() && this.peek()!.type === "AT") {
      this.advance();
      const name = this.expect("NAME").value;
      let args: Record<string, unknown> = {};
      if (this.match("LPAREN")) {
        args = this.parseArguments();
        this.expect("RPAREN");
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseVariableDefs(): ParsedVariableDef[] {
    const defs: ParsedVariableDef[] = [];
    while (this.peek() && this.peek()!.type === "DOLLAR") {
      this.advance();
      const name = this.expect("NAME").value;
      this.expect("COLON");
      const typeName = this.parseTypeRef();
      let defaultVal: unknown = undefined;
      if (this.match("EQUALS")) {
        defaultVal = this.parseValue();
      }
      defs.push({ name, type: typeName, default: defaultVal });
      this.match("COMMA");
    }
    return defs;
  }

  private parseTypeRef(): string {
    let t: string;
    if (this.match("LBRACKET")) {
      const inner = this.parseTypeRef();
      this.expect("RBRACKET");
      t = `[${inner}]`;
    } else {
      t = this.expect("NAME").value;
    }
    if (this.match("BANG")) {
      t += "!";
    }
    return t;
  }
}

// ── Schema ───────────────────────────────────────────────────

interface QueryConfig {
  args: Record<string, string>;
  returnType: string;
  resolver: ResolverFn;
}

// ── Env-driven config ────────────────────────────────────────

/**
 * URL the GraphQL handler should be mounted at.
 * `TINA4_GRAPHQL_ENDPOINT` overrides the default `/graphql`.
 */
export function graphqlEndpoint(): string {
  const raw = (process.env.TINA4_GRAPHQL_ENDPOINT ?? "").trim();
  if (raw.length === 0) return "/graphql";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/**
 * Whether to auto-generate the schema from registered ORM models.
 * `TINA4_GRAPHQL_AUTO_SCHEMA=true` (default) lets the dev server build a
 * usable schema with no manual wiring; set to `false` to require explicit
 * `addType` / `addQuery` calls.
 */
export function graphqlAutoSchemaEnabled(): boolean {
  const raw = (process.env.TINA4_GRAPHQL_AUTO_SCHEMA ?? "true").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(raw);
}

// ── GraphQL Engine ───────────────────────────────────────────

export class GraphQL {
  private types: Map<string, Record<string, GraphQLField>> = new Map();
  private queries: Map<string, QueryConfig> = new Map();
  private mutations: Map<string, QueryConfig> = new Map();

  constructor() {}

  /**
   * Return schema metadata for debugging.
   */
  introspect(): Record<string, unknown> {
    const queries: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.queries)) {
      queries[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    const mutations: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.mutations)) {
      mutations[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    return { types: Object.keys(this.types), queries, mutations };
  }

  /**
   * Register a named type with its fields.
   */
  addType(name: string, fields: Record<string, GraphQLField>): GraphQL {
    this.types.set(name, fields);
    return this;
  }

  /**
   * Return schema metadata for debugging.
   */
  introspect(): Record<string, unknown> {
    const queries: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.queries)) {
      queries[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    const mutations: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.mutations)) {
      mutations[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    return { types: Object.keys(this.types), queries, mutations };
  }

  /**
   * Register a query resolver.
   */
  addQuery(
    name: string,
    args: Record<string, string>,
    returnType: string,
    resolver: ResolverFn,
  ): GraphQL {
    this.queries.set(name, { args, returnType, resolver });
    return this;
  }

  /**
   * Return schema metadata for debugging.
   */
  introspect(): Record<string, unknown> {
    const queries: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.queries)) {
      queries[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    const mutations: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.mutations)) {
      mutations[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    return { types: Object.keys(this.types), queries, mutations };
  }

  /**
   * Register a mutation resolver.
   */
  addMutation(
    name: string,
    args: Record<string, string>,
    returnType: string,
    resolver: ResolverFn,
  ): GraphQL {
    this.mutations.set(name, { args, returnType, resolver });
    return this;
  }

  /**
   * Return schema metadata for debugging.
   */
  introspect(): Record<string, unknown> {
    const queries: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.queries)) {
      queries[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    const mutations: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.mutations)) {
      mutations[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    return { types: Object.keys(this.types), queries, mutations };
  }

  /**
   * Execute a GraphQL query string.
   */
  execute(query: string, variables?: Record<string, unknown>, context?: Record<string, unknown>): GraphQLResult {
    const vars = variables ?? {};
    const ctx = context ?? {};
    const errors: Array<{ message: string; path?: string[] }> = [];

    let doc: { definitions: ParsedOperation[] };
    try {
      const tokens = tokenize(query);
      const parser = new Parser(tokens);
      doc = parser.parse();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: null, errors: [{ message }] };
    }

    if (doc.definitions.length === 0) {
      return { data: null, errors: [{ message: "No operation found" }] };
    }

    const op = doc.definitions[0];
    const resolvers = op.operation === "query" ? this.queries : this.mutations;

    // Apply variable defaults
    for (const vdef of op.variables) {
      if (!(vdef.name in vars) && vdef.default !== undefined) {
        vars[vdef.name] = vdef.default;
      }
    }

    const data: Record<string, unknown> = {};

    for (const sel of op.selections) {
      // Check directives (@skip, @include, @auth, @role, @guest)
      if (!this.checkDirectives(sel.directives ?? [], vars, ctx)) continue;

      const [value, errs] = this.resolveField(sel, resolvers, null, vars, ctx);
      errors.push(...errs);
      const key = sel.alias ?? sel.name;
      data[key] = value;
    }

    const result: GraphQLResult = { data };
    if (errors.length > 0) {
      result.errors = errors;
    }
    return result;
  }

  /**
   * Return schema metadata for debugging.
   */
  introspect(): Record<string, unknown> {
    const queries: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.queries)) {
      queries[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    const mutations: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.mutations)) {
      mutations[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    return { types: Object.keys(this.types), queries, mutations };
  }


  /**
   * Return schema metadata for debugging.
   */
  introspect(): Record<string, unknown> {
    const queries: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.queries)) {
      queries[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    const mutations: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.mutations)) {
      mutations[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    return { types: Object.keys(this.types), queries, mutations };
  }

  /**
   * Generate SDL schema string.
   */

  /**
   * Return schema metadata for debugging.
   */
  introspect(): Record<string, unknown> {
    const queries: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.queries)) {
      queries[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    const mutations: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.mutations)) {
      mutations[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    return { types: Object.keys(this.types), queries, mutations };
  }

  schemaSdl(): string {
    const lines: string[] = [];

    // Types
    for (const [name, fields] of this.types) {
      lines.push(`type ${name} {`);
      for (const [fieldName, field] of Object.entries(fields)) {
        lines.push(`  ${fieldName}: ${field.type}`);
      }
      lines.push("}");
      lines.push("");
    }

    // Query type
    if (this.queries.size > 0) {
      lines.push("type Query {");
      for (const [name, config] of this.queries) {
        const argsStr = this.formatArgs(config.args);
        lines.push(`  ${name}${argsStr}: ${config.returnType}`);
      }
      lines.push("}");
      lines.push("");
    }

    // Mutation type
    if (this.mutations.size > 0) {
      lines.push("type Mutation {");
      for (const [name, config] of this.mutations) {
        const argsStr = this.formatArgs(config.args);
        lines.push(`  ${name}${argsStr}: ${config.returnType}`);
      }
      lines.push("}");
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Return schema metadata for debugging.
   */
  introspect(): Record<string, unknown> {
    const queries: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.queries)) {
      queries[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    const mutations: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(this.mutations)) {
      mutations[name] = { type: (config as any).type, args: (config as any).args ?? {} };
    }
    return { types: Object.keys(this.types), queries, mutations };
  }

  /**
   * Auto-generate type, queries, and CRUD mutations from an ORM model class.
   *
   * The model class must have static `tableName` (string) and `fields`
   * (Record<string, { type: string; primaryKey?: boolean }>).
   *
   * Creates:
   *   - A GraphQL type from the model's fields
   *   - Queries: {modelName}(id: ID!): Type, {modelNames}(limit: Int, offset: Int): [Type]
   *   - Mutations: create{ModelName}, update{ModelName}, delete{ModelName}
   *
   * @param modelClass - The model class with static tableName and fields
   * @param adapter - Optional database adapter; if omitted, resolvers will
   *                  import getAdapter from @tina4/orm at call time
   */
  fromOrm(
    modelClass: {
      tableName: string;
      fields: Record<string, { type: string; primaryKey?: boolean }>;
      name?: string;
    },
    adapter?: {
      query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => T[];
      execute: (sql: string, params?: unknown[]) => unknown;
    },
  ): GraphQL {
    const tableName = modelClass.tableName;
    const fields = modelClass.fields;
    const className = modelClass.name ?? tableName.charAt(0).toUpperCase() + tableName.slice(1);

    // Find primary key
    let pkField = "id";
    for (const [fname, fdef] of Object.entries(fields)) {
      if (fdef.primaryKey) {
        pkField = fname;
        break;
      }
    }

    // Map model field types to GraphQL types
    const gqlFields: Record<string, GraphQLField> = {};
    for (const [fname, fdef] of Object.entries(fields)) {
      let gqlType: string;
      if (fdef.primaryKey) {
        gqlType = "ID";
      } else {
        switch (fdef.type) {
          case "integer":
            gqlType = "Int";
            break;
          case "number":
          case "numeric":
            gqlType = "Float";
            break;
          case "boolean":
            gqlType = "Boolean";
            break;
          case "string":
          case "text":
          case "datetime":
          default:
            gqlType = "String";
            break;
        }
      }
      gqlFields[fname] = { type: gqlType };
    }

    this.addType(className, gqlFields);

    // Build singular/plural names
    const singular = className.charAt(0).toLowerCase() + className.slice(1);
    const plural = singular + "s";

    // Helper to get the adapter (lazy so it works even if adapter is set later)
    const getDb = () => {
      if (adapter) return adapter;
      // Try dynamic import fallback — caller must provide adapter
      throw new Error(
        `GraphQL fromOrm: no database adapter provided for ${className}. Pass an adapter to fromOrm().`,
      );
    };

    // Query: single record by ID
    this.addQuery(singular, { id: "ID!" }, className, (root, args) => {
      const db = getDb();
      const rows = db.query(
        `SELECT * FROM "${tableName}" WHERE "${pkField}" = ?`,
        [args.id],
      );
      return rows.length > 0 ? rows[0] : null;
    });

    // Query: list with pagination
    this.addQuery(
      plural,
      { limit: "Int", offset: "Int" },
      `[${className}]`,
      (root, args) => {
        const db = getDb();
        const limit = (args.limit as number) ?? 10;
        const offset = (args.offset as number) ?? 0;
        return db.query(
          `SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`,
          [limit, offset],
        );
      },
    );

    // Build mutation args (all fields except PK)
    const mutationArgs: Record<string, string> = {};
    for (const [fname, fdef] of Object.entries(fields)) {
      if (fname !== pkField) {
        mutationArgs[fname] = "String";
      }
    }

    // Mutation: create
    this.addMutation(
      `create${className}`,
      mutationArgs,
      className,
      (root, args) => {
        const db = getDb();
        const fieldNames = Object.keys(args);
        const placeholders = fieldNames.map(() => "?");
        const values = fieldNames.map((f) => args[f]);

        db.execute(
          `INSERT INTO "${tableName}" (${fieldNames.map((f) => `"${f}"`).join(", ")}) VALUES (${placeholders.join(", ")})`,
          values,
        );

        // Fetch the newly created record
        const rows = db.query(
          `SELECT * FROM "${tableName}" ORDER BY "${pkField}" DESC LIMIT 1`,
        );
        return rows.length > 0 ? rows[0] : null;
      },
    );

    // Mutation: update
    const updateArgs: Record<string, string> = { id: "ID!", ...mutationArgs };
    this.addMutation(
      `update${className}`,
      updateArgs,
      className,
      (root, args) => {
        const db = getDb();
        const id = args.id;
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [k, v] of Object.entries(args)) {
          if (k !== "id") {
            setClauses.push(`"${k}" = ?`);
            values.push(v);
          }
        }

        if (setClauses.length === 0) return null;
        values.push(id);

        db.execute(
          `UPDATE "${tableName}" SET ${setClauses.join(", ")} WHERE "${pkField}" = ?`,
          values,
        );

        const rows = db.query(
          `SELECT * FROM "${tableName}" WHERE "${pkField}" = ?`,
          [id],
        );
        return rows.length > 0 ? rows[0] : null;
      },
    );

    // Mutation: delete
    this.addMutation(
      `delete${className}`,
      { id: "ID!" },
      "Boolean",
      (root, args) => {
        const db = getDb();
        const rows = db.query(
          `SELECT * FROM "${tableName}" WHERE "${pkField}" = ?`,
          [args.id],
        );
        if (rows.length === 0) return false;

        db.execute(
          `DELETE FROM "${tableName}" WHERE "${pkField}" = ?`,
          [args.id],
        );
        return true;
      },
    );

    return this;
  }

  // ── Private helpers ──────────────────────────────────────

  private formatArgs(args: Record<string, string>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";
    const parts = entries.map(([k, v]) => `${k}: ${v}`);
    return `(${parts.join(", ")})`;
  }

  private resolveField(
    sel: ParsedField,
    resolvers: Map<string, QueryConfig>,
    parent: unknown,
    variables: Record<string, unknown>,
    context: Record<string, unknown> = {},
  ): [unknown, Array<{ message: string; path?: string[] }>] {
    const errors: Array<{ message: string; path?: string[] }> = [];
    const name = sel.name;
    const args = this.resolveArgs(sel.args, variables);

    // Check directives (@auth, @role, @guest, @skip, @include)
    if (!this.checkDirectives(sel.directives ?? [], variables, context)) {
      return [null, errors];
    }

    let value: unknown = undefined;

    if (parent !== null && parent !== undefined) {
      if (typeof parent === "object" && parent !== null) {
        value = (parent as Record<string, unknown>)[name];
      }
    } else if (resolvers.has(name)) {
      const config = resolvers.get(name)!;

      // Input validation
      const validationErrors = this.validateArgs(args, config.args ?? {}, name);
      if (validationErrors.length > 0) {
        return [null, validationErrors];
      }

      // Inject sub-selections into context for DataLoader/eager-loading
      const ctx = { ...context, __selections: sel.selections ?? [] };
      try {
        value = config.resolver(null, args, ctx);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ message, path: [name] });
        return [null, errors];
      }
    }

    if (!sel.selections || sel.selections.length === 0) {
      return [value, errors];
    }

    if (Array.isArray(value)) {
      const result: Record<string, unknown>[] = [];
      for (const item of value) {
        const obj: Record<string, unknown> = {};
        for (const subSel of sel.selections) {
          const [subVal, subErrs] = this.resolveField(subSel, new Map(), item, variables, context);
          errors.push(...subErrs);
          obj[subSel.alias ?? subSel.name] = subVal;
        }
        result.push(obj);
      }
      return [result, errors];
    }

    if (value !== null && value !== undefined) {
      const obj: Record<string, unknown> = {};
      for (const subSel of sel.selections) {
        const [subVal, subErrs] = this.resolveField(subSel, new Map(), value, variables, context);
        errors.push(...subErrs);
        obj[subSel.alias ?? subSel.name] = subVal;
      }
      return [obj, errors];
    }

    return [null, errors];
  }

  private resolveArgs(
    args: Record<string, unknown>,
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "object" && v !== null && "$var" in v) {
        resolved[k] = variables[(v as { $var: string }).$var];
      } else if (Array.isArray(v)) {
        resolved[k] = v.map((i) => {
          if (typeof i === "object" && i !== null && "$var" in i) {
            return variables[(i as { $var: string }).$var];
          }
          return i;
        });
      } else {
        resolved[k] = v;
      }
    }
    return resolved;
  }

  /**
   * Check directives: @skip, @include, @auth, @role, @guest.
   * Returns true if the field should be included, false to skip.
   */
  private checkDirectives(
    directives: Array<{ name: string; args: Record<string, unknown> }>,
    variables: Record<string, unknown>,
    context: Record<string, unknown> = {},
  ): boolean {
    for (const d of directives) {
      let val = d.args?.if;
      if (typeof val === "object" && val !== null && "$var" in val) {
        val = variables[(val as { $var: string }).$var];
      }

      if (d.name === "skip" && val) return false;
      if (d.name === "include" && !val) return false;

      // Auth: @auth — requires any authenticated user
      if (d.name === "auth" && !context.user) return false;

      // Auth: @role(role: "admin") — requires specific role
      if (d.name === "role") {
        const required = d.args?.role;
        const user = context.user as Record<string, unknown> | undefined;
        const actual = user?.role ?? context.role;
        if (!required || actual !== required) return false;
      }

      // Auth: @guest — only for unauthenticated
      if (d.name === "guest" && context.user) return false;
    }
    return true;
  }

  /**
   * Validate resolved args against declared types.
   */
  private validateArgs(
    args: Record<string, unknown>,
    argConfigs: Record<string, string>,
    fieldName: string,
  ): Array<{ message: string; path?: string[] }> {
    const errors: Array<{ message: string; path?: string[] }> = [];

    for (const [argName, declaredType] of Object.entries(argConfigs)) {
      const parsed = GraphQLType.parse(declaredType);
      const value = args[argName];
      const isNonNull = parsed.kind === "non_null";
      const innerType = isNonNull ? parsed.ofType! : parsed;
      const baseName = innerType.kind === "list" ? "list" : innerType.name;

      if (isNonNull && (value === null || value === undefined || value === "")) {
        errors.push({
          message: `Argument '${argName}' on field '${fieldName}' is required (type: ${declaredType})`,
          path: [fieldName],
        });
        continue;
      }

      if (value === null || value === undefined) continue;

      if (baseName === "list" && Array.isArray(value)) {
        const itemType = innerType.ofType;
        if (itemType) {
          const itemName = itemType.kind === "non_null" ? (itemType.ofType?.name ?? "String") : itemType.name;
          for (let i = 0; i < value.length; i++) {
            if (!this.coerceValue(value[i], itemName)) {
              errors.push({
                message: `Argument '${argName}[${i}]' on field '${fieldName}' expected ${itemName}, got ${typeof value[i]}`,
                path: [fieldName],
              });
            }
          }
        }
        continue;
      }

      if (GraphQLType.SCALARS.includes(baseName)) {
        if (!this.coerceValue(value, baseName)) {
          errors.push({
            message: `Argument '${argName}' on field '${fieldName}' expected type ${baseName}, got ${typeof value}`,
            path: [fieldName],
          });
        }
      }
    }

    return errors;
  }

  private coerceValue(value: unknown, typeName: string): boolean {
    if (typeName === "String" || typeName === "ID") {
      return typeof value === "string" || typeof value === "number";
    }
    if (typeName === "Int") {
      if (typeof value === "boolean") return false;
      if (typeof value === "number") return Number.isInteger(value);
      if (typeof value === "string") return /^-?\d+$/.test(value);
      return false;
    }
    if (typeName === "Float") {
      if (typeof value === "boolean") return false;
      if (typeof value === "number") return true;
      if (typeof value === "string") return !isNaN(parseFloat(value));
      return false;
    }
    if (typeName === "Boolean") {
      return typeof value === "boolean" || value === 0 || value === 1
        || value === "true" || value === "false";
    }
    return true;
  }
}

/**
 * Lightweight GraphQL type wrapper matching Ruby's GraphQLType.
 */
export class GraphQLType {
  static readonly SCALARS = ["String", "Int", "Float", "Boolean", "ID"];

  name: string;
  kind: string;
  ofType: GraphQLType | null;

  constructor(name: string, kind: string = "object", ofType: GraphQLType | null = null) {
    this.name = name;
    this.kind = kind;
    this.ofType = ofType;
  }

  /**
   * Parse a GraphQL type string like "String", "String!", "[Int!]!".
   */
  static parse(typeStr: string): GraphQLType {
    const s = String(typeStr).trim();
    if (s.endsWith("!")) {
      const inner = GraphQLType.parse(s.slice(0, -1));
      return new GraphQLType(s, "non_null", inner);
    }
    if (s.startsWith("[") && s.endsWith("]")) {
      const inner = GraphQLType.parse(s.slice(1, -1));
      return new GraphQLType(s, "list", inner);
    }
    if (GraphQLType.SCALARS.includes(s)) {
      return new GraphQLType(s, "scalar");
    }
    return new GraphQLType(s, "object");
  }
}

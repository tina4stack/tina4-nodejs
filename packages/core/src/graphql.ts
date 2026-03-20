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

function tokenize(source: string): Token[] {
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

// ── GraphQL Engine ───────────────────────────────────────────

export class GraphQL {
  private types: Map<string, Record<string, GraphQLField>> = new Map();
  private queries: Map<string, QueryConfig> = new Map();
  private mutations: Map<string, QueryConfig> = new Map();

  constructor() {}

  /**
   * Register a named type with its fields.
   */
  addType(name: string, fields: Record<string, GraphQLField>): GraphQL {
    this.types.set(name, fields);
    return this;
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
   * Execute a GraphQL query string.
   */
  execute(query: string, variables?: Record<string, unknown>): GraphQLResult {
    const vars = variables ?? {};
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
      const [value, errs] = this.resolveField(sel, resolvers, null, vars);
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
   * Generate SDL schema string.
   */
  schema(): string {
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
  ): [unknown, Array<{ message: string; path?: string[] }>] {
    const errors: Array<{ message: string; path?: string[] }> = [];
    const name = sel.name;
    const args = this.resolveArgs(sel.args, variables);

    let value: unknown = undefined;

    if (parent !== null && parent !== undefined) {
      // Resolve from parent object
      if (typeof parent === "object" && parent !== null) {
        value = (parent as Record<string, unknown>)[name];
      }
    } else if (resolvers.has(name)) {
      const config = resolvers.get(name)!;
      try {
        value = config.resolver(null, args, {});
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ message, path: [name] });
        return [null, errors];
      }
    }

    // If no sub-selections, return the scalar value
    if (!sel.selections || sel.selections.length === 0) {
      return [value, errors];
    }

    // Handle list types
    if (Array.isArray(value)) {
      const result: Record<string, unknown>[] = [];
      for (const item of value) {
        const obj: Record<string, unknown> = {};
        for (const subSel of sel.selections) {
          const [subVal, subErrs] = this.resolveField(
            subSel,
            new Map(),
            item,
            variables,
          );
          errors.push(...subErrs);
          const key = subSel.alias ?? subSel.name;
          obj[key] = subVal;
        }
        result.push(obj);
      }
      return [result, errors];
    }

    // Handle object types
    if (value !== null && value !== undefined) {
      const obj: Record<string, unknown> = {};
      for (const subSel of sel.selections) {
        const [subVal, subErrs] = this.resolveField(
          subSel,
          new Map(),
          value,
          variables,
        );
        errors.push(...subErrs);
        const key = subSel.alias ?? subSel.name;
        obj[key] = subVal;
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
}

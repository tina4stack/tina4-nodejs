/**
 * One CRUD SQL builder for every engine, instead of one per adapter.
 *
 * Feature 3's last open item, the 4.3x LOC finding: `insert`/`update`/`delete`
 * built their SQL independently in all seven adapters. Building
 * `INSERT INTO x (a, b) VALUES (?, ?)` is not engine-specific work - Ruby has
 * always done it once - and the seven copies differed in exactly two ways:
 *
 *   IDENTIFIER QUOTING   "col"  |  `col`  |  [col]  |  Firebird's fbQuote
 *   PARAMETER MARKER     ?      |  $1     |  @p1
 *
 * Both are captured in a `Dialect` below, so the builders are shared and each
 * adapter declares only what genuinely differs about its engine.
 *
 * These functions build STRINGS and nothing else. Execution and result
 * extraction stay in the adapters on purpose: those really are per-driver
 * (`client.query` vs `lastInsertRowid` vs a Firebird transaction handle), and
 * folding them in here would trade a real duplication for a fake abstraction.
 *
 * MongoDB has no entry: it does not build SQL at all.
 */

/** How one engine spells identifiers and parameter markers. */
export interface Dialect {
  /** Quote a table or column name for this engine. */
  quote(name: string): string;
  /**
   * The parameter marker for the 1-based position `index`. Engines with
   * positional markers ($1, @p1) use the index; the rest ignore it.
   */
  marker(index: number): string;
}

const doubleQuote = (name: string): string => `"${name}"`;
const questionMark = (): string => "?";

/** SQLite, and ODBC which follows the SQL standard spelling. */
export const ANSI_DIALECT: Dialect = { quote: doubleQuote, marker: questionMark };

/** PostgreSQL: standard quoting, positional $N markers. */
export const POSTGRES_DIALECT: Dialect = {
  quote: doubleQuote,
  marker: (index) => `$${index}`,
};

/** MySQL: backtick quoting. */
export const MYSQL_DIALECT: Dialect = {
  quote: (name) => `\`${name}\``,
  marker: questionMark,
};

/** MSSQL: bracket quoting, named @pN markers. */
export const MSSQL_DIALECT: Dialect = {
  quote: (name) => `[${name}]`,
  marker: (index) => `@p${index}`,
};

/**
 * Firebird quotes only when it has to: an unquoted identifier is folded to
 * UPPER CASE, so quoting a lower-case name would make it unfindable. The
 * adapter owns that rule and passes its own quoter in.
 */
export function firebirdDialect(fbQuote: (name: string) => string): Dialect {
  return { quote: fbQuote, marker: questionMark };
}

/**
 * `INSERT INTO <table> (<cols>) VALUES (<markers>)`.
 *
 * @param suffix Appended verbatim - PostgreSQL passes " RETURNING *" and MSSQL
 *               its SCOPE_IDENTITY() probe, the genuinely engine-specific parts.
 * @param startAt Position of the FIRST marker. PostgreSQL numbers its `$N` from
 *                1; MSSQL names its `@pN` from 0 and BINDS by that same name, so
 *                shifting it would produce SQL whose parameters do not exist.
 *                Engines using `?` ignore this.
 */
export function buildInsert(
  dialect: Dialect,
  table: string,
  keys: string[],
  suffix = "",
  startAt = 1,
): string {
  const columns = keys.map((k) => dialect.quote(k)).join(", ");
  const placeholders = keys.map((_, i) => dialect.marker(startAt + i)).join(", ");
  return `INSERT INTO ${dialect.quote(table)} (${columns}) VALUES (${placeholders})${suffix}`;
}

/**
 * The `SET a = ?, b = ?` fragment of an UPDATE.
 *
 * @param startAt 1-based position of the FIRST marker. An UPDATE's WHERE
 *                clause continues the numbering after the SET values, so a
 *                positional engine ($N, @pN) must not restart at 1.
 */
export function buildSetClause(
  dialect: Dialect,
  keys: string[],
  startAt = 1,
): string {
  return keys
    .map((k, i) => `${dialect.quote(k)} = ${dialect.marker(startAt + i)}`)
    .join(", ");
}

/**
 * The `a = ? AND b = ?` fragment for an object filter.
 *
 * @param startAt 1-based position of the first marker, for the same reason as
 *                buildSetClause.
 */
export function buildWhereClause(
  dialect: Dialect,
  keys: string[],
  startAt = 1,
): string {
  return keys
    .map((k, i) => `${dialect.quote(k)} = ${dialect.marker(startAt + i)}`)
    .join(" AND ");
}

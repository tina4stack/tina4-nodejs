/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

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

/**
 * Quote a table/column name the ORM emits, in one engine's identifier quotes.
 *
 * Port of the Python master's `quote_identifier` (adapter.py; Firebird's
 * override upper-cases): idempotent (an already-quoted name is returned
 * unchanged), dot-aware (`schema.table` quotes each part), and a non-identifier
 * (`*`, `COUNT(*)`, an expression) is passed through untouched. An embedded
 * closing quote is doubled.
 *
 * `upperCase` is Firebird's rule: an unquoted identifier is stored UPPER CASE,
 * so a lower-case name must be quoted upper-case to match it.
 */
export function quoteIdentifierWith(name: string, open: string, close: string, upperCase = false): string {
  if (!name) return name;
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) return trimmed;
  if (trimmed.includes(".")) {
    return trimmed.split(".").map((part) => quoteIdentifierWith(part, open, close, upperCase)).join(".");
  }
  if (!/^[\p{L}\p{N}_$]+$/u.test(trimmed)) return trimmed;
  const body = upperCase ? trimmed.toUpperCase() : trimmed;
  return `${open}${body.split(close).join(close + close)}${close}`;
}

/** The ANSI default: `"name"` (SQLite, PostgreSQL, MSSQL, ODBC). */
export function quoteIdentifierAnsi(name: string): string {
  return quoteIdentifierWith(name, '"', '"');
}
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

const PLAIN_COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Refuse a data or filter-map key that is not a plain identifier.
 *
 * tina4: ADR-0069 (G3) - the write helpers emit these keys as column names, and
 * the dialect quoters do not escape, so a key must be a plain identifier
 * (letters, digits, underscore, dollar; not starting with a digit) before any
 * SQL is built. Valid names are emitted exactly as before. Table names are
 * developer code and are not checked here.
 */
export function assertColumnNames(keys: Iterable<string>): void {
  for (const key of keys) {
    if (!PLAIN_COLUMN_NAME.test(key)) throw new Error(`Invalid column name '${key}'`);
  }
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
  assertColumnNames(keys);
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
  assertColumnNames(keys);
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
  assertColumnNames(keys);
  return keys
    .map((k, i) => `${dialect.quote(k)} = ${dialect.marker(startAt + i)}`)
    .join(" AND ");
}

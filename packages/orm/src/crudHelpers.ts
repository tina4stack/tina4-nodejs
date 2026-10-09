/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Crud (ADR-0094) — the pure helpers behind the HTML admin page.
 *
 * No I/O, no templates, no DB: column/label/alignment derivation, safe-sort
 * resolution, the pre-joined table-data hash, the pagination controls, the
 * injected JS config, and the two linear SQL-listing parsers. Kept in their own
 * module so `crud.ts` stays a thin orchestrator and no single file carries the
 * whole feature (the second-pass split by concern).
 */

import { escapeHtml } from "../../frond/src/engine.js";

/** A BaseModel-like class: the statics Crud reads + the query statics it calls. */
export interface CrudModel {
  tableName: string;
  fields: Record<string, { type?: string; primaryKey?: boolean; [k: string]: unknown }>;
  fieldMapping?: Record<string, string>;
  softDelete?: boolean;
  tableFilter?: string;
  name?: string;
  all(limit?: number, offset?: number, include?: string[], orderBy?: string): Promise<any>;
  where(conditions: string, params?: unknown[], limit?: number, offset?: number, include?: string[], orderBy?: string): Promise<any>;
  count(conditions?: string, params?: unknown[]): Promise<number>;
}

/** Escape alias used throughout the CRUD HTML assembly. */
export const h = escapeHtml;

/** The DB column a property name maps to (fieldMapping or the property itself). */
export function columnOf(model: CrudModel, prop: string): string {
  return model.fieldMapping?.[prop] ?? prop;
}

/** The primary-key property name (the field flagged primaryKey, else "id"). */
export function primaryKeyProp(model: CrudModel): string {
  for (const [name, def] of Object.entries(model.fields)) {
    if (def.primaryKey) return name;
  }
  return "id";
}

/** The model's declared string/text property names. */
export function searchableProps(model: CrudModel): string[] {
  return Object.entries(model.fields)
    .filter(([, def]) => def.type === "string" || def.type === "text")
    .map(([name]) => name);
}

/** Column alignment from the field type: numeric right, everything else left. */
export function columnAlignment(model: CrudModel | null, col: string): string {
  const type = model?.fields?.[col]?.type;
  return type === "integer" || type === "number" || type === "float" || type === "decimal"
    ? "text-end"
    : "text-start";
}

/** Pretty label from a column name: "user_name" => "User Name". */
export function prettyLabel(col: string): string {
  return String(col)
    .split("_")
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * ADR-0069 safe sort: resolve the requested sort to a declared field PROPERTY
 * (the grid's headers + client state are keyed by property), else the primary
 * key. A request may name the field by its property or its mapped column; the
 * DB column for the ORDER BY is derived with columnOf(). A rendered page ignores
 * a bad sort rather than erroring.
 */
export function crudSortProp(model: CrudModel, requested: string | undefined, pkProp: string): string {
  const req = (requested ?? "").trim();
  if (req === "") return pkProp;
  if (Object.hasOwn(model.fields, req)) return req;
  for (const name of Object.keys(model.fields)) {
    if (columnOf(model, name) === req) return name;
  }
  return pkProp;
}

/** Read one column value from a record hash (keyed by property name). */
export function cellValue(record: Record<string, unknown>, col: string): unknown {
  return record[col];
}

/** Build the pre-joined <td> run for one row (every value escaped + aligned). */
export function buildCells(
  columns: string[],
  record: Record<string, unknown>,
  editable: boolean,
  aligns: string[],
): string {
  return columns
    .map((col, index) => {
      const raw = cellValue(record, col);
      const value = h(raw === null || raw === undefined ? "" : raw);
      const css = aligns[index];
      return editable
        ? `<td class="${css}" contenteditable="true" data-field="${h(col)}">${value}</td>`
        : `<td class="${css}">${value}</td>`;
    })
    .join("");
}

/**
 * Drop a trailing ORDER BY / LIMIT clause from each line of a custom listing SQL.
 * Pure string scanning — no backtracking regex.
 */
export function stripOrderAndLimit(sql: string): string {
  const cut = (line: string, keyword: string): string => {
    const hasNewline = line.endsWith("\n");
    const content = hasNewline ? line.slice(0, -1) : line;
    const at = content.toUpperCase().indexOf(keyword);
    if (at < 0) return line;
    const after = at + keyword.length;
    if (content.length <= after) return line;
    return content.slice(0, at) + (hasNewline ? "\n" : "");
  };
  return String(sql)
    .split(/(?<=\n)/)
    .map((line) => cut(cut(line, "ORDER BY "), "LIMIT "))
    .join("")
    .trim();
}

/**
 * The column names a custom listing SQL selects (for the search CAST LIKE).
 * Linear string scan: locate the first SELECT / FROM keywords (whitespace
 * bounded, case-insensitive) and split the projection on commas — no
 * backtracking regex over caller-supplied SQL (ReDoS-safe), mirroring the
 * Ruby master's plain-string SQL parsing.
 */
export function extractColumns(sql: string): string[] {
  const colsStr = selectProjection(sql);
  if (colsStr === null || colsStr === "*") return ["*"];
  return colsStr.split(",").map((c) => columnAlias(c.trim()));
}

/** The text between the first SELECT and its matching FROM, or null. */
function selectProjection(sql: string): string | null {
  const upper = sql.toUpperCase();
  const selectAt = keywordIndex(upper, "SELECT", 0);
  if (selectAt < 0) return null;
  const colsStart = selectAt + "SELECT".length;
  const fromAt = keywordIndex(upper, "FROM", colsStart);
  if (fromAt < 0) return null;
  return sql.slice(colsStart, fromAt).trim();
}

/** The alias/column name a single projection item resolves to. */
function columnAlias(trimmed: string): string {
  const asAt = keywordIndex(trimmed.toUpperCase(), "AS", 0);
  if (asAt >= 0) {
    const after = trimmed.slice(asAt + "AS".length).trim();
    const word = after.split(/[\s,]/, 1)[0];
    if (word) return word;
  }
  if (trimmed.includes(".")) return trimmed.split(".").pop()!.trim();
  return trimmed;
}

/**
 * Index of a whitespace-delimited keyword at or after `from`, or -1. Linear
 * scan; the keyword must be flanked by a boundary (string edge or whitespace)
 * so "FROM" inside "FROMAGE" never matches.
 */
function keywordIndex(upperHaystack: string, keyword: string, from: number): number {
  let at = upperHaystack.indexOf(keyword, from);
  while (at >= 0) {
    const afterIdx = at + keyword.length;
    const boundaryBefore = at === 0 || /\s/.test(upperHaystack[at - 1]);
    const boundaryAfter = afterIdx >= upperHaystack.length || /\s/.test(upperHaystack[afterIdx]);
    if (boundaryBefore && boundaryAfter) return at;
    at = upperHaystack.indexOf(keyword, at + 1);
  }
  return -1;
}

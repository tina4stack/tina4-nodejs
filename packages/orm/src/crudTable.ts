/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Crud (ADR-0094) — table + pagination assembly.
 *
 * The sort links, the pagination controls, the injected JS config, and the
 * pre-joined table-data hash the crud/table.twig template consumes. Split from
 * crudHelpers so neither file carries the whole feature (one concern per file).
 */

import {
  type CrudModel,
  h,
  columnAlignment,
  prettyLabel,
  cellValue,
  buildCells,
} from "./crudHelpers.js";

export function sortIndicator(sortCol: string, col: string, sortDir: string): string {
  if (String(sortCol) !== String(col)) return "";
  const arrow = sortDir === "asc" ? "&#9650;" : "&#9660;";
  return ` <span class="sort-indicator">${arrow}</span>`;
}

export function sortUrl(
  requestPath: string,
  col: string,
  nextDir: string,
  page: number,
  search: string,
  limit: number,
): string {
  const query =
    `sort=${encodeURIComponent(col)}&sort_dir=${nextDir}` +
    `&page=${page}&search=${encodeURIComponent(search)}&limit=${limit}`;
  return h(`${requestPath}?${query}`);
}

export function pageUrl(
  requestPath: string,
  p: number,
  search: string,
  sortCol: string,
  sortDir: string,
  limit: number,
): string {
  const query =
    `page=${p}&search=${encodeURIComponent(search)}` +
    `&sort=${encodeURIComponent(sortCol)}&sort_dir=${sortDir}&limit=${limit}`;
  return h(`${requestPath}?${query}`);
}

/** One flat list of pagination controls (Prev, numbered pages, Next). */
export function pageControls(
  page: number,
  totalPages: number,
  requestPath: string,
  search: string,
  sortCol: string,
  sortDir: string,
  limit: number,
): Array<Record<string, unknown>> {
  if (totalPages <= 1) return [];
  const controls: Array<Record<string, unknown>> = [];
  if (page > 1) {
    controls.push({
      label: "Prev", page: page - 1, active: false, inactive: true,
      url: pageUrl(requestPath, page - 1, search, sortCol, sortDir, limit),
    });
  }
  let startPage = Math.max(page - 3, 1);
  const endPage = Math.min(startPage + 6, totalPages);
  startPage = Math.max(endPage - 6, 1);
  for (let p = startPage; p <= endPage; p++) {
    controls.push({
      label: p, page: p, active: p === page, inactive: p !== page,
      url: pageUrl(requestPath, p, search, sortCol, sortDir, limit),
    });
  }
  if (page < totalPages) {
    controls.push({
      label: "Next", page: page + 1, active: false, inactive: true,
      url: pageUrl(requestPath, page + 1, search, sortCol, sortDir, limit),
    });
  }
  return controls;
}

/** The JSON config injected into the page's nonce'd <script>. */
export function jsConfig(opts: {
  apiPath: string; pk: string; columns: string[]; editable: string[]; model: CrudModel;
  limit: number; search: string; sortCol: string; sortDir: string; page: number;
}): string {
  const aligns: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const col of opts.columns) {
    aligns[col] = columnAlignment(opts.model, col);
    labels[col] = prettyLabel(col);
  }
  const config = {
    api: opts.apiPath,
    pk: opts.pk,
    columns: opts.columns,
    editable: opts.editable,
    aligns,
    labels,
    limit: opts.limit,
    search: opts.search,
    sort: opts.sortCol,
    sort_dir: opts.sortDir,
    page: opts.page,
  };
  // Unicode-escape < > & so the literal is safe inside the <script> element.
  return JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export interface TableDataOpts {
  columns: string[]; records: Array<Record<string, unknown>>; pk: string; tableName: string;
  editable: boolean; sortable: boolean; inlineScript: boolean; requestPath: string;
  search: string; sortCol: string; sortDir: string; page: number; limit: number;
  tableId: string | null; model: CrudModel | null;
}

/** Build one sortable/plain header cell for the given column. */
function headerCell(opts: TableDataOpts, col: string, align: string): Record<string, unknown> {
  const header: Record<string, unknown> = { label: h(prettyLabel(col)), align };
  if (!opts.sortable) {
    header.plain = true;
    return header;
  }
  const nextDir = String(opts.sortCol) === String(col) && opts.sortDir === "asc" ? "desc" : "asc";
  header.sortable = true;
  header.col = h(col);
  header.next_dir = nextDir;
  header.url = sortUrl(opts.requestPath, col, nextDir, opts.page, opts.search, opts.limit);
  header.indicator = sortIndicator(opts.sortCol, col, opts.sortDir);
  return header;
}

/** Build the data hash crud/table.twig consumes (headers + pre-joined rows). */
export function tableData(opts: TableDataOpts): Record<string, unknown> {
  const aligns = opts.columns.map((col) => columnAlignment(opts.model, col));
  const headers = opts.columns.map((col, index) => headerCell(opts, col, aligns[index]));
  const rows = opts.records.map((record) => ({
    id: h(cellValue(record, opts.pk) ?? ""),
    cells: buildCells(opts.columns, record, opts.editable, aligns),
  }));

  return {
    headers,
    rows,
    empty: opts.records.length === 0,
    colspan: opts.columns.length + 1,
    editable: opts.editable,
    readonly: !opts.editable,
    inline_script: opts.inlineScript,
    table_name: h(opts.tableName),
    table_id_attr: opts.tableId ? ` id="${h(opts.tableId)}"` : "",
  };
}


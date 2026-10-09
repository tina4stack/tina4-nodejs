/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Crud (ADR-0094) — a FRONTEND over AutoCrud.
 *
 * `Crud.toCrud(request, options)` renders a complete server-rendered admin UI
 * (searchable, sortable, paginated table + create/edit/delete modals) for an ORM
 * model. It owns NO backend routes: the entire REST backend (GET list, GET /{id},
 * POST, PUT, DELETE, secure-by-default) is delegated to AutoCrud, and the UI's
 * JavaScript talks to those routes over fetch(). The HTML comes from four
 * app-overridable Frond templates under `crud/` (page, table, form, modals),
 * resolved app-first-then-framework (the same convention the error pages use), so
 * an app restyles the admin by dropping its own `src/templates/crud/<name>.twig`.
 *
 * Lives in @tina4/orm (next to AutoCrud, the ORM it drives) rather than in the
 * eager @tina4/core barrel: Crud is an opt-in feature, not on every request
 * path, so it must not be pulled into core's import graph (lazyFeatureLoading).
 *
 * Node returns `Promise<string>` (the DB adapters are async); the Python/PHP/Ruby
 * entry points return a string. generateTable / generateForm stay synchronous.
 *
 * Usage:
 *   get("/admin/users", async (request, response) =>
 *     response.html(await Crud.toCrud(request, { model: User, title: "Users" }))
 *   ).secure();
 *
 * A custom `sql` only shapes the LISTING grid (a filter/join/projection); the
 * model still drives columns, the primary key, and every write path, so a custom
 * listing can never create an unauthenticated or divergent write route.
 */

import type { Tina4Request } from "../../core/src/types.js";
import { defaultRouter } from "../../core/src/router.js";
import { generateCrudRoutes } from "./autoCrud.js";
import { getAdapter, adapterQuery, adapterFetch } from "./database.js";
import {
  type CrudModel,
  h,
  columnOf,
  primaryKeyProp,
  searchableProps,
  crudSortProp,
  stripOrderAndLimit,
  extractColumns,
} from "./crudHelpers.js";
import { jsConfig, pageControls, tableData } from "./crudTable.js";
import { renderCrudTemplate, renderModals, generateTable, generateForm } from "./crudRender.js";

export type { CrudModel } from "./crudHelpers.js";
export type { FormFieldDef } from "./crudRender.js";
export { generateTable, generateForm } from "./crudRender.js";
export { stripOrderAndLimit } from "./crudHelpers.js";

export interface ToCrudOptions {
  /** REQUIRED — the ORM model class (a BaseModel subclass). */
  model: CrudModel;
  /** Optional listing query (inferred from the model when omitted); shapes only the displayed grid. */
  sql?: string;
  /** Page title (default "CRUD"). */
  title?: string;
  /** AutoCrud route prefix (default "/api"). */
  prefix?: string;
  /** Records per page (default 10). */
  limit?: number;
  /** When true, the AutoCrud write routes are OPEN (no auth). Default false (secure). */
  public?: boolean;
}

/** (prefix, table) pairs whose AutoCrud routes have already been registered. */
const registeredTables = new Set<string>();

/** Reset the registration cache (tests). */
export function _resetCrudRegistrations(): void {
  registeredTables.clear();
}

/** Build the DiscoveredModel shape generateCrudRoutes expects from a model class. */
function discoveredFrom(model: CrudModel): any {
  return {
    filePath: `src/models/${model.name ?? model.tableName}.ts`,
    modelClass: model,
    definition: {
      tableName: model.tableName,
      className: model.name,
      fields: model.fields,
      fieldMapping: model.fieldMapping,
      softDelete: (model as any).softDelete ?? false,
      tableFilter: (model as any).tableFilter,
      dbName: (model as any)._db,
    },
  };
}

/**
 * Delegate the ENTIRE backend to AutoCrud. Idempotent per (prefix, table):
 * the first registration wins (so a scaffolded route that opted writes public
 * is not later reset to secure), and addRoute replaces a route in place anyway.
 */
export async function registerBackend(
  model: CrudModel,
  options: { prefix?: string; public?: boolean } = {},
): Promise<void> {
  const prefix = options.prefix ?? "/api";
  const key = `${prefix}::${model.tableName}`;
  if (registeredTables.has(key)) return;

  const routes = generateCrudRoutes([discoveredFrom(model)], { public: options.public === true });
  for (const route of routes) defaultRouter.addRoute(route);
  registeredTables.add(key);
}

interface FetchOpts { search: string; sort: string; sortDir: string; limit: number; offset: number; }

/** Fetch a page of records from the model (ADR-0069 safe search + sort). */
async function fetchModelData(model: CrudModel, opts: FetchOpts): Promise<[Array<Record<string, unknown>>, number]> {
  const orderBy = `${opts.sort} ${opts.sortDir.toUpperCase()}`;
  const search = opts.search.trim();
  const searchable = search === "" ? [] : searchableProps(model);

  let rows: any;
  if (searchable.length === 0) {
    rows = await model.all(opts.limit, opts.offset, undefined, orderBy);
  } else {
    const whereClause = searchable.map((prop) => `${columnOf(model, prop)} LIKE ?`).join(" OR ");
    const params = searchable.map(() => `%${search}%`);
    rows = await model.where(whereClause, params, opts.limit, opts.offset, undefined, orderBy);
  }
  const total = typeof rows.getTotalRecords === "function" ? rows.getTotalRecords() : rows.length;
  const records = (rows as any[]).map((r) => (typeof r.toDict === "function" ? r.toDict() : r));
  return [records, total];
}

/** Fetch a page of rows for a custom listing SQL (shapes the DISPLAY only). */
async function fetchSqlData(sql: string, opts: FetchOpts): Promise<[Array<Record<string, unknown>>, number]> {
  let adapter: any;
  try {
    adapter = getAdapter();
  } catch {
    return [[], 0];
  }

  const base = stripOrderAndLimit(sql);
  const dir = opts.sortDir.toUpperCase();
  const search = opts.search.trim();

  if (search === "") {
    const countRow = await adapterQuery(adapter, `SELECT COUNT(*) as cnt FROM (${base}) AS _crud_cnt`, []);
    const total = Number(countRow[0]?.cnt ?? 0);
    const rows = await adapterFetch(adapter, `${base} ORDER BY ${opts.sort} ${dir}`, [], opts.limit, opts.offset);
    return [rows as Array<Record<string, unknown>>, total];
  }

  const columns = extractColumns(sql);
  const searchParts = columns.map((col) => `CAST(${col} AS TEXT) LIKE ?`);
  const params = columns.map(() => `%${search}%`);
  const countRow = await adapterQuery(
    adapter,
    `SELECT COUNT(*) as cnt FROM (${base}) AS _crud_cnt WHERE ${searchParts.join(" OR ")}`,
    params,
  );
  const total = Number(countRow[0]?.cnt ?? 0);
  const rows = await adapterFetch(
    adapter,
    `SELECT * FROM (${base}) AS _crud_sub WHERE ${searchParts.join(" OR ")} ORDER BY ${opts.sort} ${dir}`,
    params,
    opts.limit,
    opts.offset,
  );
  return [rows as Array<Record<string, unknown>>, total];
}

interface CrudRequest {
  page: number; search: string; sortProp: string; sortColumn: string; sortDir: string;
  offset: number; requestPath: string;
}

/** Parse pagination / search / safe-sort from the request query string. */
function parseCrudRequest(request: Tina4Request, model: CrudModel, pkProp: string, limit: number): CrudRequest {
  const query = (request && (request as any).query) || {};
  const page = Math.max(parseInt(String(query.page ?? "1"), 10) || 1, 1);
  const search = String(query.search ?? "").trim();
  const sortProp = crudSortProp(model, query.sort, pkProp);   // header/state key (property)
  const sortColumn = columnOf(model, sortProp);               // DB column for ORDER BY
  const sortDir = query.sort_dir === "desc" ? "desc" : "asc";
  const requestPath = (request && typeof (request as any).path === "string") ? (request as any).path : "/";
  return { page, search, sortProp, sortColumn, sortDir, offset: (page - 1) * limit, requestPath };
}

/** Clamp the configured records-per-page to a positive integer (default 10). */
function clampLimit(raw: number | undefined): number {
  const limit = Number(raw ?? 10);
  return !Number.isFinite(limit) || limit <= 0 ? 10 : limit;
}

/**
 * Render the CRUD admin page for `model` and register its AutoCrud routes.
 * Returns the rendered crud/page template.
 */
export async function toCrud(request: Tina4Request, options: ToCrudOptions): Promise<string> {
  const model = options.model;
  if (!model || !model.tableName || !model.fields) {
    throw new Error("Crud.toCrud requires a model (an ORM class)");
  }

  const sql = options.sql;
  const title = String(options.title ?? "CRUD");
  const prefix = String(options.prefix ?? "/api");
  const limit = clampLimit(options.limit);

  const tableName = String(model.tableName);
  const pkProp = primaryKeyProp(model);
  const columns = Object.keys(model.fields);

  // Backend: delegate 100% to AutoCrud (idempotent — register once).
  await registerBackend(model, { prefix, public: options.public });

  const req = parseCrudRequest(request, model, pkProp, limit);
  const fetchOpts: FetchOpts = {
    search: req.search, sort: req.sortColumn, sortDir: req.sortDir, limit, offset: req.offset,
  };
  const [records, total] = sql
    ? await fetchSqlData(sql, fetchOpts)
    : await fetchModelData(model, fetchOpts);

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const apiPath = `${prefix}/${tableName}`;
  const editableColumns = columns.filter((c) => c !== pkProp);

  const tableHtml = renderCrudTemplate(
    "table",
    tableData({
      columns, records, pk: pkProp, tableName, editable: false, sortable: true,
      inlineScript: false, requestPath: req.requestPath, search: req.search, sortCol: req.sortProp,
      sortDir: req.sortDir, page: req.page, limit, tableId: null, model,
    }),
  );

  return renderCrudTemplate("page", {
    title: h(title),
    search: h(req.search),
    request_path: h(req.requestPath),
    info_count: records.length,
    info_total: total,
    info_page: req.page,
    info_total_pages: totalPages,
    table_html: tableHtml,
    modals_html: renderModals(editableColumns, pkProp),
    show_pagination: totalPages > 1,
    controls: pageControls(req.page, totalPages, req.requestPath, req.search, req.sortProp, req.sortDir, limit),
    config_json: jsConfig({
      apiPath, pk: pkProp, columns, editable: editableColumns, model, limit,
      search: req.search, sortCol: req.sortProp, sortDir: req.sortDir, page: req.page,
    }),
  });
}

/** The public Crud surface (ADR-0094). `CRUD` is an uppercase alias. */
export const Crud = {
  toCrud,
  registerBackend,
  generateTable,
  generateForm,
  stripOrderAndLimit,
  _resetCrudRegistrations,
};

export const CRUD = Crud;

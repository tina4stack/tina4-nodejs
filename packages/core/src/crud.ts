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

import { existsSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Frond, escapeHtml, setCspNonceProvider } from "../../frond/src/engine.js";
import { defaultRouter } from "./router.js";
import { currentCspNonce } from "./csp.js";
import type { Tina4Request } from "./types.js";

/** A BaseModel-like class: the statics Crud reads + the query statics it calls. */
interface CrudModel {
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

/** Framework crud/ templates dir (ships with @tina4/core). */
const FRAMEWORK_TEMPLATES_DIR = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "templates");

/** Cache one Frond engine per template directory. */
const frondCache = new Map<string, InstanceType<typeof Frond>>();

function frondFor(dir: string): InstanceType<typeof Frond> {
  let engine = frondCache.get(dir);
  if (!engine) {
    // Make {{ csp_nonce() }} resolve to the current request's nonce (ADR-0088).
    setCspNonceProvider(currentCspNonce);
    engine = new Frond(dir);
    frondCache.set(dir, engine);
  }
  return engine;
}

/**
 * Render a crud/<name>.twig template, app-first-then-framework: an app override
 * at src/templates/crud/<name>.twig wins over the framework's shipped copy (the
 * same resolution the error pages use).
 */
function renderCrudTemplate(name: string, data: Record<string, unknown>): string {
  const templateFile = `crud/${name}.twig`;
  const userDir = pathResolve(process.cwd(), "src", "templates");
  if (existsSync(pathJoin(userDir, templateFile))) {
    return frondFor(userDir).render(templateFile, data);
  }
  return frondFor(FRAMEWORK_TEMPLATES_DIR).render(templateFile, data);
}

/** (prefix, table) pairs whose AutoCrud routes have already been registered. */
const registeredTables = new Set<string>();

/** Reset the registration cache (tests). */
export function _resetCrudRegistrations(): void {
  registeredTables.clear();
}

/** The DB column a property name maps to (fieldMapping or the property itself). */
function columnOf(model: CrudModel, prop: string): string {
  return model.fieldMapping?.[prop] ?? prop;
}

/** The primary-key property name (the field flagged primaryKey, else "id"). */
function primaryKeyProp(model: CrudModel): string {
  for (const [name, def] of Object.entries(model.fields)) {
    if (def.primaryKey) return name;
  }
  return "id";
}

/** The model's declared string/text property names. */
function searchableProps(model: CrudModel): string[] {
  return Object.entries(model.fields)
    .filter(([, def]) => def.type === "string" || def.type === "text")
    .map(([name]) => name);
}

/** Column alignment from the field type: numeric right, everything else left. */
function columnAlignment(model: CrudModel | null, col: string): string {
  const type = model?.fields?.[col]?.type;
  return type === "integer" || type === "number" || type === "float" || type === "decimal"
    ? "text-end"
    : "text-start";
}

/** Pretty label from a column name: "user_name" => "User Name". */
function prettyLabel(col: string): string {
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
function crudSortProp(model: CrudModel, requested: string | undefined, pkProp: string): string {
  const req = (requested ?? "").trim();
  if (req === "") return pkProp;
  if (Object.hasOwn(model.fields, req)) return req;
  for (const name of Object.keys(model.fields)) {
    if (columnOf(model, name) === req) return name;
  }
  return pkProp;
}

/** Read one column value from a record hash (keyed by property name). */
function cellValue(record: Record<string, unknown>, col: string): unknown {
  return record[col];
}

const h = escapeHtml;

/** Build the pre-joined <td> run for one row (every value escaped + aligned). */
function buildCells(
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

function sortIndicator(sortCol: string, col: string, sortDir: string): string {
  if (String(sortCol) !== String(col)) return "";
  const arrow = sortDir === "asc" ? "&#9650;" : "&#9660;";
  return ` <span class="sort-indicator">${arrow}</span>`;
}

function sortUrl(
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

function pageUrl(
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
function pageControls(
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
function jsConfig(opts: {
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

/** Build the data hash crud/table.twig consumes (headers + pre-joined rows). */
function tableData(opts: {
  columns: string[]; records: Array<Record<string, unknown>>; pk: string; tableName: string;
  editable: boolean; sortable: boolean; inlineScript: boolean; requestPath: string;
  search: string; sortCol: string; sortDir: string; page: number; limit: number;
  tableId: string | null; model: CrudModel | null;
}): Record<string, unknown> {
  const aligns = opts.columns.map((col) => columnAlignment(opts.model, col));

  const headers = opts.columns.map((col, index) => {
    const header: Record<string, unknown> = { label: h(prettyLabel(col)), align: aligns[index] };
    if (opts.sortable) {
      const nextDir = String(opts.sortCol) === String(col) && opts.sortDir === "asc" ? "desc" : "asc";
      header.sortable = true;
      header.col = h(col);
      header.next_dir = nextDir;
      header.url = sortUrl(opts.requestPath, col, nextDir, opts.page, opts.search, opts.limit);
      header.indicator = sortIndicator(opts.sortCol, col, opts.sortDir);
    } else {
      header.plain = true;
    }
    return header;
  });

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

  const orm = await import("../../orm/src/index.js");
  const routes = orm.generateCrudRoutes([discoveredFrom(model)], { public: options.public === true });
  for (const route of routes) defaultRouter.addRoute(route);
  registeredTables.add(key);
}

/** Fetch a page of records from the model (ADR-0069 safe search + sort). */
async function fetchModelData(
  model: CrudModel,
  opts: { search: string; sort: string; sortDir: string; limit: number; offset: number },
): Promise<[Array<Record<string, unknown>>, number]> {
  const orderBy = `${opts.sort} ${opts.sortDir.toUpperCase()}`;
  const search = opts.search.trim();
  const searchable = search === "" ? [] : searchableProps(model);

  let rows: any;
  if (search === "" || searchable.length === 0) {
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

/** Drop a trailing ORDER BY / LIMIT clause from each line of a custom listing SQL. */
export function stripOrderAndLimit(sql: string): string {
  const cut = (line: string, keyword: RegExp): string => {
    const hasNewline = line.endsWith("\n");
    const content = hasNewline ? line.slice(0, -1) : line;
    const match = keyword.exec(content);
    if (!match) return line;
    const at = match.index;
    const after = at + match[0].length;
    if (content.length <= after) return line;
    return content.slice(0, at) + (hasNewline ? "\n" : "");
  };
  return String(sql)
    .split(/(?<=\n)/)
    .map((line) => cut(cut(line, /ORDER BY /i), /LIMIT /i))
    .join("")
    .trim();
}

/** The column names a custom listing SQL selects (for the search CAST LIKE). */
function extractColumns(sql: string): string[] {
  const match = /SELECT\s+(.+?)\s+FROM/ims.exec(sql);
  if (!match) return ["*"];
  const colsStr = match[1].trim();
  if (colsStr === "*") return ["*"];
  return colsStr.split(",").map((c) => {
    const trimmed = c.trim();
    const asMatch = /\bAS\s+(\w+)/i.exec(trimmed);
    if (asMatch) return asMatch[1];
    if (trimmed.includes(".")) return trimmed.split(".").pop()!.trim();
    return trimmed;
  });
}

/** Fetch a page of rows for a custom listing SQL (shapes the DISPLAY only). */
async function fetchSqlData(
  sql: string,
  opts: { search: string; sort: string; sortDir: string; limit: number; offset: number },
): Promise<[Array<Record<string, unknown>>, number]> {
  const orm = await import("../../orm/src/index.js");
  let adapter: any;
  try {
    adapter = orm.getAdapter();
  } catch {
    return [[], 0];
  }

  const base = stripOrderAndLimit(sql);
  const dir = opts.sortDir.toUpperCase();
  const search = opts.search.trim();

  if (search === "") {
    const countRow = await orm.adapterQuery(adapter, `SELECT COUNT(*) as cnt FROM (${base}) AS _crud_cnt`, []);
    const total = Number(countRow[0]?.cnt ?? 0);
    const rows = await orm.adapterFetch(adapter, `${base} ORDER BY ${opts.sort} ${dir}`, [], opts.limit, opts.offset);
    return [rows as Array<Record<string, unknown>>, total];
  }

  const columns = extractColumns(sql);
  const searchParts = columns.map((col) => `CAST(${col} AS TEXT) LIKE ?`);
  const params = columns.map(() => `%${search}%`);
  const countRow = await orm.adapterQuery(
    adapter,
    `SELECT COUNT(*) as cnt FROM (${base}) AS _crud_cnt WHERE ${searchParts.join(" OR ")}`,
    params,
  );
  const total = Number(countRow[0]?.cnt ?? 0);
  const rows = await orm.adapterFetch(
    adapter,
    `SELECT * FROM (${base}) AS _crud_sub WHERE ${searchParts.join(" OR ")} ORDER BY ${opts.sort} ${dir}`,
    params,
    opts.limit,
    opts.offset,
  );
  return [rows as Array<Record<string, unknown>>, total];
}

/** A modal's create/edit form via crud/form.twig. */
function renderModalForm(mode: string, columns: string[], pk: string, edit: boolean): string {
  const fields = columns.map((col) => {
    const label = prettyLabel(col);
    return {
      id: `${mode}-${col}`,
      name: h(col),
      label: h(label),
      value: "",
      placeholder: h(`Enter ${label.toLowerCase()}`),
      type: "text",
      required_attr: "",
      input: true,
    };
  });
  return renderCrudTemplate("form", {
    wrap: true,
    form_id_attr: ` id="form-${mode}"`,
    action: "",
    form_method: "POST",
    method_override: null,
    edit,
    mode,
    pk: h(pk),
    modal_footer: true,
    submit_button: false,
    fields,
  });
}

/** Render the create/edit/delete modal shell (crud/modals.twig). */
function renderModals(editableColumns: string[], pk: string): string {
  return renderCrudTemplate("modals", {
    create_form: renderModalForm("create", editableColumns, pk, false),
    edit_form: renderModalForm("edit", editableColumns, pk, true),
  });
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
  let limit = Number(options.limit ?? 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 10;

  const tableName = String(model.tableName);
  const pkProp = primaryKeyProp(model);
  const columns = Object.keys(model.fields);

  // Backend: delegate 100% to AutoCrud (idempotent — register once).
  await registerBackend(model, { prefix, public: options.public });

  // Pagination / search / safe-sort from the query string.
  const query = (request && (request as any).query) || {};
  const page = Math.max(parseInt(String(query.page ?? "1"), 10) || 1, 1);
  const search = String(query.search ?? "").trim();
  const sortProp = crudSortProp(model, query.sort, pkProp);       // header/state key (property)
  const sortColumn = columnOf(model, sortProp);                    // DB column for ORDER BY
  const sortDir = query.sort_dir === "desc" ? "desc" : "asc";
  const offset = (page - 1) * limit;

  const [records, total] = sql
    ? await fetchSqlData(sql, { search, sort: sortColumn, sortDir, limit, offset })
    : await fetchModelData(model, { search, sort: sortColumn, sortDir, limit, offset });

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const apiPath = `${prefix}/${tableName}`;
  const requestPath = (request && typeof (request as any).path === "string") ? (request as any).path : "/";

  const editableColumns = columns.filter((c) => c !== pkProp);

  const tableHtml = renderCrudTemplate(
    "table",
    tableData({
      columns, records, pk: pkProp, tableName, editable: false, sortable: true,
      inlineScript: false, requestPath, search, sortCol: sortProp,
      sortDir, page, limit, tableId: null, model,
    }),
  );

  const modalsHtml = renderModals(editableColumns, pkProp);

  return renderCrudTemplate("page", {
    title: h(title),
    search: h(search),
    request_path: h(requestPath),
    info_count: records.length,
    info_total: total,
    info_page: page,
    info_total_pages: totalPages,
    table_html: tableHtml,
    modals_html: modalsHtml,
    show_pagination: totalPages > 1,
    controls: pageControls(page, totalPages, requestPath, search, sortProp, sortDir, limit),
    config_json: jsConfig({
      apiPath, pk: pkProp, columns, editable: editableColumns, model, limit,
      search, sortCol: sortProp, sortDir, page,
    }),
  });
}

/**
 * Render an HTML table fragment from an array of record hashes via crud/table.twig.
 * Inline-editable (contenteditable cells + Save/Delete wired by the template's
 * delegated listener). Synchronous — no model, no DB.
 */
export function generateTable(
  records: Array<Record<string, unknown>> | null | undefined,
  options: { tableName?: string; primaryKey?: string; editable?: boolean } = {},
): string {
  const rows = records ?? [];
  const tableName = String(options.tableName ?? "data");
  const primaryKey = String(options.primaryKey ?? "id");
  const editable = options.editable ?? true;
  const columns = rows.length === 0 ? [] : Object.keys(rows[0]);

  return renderCrudTemplate(
    "table",
    tableData({
      columns, records: rows, pk: primaryKey, tableName, editable, sortable: false,
      inlineScript: editable, requestPath: "", search: "", sortCol: "", sortDir: "asc",
      page: 1, limit: 10, tableId: `crud-${tableName}`, model: null,
    }),
  );
}

interface FormFieldDef {
  name: string;
  type?: string;
  label?: string;
  value?: unknown;
  required?: boolean;
  options?: Array<{ value: unknown; label: unknown }>;
}

function buildOptions(options: Array<{ value: unknown; label: unknown }> | undefined, selectedValue: unknown): string {
  return (options ?? [])
    .map((opt) => {
      const selected = String(opt.value) === String(selectedValue) ? " selected" : "";
      return `<option value="${h(opt.value)}"${selected}>${h(opt.label)}</option>`;
    })
    .join("");
}

function buildCustomField(field: FormFieldDef): Record<string, unknown> {
  const name = String(field.name ?? "");
  const label = field.label ?? (name.charAt(0).toUpperCase() + name.slice(1));
  const value = field.value;
  const requiredAttr = field.required ? " required" : "";

  const base: Record<string, unknown> = {
    id: h(name),
    name: h(name),
    label: h(String(label)),
    value: h(value ?? ""),
    placeholder: "",
    required_attr: requiredAttr,
  };

  switch (field.type ?? "string") {
    case "text":
      return { ...base, textarea: true };
    case "boolean":
      return { ...base, checkbox: true, checked_attr: value ? " checked" : "" };
    case "select":
      return { ...base, select: true, options_html: buildOptions(field.options, value) };
    case "date":
      return { ...base, input: true, type: "date" };
    case "integer":
    case "number":
    case "float":
    case "decimal":
      return { ...base, input: true, type: "number" };
    default:
      return { ...base, input: true, type: "text" };
  }
}

/**
 * Render an HTML form from a field-definition array via crud/form.twig.
 * Synchronous — no model, no DB.
 */
export function generateForm(
  fields: FormFieldDef[],
  options: { action?: string; method?: string; tableName?: string } = {},
): string {
  const verb = String(options.method ?? "POST").toUpperCase();
  return renderCrudTemplate("form", {
    wrap: true,
    form_id_attr: "",
    action: h(options.action ?? "/"),
    form_method: h(verb),
    method_override: ["PUT", "PATCH", "DELETE"].includes(verb) ? verb : null,
    edit: false,
    modal_footer: false,
    submit_button: true,
    fields: (fields ?? []).map((f) => buildCustomField(f)),
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

/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Crud (ADR-0094) — the Frond rendering layer of the HTML admin page.
 *
 * Resolves the crud/<name>.twig templates app-first-then-framework (an app copy
 * at src/templates/crud/ wins over the framework's shipped copy, the same
 * resolution the error pages use), caches one Frond engine per directory, and
 * exposes the two synchronous public generators (generateTable / generateForm)
 * plus the modal shell renderer toCrud uses.
 */

import { existsSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Frond, setCspNonceProvider } from "../../frond/src/engine.js";
import { currentCspNonce } from "../../core/src/csp.js";
import { h, prettyLabel } from "./crudHelpers.js";
import { tableData } from "./crudTable.js";

/**
 * Framework crud/ templates dir. The templates ship with @tina4/core
 * (packages/core/templates/crud); from this module (packages/orm/{src,dist})
 * that is two levels up then into core/templates — the same relative path in
 * both the monorepo source tree and the published dist layout.
 */
const FRAMEWORK_TEMPLATES_DIR = pathResolve(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "templates",
);

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
export function renderCrudTemplate(name: string, data: Record<string, unknown>): string {
  const templateFile = `crud/${name}.twig`;
  const userDir = pathResolve(process.cwd(), "src", "templates");
  if (existsSync(pathJoin(userDir, templateFile))) {
    return frondFor(userDir).render(templateFile, data);
  }
  return frondFor(FRAMEWORK_TEMPLATES_DIR).render(templateFile, data);
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
export function renderModals(editableColumns: string[], pk: string): string {
  return renderCrudTemplate("modals", {
    create_form: renderModalForm("create", editableColumns, pk, false),
    edit_form: renderModalForm("edit", editableColumns, pk, true),
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

export interface FormFieldDef {
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

/** The type-specific input descriptor layered onto the shared base field. */
function fieldInputShape(field: FormFieldDef, base: Record<string, unknown>): Record<string, unknown> {
  const value = field.value;
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

function buildCustomField(field: FormFieldDef): Record<string, unknown> {
  const name = String(field.name ?? "");
  const label = field.label ?? (name.charAt(0).toUpperCase() + name.slice(1));
  const base: Record<string, unknown> = {
    id: h(name),
    name: h(name),
    label: h(String(label)),
    value: h(field.value ?? ""),
    placeholder: "",
    required_attr: field.required ? " required" : "",
  };
  return fieldInputShape(field, base);
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

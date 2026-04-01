/**
 * CLI command: generate — Rich scaffolding for models, routes, migrations,
 * middleware, tests, forms, views, CRUD stacks, and auth.
 *
 * Usage:
 *   tina4nodejs generate model Product --fields "name:string,price:float"
 *   tina4nodejs generate route products --model Product
 *   tina4nodejs generate crud Product --fields "name:string,price:float"
 *   tina4nodejs generate migration create_product
 *   tina4nodejs generate middleware Auth
 *   tina4nodejs generate test products --model Product
 *   tina4nodejs generate form Product --fields "name:string,price:float"
 *   tina4nodejs generate view Product --fields "name:string,price:float"
 *   tina4nodejs generate auth
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Field type mapping ──────────────────────────────────────────────
const FIELD_TYPE_MAP: Record<string, { orm: string; sql: string; defaultVal: string }> = {
  string:   { orm: '"string"',   sql: "TEXT",    defaultVal: "''" },
  str:      { orm: '"string"',   sql: "TEXT",    defaultVal: "''" },
  int:      { orm: '"integer"',  sql: "INTEGER", defaultVal: "0" },
  integer:  { orm: '"integer"',  sql: "INTEGER", defaultVal: "0" },
  float:    { orm: '"number"',   sql: "REAL",    defaultVal: "0" },
  number:   { orm: '"number"',   sql: "REAL",    defaultVal: "0" },
  numeric:  { orm: '"number"',   sql: "REAL",    defaultVal: "0" },
  decimal:  { orm: '"number"',   sql: "REAL",    defaultVal: "0" },
  bool:     { orm: '"boolean"',  sql: "INTEGER", defaultVal: "0" },
  boolean:  { orm: '"boolean"',  sql: "INTEGER", defaultVal: "0" },
  text:     { orm: '"string"',   sql: "TEXT",    defaultVal: "''" },
  datetime: { orm: '"datetime"', sql: "TEXT",    defaultVal: "NULL" },
  blob:     { orm: '"string"',   sql: "BLOB",    defaultVal: "NULL" },
};

// ── Helpers ─────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeFileSafe(path: string, content: string): void {
  if (existsSync(path)) {
    console.log(`  File already exists: ${path}`);
    return;
  }
  writeFileSync(path, content, "utf-8");
  console.log(`  Created ${path}`);
}

export function toSnake(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function toTableName(name: string): string {
  return toSnake(name);
}

function toPlural(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith("s")) return lower;
  if (lower.endsWith("y") && !/[aeiou]y$/i.test(lower)) return lower.slice(0, -1) + "ies";
  return lower + "s";
}

function toCamel(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export function parseFields(fieldsStr: string): Array<[string, string]> {
  if (!fieldsStr || !fieldsStr.trim()) return [];
  const result: Array<[string, string]> = [];
  for (const part of fieldsStr.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes(":")) {
      const [fname, ftype] = trimmed.split(":", 2);
      result.push([fname.trim(), ftype.trim().toLowerCase()]);
    } else if (trimmed) {
      result.push([trimmed, "string"]);
    }
  }
  return result;
}

export function parseCliArgs(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(args[i]);
      i += 1;
    }
  }
  return { flags, positional };
}

function timestamp(): string {
  const now = new Date();
  return (
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0")
  );
}

function isoNow(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

// ── Main entry point ────────────────────────────────────────────────

export async function generate(what: string, name: string, extraArgs: string[] = []): Promise<void> {
  if (!what) {
    console.error("  Usage: tina4nodejs generate <what> <name> [options]");
    console.error("  Generators: model, route, crud, migration, middleware, test, form, view, auth");
    console.error('  Options:    --fields "name:string,price:float"  --model ModelName');
    process.exit(1);
  }

  // Auth doesn't require a name
  const noNameGenerators = new Set(["auth"]);
  if (!noNameGenerators.has(what) && !name) {
    console.error(`  Usage: tina4nodejs generate ${what} <name> [options]`);
    process.exit(1);
  }

  const { flags } = parseCliArgs(extraArgs);

  switch (what) {
    case "model":
      generateModel(name, flags);
      break;
    case "route":
      generateRoute(name, flags);
      break;
    case "crud":
      generateCrud(name, flags);
      break;
    case "migration":
      generateMigration(name, flags);
      break;
    case "middleware":
      generateMiddleware(name, flags);
      break;
    case "test":
      generateTest(name, flags);
      break;
    case "form":
      generateForm(name, flags);
      break;
    case "view":
      generateView(name, flags);
      break;
    case "auth":
      generateAuth(flags);
      break;
    default:
      console.error(`  Unknown generator: ${what}`);
      console.error("  Available: model, route, crud, migration, middleware, test, form, view, auth");
      process.exit(1);
  }
}

// ── Model ───────────────────────────────────────────────────────────

function generateModel(name: string, flags: Record<string, string | boolean>): void {
  const fields = parseFields((flags.fields as string) || "");
  const table = toTableName(name);
  const dir = resolve("src/models");
  ensureDir(dir);
  const path = join(dir, `${name}.ts`);

  // Build field definitions
  const fieldLines: string[] = [
    `    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },`,
  ];
  if (fields.length > 0) {
    for (const [fname, ftype] of fields) {
      const info = FIELD_TYPE_MAP[ftype] || FIELD_TYPE_MAP.string;
      fieldLines.push(`    ${fname}: { type: ${info.orm} as const },`);
    }
  } else {
    fieldLines.push(`    name: { type: "string" as const },`);
  }
  fieldLines.push(`    created_at: { type: "datetime" as const },`);

  const content = `import { BaseModel } from "tina4-nodejs";

export default class ${name} extends BaseModel {
  static tableName = "${table}";
  static fields = {
${fieldLines.join("\n")}
  };
}
`;

  writeFileSafe(path, content);

  // Generate matching migration unless --no-migration
  if (!flags["no-migration"]) {
    generateMigration(`create_${table}`, flags, fields.length > 0 ? fields : undefined, table);
  }
}

// ── Route ───────────────────────────────────────────────────────────

function generateRoute(name: string, flags: Record<string, string | boolean>): void {
  const routePath = name.replace(/^\//, "");
  const singular = routePath.endsWith("s") ? routePath.slice(0, -1) : routePath;
  const model = flags.model as string | undefined;
  const base = resolve("src/routes/api", routePath);
  const idDir = join(base, "[id]");
  ensureDir(base);
  ensureDir(idDir);

  const modelImport = model
    ? `import ${model} from "../../../models/${model}.js";\n`
    : "";

  // GET list
  if (model) {
    writeFileSafe(
      join(base, "get.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImport}
export const meta = { summary: "List all ${routePath}", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const page = parseInt(req.query?.page as string) || 1;
  const limit = parseInt(req.query?.limit as string) || 20;
  const offset = (page - 1) * limit;
  const results = await ${model}.select("SELECT * FROM ${toTableName(model)} LIMIT ? OFFSET ?", [limit, offset]);
  res.json({ data: results, page, limit });
}
`,
    );
  } else {
    writeFileSafe(
      join(base, "get.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "List all ${routePath}", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  res.json({ data: [] });
}
`,
    );
  }

  // POST create
  if (model) {
    writeFileSafe(
      join(base, "post.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImport}
export const meta = { summary: "Create a new ${singular}", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const item = new ${model}(req.body);
  await item.save();
  res.json({ data: item.toJSON() }, 201);
}
`,
    );
  } else {
    writeFileSafe(
      join(base, "post.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Create a new ${singular}", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  res.json({ data: req.body }, 201);
}
`,
    );
  }

  // GET by id
  if (model) {
    writeFileSafe(
      join(idDir, "get.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImport}
export const meta = { summary: "Get a ${singular} by ID", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  const item = await ${model}.selectOne("SELECT * FROM ${toTableName(model)} WHERE id = ?", [id]);
  if (!item) {
    res.json({ error: "Not found" }, 404);
    return;
  }
  res.json({ data: item });
}
`,
    );
  } else {
    writeFileSafe(
      join(idDir, "get.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Get a ${singular} by ID", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  res.json({ data: { id } });
}
`,
    );
  }

  // PUT by id
  if (model) {
    writeFileSafe(
      join(idDir, "put.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImport}
export const meta = { summary: "Update a ${singular} by ID", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  const item = await ${model}.selectOne("SELECT * FROM ${toTableName(model)} WHERE id = ?", [id]);
  if (!item) {
    res.json({ error: "Not found" }, 404);
    return;
  }
  const updated = new ${model}({ ...item, ...req.body, id });
  await updated.save();
  res.json({ data: updated.toJSON() });
}
`,
    );
  } else {
    writeFileSafe(
      join(idDir, "put.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Update a ${singular} by ID", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  res.json({ data: { ...req.body, id } });
}
`,
    );
  }

  // DELETE by id
  if (model) {
    writeFileSafe(
      join(idDir, "delete.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImport}
export const meta = { summary: "Delete a ${singular} by ID", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  const item = await ${model}.selectOne("SELECT * FROM ${toTableName(model)} WHERE id = ?", [id]);
  if (!item) {
    res.json({ error: "Not found" }, 404);
    return;
  }
  const record = new ${model}(item);
  await record.delete();
  res.json({ message: "deleted", id });
}
`,
    );
  } else {
    writeFileSafe(
      join(idDir, "delete.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Delete a ${singular} by ID", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  res.json({ message: "deleted", id });
}
`,
    );
  }
}

// ── CRUD ────────────────────────────────────────────────────────────

function generateCrud(name: string, flags: Record<string, string | boolean>): void {
  const table = toTableName(name);
  const routeName = toPlural(table);

  console.log(`\n  Generating CRUD for ${name}...\n`);

  // 1. Model + migration
  generateModel(name, flags);

  // 2. Routes with model
  generateRoute(routeName, { ...flags, model: name });

  // 3. Form
  generateForm(name, flags);

  // 4. View (list + detail)
  generateView(name, flags);

  // 5. Test
  generateTest(routeName, { ...flags, model: name });

  console.log(`\n  CRUD generation complete for ${name}.`);
  console.log("  Run: tina4nodejs migrate");
  console.log("  Visit: /swagger to see the API docs");
}

// ── Migration ───────────────────────────────────────────────────────

function generateMigration(
  name: string,
  flags: Record<string, string | boolean>,
  fieldsOverride?: Array<[string, string]>,
  tableOverride?: string,
): void {
  const ts = timestamp();
  const dir = resolve("migrations");
  ensureDir(dir);

  // Determine table name
  let table: string;
  if (tableOverride) {
    table = tableOverride;
  } else {
    table = name
      .replace(/^create_/, "")
      .replace(/^add_/, "")
      .replace(/^drop_/, "");
    table = toSnake(table);
  }

  // Build SQL columns from fields
  const fields = fieldsOverride || parseFields((flags.fields as string) || "");
  const isCreate = name.startsWith("create_") || fieldsOverride !== undefined;

  const fileName = `${ts}_${name}.sql`;
  const path = join(dir, fileName);

  let upSql: string;
  let downSql: string;

  if (isCreate) {
    const colLines = ["    id INTEGER PRIMARY KEY AUTOINCREMENT"];
    for (const [fname, ftype] of fields) {
      const info = FIELD_TYPE_MAP[ftype] || FIELD_TYPE_MAP.string;
      const defaultClause = info.defaultVal !== "NULL" ? ` DEFAULT ${info.defaultVal}` : "";
      colLines.push(`    ${fname} ${info.sql}${defaultClause}`);
    }
    colLines.push("    created_at TEXT DEFAULT CURRENT_TIMESTAMP");

    upSql = `CREATE TABLE IF NOT EXISTS ${table} (\n${colLines.join(",\n")}\n);`;
    downSql = `DROP TABLE IF EXISTS ${table};`;
  } else {
    upSql = `-- Write your UP migration SQL here\n-- Example: ALTER TABLE ${table} ADD COLUMN new_col TEXT DEFAULT '';`;
    downSql = `-- Write your DOWN rollback SQL here\n-- Example: ALTER TABLE ${table} DROP COLUMN new_col;`;
  }

  const now = isoNow();
  const content =
    `-- Migration: ${name}\n` +
    `-- Created: ${now}\n\n` +
    `-- UP\n${upSql}\n\n` +
    `-- DOWN\n${downSql}\n`;

  writeFileSafe(path, content);

  // Also create .down.sql
  const downPath = join(dir, `${ts}_${name}.down.sql`);
  const downContent =
    `-- Rollback: ${name}\n` +
    `-- Created: ${now}\n\n` +
    `${downSql}\n`;

  writeFileSafe(downPath, downContent);
}

// ── Middleware ───────────────────────────────────────────────────────

function generateMiddleware(name: string, flags: Record<string, string | boolean>): void {
  const snake = toSnake(name);
  const camel = toCamel(name);
  const dir = resolve("src/middleware");
  ensureDir(dir);
  const path = join(dir, `${snake}.ts`);

  const content = `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

/**
 * ${name} middleware — runs before and after route handlers.
 *
 * Usage:
 *   import { before${name}, after${name} } from "../middleware/${snake}.js";
 */

export async function before${name}(
  req: Tina4Request,
  res: Tina4Response,
  next: () => Promise<void>,
): Promise<void> {
  const auth = req.headers["authorization"];
  if (!auth) {
    res.json({ error: "Unauthorized" }, 401);
    return;
  }
  await next();
}

export async function after${name}(
  req: Tina4Request,
  res: Tina4Response,
  next: () => Promise<void>,
): Promise<void> {
  // Post-processing logic here (logging, header injection, etc.)
  await next();
}
`;

  writeFileSafe(path, content);
}

// ── Test ────────────────────────────────────────────────────────────

function generateTest(name: string, flags: Record<string, string | boolean>): void {
  const snake = toSnake(name);
  const singular = snake.endsWith("s") ? snake.slice(0, -1) : snake;
  const model = flags.model as string | undefined;

  const dir = resolve("tests");
  ensureDir(dir);
  const path = join(dir, `${snake}.test.ts`);

  let content: string;

  if (model) {
    content = `import { tests, assertTrue, assertEqual } from "tina4-nodejs";

/**
 * Tests for ${name} CRUD operations.
 */

const list${model}s = tests(
  assertTrue([]),
)(function list${model}s() {
  // TODO: implement list test
  return true;
});

const get${model} = tests(
  assertTrue([]),
)(function get${model}() {
  // TODO: implement get test
  return true;
});

const create${model} = tests(
  assertTrue([]),
)(function create${model}() {
  // TODO: implement create test
  return true;
});

const update${model} = tests(
  assertTrue([]),
)(function update${model}() {
  // TODO: implement update test
  return true;
});

const delete${model} = tests(
  assertTrue([]),
)(function delete${model}() {
  // TODO: implement delete test
  return true;
});
`;
  } else {
    const titleName = name.charAt(0).toUpperCase() + name.slice(1);
    content = `import { tests, assertTrue, assertEqual } from "tina4-nodejs";

/**
 * Tests for ${name}.
 */

const test${titleName} = tests(
  assertTrue([]),
)(function test${titleName}() {
  // TODO: implement test
  return true;
});
`;
  }

  writeFileSafe(path, content);
}

// ── Form ────────────────────────────────────────────────────────────

function generateForm(name: string, flags: Record<string, string | boolean>): void {
  const fields = parseFields((flags.fields as string) || "");
  const table = toTableName(name);
  const routeName = toPlural(table);

  const inputTypes: Record<string, string> = {
    string: "text", str: "text", text: "textarea",
    int: "number", integer: "number",
    float: "number", numeric: "number", decimal: "number",
    bool: "checkbox", boolean: "checkbox",
    datetime: "datetime-local", blob: "file",
  };

  const dir = resolve("src/templates/forms");
  ensureDir(dir);
  const path = join(dir, `${table}.twig`);

  // Build form fields
  const fieldEntries = fields.length > 0 ? fields : [["name", "string"] as [string, string]];
  let fieldHtml = "";
  for (const [fname, ftype] of fieldEntries) {
    const itype = inputTypes[ftype] || "text";
    const label = fname.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const step = ["float", "numeric", "decimal"].includes(ftype) ? ' step="0.01"' : "";

    if (itype === "textarea") {
      fieldHtml +=
        `    <div class="form-group mb-3">\n` +
        `        <label for="${fname}">${label}</label>\n` +
        `        <textarea id="${fname}" name="${fname}" class="form-control" rows="4"` +
        ` placeholder="${label}">{{ item.${fname} }}</textarea>\n` +
        `    </div>\n`;
    } else if (itype === "checkbox") {
      fieldHtml +=
        `    <div class="form-group mb-3">\n` +
        `        <label>\n` +
        `            <input type="checkbox" id="${fname}" name="${fname}" value="1"` +
        ` {% if item.${fname} %}checked{% endif %}>\n` +
        `            ${label}\n` +
        `        </label>\n` +
        `    </div>\n`;
    } else {
      fieldHtml +=
        `    <div class="form-group mb-3">\n` +
        `        <label for="${fname}">${label}</label>\n` +
        `        <input type="${itype}" id="${fname}" name="${fname}" class="form-control"` +
        `${step} value="{{ item.${fname} }}" placeholder="${label}">\n` +
        `    </div>\n`;
    }
  }

  const content =
    `{% extends "base.twig" %}\n` +
    `{% block title %}${name} {% if item.id %}Edit{% else %}Create{% endif %}{% endblock %}\n` +
    `{% block content %}\n` +
    `<div class="container mt-4">\n` +
    `    <h1>{% if item.id %}Edit ${name}{% else %}Create ${name}{% endif %}</h1>\n` +
    `    <form method="post" action="/api/${routeName}{% if item.id %}/{{ item.id }}{% endif %}">\n` +
    `        {{ form_token() }}\n` +
    fieldHtml +
    `    <button type="submit" class="btn btn-primary">\n` +
    `        {% if item.id %}Update{% else %}Create{% endif %}\n` +
    `    </button>\n` +
    `    <a href="/api/${routeName}" class="btn btn-secondary">Cancel</a>\n` +
    `    </form>\n` +
    `</div>\n` +
    `{% endblock %}\n`;

  writeFileSafe(path, content);
}

// ── View ────────────────────────────────────────────────────────────

function generateView(name: string, flags: Record<string, string | boolean>): void {
  const fields = parseFields((flags.fields as string) || "");
  const table = toTableName(name);
  const routeName = toPlural(table);

  const cols = fields.length > 0 ? fields.map(([f]) => f) : ["name"];

  const dir = resolve("src/templates/pages");
  ensureDir(dir);

  // List view
  const listPath = join(dir, `${routeName}.twig`);
  const th = cols.map((c) => `                <th>${c.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase())}</th>`).join("\n");
  const td = cols.map((c) => `                <td>{{ item.${c} }}</td>`).join("\n");

  const listContent =
    `{% extends "base.twig" %}\n` +
    `{% block title %}${name}s{% endblock %}\n` +
    `{% block content %}\n` +
    `<div class="container mt-4">\n` +
    `    <div class="d-flex justify-content-between align-items-center mb-3">\n` +
    `        <h1>${name}s</h1>\n` +
    `        <a href="/${routeName}/create" class="btn btn-primary">Add ${name}</a>\n` +
    `    </div>\n` +
    `    <table class="table">\n` +
    `        <thead>\n` +
    `            <tr>\n` +
    `                <th>ID</th>\n` +
    `${th}\n` +
    `                <th>Actions</th>\n` +
    `            </tr>\n` +
    `        </thead>\n` +
    `        <tbody>\n` +
    `        {% for item in items %}\n` +
    `            <tr>\n` +
    `                <td>{{ item.id }}</td>\n` +
    `${td}\n` +
    `                <td>\n` +
    `                    <a href="/${routeName}/{{ item.id }}" class="btn btn-sm btn-primary">View</a>\n` +
    `                    <a href="/${routeName}/{{ item.id }}/edit" class="btn btn-sm btn-secondary">Edit</a>\n` +
    `                </td>\n` +
    `            </tr>\n` +
    `        {% endfor %}\n` +
    `        </tbody>\n` +
    `    </table>\n` +
    `</div>\n` +
    `{% endblock %}\n`;

  writeFileSafe(listPath, listContent);

  // Detail view
  const detailPath = join(dir, `${table}.twig`);
  const detailFields = cols
    .map((c) => `    <div class="mb-3"><strong>${c.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase())}:</strong> {{ item.${c} }}</div>`)
    .join("\n");

  const detailContent =
    `{% extends "base.twig" %}\n` +
    `{% block title %}${name} Detail{% endblock %}\n` +
    `{% block content %}\n` +
    `<div class="container mt-4">\n` +
    `    <div class="d-flex justify-content-between align-items-center mb-3">\n` +
    `        <h1>${name} #{{ item.id }}</h1>\n` +
    `        <div>\n` +
    `            <a href="/${routeName}/{{ item.id }}/edit" class="btn btn-secondary">Edit</a>\n` +
    `            <a href="/${routeName}" class="btn btn-outline-secondary">Back</a>\n` +
    `        </div>\n` +
    `    </div>\n` +
    `${detailFields}\n` +
    `</div>\n` +
    `{% endblock %}\n`;

  writeFileSafe(detailPath, detailContent);
}

// ── Auth ────────────────────────────────────────────────────────────

function generateAuth(flags: Record<string, string | boolean>): void {
  console.log("\n  Generating authentication scaffolding...\n");

  // 1. User model + migration
  generateModel("User", { fields: "email:string,password:string,role:string" });

  // 2. Auth routes (file-based)
  const registerDir = resolve("src/routes/api/auth/register");
  const loginDir = resolve("src/routes/api/auth/login");
  const meDir = resolve("src/routes/api/auth/me");
  ensureDir(registerDir);
  ensureDir(loginDir);
  ensureDir(meDir);

  // POST /api/auth/register
  writeFileSafe(
    join(registerDir, "post.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import User from "../../../../models/User.js";

export const meta = { summary: "Register a new user", tags: ["auth"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { email, password } = req.body || {};

  if (!email || !password) {
    res.json({ error: "Email and password required" }, 400);
    return;
  }

  // Check if user exists
  const existing = await User.selectOne("SELECT * FROM user WHERE email = ?", [email]);
  if (existing) {
    res.json({ error: "Email already registered" }, 409);
    return;
  }

  // Create user (password should be hashed in production)
  const user = new User({ email, password, role: "user" });
  await user.save();
  res.json({ message: "Registered", id: user.toJSON().id }, 201);
}
`,
  );

  // POST /api/auth/login
  writeFileSafe(
    join(loginDir, "post.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import User from "../../../../models/User.js";

export const meta = { summary: "Login and receive JWT token", tags: ["auth"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { email, password } = req.body || {};

  if (!email || !password) {
    res.json({ error: "Email and password required" }, 400);
    return;
  }

  const user = await User.selectOne("SELECT * FROM user WHERE email = ?", [email]);
  if (!user) {
    res.json({ error: "Invalid credentials" }, 401);
    return;
  }

  // In production, compare hashed passwords
  if ((user as any).password !== password) {
    res.json({ error: "Invalid credentials" }, 401);
    return;
  }

  res.json({ message: "Logged in", email: (user as any).email });
}
`,
  );

  // GET /api/auth/me
  writeFileSafe(
    join(meDir, "get.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Get current authenticated user", tags: ["auth"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const auth = req.headers["authorization"];
  if (!auth) {
    res.json({ error: "Unauthorized" }, 401);
    return;
  }

  // In production, decode JWT and look up user
  res.json({ message: "Authenticated user profile" });
}
`,
  );

  // 3. Login template
  const formsDir = resolve("src/templates/forms");
  ensureDir(formsDir);

  writeFileSafe(
    join(formsDir, "login.twig"),
    `{% extends "base.twig" %}
{% block title %}Login{% endblock %}
{% block content %}
<div class="container mt-4" style="max-width:400px">
    <h1>Login</h1>
    <form method="post" action="/api/auth/login">
        {{ form_token() }}
        <div class="form-group mb-3">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" class="form-control" placeholder="you@example.com" required>
        </div>
        <div class="form-group mb-3">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" class="form-control" placeholder="Password" required>
        </div>
        <button type="submit" class="btn btn-primary w-100">Login</button>
        <p class="mt-3 text-center"><a href="/register">Create an account</a></p>
    </form>
</div>
{% endblock %}
`,
  );

  // 4. Register template
  writeFileSafe(
    join(formsDir, "register.twig"),
    `{% extends "base.twig" %}
{% block title %}Register{% endblock %}
{% block content %}
<div class="container mt-4" style="max-width:400px">
    <h1>Register</h1>
    <form method="post" action="/api/auth/register">
        {{ form_token() }}
        <div class="form-group mb-3">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" class="form-control" placeholder="you@example.com" required>
        </div>
        <div class="form-group mb-3">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" class="form-control" placeholder="Password" minlength="8" required>
        </div>
        <button type="submit" class="btn btn-primary w-100">Register</button>
        <p class="mt-3 text-center"><a href="/login">Already have an account?</a></p>
    </form>
</div>
{% endblock %}
`,
  );

  // 5. Auth test
  generateTest("auth", { model: "User" });

  console.log("\n  Authentication scaffolding complete.");
  console.log("  Run: tina4nodejs migrate");
  console.log("  POST /api/auth/register  — create account");
  console.log("  POST /api/auth/login     — get JWT token");
  console.log("  GET  /api/auth/me        — get profile (requires token)");
}

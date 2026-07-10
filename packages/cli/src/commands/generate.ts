/**
 * CLI command: generate — Rich, scaffolding-first code generation.
 *
 * Two shapes of generator:
 *   • CRUD-shaped (model, crud, migration, middleware, form, view, test, auth):
 *     emit WORKING code — the boilerplate IS the feature. A working extension
 *     point is flagged with a light `EXTEND:` marker (no throw).
 *   • LOGIC-shaped (custom route body, service, queue, validator, seeder,
 *     websocket, listener): emit the real WIRING (imports + registration +
 *     signature) plus a single greppable `AI-FILL` fill-spec that ends in
 *     `throw new Error("… not implemented")`, so an unfilled scaffold fails LOUD.
 *
 * Secure by default: the router gates every scaffolded WRITE (POST/PUT/DELETE)
 * behind a Bearer token automatically; reads (GET) are public automatically.
 * `--public` re-adds the opt-out (`export const secure = false;`) on the WRITE
 * method files only — mirroring the AutoCrud `public` opt-in.
 *
 * Usage:
 *   tina4nodejs generate model Product --fields "name:string,price:float"
 *   tina4nodejs generate route products --model Product [--public]
 *   tina4nodejs generate crud Product --fields "name:string,price:float" [--public]
 *   tina4nodejs generate migration create_product
 *   tina4nodejs generate middleware Auth
 *   tina4nodejs generate test products --model Product
 *   tina4nodejs generate form Product --fields "name:string,price:float"
 *   tina4nodejs generate view Product --fields "name:string,price:float"
 *   tina4nodejs generate auth
 *   tina4nodejs generate service Cleanup --every 5m | --cron "0 3 * * *"
 *   tina4nodejs generate queue order-emails
 *   tina4nodejs generate validator CreateUser
 *   tina4nodejs generate seeder Product
 *   tina4nodejs generate websocket chat
 *   tina4nodejs generate listener user.created
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/** slug-of-anything → PascalCase (order-emails → OrderEmails). */
export function toPascal(name: string): string {
  return name
    .split(/[^0-9a-zA-Z]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

export function parseFields(fieldsStr: string): Array<[string, string]> {
  if (!fieldsStr || !fieldsStr.trim()) return [];
  const result: Array<[string, string]> = [];
  for (const part of fieldsStr.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes(":")) {
      const [fname, ftype] = trimmed.split(":", 2);
      if (fname.trim()) result.push([fname.trim(), ftype.trim().toLowerCase()]);
    } else if (trimmed) {
      result.push([trimmed, "string"]);
    }
  }
  return result;
}

export function parseCliArgs(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  // Boolean-only flags that never take a value argument.
  const booleanFlags = new Set([
    "no-browser", "no-reload", "production", "managed", "all", "clear",
    "public", "no-migration",
  ]);

  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (booleanFlags.has(key)) {
        flags[key] = true;
        i += 1;
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
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

/**
 * Parse a `--every` duration ("5m", "30s", "2h", "1d", or bare seconds) → seconds.
 * Falls back to 60s on an empty/unparseable value so a scaffold always has a
 * valid ServiceRunner interval.
 */
export function parseEvery(every: string | boolean | undefined): number {
  if (!every || every === true) return 60;
  const s = String(every).trim().toLowerCase();
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const unit = s.slice(-1);
  if (unit in units) {
    const n = parseFloat(s.slice(0, -1));
    return Number.isFinite(n) ? Math.max(1, Math.round(n * units[unit])) : 60;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.max(1, Math.round(n)) : 60;
}

/**
 * The canonical AI-FILL placeholder for a LOGIC-shaped stub — a tight, grounded
 * fill-spec (not a vague `// TODO`) so a coding agent (or dev) completes it
 * correctly. `throw new Error(...)` makes an unfilled scaffold fail LOUD; the
 * greppable `AI-FILL` banner lets a human/agent jump to every gap. `use` names
 * only REAL tina4-nodejs symbols (verified in source).
 */
export function aiFill(
  fn: string,
  spec: { intent: string; given?: string; use: string; ret?: string; ground: string; raise: string },
  indent = "  ",
): string {
  const rule = (label: string) => "─".repeat(Math.max(4, 46 - label.length));
  const lines = [`${indent}// ─── AI-FILL: ${fn} ${rule(fn)}`];
  lines.push(`${indent}// Intent:  ${spec.intent}`);
  if (spec.given) lines.push(`${indent}// Given:   ${spec.given}`);
  lines.push(`${indent}// Use:     ${spec.use}`);
  if (spec.ret) lines.push(`${indent}// Return:  ${spec.ret}`);
  lines.push(`${indent}// Ground:  ${spec.ground}`);
  lines.push(`${indent}throw new Error(${JSON.stringify(spec.raise)});   // remove when implemented`);
  lines.push(`${indent}// ${"─".repeat(52)}`);
  return lines.join("\n") + "\n";
}

/**
 * The lighter EXTEND marker for CRUD-shaped WORKING code — no throw (the
 * boilerplate IS the feature); just a greppable hint at the natural extension
 * point (custom validation / business rules / authorization).
 */
export function extend(note: string, hint = "", indent = "  "): string {
  let out = `${indent}// ─── EXTEND: ${note} ${"─".repeat(Math.max(4, 46 - note.length))}\n`;
  if (hint) out += `${indent}// ${hint}\n`;
  return out;
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

// ── Generator registry — the single source of truth ─────────────────
//
// One entry per generator drives `generate` dispatch (below), the human help
// (`bin.ts` Generators section), AND the `commands --json` manifest's
// `generate.subcommands`. Add a generator in ONE place and it appears in
// dispatch, help, and discovery with no second list to keep in sync.
//
// Every handler is normalised to `(name, flags) => void`; `auth` takes no name
// so it drops it. Mirrors the Python master's GENERATORS registry
// (tina4_python/cli/__init__.py).

export interface GeneratorSpec {
  handler: (name: string, flags: Record<string, string | boolean>) => void;
  /** Arg/flag hint shown in `tina4nodejs help` (human only). */
  usage: string;
  summary: string;
}

export const GENERATORS: Record<string, GeneratorSpec> = {
  model:      { handler: generateModel,                     usage: '<Name> [--fields "name:string,price:float"]', summary: "ORM model + matching migration" },
  route:      { handler: generateRoute,                     usage: "<name> [--model Name] [--public]",            summary: "CRUD route file, secure by default (--public opens writes)" },
  crud:       { handler: generateCrud,                      usage: '<Name> [--fields "..."] [--public]',          summary: "Model + migration + routes + form + view + test" },
  migration:  { handler: (n, f) => generateMigration(n, f), usage: "<description>",                                summary: "Timestamped migration file (UP/DOWN)" },
  middleware: { handler: generateMiddleware,                usage: "<Name>",                                       summary: "Middleware with before/after hooks" },
  test:       { handler: generateTest,                      usage: "<name> [--model Name]",                        summary: "Test file" },
  form:       { handler: generateForm,                      usage: '<Name> [--fields "..."]',                      summary: "Form template with inputs matching model fields" },
  view:       { handler: generateView,                      usage: '<Name> [--fields "..."]',                      summary: "List + detail view templates" },
  auth:       { handler: (_n, f) => generateAuth(f),        usage: "",                                             summary: "Login/register routes (public) + User model + templates" },
  service:    { handler: generateService,                   usage: '<Name> [--every 5m | --cron "..."]',           summary: "Scheduled ServiceRunner task (src/services/)" },
  queue:      { handler: generateQueue,                     usage: "<topic>",                                      summary: "Producer + consumer daemon worker (src/services/)" },
  validator:  { handler: generateValidator,                 usage: "<Name>",                                       summary: "Request-body Validator (src/validators/)" },
  seeder:     { handler: generateSeeder,                    usage: "<Model>",                                      summary: "FakeData + seedOrm seeder (src/seeds/)" },
  websocket:  { handler: generateWebsocket,                 usage: "<path>",                                       summary: "websocket() handler (src/routes/)" },
  listener:   { handler: generateListener,                  usage: "<event>",                                      summary: "Events.on(event) listener (src/listeners/)" },
};

/** Comma-separated generator names for usage/error output — derived, never a hand-kept list. */
const GENERATOR_LIST = Object.keys(GENERATORS).join(", ");

// ── Main entry point ────────────────────────────────────────────────

export async function generate(what: string, name: string, extraArgs: string[] = []): Promise<void> {
  if (!what) {
    console.error("  Usage: tina4nodejs generate <what> <name> [options]");
    console.error(`  Generators: ${GENERATOR_LIST}`);
    console.error('  Options:    --fields "name:string,price:float"  --model ModelName');
    console.error("              --public                 open a route's writes (default: secure)");
    console.error('              --every 5m | --cron "…"   service schedule');
    process.exit(1);
  }

  // Auth doesn't require a name
  const noNameGenerators = new Set(["auth"]);
  if (!noNameGenerators.has(what) && !name) {
    console.error(`  Usage: tina4nodejs generate ${what} <name> [options]`);
    process.exit(1);
  }

  const { flags } = parseCliArgs(extraArgs);

  // Dispatch from the single-source-of-truth GENERATORS registry (also feeds
  // `bin.ts` help + the `commands --json` manifest subcommands).
  const spec = GENERATORS[what];
  if (spec) {
    spec.handler(name, flags);
  } else {
    console.error(`  Unknown generator: ${what}`);
    console.error(`  Available: ${GENERATOR_LIST}`);
    process.exit(1);
  }
}

// ── Model ───────────────────────────────────────────────────────────

function generateModel(name: string, flags: Record<string, string | boolean>, emitTest = true): void {
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

  // BaseModel is exported from tina4-nodejs/orm (NOT the core "tina4-nodejs"
  // entry) — importing it from the core entry yields `undefined` at runtime.
  const content = `import { BaseModel } from "tina4-nodejs/orm";

export default class ${name} extends BaseModel {
  static tableName = "${table}";
  static fields = {
${fieldLines.join("\n")}
  };
}
`;

  writeFileSafe(path, content);

  // Generate matching migration unless --no-migration. The model's own test
  // (below) proves the schema through the real ORM, so the migration sub-call
  // does NOT also co-emit a migration test (emitTest=false).
  if (!flags["no-migration"]) {
    generateMigration(`create_${table}`, flags, fields.length > 0 ? fields : undefined, table, false);
  }

  // Co-emit a real SQLite roundtrip test next to the model. Composite
  // generators (crud/auth) pass emitTest=false and emit their own broader test.
  if (emitTest) emitModelTest(name, table, fields);
}

// ── Route ───────────────────────────────────────────────────────────
//
// Secure by default. The router marks POST/PUT/DELETE `secure: true` unless the
// route def opts out; route discovery reads a module's `export const secure`
// into that def. So a scaffolded write is Bearer-gated with NOTHING emitted;
// `--public` emits `export const secure = false;` on the write files only.

/** The opt-out line for a WRITE method file when --public is set (else ""). */
function secureOptOut(isPublic: boolean): string {
  return isPublic ? `export const secure = false;\n\n` : "";
}

function generateRoute(name: string, flags: Record<string, string | boolean>, emitTest = true): void {
  const routePath = name.replace(/^\//, "");
  const singular = routePath.endsWith("s") ? routePath.slice(0, -1) : routePath;
  const model = flags.model as string | undefined;
  const isPublic = Boolean(flags.public);
  const base = resolve("src/routes/api", routePath);
  const idDir = join(base, "[id]");
  ensureDir(base);
  ensureDir(idDir);

  const table = model ? toTableName(model) : "";
  // Model import path is RELATIVE to the route file's directory. Files directly
  // under src/routes/api/<name>/ are 3 levels above src/models/; the [id]/ files
  // are one deeper (4 levels).
  const modelImportBase = model ? `import ${model} from "../../../models/${model}.js";\n` : "";
  const modelImportId = model ? `import ${model} from "../../../../models/${model}.js";\n` : "";

  const writeDoc = isPublic
    ? "Public (--public): no token required."
    : "Secure by default: requires a Bearer token (use --public to open).";

  // ── GET list (public) ──────────────────────────────────────────────
  if (model) {
    writeFileSafe(
      join(base, "get.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImportBase}
export const meta = { summary: "List all ${routePath}", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const rows = await ${model}.select("SELECT * FROM ${table} LIMIT ? OFFSET ?", [limit, offset]);
  res.json({ data: rows.map((r) => r.toObject()), page, limit });
}
`,
    );
  } else {
    writeFileSafe(
      join(base, "get.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "List all ${routePath}", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
${aiFill(`list_${routePath}`, {
  intent: `return the ${routePath} collection (add pagination if it grows)`,
  given: "req.query -> filters/paging",
  use: `Model.select("SELECT … LIMIT ? OFFSET ?", [limit, offset]) then r.toObject()`,
  ret: "res.json({ data: rows })",
  ground: `tina4_context("list ORM records with pagination", "nodejs") · skill tina4-developer-nodejs`,
  raise: `${routePath} list not implemented`,
})}}
`,
    );
  }

  // ── POST create (secure by default; --public opens it) ─────────────
  if (model) {
    writeFileSafe(
      join(base, "post.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImportBase}${secureOptOut(isPublic)}export const meta = { summary: "Create a new ${singular}", tags: ["${routePath}"] };

// ${writeDoc}
export default async function (req: Tina4Request, res: Tina4Response) {
${extend("validate / business rules before persist",
  `e.g. reject invalid input; ground: tina4_context("validate before create", "nodejs")`)}  const item = new ${model}(req.body as Record<string, unknown>);
  await item.save();
  res.json({ data: item.toObject() }, 201);
}
`,
    );
  } else {
    writeFileSafe(
      join(base, "post.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

${secureOptOut(isPublic)}export const meta = { summary: "Create a new ${singular}", tags: ["${routePath}"] };

// ${writeDoc}
export default async function (req: Tina4Request, res: Tina4Response) {
${aiFill(`create_${singular}`, {
  intent: `validate the body and persist a new ${singular}`,
  given: "req.body -> the posted fields",
  use: "new Model(req.body).save() then item.toObject()  (import your model)",
  ret: "res.json({ data: item }, 201)",
  ground: `tina4_context("create ORM record and return 201", "nodejs") · skill tina4-developer-nodejs`,
  raise: `create ${singular} not implemented`,
})}}
`,
    );
  }

  // ── GET by id (public) ─────────────────────────────────────────────
  if (model) {
    writeFileSafe(
      join(idDir, "get.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImportId}
export const meta = { summary: "Get a ${singular} by ID", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  const item = await ${model}.selectOne("SELECT * FROM ${table} WHERE id = ?", [id]);
  if (!item) {
    res.json({ error: "Not found" }, 404);
    return;
  }
  res.json({ data: item.toObject() });
}
`,
    );
  } else {
    writeFileSafe(
      join(idDir, "get.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Get a ${singular} by ID", tags: ["${routePath}"] };

export default async function (req: Tina4Request, res: Tina4Response) {
${aiFill(`get_${singular}`, {
  intent: `fetch one ${singular} by id`,
  given: "req.params.id -> the record id",
  use: `Model.selectOne("SELECT … WHERE id = ?", [req.params.id])`,
  ret: "res.json({ data: item }) or res.json({ error: 'Not found' }, 404)",
  ground: `tina4_context("find ORM record by id", "nodejs") · skill tina4-developer-nodejs`,
  raise: `get ${singular} not implemented`,
})}}
`,
    );
  }

  // ── PUT by id (secure by default; --public opens it) ───────────────
  if (model) {
    writeFileSafe(
      join(idDir, "put.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImportId}${secureOptOut(isPublic)}export const meta = { summary: "Update a ${singular} by ID", tags: ["${routePath}"] };

// ${writeDoc}
export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  const item = await ${model}.selectOne("SELECT * FROM ${table} WHERE id = ?", [id]);
  if (!item) {
    res.json({ error: "Not found" }, 404);
    return;
  }
${extend("guard which fields / who may update",
  `e.g. enforce ownership; ground: tina4_context("authorize update", "nodejs")`)}  Object.assign(item, req.body as Record<string, unknown>);
  await item.save();
  res.json({ data: item.toObject() });
}
`,
    );
  } else {
    writeFileSafe(
      join(idDir, "put.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

${secureOptOut(isPublic)}export const meta = { summary: "Update a ${singular} by ID", tags: ["${routePath}"] };

// ${writeDoc}
export default async function (req: Tina4Request, res: Tina4Response) {
${aiFill(`update_${singular}`, {
  intent: `load, mutate and save an existing ${singular}`,
  given: "req.params.id -> id; req.body -> changed fields",
  use: "Model.selectOne(…) then Object.assign(item, req.body) then item.save()",
  ret: "res.json({ data: item }) or 404",
  ground: `tina4_context("update ORM record", "nodejs") · skill tina4-developer-nodejs`,
  raise: `update ${singular} not implemented`,
})}}
`,
    );
  }

  // ── DELETE by id (secure by default; --public opens it) ────────────
  if (model) {
    writeFileSafe(
      join(idDir, "delete.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
${modelImportId}${secureOptOut(isPublic)}export const meta = { summary: "Delete a ${singular} by ID", tags: ["${routePath}"] };

// ${writeDoc}
export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  const item = await ${model}.selectOne("SELECT * FROM ${table} WHERE id = ?", [id]);
  if (!item) {
    res.json({ error: "Not found" }, 404);
    return;
  }
  await item.delete();
  res.json({ message: "deleted", id });
}
`,
    );
  } else {
    writeFileSafe(
      join(idDir, "delete.ts"),
      `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

${secureOptOut(isPublic)}export const meta = { summary: "Delete a ${singular} by ID", tags: ["${routePath}"] };

// ${writeDoc}
export default async function (req: Tina4Request, res: Tina4Response) {
${aiFill(`delete_${singular}`, {
  intent: `delete a ${singular} by id`,
  given: "req.params.id -> id",
  use: "Model.selectOne(…) then item.delete()",
  ret: "res.json({ message: 'deleted', id }) or 404",
  ground: `tina4_context("delete ORM record", "nodejs") · skill tina4-developer-nodejs`,
  raise: `delete ${singular} not implemented`,
})}}
`,
    );
  }

  // Co-emit a real test. A --model route is working code → the secure-by-default
  // gate test (reads public, writes gated, or open under --public). A no-model
  // route's handlers are loud AI-FILL stubs → the Router-registration + live-stub
  // test. Composite generators (crud) pass emitTest=false and emit their own.
  if (emitTest) {
    if (model) {
      generateTest(routePath, { model, "secure-writes": true, public: isPublic });
    } else {
      emitRouteStubTest(routePath);
    }
  }
}

// ── CRUD ────────────────────────────────────────────────────────────

function generateCrud(name: string, flags: Record<string, string | boolean>): void {
  const table = toTableName(name);
  const routeName = toPlural(table);
  const isPublic = Boolean(flags.public);

  console.log(`\n  Generating CRUD for ${name}...\n`);

  // 1. Model + migration (its own model test is suppressed — the gate test
  //    below is CRUD's single, broader co-emitted test).
  generateModel(name, flags, false);

  // 2. Routes with model — secure by default; thread --public through so
  //    `generate crud X --public` opens the writes (mirrors AutoCrud public).
  //    Route test suppressed (the gate test below covers the routes).
  generateRoute(routeName, { ...flags, model: name }, false);

  // 3. Form
  generateForm(name, flags);

  // 4. View (list + detail)
  generateView(name, flags);

  // 5. Test — real secure-by-default boot-gate (reads public, writes gated).
  generateTest(routeName, { model: name, "secure-writes": true, public: isPublic });

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
  emitTest = true,
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

  // Co-emit a real up/down migration test — only for CREATE migrations (a
  // placeholder ALTER migration has no asserted schema yet). Suppressed when a
  // model generates its matching migration (the model's own test covers schema).
  if (emitTest && isCreate) emitMigrationTest(name, table);
}

// ── Middleware ───────────────────────────────────────────────────────

function generateMiddleware(name: string, _flags: Record<string, string | boolean>): void {
  const snake = toSnake(name);
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
  emitMiddlewareTest(name, snake);
}

// ── Test ────────────────────────────────────────────────────────────

function generateTest(name: string, flags: Record<string, string | boolean>): void {
  const snake = toSnake(name);
  const singular = snake.endsWith("s") ? snake.slice(0, -1) : snake;
  const model = flags.model as string | undefined;

  const dir = resolve("tests");
  ensureDir(dir);
  const path = join(dir, `${snake}.test.ts`);

  // Secure-by-default CRUD gate test (emitted by `generate crud`): a REAL
  // boot-gate through TestClient over the generated file-based routes and a
  // real SQLite DB — reads public, writes gated (or open under --public). No
  // mocks: real Router, real auth gate, real DB. Grounded on
  // test/testClientAuth.test.ts + test/autoCrud.test.ts.
  if (model && flags["secure-writes"]) {
    const isPublic = Boolean(flags.public);
    const posture = isPublic ? "open (--public)" : "gated";
    const writeCase = isPublic
      ? `  // --public opened the write: an anonymous POST creates -> 201.
  assert("anonymous POST is public -> 201",
    (await client.post("/api/${snake}", { json: { name: "test" } })).status === 201);`
      : `  // Secure by default: a tokenless POST is rejected with 401.
  assert("anonymous POST is gated -> 401",
    (await client.post("/api/${snake}", { json: { name: "test" } })).status === 401);
  // A valid Bearer token passes the gate and creates -> 201.
  const token = getToken({ userId: 1 });
  assert("authenticated POST creates -> 201",
    (await client.post("/api/${snake}", { json: { name: "test" }, headers: { authorization: \`Bearer \${token}\` } })).status === 201);`;

    const content = `/**
 * ${name} CRUD — reads public, writes ${posture} (secure by default).
 *
 * Real end-to-end via TestClient: no mocks — real Router, real auth gate, real
 * JWT, real SQLite DB + table. Run with: npx tsx tests/${snake}.test.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, TestClient, getToken, discoverRoutes } from "tina4-nodejs";
import { initDatabase } from "tina4-nodejs/orm";
import ${model} from "../src/models/${model}.js";

process.env.TINA4_SECRET = process.env.TINA4_SECRET ?? "test-secret";
const here = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean): void {
  if (ok) { pass++; console.log(\`  PASS \${label}\`); }
  else { fail++; console.log(\`  FAIL \${label}\`); }
}

await initDatabase({ url: "sqlite:///data/test_${snake}.db" });
await ${model}.createTable();

const router = new Router();
for (const def of await discoverRoutes(resolve(here, "../src/routes"))) router.addRoute(def);
const client = new TestClient(router);

// Reads are public.
assert("GET list is public -> 200", (await client.get("/api/${snake}")).status === 200);
${writeCase}

console.log(\`\\nResults: \${pass} passed, \${fail} failed\`);
process.exit(fail > 0 ? 1 : 0);
`;
    writeFileSafe(path, content);
    return;
  }

  let content: string;

  if (model) {
    content = `import { tests, assertTrue } from "tina4-nodejs";

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

void [list${model}s, get${model}, create${model}, update${model}, delete${model}];
`;
  } else {
    const titleName = name.charAt(0).toUpperCase() + name.slice(1);
    content = `import { tests, assertTrue } from "tina4-nodejs";

/**
 * Tests for ${name}.
 */

const test${titleName} = tests(
  assertTrue([]),
)(function test${titleName}() {
  // TODO: implement test
  return true;
});

void test${titleName};
`;
  }

  writeFileSafe(path, content);
  void singular;
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

// ── Auth (login/register stay PUBLIC) ───────────────────────────────

function generateAuth(_flags: Record<string, string | boolean>): void {
  console.log("\n  Generating authentication scaffolding...\n");

  // 1. User model + migration (model test suppressed — the auth test below is
  //    the composite, broader co-emitted test).
  generateModel("User", { fields: "email:string,password:string,role:string" }, false);

  // 2. Auth routes (file-based). register + login are genuinely public — the
  //    user has no token yet — so they opt out of the write gate with
  //    `export const secure = false;`. `me` is a GET (public route) that
  //    authenticates the Bearer itself.
  const registerDir = resolve("src/routes/api/auth/register");
  const loginDir = resolve("src/routes/api/auth/login");
  const meDir = resolve("src/routes/api/auth/me");
  ensureDir(registerDir);
  ensureDir(loginDir);
  ensureDir(meDir);

  // POST /api/auth/register  (public)
  writeFileSafe(
    join(registerDir, "post.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { hashPassword } from "tina4-nodejs";
import User from "../../../../models/User.js";

// Public: registration mints an account for a user who has no token yet.
export const secure = false;

export const meta = { summary: "Register a new user", tags: ["auth"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };

  if (!email || !password) {
    res.json({ error: "Email and password required" }, 400);
    return;
  }

  const existing = await User.selectOne("SELECT * FROM user WHERE email = ?", [email]);
  if (existing) {
    res.json({ error: "Email already registered" }, 409);
    return;
  }

  const user = new User({ email, password: hashPassword(password), role: "user" });
  await user.save();
  res.json({ message: "Registered", id: user.toObject().id }, 201);
}
`,
  );

  // POST /api/auth/login  (public)
  writeFileSafe(
    join(loginDir, "post.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { checkPassword, getToken } from "tina4-nodejs";
import User from "../../../../models/User.js";

// Public: login authenticates by password and mints the token.
export const secure = false;

export const meta = { summary: "Login and receive JWT token", tags: ["auth"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };

  if (!email || !password) {
    res.json({ error: "Email and password required" }, 400);
    return;
  }

  const user = await User.selectOne("SELECT * FROM user WHERE email = ?", [email]);
  if (!user || !checkPassword(password, user.toObject().password as string)) {
    res.json({ error: "Invalid credentials" }, 401);
    return;
  }

  const data = user.toObject();
  const token = getToken({ userId: data.id, email: data.email, role: data.role });
  res.json({ token });
}
`,
  );

  // GET /api/auth/me  (public route; authenticates the Bearer itself)
  writeFileSafe(
    join(meDir, "get.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { authenticateRequest } from "tina4-nodejs";

export const meta = { summary: "Get current authenticated user", tags: ["auth"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const payload = authenticateRequest(req.headers as Record<string, string | string[] | undefined>);
  if (!payload) {
    res.json({ error: "Unauthorized" }, 401);
    return;
  }
  res.json({ user: payload });
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

  // 5. Auth test — real register / login / me end-to-end (no mocks).
  emitAuthTest();

  console.log("\n  Authentication scaffolding complete.");
  console.log("  Run: tina4nodejs migrate");
  console.log("  POST /api/auth/register  — create account (public)");
  console.log("  POST /api/auth/login     — get JWT token (public)");
  console.log("  GET  /api/auth/me        — get profile (requires token)");
}

// ── Service (scheduled background task — ServiceRunner) ──────────────
//
// Grounded on packages/core/src/service.ts: ServiceRunner.discover() imports
// each src/services/*.ts and reads `mod.default ?? mod` for
// { name, handler, interval?/timing?/daemon? }. handler receives a
// ServiceContext ({ running, lastRun, name }).

function generateService(name: string, flags: Record<string, string | boolean>): void {
  const snake = toSnake(name);
  const camel = toCamel(toPascal(name)) || snake;
  const cron = flags.cron;
  const dir = resolve("src/services");
  ensureDir(dir);
  const path = join(dir, `${snake}.ts`);

  let scheduleField: string;
  let note: string;
  if (cron && cron !== true) {
    scheduleField = `  timing: ${JSON.stringify(String(cron))},`;
    note = `cron '${cron}'`;
  } else {
    const seconds = parseEvery(flags.every);
    scheduleField = `  interval: ${seconds},`;
    note = `every ${seconds}s`;
  }

  const body = aiFill(`${camel}Task`, {
    intent: "do the scheduled work for this service",
    given: "context -> ServiceContext (.name, .running, .lastRun)",
    use: "your ORM / Api / Messenger code (re-run on schedule)",
    ground: `tina4_context("background service scheduled task", "nodejs") · skill tina4-developer-nodejs`,
    raise: `service ${snake} not implemented`,
  });

  const content = `import type { ServiceContext } from "tina4-nodejs";

/**
 * ${name} background service — runs ${note} via ServiceRunner.
 *
 * Wire a runner once (e.g. in app.ts) to actually run it — \`tina4nodejs serve\`
 * does NOT auto-start services:
 *
 *   import { ServiceRunner } from "tina4-nodejs";
 *   await ServiceRunner.discover("src/services");   // registers this default export
 *   ServiceRunner.start();
 */

export async function ${camel}Task(context: ServiceContext): Promise<void> {
${body}}

// Discovered by ServiceRunner.discover("src/services") — it reads name/handler
// (+ interval or timing) off this default export.
export default {
  name: "${snake}",
  handler: ${camel}Task,
${scheduleField}
};
`;

  writeFileSafe(path, content);
  emitServiceTest(name, snake, camel);
}

// ── Queue (producer + consumer worker) ──────────────────────────────
//
// Grounded on packages/core/src/queue.ts + job.ts: new Queue({ topic }),
// queue.produce(topic, payload) -> id, `for await (const job of
// queue.consume(topic))` yields QueueJob ({ payload, complete(), fail() }).
// The consumer is wired as a ServiceRunner daemon (it owns its own loop).

function generateQueue(name: string, _flags: Record<string, string | boolean>): void {
  const topic = name.replace(/^\//, "");
  const slug = toSnake(topic.replace(/[^0-9a-zA-Z]+/g, "_")).replace(/^_+|_+$/g, "") || "topic";
  const pascal = toPascal(topic) || "Topic";
  const dir = resolve("src/services"); // consumer runs as a daemon service
  ensureDir(dir);
  const path = join(dir, `${slug}_consumer.ts`);

  const body = aiFill(`handle${pascal}`, {
    intent: `process ONE ${topic} job payload`,
    given: "payload -> the produced job data (job.payload)",
    use: "your ORM / Messenger code; return to ack (job.complete), throw to nack (job.fail)",
    ground: `tina4_context("process a queue job", "nodejs") · skill tina4-developer-nodejs`,
    raise: `queue ${topic} handler not implemented`,
  });

  const content = `import { Queue } from "tina4-nodejs";
import type { ServiceContext } from "tina4-nodejs";

/**
 * ${topic} queue — producer + consumer worker.
 *
 * Produce from anywhere:  publish${pascal}({ ... })
 * The consumer is a long-running worker wired as a ServiceRunner daemon:
 *   await ServiceRunner.discover("src/services"); ServiceRunner.start();
 */

/** Enqueue a ${topic} job for the worker below to process. Returns the job id. */
export function publish${pascal}(payload: Record<string, unknown>): string {
  return new Queue({ topic: "${topic}" }).produce("${topic}", payload);
}

/** Process ONE ${topic} job payload. */
export async function handle${pascal}(payload: unknown): Promise<void> {
${body}}

/** Long-running ${topic} worker — consume() yields jobs; ack/nack each. */
export async function consume${pascal}(_context?: ServiceContext): Promise<void> {
  const queue = new Queue({ topic: "${topic}" });
  for await (const job of queue.consume("${topic}")) {
    const one = Array.isArray(job) ? job[0] : job;
    try {
      await handle${pascal}(one.payload);
      one.complete();          // ack — remove from the queue
    } catch (err) {
      one.fail(String(err));   // nack — retry / dead-letter
    }
  }
}

// Discovered by ServiceRunner.discover("src/services"); daemon:true because
// consume${pascal} owns its own loop. The topic + per-job handle keys let
// \`tina4nodejs queue work ${topic}\` drive this consumer directly (own the poll
// loop / bounded --once drain) without wiring a ServiceRunner.
export default {
  name: "${topic}-consumer",
  topic: "${topic}",
  handler: consume${pascal},
  handle: handle${pascal},
  daemon: true,
};
`;

  writeFileSafe(path, content);
  emitQueueTest(topic, slug, pascal);
}

// ── Validator (request-body Validator) ──────────────────────────────
//
// Grounded on packages/core/src/validator.ts: new Validator(data) is chainable
// (.required/.email/.minLength/.integer/.inList) and exposes .isValid()/.errors().

function generateValidator(name: string, _flags: Record<string, string | boolean>): void {
  const dir = resolve("src/validators");
  ensureDir(dir);
  const path = join(dir, `${toSnake(name)}.ts`);

  // Working-default: ship a real starter rule (required "name") so the
  // co-emitted valid/invalid test is GREEN on generation — a scaffolded test
  // that fails on creation is bad DX. Extend the rules for your own payload.
  const rules = extend(
    "add / adjust the validation rules for this payload",
    `e.g. .email("email").minLength("name", 2).integer("age"); ground: tina4_context("validate request body with Validator", "nodejs")`,
  );

  const content = `import { Validator } from "tina4-nodejs";

/**
 * Validate a ${name} payload. Returns a Validator (chainable rules).
 *
 * Usage in a route:
 *   const v = validate${toPascal(name)}(req.body as Record<string, unknown>);
 *   if (!v.isValid()) return res.json({ error: v.errors()[0]?.message }, 400);
 */
export function validate${toPascal(name)}(data: Record<string, unknown>): Validator {
  const validator = new Validator(data);
${rules}  validator.required("name");   // starter rule (matches the model's default field)
  return validator;
}
`;

  writeFileSafe(path, content);
  emitValidatorTest(name, toSnake(name), toPascal(name));
}

// ── Seeder (FakeData + seedOrm) ─────────────────────────────────────
//
// Grounded on packages/orm/src/seeder.ts (seedOrm(model, count, overrides) —
// overrides may be static values OR (fake) => value callables) and
// packages/cli/src/commands/seed.ts (runs each src/seeds/*.ts as a script).

function generateSeeder(name: string, _flags: Record<string, string | boolean>): void {
  const table = toTableName(name);
  const dir = resolve("src/seeds");
  ensureDir(dir);
  const path = join(dir, `${table}_seeder.ts`);

  // Working-default: return {} so seedOrm auto-fills every field by type/name
  // and the co-emitted rows-created test is GREEN on generation. Override the
  // fields that need a specific shape below.
  const overrides = extend(
    "override fields that need a specific shape (seedOrm auto-fills the rest)",
    `e.g. return { email: (f) => f.email(), status: "active" }; ground: tina4_context("seed ORM model with FakeData", "nodejs")`,
  );

  const content = `import { pathToFileURL } from "node:url";
import { FakeData, seedOrm, initDatabase } from "tina4-nodejs/orm";
import ${name} from "../models/${name}.js";

/**
 * Seeder for ${name} — run with: tina4nodejs seed
 *
 * seedOrm auto-fills every field by type/name; override the ones that need a
 * specific shape below. Each callable receives a FakeData instance.
 */
export function fieldOverrides(fake: FakeData): Record<string, unknown> {
${overrides}  void fake;   // available for overrides above
  return {};
}

/** Seed rows. Invoked when this file is run directly by \`tina4nodejs seed\`. */
export async function run(): Promise<void> {
  await initDatabase({ url: process.env.TINA4_DATABASE_URL ?? "sqlite:///data/app.db" });
  const summary = await seedOrm(${name} as never, 20, fieldOverrides(new FakeData()));
  console.log(\`Seeded \${summary.seeded} ${name} row(s), \${summary.failed} failed\`);
}

// Only seed when executed as a script (\`tina4nodejs seed\` runs it via tsx) —
// importing this module (e.g. in a test) must NOT trigger seeding.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
`;

  writeFileSafe(path, content);
  emitSeederTest(name, table);
}

// ── WebSocket route ─────────────────────────────────────────────────
//
// Grounded on packages/core/src/router.ts (websocket(path, handler).secure())
// + types.ts (handler is (connection, event, data)) + websocketConnection.ts
// (.send/.sendJson/.broadcast/.close/.params). Node has NO file-based WS
// auto-discovery — the module must be imported to register (see the doc block).

function generateWebsocket(name: string, _flags: Record<string, string | boolean>): void {
  const raw = name.trim();
  const wsPath = raw.startsWith("/") ? raw : "/ws/" + raw.replace(/^\/+/, "");
  let slug = toSnake(raw.replace(/^\/+|\/+$/g, "").replace(/[^0-9a-zA-Z]+/g, "_")).replace(/^_+|_+$/g, "") || "ws";
  const base = slug.startsWith("ws_") ? slug.slice(3) : slug;
  const handlerName = `${toCamel(toPascal(base))}Ws`;
  const dir = resolve("src/routes");
  ensureDir(dir);
  const path = join(dir, `ws_${base}.ts`);

  const body = aiFill(handlerName, {
    intent: `handle an inbound "message" frame on ${wsPath}`,
    given: "data -> the message payload (string); connection -> WebSocketConnection",
    use: "connection.broadcast(data)  or  connection.sendJson({ ... })",
    ground: `tina4_context("websocket broadcast message", "nodejs") · skill tina4-developer-nodejs`,
    raise: `websocket ${wsPath} not implemented`,
  });

  const content = `import { websocket } from "tina4-nodejs";
import type { WebSocketConnection } from "tina4-nodejs";

/**
 * ${wsPath} WebSocket route.
 *
 * Registered on import by websocket(). Node has NO file-based WS
 * auto-discovery, so IMPORT this module once from app.ts to activate it (add
 * \`.secure()\` to require a JWT on the upgrade):
 *
 *   import "./src/routes/ws_${base}.js";
 *
 * The server invokes the handler as (connection, event, data) for each event:
 * "open" (connect), "message" (inbound frame), "close" (disconnect).
 */
export async function ${handlerName}(
  connection: WebSocketConnection,
  event: "open" | "message" | "close",
  data: string,
): Promise<void> {
  if (event === "open") {
    connection.sendJson({ type: "welcome" });
    return;
  }
  if (event === "close") {
    return;
  }
  // event === "message"
${body}}

websocket("${wsPath}", ${handlerName});
`;

  writeFileSafe(path, content);
  emitWebsocketTest(wsPath, base, handlerName);
}

// ── Event listener ──────────────────────────────────────────────────
//
// Grounded on packages/core/src/events.ts: Events.on(event, cb) registers,
// Events.emit(event, ...args) fires, Events.listeners(event) reads them. Node
// has NO src/listeners/ auto-discovery — import the module to register.

function generateListener(name: string, _flags: Record<string, string | boolean>): void {
  const event = name.trim();
  const slug = toSnake(event.replace(/[^0-9a-zA-Z]+/g, "_")).replace(/^_+|_+$/g, "") || "event";
  const handlerName = `on${toPascal(slug)}`;
  const dir = resolve("src/listeners");
  ensureDir(dir);
  const path = join(dir, `${slug}.ts`);

  const body = aiFill(handlerName, {
    intent: `react to the '${event}' event`,
    given: `args -> whatever Events.emit("${event}", ...args) passed`,
    use: "your app code — Messenger().send(...), an ORM write, or Events.emit(...) a follow-up",
    ground: `tina4_context("event listener reaction", "nodejs") · skill tina4-developer-nodejs`,
    raise: `listener ${event} not implemented`,
  });

  const content = `import { Events } from "tina4-nodejs";

/**
 * Listener for the '${event}' event.
 *
 * Registered on import by Events.on(). Node has NO src/listeners/
 * auto-discovery, so IMPORT this module once from app.ts to activate it:
 *
 *   import "./src/listeners/${slug}.js";
 *
 * Fires when something calls Events.emit("${event}", ...args).
 */
export function ${handlerName}(...args: unknown[]): void {
${body}}

Events.on("${event}", ${handlerName});
`;

  writeFileSafe(path, content);
  emitListenerTest(event, slug);
}

// ══════════════════════════════════════════════════════════════════════
// Co-emitted test builders — every code-producing generator emits a REAL,
// green, no-mock `*.test.ts` next to its scaffold (self-describing CLI epic,
// Phase 4). Mirrors the Python master's `_write_test` + `_emit_*_test` builders
// (tina4_python/cli/__init__.py): ONE shared writer + ONE focused builder per
// generator (not copy-pasted blobs). Each exercises a DIFFERENT real subsystem
// (real SQLite / TestClient / Router / MiddlewareChain / ServiceRunner / Queue /
// event bus). CRUD-shaped scaffolds (working code) get behavioural tests;
// logic-shaped scaffolds (loud AI-FILL stubs) get real wiring tests + a lock-in
// that the placeholder fails loud. form/view are template-only → exempt (no
// test); `test` itself is exempt (it IS the test generator).
// ══════════════════════════════════════════════════════════════════════

/**
 * The SINGLE place a co-emitted test is written — `tests/<name>.test.ts`
 * (Node's `*.test.ts` convention, discovered by `tsx test/run-all.ts`). Shares
 * writeFileSafe's overwrite-refusal + the same "Created …" line every generator
 * prints. Generalized from generateTest so builders share one rule.
 */
function writeTest(testName: string, content: string): void {
  const dir = resolve("tests");
  ensureDir(dir);
  writeFileSafe(join(dir, `${testName}.test.ts`), content);
}

/**
 * Assemble a standalone-tsx test: doc header + shared pass/fail tally + body +
 * summary line + `process.exit`. This is the project's test convention (each
 * file self-tallies and exits), so `tsx test/run-all.ts` — and the co-emit
 * meta-test — pick the emitted file up and read its "Results: N passed, M
 * failed" line. Grounded on the existing secure-gate CRUD test format.
 */
function standaloneTest(doc: string, body: string): string {
  return `${doc}

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean): void {
  if (ok) { pass++; console.log(\`  PASS \${label}\`); }
  else { fail++; console.log(\`  FAIL \${label}\`); }
}
async function assertThrows(label: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try { await fn(); assert(label, false); }
  catch { assert(label, true); }
}

${body}

console.log(\`\\nResults: \${pass} passed, \${fail} failed\`);
process.exit(fail > 0 ? 1 : 0);
`;
}

/** A source-text literal that is a valid value for a scaffolded field type. */
function sampleLiteral(fieldType: string): string {
  switch ((fieldType || "string").toLowerCase()) {
    case "int": case "integer": return "1";
    case "float": case "number": case "numeric": case "decimal": return "1.5";
    case "bool": case "boolean": return "true";
    case "datetime": return '"2020-01-01 00:00:00"';
    case "blob": return '"x"';
    default: return '"sample"';
  }
}

/** model → real SQLite roundtrip (create / read back / missing → null). */
function emitModelTest(model: string, table: string, fields: Array<[string, string]>): void {
  const flds = fields.length > 0 ? fields : [["name", "string"] as [string, string]];
  const payload = flds.map(([f, t]) => `${f}: ${sampleLiteral(t)}`).join(", ");
  const stringField = flds.find(([, t]) => ["string", "str", "text"].includes((t || "string").toLowerCase()))?.[0];
  const valueAssert = stringField
    ? `\nassert("string field round-trips", fetched !== null && (fetched.toObject() as Record<string, unknown>).${stringField} === "sample");`
    : "";
  const doc = `/**
 * Real ORM roundtrip for ${model} — no mocks, real SQLite.
 *
 * Generated with src/models/${model}.ts by \`tina4nodejs generate model
 * ${model}\`. The model scaffold is working code, so this passes on generation:
 * binds a real in-memory SQLite DB, creates the table, saves a row, reads it
 * back. Run with: npx tsx tests/${table}_model.test.ts
 */
import ${model} from "../src/models/${model}.js";
import { initDatabase } from "tina4-nodejs/orm";`;
  const body = `await initDatabase({ url: "sqlite:///:memory:" });
await ${model}.createTable();

const row = new ${model}({ ${payload} });
const saved = await row.save();
assert("create() persists and returns the row", saved !== false && Boolean(row.toObject().id));

const id = row.toObject().id;
const fetched = await ${model}.selectOne("SELECT * FROM ${table} WHERE id = ?", [id]);
assert("row reads back by id", fetched !== null);
assert("read-back id matches", fetched !== null && (fetched.toObject() as Record<string, unknown>).id === id);${valueAssert}

const missing = await ${model}.selectOne("SELECT * FROM ${table} WHERE id = ?", [999999]);
assert("find missing returns null", missing === null);`;
  writeTest(`${table}_model`, standaloneTest(doc, body));
}

/** route (no --model) → real Router registration + the list handler is a live
 *  loud stub. (route --model reuses the secure-gate generateTest instead.) */
function emitRouteStubTest(route: string): void {
  const doc = `/**
 * Routing test for ${route} — no mocks, real Router + route discovery.
 *
 * Generated with src/routes/api/${route}/ by \`tina4nodejs generate route
 * ${route}\` (no --model). The handlers are AI-FILL stubs that throw until you
 * implement them, so this tests what IS live on generation: all five routes
 * register on the REAL Router, and the list handler fails loud until filled.
 * Run with: npx tsx tests/${route}.test.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, discoverRoutes } from "tina4-nodejs";
import listHandler from "../src/routes/api/${route}/get.js";`;
  const body = `const here = dirname(fileURLToPath(import.meta.url));
const router = new Router();
const defs = await discoverRoutes(resolve(here, "../src/routes"));
for (const def of defs) router.addRoute(def);

const sigs = defs.map((d) => \`\${d.method} \${d.pattern}\`);
for (const sig of ["GET /api/${route}", "POST /api/${route}", "GET /api/${route}/{id}", "PUT /api/${route}/{id}", "DELETE /api/${route}/{id}"]) {
  assert(\`route registered: \${sig}\`, sigs.includes(sig));
}

// The scaffolded list handler is a loud AI-FILL stub — it throws until filled.
await assertThrows("list handler is a live stub (throws until filled)",
  () => listHandler({} as never, {} as never));`;
  writeTest(route, standaloneTest(doc, body));
}

/** middleware → the scaffolded before/after driven through the REAL
 *  MiddlewareChain with a real Request/Response (no mock req/res). */
function emitMiddlewareTest(name: string, snake: string): void {
  const doc = `/**
 * Real dispatch test for the ${name} middleware — no mocks.
 *
 * Generated with src/middleware/${snake}.ts by \`tina4nodejs generate middleware
 * ${name}\`. Drives the scaffolded before/after functions through the REAL
 * MiddlewareChain with a real Tina4Request/Response (built from real node http
 * objects) — the same continuation dispatch the live server runs.
 * Run with: npx tsx tests/${snake}.test.ts
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { MiddlewareChain, createRequest, createResponse } from "tina4-nodejs";
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { before${name}, after${name} } from "../src/middleware/${snake}.js";`;
  const body = `function realPair(headers: Record<string, string>): { req: Tina4Request; res: Tina4Response; raw: ServerResponse } {
  const socket = new Socket();
  const rawReq = new IncomingMessage(socket);
  rawReq.method = "GET";
  rawReq.url = "/";
  rawReq.headers = { ...headers, host: "localhost" };
  rawReq.push(null);
  const rawRes = new ServerResponse(rawReq);
  rawRes.write = (() => true) as typeof rawRes.write;
  rawRes.end = (function (this: ServerResponse) { return this; }) as typeof rawRes.end;
  return { req: createRequest(rawReq), res: createResponse(rawRes), raw: rawRes };
}

// before(): blocks an unauthenticated request (401, does not call next()).
{
  const chain = new MiddlewareChain();
  chain.use(before${name});
  let reached = false;
  chain.use(async (_r, _s, next) => { reached = true; next(); });
  const { req, res, raw } = realPair({});
  await chain.run(req, res);
  assert("before blocks unauthenticated (401, chain short-circuits)", raw.statusCode === 401 && reached === false);
}

// before(): lets an authenticated request through to the next middleware.
{
  const chain = new MiddlewareChain();
  chain.use(before${name});
  let reached = false;
  chain.use(async (_r, _s, next) => { reached = true; next(); });
  const { req, res } = realPair({ authorization: "Bearer test" });
  await chain.run(req, res);
  assert("before passes an authenticated request through", reached === true);
}

// after(): always continues the chain.
{
  const chain = new MiddlewareChain();
  chain.use(after${name});
  let reached = false;
  chain.use(async (_r, _s, next) => { reached = true; next(); });
  const { req, res } = realPair({});
  await chain.run(req, res);
  assert("after runs and continues the chain", reached === true);
}`;
  writeTest(snake, standaloneTest(doc, body));
}

/** service → registrable on a REAL ServiceRunner + descriptor shape + loud stub. */
function emitServiceTest(name: string, snake: string, camel: string): void {
  const doc = `/**
 * Real ServiceRunner test for the ${name} service — no mocks.
 *
 * Generated with src/services/${snake}.ts by \`tina4nodejs generate service
 * ${name}\`. Registers the scaffold on a REAL ServiceRunner and confirms the
 * descriptor; the task body is an AI-FILL stub that throws until filled.
 * Run with: npx tsx tests/${snake}.test.ts
 */
import { ServiceRunner } from "tina4-nodejs";
import service, { ${camel}Task } from "../src/services/${snake}.js";`;
  const body = `assert("descriptor has a name + callable handler",
  service.name === "${snake}" && typeof service.handler === "function");

// Register on a REAL ServiceRunner and confirm it is listed.
ServiceRunner.register(service.name, service.handler, { interval: (service as { interval?: number }).interval });
assert("registers on a real ServiceRunner", ServiceRunner.list().some((s) => s.name === "${snake}"));
ServiceRunner.remove("${snake}");

// The scaffolded task body is an AI-FILL stub — it throws until filled.
await assertThrows("task is a live stub (throws until filled)", () => ${camel}Task({} as never));`;
  writeTest(snake, standaloneTest(doc, body));
}

/** queue → push a REAL job onto the real file-backed Queue + daemon wiring. */
function emitQueueTest(topic: string, slug: string, pascal: string): void {
  const doc = `/**
 * Real file-backed Queue test for the ${topic} worker — no mocks.
 *
 * Generated with src/services/${slug}_consumer.ts by \`tina4nodejs generate
 * queue ${topic}\`. Pushes a REAL job onto the real file-backed Queue and
 * asserts it is enqueued, and that the consumer is wired as a daemon. The
 * per-job handle is an AI-FILL stub that throws until filled.
 * Run with: npx tsx tests/${slug}.test.ts
 */
import { Queue } from "tina4-nodejs";
import worker, { publish${pascal}, handle${pascal} } from "../src/services/${slug}_consumer.js";`;
  const body = `const jobId = publish${pascal}({ hello: "world" });
assert("publish enqueues a real job (returns an id)", typeof jobId === "string" && jobId.length > 0);
assert("the job is really on the queue", new Queue({ topic: "${topic}" }).size() >= 1);

assert("consumer default export is a daemon", worker.daemon === true);
assert("consumer handler is wired", typeof worker.handler === "function");

// The per-job handler is an AI-FILL stub — it throws until filled.
await assertThrows("handle is a live stub (throws until filled)", () => handle${pascal}({}));`;
  writeTest(slug, standaloneTest(doc, body));
}

/** validator → run the scaffold against valid + invalid real input
 *  (working-default: ships a starter required("name") rule). */
function emitValidatorTest(name: string, snake: string, pascal: string): void {
  const doc = `/**
 * Real validation test for validate${pascal} — no mocks.
 *
 * Generated with src/validators/${snake}.ts by \`tina4nodejs generate validator
 * ${name}\`. The scaffold ships a starter rule (required "name"), so this passes
 * on generation — adjust the rules for your payload and update these cases.
 * Run with: npx tsx tests/${snake}.test.ts
 */
import { validate${pascal} } from "../src/validators/${snake}.js";`;
  const body = `assert("valid input passes", validate${pascal}({ name: "Ada" }).isValid());

const bad = validate${pascal}({});
assert("invalid input fails", bad.isValid() === false);
assert("invalid input reports errors", bad.errors().length > 0);`;
  writeTest(snake, standaloneTest(doc, body));
}

/** seeder → run the scaffolded seeder against real SQLite, assert rows created
 *  (working-default: fieldOverrides returns {}, seedOrm auto-fills). */
function emitSeederTest(model: string, table: string): void {
  const doc = `/**
 * Real seeding test for the ${model} seeder — no mocks, real SQLite.
 *
 * Generated with src/seeds/${table}_seeder.ts by \`tina4nodejs generate seeder
 * ${model}\`. Binds a real SQLite DB, creates the table, runs the scaffolded
 * seeder (auto-fills every field via FakeData) and asserts rows were created.
 * Run with: npx tsx tests/${table}_seeder.test.ts
 */
import { initDatabase, FakeData } from "tina4-nodejs/orm";
import ${model} from "../src/models/${model}.js";
import { fieldOverrides, run } from "../src/seeds/${table}_seeder.js";`;
  const body = `process.env.TINA4_DATABASE_URL = "sqlite:///test_${table}_seeder.db";
await initDatabase({ url: process.env.TINA4_DATABASE_URL });
await ${model}.createTable();

assert("fieldOverrides returns an object", typeof fieldOverrides(new FakeData()) === "object");

await run();   // run() re-binds the same DB URL and seeds via seedOrm
const rows = await ${model}.all();
assert("run() seeds real rows", rows.length >= 1);`;
  writeTest(`${table}_seeder`, standaloneTest(doc, body));
}

/** websocket → real Router registration + drive the real handler (socket-free
 *  "close" event) directly; the "message" branch is a loud stub. */
function emitWebsocketTest(wsPath: string, base: string, handler: string): void {
  const doc = `/**
 * Real handler test for the ${wsPath} WebSocket route — no mocks.
 *
 * Generated with src/routes/ws_${base}.ts by \`tina4nodejs generate websocket
 * ...\`. Confirms the handler registers on the REAL Router (importing runs the
 * module-level websocket() call) and drives the real handler for the "close"
 * event (no socket needed). The "message" branch is an AI-FILL stub that throws
 * until filled. Run with: npx tsx tests/ws_${base}.test.ts
 */
import { Router } from "tina4-nodejs";
import { ${handler} } from "../src/routes/ws_${base}.js";  // importing registers via websocket()`;
  const body = `assert("handler registered on the real router",
  Router.getWebSocketRoutes().some((r) => r.pattern === "${wsPath}"));

// The "close" branch returns cleanly without a live connection.
const closed = await ${handler}(null as never, "close", "");
assert("close event handled cleanly", closed === undefined);

// The "message" branch is an AI-FILL stub — it throws until filled.
await assertThrows("message branch is a live stub (throws until filled)",
  () => ${handler}(null as never, "message", "hi"));`;
  writeTest(`ws_${base}`, standaloneTest(doc, body));
}

/** listener → emit the REAL event on the real bus, assert the listener ran. */
function emitListenerTest(event: string, slug: string): void {
  const doc = `/**
 * Real event-bus test for the '${event}' listener — no mocks.
 *
 * Generated with src/listeners/${slug}.ts by \`tina4nodejs generate listener
 * ${event}\`. Confirms the listener binds on the REAL event bus (importing runs
 * the module-level Events.on) and that emitting the event reaches it. The
 * reaction body is an AI-FILL stub, so a strict emit re-raises here (proving it
 * ran). Run with: npx tsx tests/${slug}.test.ts
 */
import { Events } from "tina4-nodejs";
import "../src/listeners/${slug}.js";  // importing registers the listener via Events.on()`;
  const body = `assert("listener registered on the real event bus", Events.listeners("${event}").length >= 1);

// strict emit re-raises the stub error, proving the listener actually ran.
await assertThrows("emitting the event reaches the (stub) listener",
  () => Events.emit("${event}", { strict: true }, { id: 1 }));`;
  writeTest(slug, standaloneTest(doc, body));
}

/** auth → real register / login / me end-to-end via the real TestClient. This
 *  proves the token→200 path on /api/auth/me (the scaffold passes headers to
 *  authenticateRequest, not the request — no always-401 bug). */
function emitAuthTest(): void {
  const doc = `/**
 * Real auth test — register / login / me via the real TestClient.
 *
 * Generated with the auth scaffold by \`tina4nodejs generate auth\`. No mocks:
 * real Router + route discovery, real Auth (PBKDF2 + JWT), real SQLite. register
 * + login are public; the token from login authenticates GET /api/auth/me.
 * Run with: npx tsx tests/auth.test.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, TestClient, discoverRoutes } from "tina4-nodejs";
import { initDatabase } from "tina4-nodejs/orm";
import User from "../src/models/User.js";

process.env.TINA4_SECRET = process.env.TINA4_SECRET ?? "test-secret";
delete process.env.TINA4_API_KEY;
const here = dirname(fileURLToPath(import.meta.url));`;
  const body = `await initDatabase({ url: "sqlite:///test_auth.db" });
await User.createTable();
for (const existing of await User.all()) await existing.delete();   // start from an empty table

const router = new Router();
for (const def of await discoverRoutes(resolve(here, "../src/routes"))) router.addRoute(def);
const client = new TestClient(router);

const registered = await client.post("/api/auth/register", { json: { email: "a@b.c", password: "secret12" } });
assert("register a new user -> 201", registered.status === 201);

const duplicate = await client.post("/api/auth/register", { json: { email: "a@b.c", password: "secret12" } });
assert("duplicate register -> 409", duplicate.status === 409);

const login = await client.post("/api/auth/login", { json: { email: "a@b.c", password: "secret12" } });
assert("login -> 200", login.status === 200);
const token = (login.json() as { token?: string }).token;
assert("login returns a token", typeof token === "string" && token.length > 0);

const me = await client.get("/api/auth/me", { headers: { authorization: \`Bearer \${token}\` } });
assert("authenticated GET /api/auth/me -> 200 (token accepted)", me.status === 200);
assert("me returns the authenticated user's email",
  ((me.json() as { user?: { email?: string } }).user?.email) === "a@b.c");

const anon = await client.get("/api/auth/me");
assert("anonymous GET /api/auth/me -> 401", anon.status === 401);

const bad = await client.post("/api/auth/login", { json: { email: "a@b.c", password: "WRONG" } });
assert("wrong password -> 401", bad.status === 401);`;
  writeTest("auth", standaloneTest(doc, body));
}

/** migration (create_*) → apply UP then DOWN against real SQLite, assert the
 *  table appears then disappears. Only for CREATE migrations. */
function emitMigrationTest(migrationName: string, table: string): void {
  const doc = `/**
 * Real migration test for ${migrationName} — no mocks, real SQLite.
 *
 * Generated with the migration by \`tina4nodejs generate migration
 * ${migrationName}\`. Applies the generated UP SQL against a fresh real
 * in-memory SQLite database and asserts the table exists, then applies the DOWN
 * SQL and asserts it is gone — the raw SQL the migration runner executes.
 * Run with: npx tsx tests/${table}_migration.test.ts
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { SQLiteAdapter } from "tina4-nodejs/orm";`;
  const body = `const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../migrations");

const upFile = readdirSync(migrationsDir).find((f) => f.endsWith("_${migrationName}.sql") && !f.endsWith(".down.sql"));
assert("generated UP migration file exists", Boolean(upFile));
const downFile = upFile!.replace(/\\.sql$/, ".down.sql");

function statements(sql: string): string[] {
  const noComments = sql.split("\\n").filter((l) => !l.trim().startsWith("--")).join("\\n");
  return noComments.split(";").map((s) => s.trim()).filter(Boolean);
}

const upText = readFileSync(join(migrationsDir, upFile!), "utf-8");
const upSql = upText.split("-- UP")[1].split("-- DOWN")[0];
const downSql = readFileSync(join(migrationsDir, downFile), "utf-8");

const db = new SQLiteAdapter(":memory:");
for (const stmt of statements(upSql)) db.execute(stmt);
assert("UP creates the ${table} table", db.tableExists("${table}"));

for (const stmt of statements(downSql)) db.execute(stmt);
assert("DOWN drops the ${table} table", db.tableExists("${table}") === false);`;
  writeTest(`${table}_migration`, standaloneTest(doc, body));
}

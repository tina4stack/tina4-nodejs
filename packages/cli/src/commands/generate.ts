/**
 * CLI command: generate — Scaffold models, routes, migrations, and middleware.
 *
 * Usage:
 *   tina4nodejs generate model User
 *   tina4nodejs generate route /api/users
 *   tina4nodejs generate migration create_users
 *   tina4nodejs generate middleware Auth
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function generate(what: string, name: string): Promise<void> {
  if (!what || !name) {
    console.error("  Usage: tina4nodejs generate <what> <name>");
    console.error("  Generators: model, route, migration, middleware");
    process.exit(1);
  }

  switch (what) {
    case "model":
      generateModel(name);
      break;
    case "route":
      generateRoute(name);
      break;
    case "migration":
      generateMigration(name);
      break;
    case "middleware":
      generateMiddleware(name);
      break;
    default:
      console.error(`  Unknown generator: ${what}`);
      console.error("  Available: model, route, migration, middleware");
      process.exit(1);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeFileSafe(path: string, content: string): void {
  if (existsSync(path)) {
    console.error(`  File already exists: ${path}`);
    process.exit(1);
  }
  writeFileSync(path, content, "utf-8");
  console.log(`  Created ${path}`);
}

function toSnake(name: string): string {
  return name.replace(/([A-Z])/g, (_, ch, i) => (i > 0 ? "_" : "") + ch.toLowerCase());
}

function toPlural(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith("s")) return lower;
  if (lower.endsWith("y")) return lower.slice(0, -1) + "ies";
  return lower + "s";
}

function toCamel(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

// ── Model ────────────────────────────────────────────────────────

function generateModel(name: string): void {
  const dir = resolve("src/models");
  ensureDir(dir);

  const table = toPlural(name);
  const path = join(dir, `${name}.ts`);

  const content = `import { BaseModel } from "tina4-nodejs";

export class ${name} extends BaseModel {
  static tableName = "${table}";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    email: { type: "string" },
  };
}
`;

  writeFileSafe(path, content);
}

// ── Route ────────────────────────────────────────────────────────

function generateRoute(name: string): void {
  const routePath = name.replace(/^\//, "");
  const base = resolve("src/routes", routePath);
  const idDir = join(base, "[id]");
  ensureDir(base);
  ensureDir(idDir);

  // GET list
  writeFileSafe(
    join(base, "get.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "List all", tags: ["auto-generated"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  res.json({ data: [] });
}
`,
  );

  // POST create
  writeFileSafe(
    join(base, "post.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Create new", tags: ["auto-generated"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  res.json({ message: "created" }, 201);
}
`,
  );

  // GET by id
  writeFileSafe(
    join(idDir, "get.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Get by id", tags: ["auto-generated"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  res.json({ data: { id } });
}
`,
  );

  // PUT by id
  writeFileSafe(
    join(idDir, "put.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Update by id", tags: ["auto-generated"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  res.json({ message: "updated", id });
}
`,
  );

  // DELETE by id
  writeFileSafe(
    join(idDir, "delete.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const meta = { summary: "Delete by id", tags: ["auto-generated"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const { id } = req.params;
  res.json({ message: "deleted", id });
}
`,
  );
}

// ── Migration ────────────────────────────────────────────────────

function generateMigration(name: string): void {
  const dir = resolve("migrations");
  ensureDir(dir);

  const now = new Date();
  const timestamp =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  const table = toPlural(name.replace(/^create_/, ""));
  const fileName = `${timestamp}_${name}.sql`;
  const path = join(dir, fileName);

  const content = `-- Migration: ${name}
-- Created: ${now.toISOString().replace("T", " ").replace(/\.\d+Z$/, "")}

CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

  writeFileSafe(path, content);
}

// ── Middleware ────────────────────────────────────────────────────

function generateMiddleware(name: string): void {
  const dir = resolve("src/middleware");
  ensureDir(dir);

  const snake = toSnake(name);
  const camel = toCamel(name);
  const path = join(dir, `${snake}.ts`);

  const content = `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

/**
 * ${name} middleware — checks for Authorization header.
 */
export default async function ${camel}(
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
`;

  writeFileSafe(path, content);
}

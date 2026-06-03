/**
 * Tina4 AI — Install AI coding assistant context files.
 *
 * Simple menu-driven installer for AI tool context files.
 * The user picks which tools they use, we install the appropriate files.
 *
 *   import { showMenu, installSelected } from "@tina4/core";
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, cpSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

// ── Types ────────────────────────────────────────────────────

export interface AiTool {
  name: string;
  description: string;
  contextFile: string;
  configDir: string | null;
}

// ── Tool definitions (ordered array) ────────────────────────

export const AI_TOOLS: AiTool[] = [
  { name: "claude-code", description: "Claude Code", contextFile: "CLAUDE.md", configDir: ".claude" },
  { name: "cursor", description: "Cursor", contextFile: ".cursorules", configDir: ".cursor" },
  { name: "copilot", description: "GitHub Copilot", contextFile: ".github/copilot-instructions.md", configDir: ".github" },
  { name: "windsurf", description: "Windsurf", contextFile: ".windsurfrules", configDir: null },
  { name: "aider", description: "Aider", contextFile: "CONVENTIONS.md", configDir: null },
  { name: "cline", description: "Cline", contextFile: ".clinerules", configDir: null },
  { name: "codex", description: "OpenAI Codex", contextFile: "AGENTS.md", configDir: null },
];

// ── Helpers ─────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/**
 * Read the Tina4 version from the root package.json.
 */
function readVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const rootPkg = resolve(thisDir, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(rootPkg, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Check if a tool's context file already exists.
 */
export function isInstalled(root: string, tool: AiTool): boolean {
  return existsSync(join(resolve(root), tool.contextFile));
}

/**
 * Print the numbered menu and read user input via readline.
 * Returns a promise that resolves to the user's selection string.
 */
export function showMenu(root: string = "."): Promise<string> {
  const r = resolve(root);

  console.log("\n  Tina4 AI Context Installer\n");

  for (let i = 0; i < AI_TOOLS.length; i++) {
    const tool = AI_TOOLS[i];
    const installed = isInstalled(r, tool);
    const marker = installed ? `  ${GREEN}[installed]${RESET}` : "";
    const desc = tool.description.padEnd(20);
    console.log(`  ${i + 1}. ${desc} ${tool.contextFile}${marker}`);
  }

  // tina4-ai tools option
  let tina4AiInstalled = false;
  try {
    execSync("which mdview", { stdio: "ignore" });
    tina4AiInstalled = true;
  } catch {
    // not installed
  }
  const tina4AiMarker = tina4AiInstalled ? `  ${GREEN}[installed]${RESET}` : "";
  console.log(`  8. Install tina4-ai tools  (requires Python)${tina4AiMarker}`);
  console.log();

  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("  Select (comma-separated, or 'all'): ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Install context files for the selected tools.
 *
 * selection: comma-separated numbers like "1,2,3" or "all"
 * Returns list of created/updated file paths.
 */
export function installSelected(root: string, selection: string): string[] {
  const rootPath = resolve(root);
  const created: string[] = [];

  let indices: number[];
  let doInstallTina4Ai = false;

  if (selection.toLowerCase() === "all") {
    indices = AI_TOOLS.map((_, i) => i);
    doInstallTina4Ai = true;
  } else {
    const parts = selection.split(",").map((s) => s.trim()).filter(Boolean);
    indices = [];
    for (const p of parts) {
      const n = parseInt(p, 10);
      if (isNaN(n)) continue;
      if (n === 8) {
        doInstallTina4Ai = true;
      } else if (n >= 1 && n <= AI_TOOLS.length) {
        indices.push(n - 1);
      }
    }
  }

  for (const idx of indices) {
    const tool = AI_TOOLS[idx];
    const context = generateContext(tool.name);
    const files = installForTool(rootPath, tool, context);
    created.push(...files);
  }

  if (doInstallTina4Ai) {
    installTina4Ai();
  }

  return created;
}

/**
 * Install context for all AI tools (non-interactive).
 */
export function installAll(root: string = "."): string[] {
  return installSelected(root, "all");
}

/**
 * Install context file for a single tool.
 */
function installForTool(root: string, tool: AiTool, context: string): string[] {
  const created: string[] = [];
  const contextPath = join(root, tool.contextFile);

  // Create directories
  if (tool.configDir) {
    mkdirSync(join(root, tool.configDir), { recursive: true });
  }
  const parentDir = dirname(contextPath);
  mkdirSync(parentDir, { recursive: true });

  // Always overwrite -- user chose to install
  writeFileSync(contextPath, context, "utf-8");
  const rel = relative(root, contextPath);
  created.push(rel);
  console.log(`  ${GREEN}\u2713${RESET} Updated ${rel}`);

  // Claude-specific extras
  if (tool.name === "claude-code") {
    const skills = installClaudeSkills(root);
    created.push(...skills);
  }

  return created;
}

/**
 * Install tina4-ai package (provides mdview for markdown viewing).
 */
function installTina4Ai(): void {
  console.log("  Installing tina4-ai tools...");
  for (const cmd of ["pip3", "pip"]) {
    let hasCmd = false;
    try {
      execSync(`which ${cmd}`, { stdio: "ignore" });
      hasCmd = true;
    } catch {
      // not available
    }
    if (!hasCmd) continue;

    try {
      execSync(`${cmd} install --upgrade tina4-ai`, { stdio: "pipe", timeout: 60000 });
      console.log(`  ${GREEN}\u2713${RESET} Installed tina4-ai (mdview)`);
      return;
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.toString().trim().slice(0, 100) : "unknown error";
      console.log(`  ${YELLOW}!${RESET} ${cmd} failed: ${stderr}`);
    }
  }
  console.log(`  ${YELLOW}!${RESET} Python/pip not available -- skip tina4-ai`);
}

/**
 * Copy Claude Code skill files from the framework's directories.
 */
function installClaudeSkills(root: string): string[] {
  const created: string[] = [];

  // Determine the framework root (where packages/core/src/ lives)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const frameworkRoot = resolve(thisDir, "..", "..", "..");

  // Copy skill directories from .claude/skills/ in the framework to the project
  const frameworkSkillsDir = join(frameworkRoot, ".claude", "skills");
  if (existsSync(frameworkSkillsDir)) {
    const targetSkillsDir = join(root, ".claude", "skills");
    mkdirSync(targetSkillsDir, { recursive: true });
    for (const entry of readdirSync(frameworkSkillsDir)) {
      const skillDir = join(frameworkSkillsDir, entry);
      if (existsSync(skillDir) && statSync(skillDir).isDirectory()) {
        const targetDir = join(targetSkillsDir, entry);
        cpSync(skillDir, targetDir, { recursive: true, force: true });
        const rel = relative(root, targetDir);
        created.push(rel);
        console.log(`  ${GREEN}\u2713${RESET} Updated ${rel}`);
      }
    }
  }

  return created;
}

// ── Shared content fragments ────────────────────────────────

const VERSION = readVersion();

const FEATURES_COMPACT = "Router, ORM, Database (SQLite/PostgreSQL/MySQL/MSSQL/Firebird), Frond templates (Twig-compatible), JWT auth, Sessions (File/Redis/Valkey/MongoDB/DB), GraphQL + GraphiQL, WebSocket + Redis backplane, WSDL/SOAP, Queue (File/RabbitMQ/Kafka/MongoDB), HTTP client, Messenger (SMTP/IMAP), FakeData/Seeder, Migrations, SCSS compiler, Swagger/OpenAPI, i18n, Events, Container/DI, HtmlElement, Inline testing, Error overlay, Dev dashboard, Rate limiter, Response cache, Logging, MCP server";

const PROJECT_STRUCTURE = `src/routes/    \u2014 File-based route handlers (auto-discovered)
src/models/    \u2014 ORM models
src/templates/ \u2014 Twig templates
src/app/       \u2014 Service classes
src/scss/      \u2014 SCSS (auto-compiled)
src/public/    \u2014 Static assets
src/seeds/     \u2014 Database seeders
migrations/    \u2014 SQL migration files`;

const CONVENTIONS = `1. File-based routing \u2014 src/routes/api/users/get.ts handles GET /api/users
2. Export default async function for route handlers
3. GET routes are public, POST/PUT/PATCH/DELETE require auth by default
4. ESM only (import/export, no require)
5. Every template extends base.twig
6. All schema changes via migrations \u2014 never create tables in route code
7. Use built-in features \u2014 never install npm packages for things Tina4 already provides`;

const ROUTE_EXAMPLE = `// src/routes/api/users/get.ts
export default async function(req: Tina4Request, res: Tina4Response) {
  res.json({ users: [] });
}

// src/routes/api/users/post.ts
export default async function(req: Tina4Request, res: Tina4Response) {
  res.json({ created: req.body.name }, 201);
}`;

const MODEL_EXAMPLE = `// src/models/User.ts
export default class User {
  static tableName = "users";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true },
    email: { type: "string" as const },
  };
}`;

// ── Per-tool generators ─────────────────────────────────────

function generateCursorContext(): string {
  return `# Tina4 Node.js v${VERSION} — Cursor Rules

You are working on a **Tina4 for Node.js/TypeScript** project.
Documentation: https://tina4.com

## Project Structure

\`\`\`
${PROJECT_STRUCTURE}
\`\`\`

## Built-in Features (Do NOT Install Packages For These)

${FEATURES_COMPACT}

## Conventions

${CONVENTIONS}

## Route Example

\`\`\`typescript
${ROUTE_EXAMPLE}
\`\`\`

## Model Example

\`\`\`typescript
${MODEL_EXAMPLE}
\`\`\`

## Quick Commands

\`\`\`bash
npx tina4nodejs serve     # Dev server on port 7148
npx tina4nodejs migrate   # Run migrations
npx tina4nodejs test      # Run tests
npx tina4nodejs routes    # List routes
\`\`\`

## Key Rules

- TypeScript strict mode, ESM only, Node.js 20+
- Native \`node:http\` — no Express/Fastify
- Convention-based models with \`static fields\` — no decorators
- Dynamic route params use brackets: \`[id]\`, \`[...slug]\`
- Use \`.js\` extensions in import paths
- All schema changes via migrations
`;
}

function generateCopilotContext(): string {
  return `# Tina4 Node.js v${VERSION} — Copilot Instructions

This is a **Tina4 for Node.js/TypeScript** project (https://tina4.com).

## Structure

\`\`\`
${PROJECT_STRUCTURE}
\`\`\`

## Built-in Features

${FEATURES_COMPACT}

## Conventions

${CONVENTIONS}

## Route Pattern

\`\`\`typescript
${ROUTE_EXAMPLE}
\`\`\`

## Model Pattern

\`\`\`typescript
${MODEL_EXAMPLE}
\`\`\`

## Rules

- TypeScript strict, ESM only, Node.js 20+, native \`node:http\`
- Never install npm packages for built-in features
- All schema changes via migrations
`;
}

function generateWindsurfContext(): string {
  return `# Tina4 Node.js v${VERSION} — Windsurf Rules

You are working on a **Tina4 for Node.js/TypeScript** project.
Documentation: https://tina4.com

## Project Structure

\`\`\`
${PROJECT_STRUCTURE}
\`\`\`

## Built-in Features (Do NOT Install Packages For These)

${FEATURES_COMPACT}

## Conventions

${CONVENTIONS}

## Route Example

\`\`\`typescript
${ROUTE_EXAMPLE}
\`\`\`

## Model Example

\`\`\`typescript
${MODEL_EXAMPLE}
\`\`\`

## Quick Commands

\`\`\`bash
npx tina4nodejs serve     # Dev server on port 7148
npx tina4nodejs migrate   # Run migrations
npx tina4nodejs test      # Run tests
npx tina4nodejs routes    # List routes
\`\`\`

## Key Rules

- TypeScript strict mode, ESM only, Node.js 20+
- Native \`node:http\` — no Express/Fastify
- Convention-based models with \`static fields\` — no decorators
- Dynamic route params use brackets: \`[id]\`, \`[...slug]\`
- Use \`.js\` extensions in import paths
- All schema changes via migrations

## Database

Default: SQLite via \`node:sqlite\`. Adapters for PostgreSQL, MySQL, MSSQL, Firebird.
Set \`TINA4_DATABASE_URL\` in \`.env\` (e.g. \`postgres://localhost:5432/mydb\`).

## Auth

JWT auth built in. \`import { createToken, validateToken, hashPassword, checkPassword } from "@tina4/core"\`.
GET routes are public. POST/PUT/PATCH/DELETE require auth by default.
`;
}

function generateAiderContext(): string {
  return `# Tina4 Node.js v${VERSION} — Conventions

This is a **Tina4 for Node.js/TypeScript** project (https://tina4.com).

## Project Structure

\`\`\`
${PROJECT_STRUCTURE}
\`\`\`

## Built-in Features (Do NOT Install Packages For These)

${FEATURES_COMPACT}

## Conventions

${CONVENTIONS}

## Route Example

\`\`\`typescript
${ROUTE_EXAMPLE}
\`\`\`

## Model Example

\`\`\`typescript
${MODEL_EXAMPLE}
\`\`\`

## Quick Commands

\`\`\`bash
npx tina4nodejs serve     # Dev server on port 7148
npx tina4nodejs migrate   # Run migrations
npx tina4nodejs test      # Run tests
npx tina4nodejs routes    # List routes
\`\`\`

## Key Rules

- TypeScript strict mode, ESM only, Node.js 20+
- Native \`node:http\` — no Express/Fastify
- Convention-based models with \`static fields\` — no decorators
- Dynamic route params use brackets: \`[id]\`, \`[...slug]\`
- Use \`.js\` extensions in import paths
- All schema changes via migrations

## Database

Default: SQLite via \`node:sqlite\`. Adapters for PostgreSQL, MySQL, MSSQL, Firebird.
Set \`TINA4_DATABASE_URL\` in \`.env\`.
`;
}

function generateClineContext(): string {
  return `# Tina4 Node.js v${VERSION} — Cline Rules

You are working on a **Tina4 for Node.js/TypeScript** project.
Documentation: https://tina4.com

## Project Structure

\`\`\`
${PROJECT_STRUCTURE}
\`\`\`

## Built-in Features (Do NOT Install Packages For These)

${FEATURES_COMPACT}

## Conventions

${CONVENTIONS}

## Route Example

\`\`\`typescript
${ROUTE_EXAMPLE}
\`\`\`

## Model Example

\`\`\`typescript
${MODEL_EXAMPLE}
\`\`\`

## Quick Commands

\`\`\`bash
npx tina4nodejs serve     # Dev server on port 7148
npx tina4nodejs migrate   # Run migrations
npx tina4nodejs test      # Run tests
npx tina4nodejs routes    # List routes
\`\`\`

## Key Rules

- TypeScript strict mode, ESM only, Node.js 20+
- Native \`node:http\` — no Express/Fastify
- Never install npm packages for built-in features
- All schema changes via migrations
`;
}

function generateCodexContext(): string {
  return `# Tina4 Node.js v${VERSION} — Agent Instructions

You are working on a **Tina4 for Node.js/TypeScript** project.
Documentation: https://tina4.com

## Project Structure

\`\`\`
${PROJECT_STRUCTURE}
\`\`\`

## Built-in Features (Do NOT Install Packages For These)

${FEATURES_COMPACT}

## Conventions

${CONVENTIONS}

## Route Example

\`\`\`typescript
${ROUTE_EXAMPLE}
\`\`\`

## Model Example

\`\`\`typescript
${MODEL_EXAMPLE}
\`\`\`

## Quick Commands

\`\`\`bash
npx tina4nodejs init .          # Scaffold project
npx tina4nodejs serve           # Dev server on port 7148
npx tina4nodejs migrate         # Run migrations
npx tina4nodejs test            # Run tests
npx tina4nodejs routes          # List routes
\`\`\`

## Key Rules

- TypeScript strict mode, ESM only, Node.js 20+
- Native \`node:http\` — no Express/Fastify
- Convention-based models with \`static fields\` — no decorators
- Dynamic route params use brackets: \`[id]\`, \`[...slug]\`
- Use \`.js\` extensions in import paths
- All schema changes via migrations

## Database

Default: SQLite via \`node:sqlite\`. Adapters for PostgreSQL, MySQL, MSSQL, Firebird.
Set \`TINA4_DATABASE_URL\` in \`.env\` (e.g. \`sqlite:///path/to/db.sqlite\`, \`postgres://localhost:5432/mydb\`).

## Auth

JWT auth built in. \`import { createToken, validateToken, hashPassword, checkPassword } from "@tina4/core"\`.
GET routes are public. POST/PUT/PATCH/DELETE require auth by default.

## Testing

\`\`\`bash
npx tina4nodejs test      # Run all tests
\`\`\`

Add test files in \`test/\` directory. Use built-in inline testing:
\`\`\`typescript
import { tests, assertEqual, runAll } from "@tina4/core";
\`\`\`

## Important

- Never add Express, Fastify, or any HTTP framework
- Never use CommonJS — everything is ESM
- Never use decorators — use convention-based models
- Run tests before committing
`;
}

function generateClaudeCodeContext(): string {
  // Try to read the existing CLAUDE.md from the repo root
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(thisDir, "..", "..", "..");
    const claudeMdPath = join(repoRoot, "CLAUDE.md");
    if (existsSync(claudeMdPath)) {
      return readFileSync(claudeMdPath, "utf-8");
    }
  } catch {
    // fall through to generated version
  }

  // Fallback: generate a CLAUDE.md
  return `# CLAUDE.md — Tina4 Node.js v${VERSION}

> AI Developer Guide for Tina4 Node.js/TypeScript projects.

## What This Project Is

Tina4 for Node.js/TypeScript v${VERSION} — a convention-over-configuration structural paradigm.
Zero ceremony, batteries included, file system as source of truth.

Documentation: https://tina4.com

## Project Structure

\`\`\`
${PROJECT_STRUCTURE}
\`\`\`

## Built-in Features (Do NOT Install Packages For These)

${FEATURES_COMPACT}

## Conventions

${CONVENTIONS}

## Route Example

\`\`\`typescript
${ROUTE_EXAMPLE}
\`\`\`

## Model Example

\`\`\`typescript
${MODEL_EXAMPLE}
\`\`\`

## Quick Commands

\`\`\`bash
npx tina4nodejs init .          # Scaffold project
npx tina4nodejs serve           # Dev server on port 7148
npx tina4nodejs migrate         # Run migrations
npx tina4nodejs test            # Run tests
npx tina4nodejs routes          # List routes
\`\`\`

## Key Rules

- TypeScript strict mode, ESM only, Node.js 20+
- Native \`node:http\` — no Express/Fastify
- Convention-based models with \`static fields\` — no decorators
- Dynamic route params use brackets: \`[id]\`, \`[...slug]\`
- Use \`.js\` extensions in import paths
- All schema changes via migrations

## Database

Default: SQLite via \`node:sqlite\`. Adapters for PostgreSQL, MySQL, MSSQL, Firebird.
Set \`TINA4_DATABASE_URL\` in \`.env\`.

## Auth

JWT auth built in. GET routes are public. POST/PUT/PATCH/DELETE require auth by default.

## Testing

Run \`npx tina4nodejs test\`. All tests must pass before committing.

## Don'ts

- Don't add Express, Fastify, or any HTTP framework
- Don't use decorators — convention-based models
- Don't use CommonJS — ESM only
- Don't install packages for built-in features
`;
}

// ── Main generator ──────────────────────────────────────────

/**
 * Generate the Tina4 context document for a specific AI tool.
 */
export function generateContext(toolName: string = "claude-code"): string {
  switch (toolName) {
    case "claude-code": return generateClaudeCodeContext();
    case "cursor":      return generateCursorContext();
    case "copilot":     return generateCopilotContext();
    case "windsurf":    return generateWindsurfContext();
    case "aider":       return generateAiderContext();
    case "cline":       return generateClineContext();
    case "codex":       return generateCodexContext();
    default:            return generateClaudeCodeContext();
  }
}

export { AiTool as AiToolType };

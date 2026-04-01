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

  const context = generateContext();

  for (const idx of indices) {
    const tool = AI_TOOLS[idx];
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

/**
 * Generate the universal Tina4 context document for any AI assistant.
 */
export function generateContext(): string {
  return `# Tina4 Node.js — AI Context

This project uses **Tina4 for Node.js/TypeScript**, a lightweight, batteries-included
web framework with zero third-party dependencies for core features.

**Documentation:** https://tina4.com

## Quick Start

\`\`\`bash
npx tina4nodejs init .          # Scaffold project
npx tina4nodejs serve           # Start dev server on port 7148
npx tina4nodejs migrate         # Run database migrations
npx tina4nodejs test            # Run test suite
npx tina4nodejs routes          # List all registered routes
\`\`\`

## Project Structure

\`\`\`
packages/core/src/    — Framework core (server, router, middleware, events)
src/routes/           — Route handlers (auto-discovered, file-based routing)
src/models/           — ORM models (one per file, convention-based)
src/templates/        — Twig templates
src/public/           — Static assets served at /
src/scss/             — SCSS files (auto-compiled to public/css/)
migrations/           — SQL migration files (sequential numbered)
test/                 — Test files
\`\`\`

## Built-in Features (No External Packages Needed)

| Feature | Module | Import |
|---------|--------|--------|
| Routing | router | \`import { get, post, put, del } from "@tina4/core"\` |
| ORM | orm | \`import { BaseModel } from "@tina4/orm"\` |
| Database | database | \`import { initDatabase } from "@tina4/orm"\` |
| Templates | twig | \`import { renderTemplate } from "@tina4/twig"\` |
| JWT Auth | auth | \`import { createToken, validateToken, hashPassword, checkPassword } from "@tina4/core"\` |
| REST API Client | api | \`import { Api } from "@tina4/core"\` |
| GraphQL | graphql | \`import { GraphQL } from "@tina4/core"\` |
| WebSocket | websocket | \`import { WebSocketServer } from "@tina4/core"\` |
| SOAP/WSDL | wsdl | \`import { WSDLService } from "@tina4/core"\` |
| Email (SMTP+IMAP) | messenger | \`import { Messenger } from "@tina4/core"\` |
| Background Queue | queue | \`import { Queue } from "@tina4/core"\` |
| SCSS Compilation | scss | Auto-compiled from src/scss/ |
| Migrations | migration | \`npx tina4nodejs migrate\` CLI command |
| Seeder | seeder | \`import { FakeData, seedTable } from "@tina4/orm"\` |
| i18n | i18n | \`import { I18n } from "@tina4/core"\` |
| Swagger/OpenAPI | swagger | Auto-generated at /swagger |
| Sessions | session | \`import { Session } from "@tina4/core"\` |
| Middleware | middleware | \`import { MiddlewareChain } from "@tina4/core"\` |
| Cache | cache | \`import { responseCache, cacheStats, clearCache } from "@tina4/core"\` |
| Events | events | \`import { Events } from "@tina4/core"\` |
| HTML Builder | htmlElement | \`import { HtmlElement, htmlElement, addHtmlHelpers } from "@tina4/core"\` |
| Error Overlay | errorOverlay | \`import { renderErrorOverlay, isDebugMode } from "@tina4/core"\` |
| Inline Testing | testing | \`import { tests, assertEqual, runAllTests } from "@tina4/core"\` |
| DI Container | container | \`import { Container } from "@tina4/core"\` |

## Key Conventions

1. **Route files export a default async function** — \`export default async function(req, res) {}\`
2. **File-based routing** — directory structure mirrors URL paths
3. **Dynamic params use brackets** — \`[id]\` for params, \`[...slug]\` for catch-all
4. **GET routes are public**, POST/PUT/PATCH/DELETE require auth by default
5. **ESM everywhere** — use \`.js\` extensions in imports
6. **No inline styles** — use SCSS in \`src/scss/\`
7. **All schema changes via migrations** — never create tables in route code
8. **Use built-in features** — never install packages for things Tina4 already provides

## AI Workflow — Available Skills

When using an AI coding assistant with Tina4, these skills are available:

| Skill | Description |
|-------|-------------|
| \`/tina4-route\` | Create a new route with proper decorators and auth |
| \`/tina4-orm\` | Create an ORM model with migration |
| \`/tina4-crud\` | Generate complete CRUD (migration, ORM, routes, template, tests) |
| \`/tina4-auth\` | Set up JWT authentication with login/register |
| \`/tina4-api\` | Create an external API integration |
| \`/tina4-queue\` | Set up background job processing |
| \`/tina4-template\` | Create a server-rendered template page |
| \`/tina4-graphql\` | Set up a GraphQL endpoint |
| \`/tina4-websocket\` | Set up WebSocket communication |
| \`/tina4-wsdl\` | Create a SOAP/WSDL service |
| \`/tina4-messenger\` | Set up email send/receive |
| \`/tina4-test\` | Write tests for a feature |
| \`/tina4-migration\` | Create a database migration |
| \`/tina4-seed\` | Generate fake data for development |
| \`/tina4-i18n\` | Set up internationalization |
| \`/tina4-scss\` | Set up SCSS stylesheets |
| \`/tina4-frontend\` | Set up a frontend framework |

## Common Patterns

### Route
\`\`\`typescript
// src/routes/api/users/post.ts
import type { Tina4Request, Tina4Response } from "@tina4/core";

export const meta = { summary: "Create a user", tags: ["users"] };

export default async function (req: Tina4Request, res: Tina4Response) {
  const data = req.body;
  return res.json({ created: true }, 201);
}
\`\`\`

### Model
\`\`\`typescript
// src/models/User.ts
export default class User {
  static tableName = "users";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true },
    email: { type: "string" as const, required: true },
  };
}
\`\`\`
`;
}

export { AiTool as AiToolType };

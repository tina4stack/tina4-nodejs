/**
 * Tina4 AI — Detect AI coding assistants and scaffold context files.
 *
 * Detect which AI coding tools are available and install framework-aware
 * context so that any AI assistant understands how to build with Tina4.
 *
 *   import { detectAi, installAiContext } from "@tina4/core";
 *
 *   const tools = detectAi();          // [{ name: "claude-code", ... }]
 *   installAiContext();                 // Scaffold context for all detected tools
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, copyFileSync, cpSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────

export interface AiTool {
  name: string;
  description: string;
  configDir: string | null;
  contextFile: string;
}

export interface AiDetection {
  name: string;
  description: string;
  configFile: string;
  status: "detected" | "not-detected";
}

// ── Tool definitions ─────────────────────────────────────────

const AI_TOOLS: Record<string, AiTool> = {
  "claude-code": {
    name: "claude-code",
    description: "Claude Code (Anthropic CLI)",
    configDir: ".claude",
    contextFile: "CLAUDE.md",
  },
  cursor: {
    name: "cursor",
    description: "Cursor IDE",
    configDir: ".cursor",
    contextFile: ".cursorules",
  },
  copilot: {
    name: "copilot",
    description: "GitHub Copilot",
    configDir: ".github",
    contextFile: ".github/copilot-instructions.md",
  },
  windsurf: {
    name: "windsurf",
    description: "Windsurf (Codeium)",
    configDir: null,
    contextFile: ".windsurfrules",
  },
  aider: {
    name: "aider",
    description: "Aider",
    configDir: null,
    contextFile: "CONVENTIONS.md",
  },
  cline: {
    name: "cline",
    description: "Cline (VS Code)",
    configDir: null,
    contextFile: ".clinerules",
  },
  codex: {
    name: "codex",
    description: "OpenAI Codex CLI",
    configDir: null,
    contextFile: "AGENTS.md",
  },
};

// ── Detection helpers ────────────────────────────────────────

function detectTool(root: string, toolName: string): boolean {
  const r = resolve(root);
  switch (toolName) {
    case "claude-code":
      return existsSync(join(r, ".claude")) || existsSync(join(r, "CLAUDE.md"));
    case "cursor":
      return existsSync(join(r, ".cursor")) || existsSync(join(r, ".cursorules"));
    case "copilot":
      return existsSync(join(r, ".github", "copilot-instructions.md")) || existsSync(join(r, ".github"));
    case "windsurf":
      return existsSync(join(r, ".windsurfrules"));
    case "aider":
      return existsSync(join(r, ".aider.conf.yml")) || existsSync(join(r, "CONVENTIONS.md"));
    case "cline":
      return existsSync(join(r, ".clinerules"));
    case "codex":
      return existsSync(join(r, "AGENTS.md")) || existsSync(join(r, "codex.md"));
    default:
      return false;
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Detect which AI coding tools are present in the project.
 */
export function detectAi(root: string = "."): AiDetection[] {
  const r = resolve(root);
  const results: AiDetection[] = [];

  for (const [name, tool] of Object.entries(AI_TOOLS)) {
    results.push({
      name,
      description: tool.description,
      configFile: tool.contextFile,
      status: detectTool(r, name) ? "detected" : "not-detected",
    });
  }

  return results;
}

/**
 * Return just the names of detected AI tools.
 */
export function detectAiNames(root: string = "."): string[] {
  return detectAi(root)
    .filter((t) => t.status === "detected")
    .map((t) => t.name);
}

/**
 * Generate a universal Tina4 context document for any AI assistant.
 */
export function generateContext(): string {
  return `# Tina4 Node.js — AI Context

This project uses **Tina4 for Node.js/TypeScript**, a lightweight, batteries-included
web framework with zero third-party dependencies for core features.

**Documentation:** https://tina4.com

## Quick Start

\`\`\`bash
tina4nodejs init .          # Scaffold project
tina4nodejs serve           # Start dev server on port 7148
tina4nodejs migrate         # Run database migrations
tina4nodejs test            # Run test suite
tina4nodejs routes          # List all registered routes
\`\`\`

## Project Structure

\`\`\`
src/routes/       — Route handlers (auto-discovered, file-based routing)
src/models/       — ORM models (one per file, convention-based)
src/templates/    — Twig templates
src/public/       — Static assets served at /
src/scss/         — SCSS files (auto-compiled to public/css/)
migrations/       — SQL migration files (sequential numbered)
test/             — Test files
\`\`\`

## Built-in Features (No External Packages Needed)

| Feature | Module | Import |
|---------|--------|--------|
| Routing | router | \`import { get, post, put, del } from "@tina4/core"\` |
| ORM | orm | \`import { BaseModel } from "@tina4/orm"\` |
| Database | database | \`import { initDatabase } from "@tina4/orm"\` |
| Templates | twig | \`import { renderTemplate } from "@tina4/twig"\` |
| JWT Auth | auth | \`import { createToken, validateToken } from "@tina4/core"\` |
| REST API Client | api | \`import { Api } from "@tina4/core"\` |
| GraphQL | graphql | \`import { GraphQL } from "@tina4/core"\` |
| WebSocket | websocket | \`import { WebSocketServer } from "@tina4/core"\` |
| SOAP/WSDL | wsdl | \`import { WSDLService } from "@tina4/core"\` |
| Email (SMTP+IMAP) | messenger | \`import { Messenger } from "@tina4/core"\` |
| Background Queue | queue | \`import { Queue } from "@tina4/core"\` |
| SCSS Compilation | scss | Auto-compiled from src/scss/ |
| Migrations | migration | \`tina4nodejs migrate\` CLI command |
| i18n | i18n | \`import { I18n } from "@tina4/core"\` |
| Swagger/OpenAPI | swagger | Auto-generated at /swagger |
| Sessions | session | \`import { Session } from "@tina4/core"\` |
| Middleware | middleware | \`import { MiddlewareChain } from "@tina4/core"\` |
| Cache | cache | \`import { responseCache } from "@tina4/core"\` |

## Key Conventions

1. **Route files export a default async function** — \`export default async function(req, res) {}\`
2. **File-based routing** — directory structure mirrors URL paths
3. **Dynamic params use brackets** — \`[id]\` for params, \`[...slug]\` for catch-all
4. **GET routes are public**, POST/PUT/PATCH/DELETE require auth by default
5. **ESM everywhere** — use \`.js\` extensions in imports
6. **No inline styles** — use SCSS in \`src/scss/\`
7. **All schema changes via migrations** — never create tables in route code
8. **Use built-in features** — never install packages for things Tina4 already provides

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

/**
 * Install Tina4 context files for detected (or specified) AI tools.
 *
 * Returns list of files created/updated.
 */
export function installAiContext(
  root: string = ".",
  options?: { tools?: string[]; force?: boolean },
): string[] {
  const r = resolve(root);
  const force = options?.force ?? false;
  const created: string[] = [];

  const toolNames = options?.tools ?? detectAiNames(r);
  const context = generateContext();

  for (const toolName of toolNames) {
    const tool = AI_TOOLS[toolName];
    if (!tool) continue;

    const contextPath = join(r, tool.contextFile);

    // Create config directory if needed
    if (tool.configDir) {
      mkdirSync(join(r, tool.configDir), { recursive: true });
    }

    // Ensure parent directory of context file exists
    const parentDir = join(contextPath, "..");
    mkdirSync(parentDir, { recursive: true });

    if (!existsSync(contextPath) || force) {
      writeFileSync(contextPath, context, "utf-8");
      created.push(relative(r, contextPath));
    }

    // Install Claude Code skills if it's Claude
    if (toolName === "claude-code") {
      const skillFiles = installClaudeSkills(r, force);
      created.push(...skillFiles);
    }
  }

  return created;
}

/**
 * Copy Claude Code skill files from the framework's directories.
 */
function installClaudeSkills(root: string, force: boolean): string[] {
  const created: string[] = [];

  // Determine the framework root (where packages/core/src/ lives)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const frameworkRoot = resolve(thisDir, "..", "..", "..");

  // Copy .skill files from the framework's skills/ directory to project root
  const skillsSource = join(frameworkRoot, "skills");
  if (existsSync(skillsSource)) {
    for (const entry of readdirSync(skillsSource)) {
      if (entry.endsWith(".skill")) {
        const srcFile = join(skillsSource, entry);
        const target = join(root, entry);
        if (!existsSync(target) || force) {
          copyFileSync(srcFile, target);
          created.push(entry);
        }
      }
    }
  }

  // Copy skill directories from .claude/skills/ in the framework to the project
  const frameworkSkillsDir = join(frameworkRoot, ".claude", "skills");
  if (existsSync(frameworkSkillsDir)) {
    const targetSkillsDir = join(root, ".claude", "skills");
    mkdirSync(targetSkillsDir, { recursive: true });
    for (const entry of readdirSync(frameworkSkillsDir)) {
      const skillDir = join(frameworkSkillsDir, entry);
      if (existsSync(skillDir) && statSync(skillDir).isDirectory()) {
        const targetDir = join(targetSkillsDir, entry);
        if (!existsSync(targetDir) || force) {
          cpSync(skillDir, targetDir, { recursive: true, force: true });
          created.push(relative(root, targetDir));
        }
      }
    }
  }

  return created;
}

/**
 * Install Tina4 context for ALL known AI tools (not just detected ones).
 */
export function installAllAiContext(root: string = ".", force: boolean = false): string[] {
  return installAiContext(root, {
    tools: Object.keys(AI_TOOLS),
    force,
  });
}

/**
 * Generate a human-readable report of AI tool detection.
 */
export function aiStatusReport(root: string = "."): string {
  const tools = detectAi(root);
  const installed = tools.filter((t) => t.status === "detected");
  const missing = tools.filter((t) => t.status === "not-detected");

  const lines: string[] = ["\nTina4 AI Context Status\n"];

  if (installed.length > 0) {
    lines.push("Detected AI tools:");
    for (const t of installed) {
      lines.push(`  + ${t.description} (${t.name})`);
    }
  } else {
    lines.push("No AI coding tools detected.");
  }

  if (missing.length > 0) {
    lines.push("\nNot detected (install context with `tina4nodejs ai --all`):");
    for (const t of missing) {
      lines.push(`  - ${t.description} (${t.name})`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

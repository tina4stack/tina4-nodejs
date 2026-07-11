/**
 * Tina4 AI — Install AI coding assistant context files.
 *
 * Simple menu-driven installer for AI tool context files.
 * The user picks which tools they use, we install the appropriate files.
 *
 *   import { showMenu, installSelected } from "tina4-nodejs";
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
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

// ── Skill files (the SKILL.md system) ───────────────────────────────────────
// `tina4 ai` installs the ACTUAL skills — not just a CLAUDE.md pointer to them —
// into BOTH the project (.claude/skills, so they travel with the repo) AND the
// user's global ~/.claude/skills (so they're available in every project). The
// Node developer skill lives in the tina4-nodejs repo; tina4-js + tina4-maintainer
// are the shared skills whose canonical copy is served from tina4-python. This
// mirrors the canonical install-skills.sh mapping exactly.

export const DEV_SKILL = "tina4-developer-nodejs";

interface SkillSpec {
  repo: string;
  references: string[];
}

const SKILLS: Record<string, SkillSpec> = {
  [DEV_SKILL]: {
    repo: "tina4-nodejs",
    references: [
      "auth-and-services.md", "data-and-orm.md", "deployment.md",
      "routes-and-api.md", "templates-and-frontend.md", "realtime.md",
    ],
  },
  "tina4-js": {
    repo: "tina4-python",
    references: [
      "html-and-components.md", "signals-and-reactivity.md",
      "persistence.md", "rtc.md",
    ],
  },
  "tina4-maintainer": {
    repo: "tina4-python",
    references: [
      "cli-and-deployment.md", "frond-and-frontend.md",
      "routing-and-orm.md", "subsystems.md",
    ],
  },
};

/**
 * Release ref to pull skills from — the installed framework version,
 * overridable with TINA4_SKILLS_REF (e.g. to test a branch/tag). Falls
 * back to "main" when the version can't be read.
 */
function skillsRef(): string {
  const ref = process.env.TINA4_SKILLS_REF;
  if (ref) return ref;
  const v = readVersion();
  return v && v !== "0.0.0" ? v : "main";
}

/**
 * Fetch a set of skill files over the network SYNCHRONOUSLY.
 *
 * Node has no built-in synchronous HTTP, and the whole installer chain
 * (installSelected → installForTool → installClaudeSkills) is synchronous and
 * can't be made async without breaking its existing callers/tests. So we run
 * ONE blocking child `node` process that fetches every URL in parallel with the
 * global `fetch` (Node 18+) and writes each body to all of its destinations.
 * The child prints a JSON array of the URLs it fetched successfully; any fetch
 * failure is skipped, never fatal.
 *
 * @param jobs  one entry per unique URL, with every file path it should land in
 * @returns the set of URLs that were fetched and written to disk
 */
function downloadSkillsSync(jobs: { url: string; dests: string[] }[]): Set<string> {
  if (jobs.length === 0) return new Set();
  const child = `
    const jobs = JSON.parse(process.argv[1]);
    const fs = require("node:fs");
    const path = require("node:path");
    (async () => {
      const ok = [];
      await Promise.all(jobs.map(async (job) => {
        try {
          const resp = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) return;
          const buf = Buffer.from(await resp.arrayBuffer());
          for (const dest of job.dests) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, buf);
          }
          ok.push(job.url);
        } catch { /* skip this file */ }
      }));
      process.stdout.write(JSON.stringify(ok));
    })();
  `;
  try {
    const out = execFileSync(process.execPath, ["-e", child, JSON.stringify(jobs)], {
      encoding: "utf-8",
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return new Set<string>(JSON.parse(out || "[]"));
  } catch {
    return new Set();
  }
}

/**
 * Install the Tina4 SKILL.md skills into the project AND the global
 * ~/.claude/skills, fetched from the release ref matching this framework
 * version. Returns the skills that were fully installed. Network-dependent —
 * on a fetch failure the skill is skipped, never fatal.
 */
export function installSkills(root: string = ".", targets?: string[]): string[] {
  const ref = skillsRef();
  const dests = targets ?? [
    join(resolve(root), ".claude", "skills"),
    join(homedir(), ".claude", "skills"),
  ];

  // Deduplicate: fetch each unique URL once, write it to every target path.
  const jobs: { url: string; dests: string[] }[] = [];
  const index = new Map<string, number>();
  const add = (url: string, filePath: string) => {
    let i = index.get(url);
    if (i === undefined) {
      i = jobs.length;
      index.set(url, i);
      jobs.push({ url, dests: [] });
    }
    jobs[i].dests.push(filePath);
  };

  const skillMdUrl: Record<string, string> = {};
  for (const [skill, spec] of Object.entries(SKILLS)) {
    const base = `https://raw.githubusercontent.com/tina4stack/${spec.repo}/${ref}/.claude/skills/${skill}`;
    skillMdUrl[skill] = `${base}/SKILL.md`;
    for (const dest of dests) {
      add(`${base}/SKILL.md`, join(dest, skill, "SKILL.md"));
      for (const r of spec.references) {
        add(`${base}/references/${r}`, join(dest, skill, "references", r));
      }
    }
  }

  const ok = downloadSkillsSync(jobs);

  // A skill counts as installed once its SKILL.md landed. downloadSkillsSync
  // writes a fetched URL to ALL of its destinations atomically, so a hit on the
  // SKILL.md URL means it reached every target.
  const installed: string[] = [];
  for (const skill of Object.keys(SKILLS)) {
    if (ok.has(skillMdUrl[skill])) installed.push(skill);
  }
  return installed;
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

// \u2500\u2500 v3.13.9: non-destructive context-file writer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// Pre-v3.13.9 the installer wrote a full developer guide to CLAUDE.md
// (and the other context files) on every run, clobbering whatever the
// user had put there. Now it writes only a marker-bracketed Tina4 skill
// block \u2014 pointing the assistant at .claude/skills/tina4-*/SKILL.md \u2014
// and leaves the rest of the file alone.

/** Return [start, end] markers for a context file. */
export function markersFor(contextFile: string): [string, string] {
  if (contextFile.toLowerCase().endsWith(".md")) {
    return ["<!-- tina4-skills:start -->", "<!-- tina4-skills:end -->"];
  }
  return ["# tina4-skills:start", "# tina4-skills:end"];
}

/** Return the marker-bracketed Tina4 skill registration block. */
export function skillBlock(contextFile: string): string {
  const [start, end] = markersFor(contextFile);
  const isMd = contextFile.toLowerCase().endsWith(".md");
  const body = isMd
    ? [
        "## Tina4 Skills",
        "",
        "When working on this Tina4 project, these skills give the assistant project-aware behaviour:",
        "",
        `- **${DEV_SKILL}** \u2014 Read \`.claude/skills/${DEV_SKILL}/SKILL.md\` before building features.`,
        "- **tina4-js** \u2014 Read `.claude/skills/tina4-js/SKILL.md` for frontend work.",
        "- **tina4-maintainer** \u2014 Read `.claude/skills/tina4-maintainer/SKILL.md` for framework-level changes.",
        "",
        "If Tina4 behaves differently from what these skills describe, that is a bug in the skill.",
        "Tell the developer, then report it at https://tina4.com/report-a-skill",
        "(or open an issue on the matching tina4stack/* GitHub repo).",
        "",
        "See https://tina4.com for full docs.",
      ].join("\n")
    : [
        "Tina4 Skills \u2014 read these files before working on this project:",
        `  .claude/skills/${DEV_SKILL}/SKILL.md   (feature development)`,
        "  .claude/skills/tina4-js/SKILL.md          (frontend / tina4-js)",
        "  .claude/skills/tina4-maintainer/SKILL.md  (framework-level changes)",
        "Found a skill that disagrees with how Tina4 actually behaves? Tell the developer,",
        "then report it at https://tina4.com/report-a-skill",
        "Docs: https://tina4.com",
      ].join("\n");
  return `${start}\n${body}\n${end}`;
}

/** True iff both start and end markers appear in order. */
export function hasMarkers(existing: string, start: string, end: string): boolean {
  const sIdx = existing.indexOf(start);
  if (sIdx === -1) return false;
  return existing.indexOf(end, sIdx + start.length) !== -1;
}

/** Replace the bracketed block in `existing` with `block`. */
export function replaceMarkerBlock(existing: string, block: string, start: string, end: string): string {
  const sIdx = existing.indexOf(start);
  if (sIdx === -1) return existing.replace(/\s+$/, "") + "\n\n" + block + "\n";
  const eIdx = existing.indexOf(end, sIdx + start.length);
  if (eIdx === -1) return existing.replace(/\s+$/, "") + "\n\n" + block + "\n";
  const before = existing.slice(0, sIdx).replace(/\s+$/, "");
  const after = existing.slice(eIdx + end.length).replace(/^\n+/, "");
  const glueBefore = before ? "\n\n" : "";
  const glueAfter = after ? "\n" + after : "\n";
  return `${before}${glueBefore}${block}${glueAfter}`;
}

const OLD_FRAMEWORK_HEADERS = [
  "# Tina4 Python",
  "# Tina4 PHP",
  "# Tina4 Ruby",
  "# CLAUDE.md \u2014 AI Developer Guide for tina4-nodejs",
  "# CLAUDE.md - AI Developer Guide for tina4-nodejs",
];

/**
 * True if the file starts with a header the pre-v3.13.9 installer
 * wrote. Used to migrate one-time off the old clobber-style install.
 */
export function looksLikeOldFrameworkInstall(existing: string): boolean {
  const head = existing.replace(/^\s+/, "").slice(0, 400);
  return OLD_FRAMEWORK_HEADERS.some((h) => head.startsWith(h));
}

/**
 * Write the context file non-destructively. Returns a human-readable
 * action verb for the caller's log line.
 *
 * Four branches:
 *   1. Doesn't exist  \u2192 write framework guide + skill block
 *   2. Has markers    \u2192 refresh just the skill block (idempotent)
 *   3. Old header     \u2192 migrate: replace old dump with new guide + block
 *   4. User content   \u2192 append the skill block, preserve everything else
 */
export function writeOrMerge(contextPath: string, contextFile: string, frameworkGuide: string): string {
  const block = skillBlock(contextFile);
  const [start, end] = markersFor(contextFile);

  if (!existsSync(contextPath)) {
    writeFileSync(contextPath, frameworkGuide.replace(/\s+$/, "") + "\n\n" + block + "\n", "utf-8");
    return "Installed";
  }

  const existing = readFileSync(contextPath, "utf-8");

  if (hasMarkers(existing, start, end)) {
    writeFileSync(contextPath, replaceMarkerBlock(existing, block, start, end), "utf-8");
    return "Refreshed skill block in";
  }

  if (looksLikeOldFrameworkInstall(existing)) {
    const head = existing.replace(/^\s+/, "");
    const preamble = existing.slice(0, existing.length - head.length);
    const newContent =
      (preamble.trim() ? preamble.replace(/\s+$/, "") + "\n\n" : "") +
      frameworkGuide.replace(/\s+$/, "") + "\n\n" + block + "\n";
    writeFileSync(contextPath, newContent, "utf-8");
    return "Migrated (replaced old framework dump in)";
  }

  writeFileSync(contextPath, existing.replace(/\s+$/, "") + "\n\n" + block + "\n", "utf-8");
  return "Appended skill block to";
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

  // v3.13.9: non-destructive write \u2014 see writeOrMerge above.
  const action = writeOrMerge(contextPath, tool.contextFile, context);
  const rel = relative(root, contextPath);
  created.push(rel);
  console.log(`  ${GREEN}\u2713${RESET} ${action} ${rel}`);

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
 * Install the Claude Code skills for this project.
 *
 * Fetches the SKILL.md skills from the release ref matching this framework
 * version into BOTH the project (.claude/skills) and the user's global
 * ~/.claude/skills. (The previous code copied from frameworkRoot/.claude/skills,
 * which exists only in a dev checkout \u2014 the npm package never ships
 * .claude/skills, so installed users got no skill files at all, only a
 * CLAUDE.md pointer to files that weren't there.)
 */
function installClaudeSkills(root: string): string[] {
  const created: string[] = [];
  for (const skill of installSkills(root)) {
    created.push(join(".claude", "skills", skill));
    console.log(`  ${GREEN}\u2713${RESET} Installed .claude/skills/${skill}  (project + global)`);
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

JWT auth built in. \`import { createToken, validateToken, hashPassword, checkPassword } from "tina4-nodejs"\`.
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

JWT auth built in. \`import { createToken, validateToken, hashPassword, checkPassword } from "tina4-nodejs"\`.
GET routes are public. POST/PUT/PATCH/DELETE require auth by default.

## Testing

\`\`\`bash
npx tina4nodejs test      # Run all tests
\`\`\`

Add test files in \`test/\` directory. Use built-in inline testing:
\`\`\`typescript
import { tests, assertEqual, runAll } from "tina4-nodejs";
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

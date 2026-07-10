import { initProject } from "./commands/init.js";
import { serveProject } from "./commands/serve.js";
import { runMigrations } from "./commands/migrate.js";
import { createMigration } from "./commands/migrateCreate.js";
import { migrateStatus } from "./commands/migrateStatus.js";
import { migrateRollback } from "./commands/migrateRollback.js";
import { listRoutes } from "./commands/routes.js";
import { runTests } from "./commands/test.js";
import { generate, GENERATORS } from "./commands/generate.js";
import { runSeeds } from "./commands/seed.js";
import { runMetrics } from "./commands/metrics.js";
import { queueCommand, QUEUE_SUBCOMMAND_NAMES } from "./commands/queue.js";
import { buildImage } from "./commands/build.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Version (cheap, side-effect-free) ───────────────────────────────
//
// Walk up from this file to the nearest package.json and read its version.
// From the source tree that is packages/cli/package.json; from the built
// dist/bin.js (or the published `tina4nodejs` package) it is the CLI package's
// own package.json — the framework version in every layout. Only touches the
// filesystem (JSON reads); it never bootstraps the app or opens a DB.

function readCliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (typeof pkg.version === "string" && pkg.version) return pkg.version;
      } catch {
        // keep walking — a malformed package.json isn't ours
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

// ── Port-kill helper ────────────────────────────────────────────────

function killProcessOnPort(port: number): boolean {
  try {
    const result = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 5000 }).trim();
    if (result) {
      const pids = result.split("\n");
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), "SIGTERM");
        } catch {
          // ignore ProcessLookupError / PermissionError
        }
      }
      console.log(`  Killed existing process on port ${port} (PID: ${pids.join(", ")})`);
      return true;
    }
  } catch {
    // lsof not found or no process on port — that's fine
  }
  return false;
}

// ── Self-describing command surface ─────────────────────────────────

export interface CommandManifestEntry {
  name: string;
  summary: string;
  args?: string[];
  subcommands?: string[];
}

export interface CommandManifest {
  framework: string;
  version: string;
  commands: CommandManifestEntry[];
}

/**
 * Build the machine-readable manifest of the CLI's command surface.
 *
 * Pure data: reads the module-level COMMANDS registry plus the framework
 * version — no bootstrap, no database, no migrations, no app imports. This is
 * exactly what `commands --json` serialises and what the tina4 Rust client
 * consumes to discover which commands this framework supports.
 *
 * Shape (identical keys to the Python master):
 *   { framework: "nodejs", version: "<x.y.z>",
 *     commands: [{ name, summary, args?, subcommands? }, ...] }
 */
export function buildCommandManifest(): CommandManifest {
  const commands: CommandManifestEntry[] = Object.entries(COMMANDS).map(([name, spec]) => {
    const entry: CommandManifestEntry = { name, summary: spec.summary };
    if (spec.args && spec.args.length) entry.args = [...spec.args];
    if (spec.subcommands && spec.subcommands.length) entry.subcommands = [...spec.subcommands];
    return entry;
  });
  return { framework: "nodejs", version: readCliVersion(), commands };
}

/**
 * Emit the CLI's own command surface — the self-describing manifest.
 *
 *   tina4nodejs commands           human-readable list
 *   tina4nodejs commands --json    machine-readable manifest (for the tina4 CLI)
 *
 * CHEAP + side-effect-free by contract: it only prints the static COMMANDS
 * registry plus the framework version. It MUST NOT bootstrap the framework,
 * open a database, run migrations, or import app modules — the Rust client
 * calls this on `tina4 --help`, in any directory, so it must be instant and
 * safe to run anywhere.
 */
export function runCommands(args: string[] = []): void {
  const manifest = buildCommandManifest();

  if (args.includes("--json")) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  console.log(`\n  Tina4 ${manifest.framework} — ${manifest.version}\n`);
  const width = Math.max(...manifest.commands.map((c) => c.name.length));
  for (const c of manifest.commands) {
    console.log(`  ${c.name.padEnd(width)}  ${c.summary}`);
    if (c.subcommands && c.subcommands.length) {
      console.log(`  ${" ".repeat(width)}    ${c.subcommands.join(", ")}`);
    }
  }
  console.log("");
}

/**
 * Print the human-readable command reference.
 *
 * Generated from the COMMANDS and GENERATORS registries — the SAME single
 * source of truth that drives dispatch (`main`) and the `commands --json`
 * manifest — so the help text can never drift from what the CLI actually does.
 */
function printHelp(): void {
  const commandRows: [string, string][] = Object.entries(COMMANDS).map(
    ([name, spec]) => [`${name}${spec.usage ? " " + spec.usage : ""}`, spec.summary],
  );
  const generatorRows: [string, string][] = Object.entries(GENERATORS).map(
    ([name, spec]) => [`generate ${name}${spec.usage ? " " + spec.usage : ""}`, spec.summary],
  );

  // Align summaries in a column; a left cell longer than the cap overflows
  // cleanly (2-space gap) rather than pushing every other summary out.
  const pad = Math.min(46, Math.max(...[...commandRows, ...generatorRows].map(([left]) => left.length)));
  const row = (left: string, summary: string): string => {
    const gap = left.length <= pad ? pad : left.length;
    return `  ${left.padEnd(gap)}  ${summary}`;
  };

  const lines: string[] = [
    "",
    "  tina4nodejs — The Intelligent Native Application 4ramework",
    "",
    "  Usage: tina4nodejs <command> [options]",
    "",
    "  Commands:",
    ...commandRows.map(([left, summary]) => row(left, summary)),
    "",
    "  Generators:",
    ...generatorRows.map(([left, summary]) => row(left, summary)),
    "",
    "  Scaffolding-first: logic-shaped generators (route without --model, service,",
    "  queue, validator, seeder, websocket, listener) emit real wiring + an AI-FILL",
    "  placeholder (throws until filled); CRUD-shaped ones emit working code. Writes",
    "  are secure by default — use --public to open them.",
    "",
    "  Field types: string, int, float, bool, text, datetime",
    "  Table names: singular by default (Product → product)",
    "",
    "  Options:",
    "    --port <number>      Server port (default: 7148)",
    "    --no-browser         Don't open the browser on serve",
    "    --no-reload          Disable file watcher / live-reload on serve",
    "    --all                Install AI context for all tools (with ai command)",
    "    --force              Overwrite existing AI context files (with ai command)",
    "    --help               Show this help message",
    "",
    "  https://tina4.com",
    "",
  ];
  console.log(lines.join("\n"));
}

// ── Console REPL (heavy — imports the framework lazily on demand) ────

async function openConsole(): Promise<void> {
  const repl = await import("node:repl");
  const { loadEnv, Router, Log } = await import("../../core/src/index.js");
  const { initDatabase, Database } = await import("../../orm/src/index.js");

  loadEnv();

  const dbUrl = process.env.TINA4_DATABASE_URL;
  let db: unknown = null;
  if (dbUrl) {
    try {
      db = await initDatabase({ url: dbUrl });
    } catch {
      console.warn("  Warning: could not connect to database — db will be null");
    }
  }

  console.log("\n  Tina4 Node.js Console");
  console.log("  Type JavaScript. Framework is loaded.");
  console.log("  Available: db, Router, Database, Log");
  console.log("  Exit: Ctrl+D or .exit\n");

  const r = repl.start({ prompt: "tina4> " });

  r.context.Router = Router;
  r.context.Database = Database;
  r.context.Log = Log;
  r.context.db = db;

  await new Promise<void>((resolve) => r.on("exit", resolve));
}

async function installAiContext(args: string[]): Promise<void> {
  const { showMenu, installSelected, installAll } = await import("../../core/src/ai.js");
  const root = args[0] || ".";

  if (args.includes("--all")) {
    installAll(root);
  } else {
    const selection = await showMenu(root);
    if (selection) {
      installSelected(root, selection);
    }
  }
}

// ── Command registry — the single source of truth ───────────────────
//
// One entry per command drives main() dispatch, the human help (printHelp),
// AND the machine-readable manifest (commands --json). Add a command in ONE
// place and it appears in dispatch, help, and discovery — there is no second
// list to sync. Mirrors the Python master's COMMANDS registry
// (tina4_python/cli/__init__.py).
//
//   COMMANDS[name] = {
//     handler: (cmdArgs) => …,   // args AFTER the command name
//     summary: string,
//     usage?: string,            // arg/flag hint for printHelp (human only)
//     args?: string[],           // positional args for the manifest ("x?" = optional)
//     subcommands?: string[],    // sub-names for the manifest (generate)
//   }

export interface CommandSpec {
  handler: (cmdArgs: string[]) => void | Promise<void>;
  summary: string;
  usage?: string;
  args?: string[];
  subcommands?: string[];
}

export const COMMANDS: Record<string, CommandSpec> = {
  init: {
    handler: async (a) => { await initProject(a[0] || "."); },
    usage: "[dir]",
    args: ["dir?"],
    summary: "Create a new Tina4 project (default: current directory)",
  },
  serve: {
    handler: async (a) => {
      const portIndex = a.indexOf("--port");
      const port = portIndex !== -1 ? parseInt(a[portIndex + 1], 10) : 7148;
      const noBrowser = a.includes("--no-browser");
      const noReload = a.includes("--no-reload");
      killProcessOnPort(port);
      await serveProject({ port, noBrowser, noReload });
    },
    usage: "[--port P] [--no-browser] [--no-reload]",
    summary: "Start the dev server with hot-reload (default: 0.0.0.0:7148)",
  },
  migrate: {
    handler: async (a) => { await runMigrations(a[0]); },
    summary: "Run pending SQL migrations",
  },
  "migrate:create": {
    handler: async (a) => { await createMigration(a.join(" ") || undefined); },
    usage: "<desc>",
    args: ["description"],
    summary: "Create a new migration file pair (.sql + .down.sql)",
  },
  "migrate:status": {
    handler: async (a) => { await migrateStatus(a[0]); },
    summary: "Show completed and pending migrations",
  },
  "migrate:rollback": {
    handler: async (a) => { await migrateRollback(a[0]); },
    summary: "Roll back the last batch of migrations",
  },
  routes: {
    handler: async () => { await listRoutes(); },
    summary: "List all registered routes",
  },
  test: {
    handler: async (a) => { await runTests(a[0]); },
    usage: "[file]",
    summary: "Run project tests",
  },
  queue: {
    handler: async (a) => { await queueCommand(a); },
    usage: "<work|stats|retry|clear> [topic]",
    subcommands: QUEUE_SUBCOMMAND_NAMES,
    summary: "Run queue workers and manage jobs",
  },
  build: {
    handler: (a) => { buildImage(a); },
    usage: "[--tag NAME] [--file PATH]",
    summary: "Build the deployable Docker image",
  },
  generate: {
    handler: async (a) => { await generate(a[0], a[1] || "", a.slice(2)); },
    usage: "<what> <name> [options]",
    subcommands: Object.keys(GENERATORS),
    summary: "Generate scaffolding (see Generators below)",
  },
  seed: {
    handler: async (a) => { await runSeeds(a[0]); },
    usage: "[file]",
    summary: "Run database seed files from src/seeds/",
  },
  metrics: {
    handler: (a) => { process.exit(runMetrics(a)); },
    usage: "[--top N] [--json] [--fail-on warn|error] [--path DIR]",
    summary: "Rank top code-quality offenders",
  },
  console: {
    handler: async () => { await openConsole(); },
    summary: "Open an interactive REPL with the framework loaded",
  },
  ai: {
    handler: async (a) => { await installAiContext(a); },
    usage: "[--all]",
    summary: "Install AI coding assistant context files",
  },
  commands: {
    handler: (a) => { runCommands(a); },
    usage: "[--json]",
    summary: "List available commands (add --json for the machine manifest)",
  },
  help: {
    handler: () => { printHelp(); },
    summary: "Show this help message",
  },
};

// ── Dispatch ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let command = args[0];
  const cmdArgs = args.slice(1);

  // No command or a bare help flag → the help command.
  if (command === undefined || command === "--help" || command === "-h") {
    command = "help";
  }

  const spec = COMMANDS[command];
  if (spec) {
    await spec.handler(cmdArgs);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

// Run only when invoked as the entrypoint — importing this module (e.g. in a
// test to inspect COMMANDS / buildCommandManifest) must NOT dispatch a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

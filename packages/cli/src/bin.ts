import { initProject } from "./commands/init.js";
import { serveProject } from "./commands/serve.js";
import { runMigrations } from "./commands/migrate.js";
import { createMigration } from "./commands/migrateCreate.js";
import { migrateStatus } from "./commands/migrateStatus.js";
import { migrateRollback } from "./commands/migrateRollback.js";
import { listRoutes } from "./commands/routes.js";
import { runTests } from "./commands/test.js";
import { generate, GENERATORS, RESOLUTION_ENVELOPE_VERSION } from "./commands/generate.js";
import { runSeeds } from "./commands/seed.js";
import { queueCommand, QUEUE_SUBCOMMAND_NAMES } from "./commands/queue.js";
import { buildImage } from "./commands/build.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
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

// ── Port-takeover helper ────────────────────────────────────────────
//
// The identity check, PID safety filter, container guard, dev gate and opt-out
// all live in ONE shared module (@tina4/core portTakeover) so this CLI path and
// the runtime bind-failure fallback in core/server.ts cannot diverge
// (TAKEOVER-DEC-02). Loaded lazily (mirroring how serve.ts pulls in core) so a
// quick `tina4nodejs --help` never pays to import it.

/**
 * Reclaim `port` from a stale Tina4 dev server, only when it is safe.
 *
 * Signals a holder ONLY when a Tina4 dev server recorded its PID in the per-port
 * PID file (TAKEOVER-DEC-01). A foreign holder is left running and a clear
 * message is printed; takeover is also skipped in a container, outside dev mode,
 * and when opted out (`TINA4_NO_TAKEOVER` / `tina4 serve --no-kill`).
 *
 * Returns true only when a Tina4 holder was actually signalled.
 */
async function killProcessOnPort(port: number): Promise<boolean> {
  const { takeOverPort, isDev, noTakeoverOptedOut, TAKEOVER_KILLED, TAKEOVER_REFUSALS } =
    await import("../../core/src/portTakeover.js");
  const result = takeOverPort(port, isDev(), noTakeoverOptedOut());
  if (result.status === TAKEOVER_KILLED) {
    console.log(`  ${result.message}`);
    return true;
  }
  if (result.message && TAKEOVER_REFUSALS.includes(result.status)) {
    console.log(`  ${result.message}`);
  }
  return false;
}

// ── Self-describing command surface ─────────────────────────────────

export interface CommandManifestEntry {
  name: string;
  summary: string;
  args?: string[];
  subcommands?: string[];
  /** True when the tina4 client implements this command, not the framework. */
  delegated?: boolean;
}

/**
 * A stable, machine-readable pointer to the `generate` resolution envelope
 * this framework speaks. Consumers (the tina4 client, an AI agent, a
 * downstream tool) MUST NOT hard-code an envelope shape — instead they read
 * `resolution_contract.envelope` from this manifest and follow its version.
 * `version` bumps on any breaking key rename or removal; `envelope` is the
 * name of the schema (currently `generate_v1`).
 */
export interface ResolutionContract {
  version: string;
  envelope: string;
}

export interface CommandManifest {
  framework: string;
  version: string;
  commands: CommandManifestEntry[];
  resolution_contract: ResolutionContract;
}

/**
 * Build the machine-readable manifest of the CLI's command surface.
 *
 * Pure data: reads the module-level COMMANDS and DELEGATED registries plus the
 * framework version — no bootstrap, no database, no migrations, no app imports.
 * This is exactly what `commands --json` serialises and what the tina4 Rust
 * client consumes to discover which commands this framework supports.
 *
 * Commands handed to the `tina4` client carry `delegated: true`, so the manifest
 * describes the WHOLE surface the CLI accepts while still saying who implements
 * each one. The client needs no change: its help renderer already drops manifest
 * names that clash with its own natives.
 *
 * Shape (identical keys to the Python master):
 *   { framework: "nodejs", version: "<x.y.z>",
 *     commands: [{ name, summary, args?, subcommands?, delegated? }, ...] }
 */
export function buildCommandManifest(): CommandManifest {
  const commands: CommandManifestEntry[] = Object.entries(COMMANDS).map(([name, spec]) => {
    const entry: CommandManifestEntry = { name, summary: spec.summary };
    if (spec.args && spec.args.length) entry.args = [...spec.args];
    if (spec.subcommands && spec.subcommands.length) entry.subcommands = [...spec.subcommands];
    return entry;
  });
  for (const [name, spec] of Object.entries(DELEGATED)) {
    const entry: CommandManifestEntry = { name, summary: spec.summary, delegated: true };
    if (spec.args && spec.args.length) entry.args = [...spec.args];
    commands.push(entry);
  }
  return {
    framework: "nodejs",
    version: readCliVersion(),
    commands,
    // Feature B (3.13.117): declare the resolution envelope this framework
    // emits for `generate <what> --json`. Consumers read this to know which
    // schema to parse — never hard-code the shape.
    resolution_contract: { version: "1", envelope: RESOLUTION_ENVELOPE_VERSION },
  };
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
    const marker = c.delegated ? ` (${CLIENT_BINARY} client)` : "";
    console.log(`  ${c.name.padEnd(width)}  ${c.summary}${marker}`);
    if (c.subcommands && c.subcommands.length) {
      console.log(`  ${" ".repeat(width)}    ${c.subcommands.join(", ")}`);
    }
  }
  console.log("");
}

/**
 * Print the human-readable command reference.
 *
 * Generated from the COMMANDS, DELEGATED and GENERATORS registries — the SAME
 * single source of truth that drives dispatch (`main`) and the `commands --json`
 * manifest — so the help text can never drift from what the CLI actually does.
 */
function printHelp(): void {
  const commandRows: [string, string][] = Object.entries(COMMANDS).map(
    ([name, spec]) => [`${name}${spec.usage ? " " + spec.usage : ""}`, spec.summary],
  );
  const delegatedRows: [string, string][] = Object.entries(DELEGATED).map(
    ([name, spec]) => [`${name}${spec.usage ? " " + spec.usage : ""}`, spec.summary],
  );
  const generatorRows: [string, string][] = Object.entries(GENERATORS).map(
    ([name, spec]) => [`generate ${name}${spec.usage ? " " + spec.usage : ""}`, spec.summary],
  );

  // Align summaries in a column; a left cell longer than the cap overflows
  // cleanly (2-space gap) rather than pushing every other summary out.
  const pad = Math.min(46, Math.max(...[...commandRows, ...delegatedRows, ...generatorRows].map(([left]) => left.length)));
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
    `  Delegated to the ${CLIENT_BINARY} client (same behaviour in every framework):`,
    ...delegatedRows.map(([left, summary]) => row(left, summary)),
    `    (these run the ${CLIENT_BINARY} client — install: curl -fsSL https://tina4.com/install.sh | sh)`,
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
      // --no-kill opts out of port takeover for the whole process, so the CLI
      // path here AND the runtime bind-failure fallback both honour it
      // (TAKEOVER-DEC-03).
      if (a.includes("--no-kill")) process.env.TINA4_NO_TAKEOVER = "true";
      await killProcessOnPort(port);
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
    summary: "Create a new migration file",
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

// ── Delegation to the `tina4` client ────────────────────────────────
//
// `doctor`, `setup` and `deploy` are owned by the Rust `tina4` client, not by
// any framework. `doctor` probes ALL FOUR runtimes plus package managers, ports
// and global AI-skills currency; `setup` installs language runtimes (Homebrew /
// Chocolatey, with UAC elevation on Windows) and scaffolds a project from
// nothing; `deploy` writes deployment boilerplate baked into the client binary.
// Cloning any of them into four languages would duplicate hundreds of lines per
// language for zero new capability — and four copies would immediately drift.
//
// So the framework CLI DELEGATES: it resolves `tina4` on PATH, runs it with the
// same argv, and exits with the client's exit code. All four frameworks reach
// the SAME implementation, which is a stronger parity guarantee than four ports.
//
// Delegation is ALLOW-LISTED, never blind. The client forwards ITS unknown
// commands to the framework CLI, so a framework that forwarded its unknowns back
// would ping-pong an unknown command between two processes forever — and that is
// not hypothetical here: this package publishes a `tina4` bin alias, so `tina4`
// on PATH can already resolve to THIS CLI. The closed DELEGATED set contains only
// commands the client dispatches natively, so no loop is possible by
// construction, and a real typo still gets "Unknown command".
//
// There are no handlers here: main() runs `tina4 <name> <args...>` and exits with
// its code. Keep this set closed and identical in all four frameworks. Summaries
// are the client's own wording, verbatim. Mirrors the Python master's DELEGATED.

export interface DelegatedSpec {
  summary: string;
  usage?: string;
  args?: string[];
}

export const DELEGATED: Record<string, DelegatedSpec> = {
  doctor: { summary: "Check installed languages and tools" },
  setup: { summary: "Guided, menu-driven setup: install everything + scaffold a ready-to-run project" },
  deploy: {
    usage: "<docker|systemd|nginx|cpanel> [--force]",
    args: ["target"],
    summary: "Generate deployment scaffolding (Dockerfile, systemd unit, nginx block, cPanel)",
  },
};

export const CLIENT_BINARY = "tina4";

// Internal process marker (same class as the client's own TINA4_SETUP_ELEVATED):
// set on the child so a client that resolves back to a framework CLI is caught
// instead of spawning forever. NOT user configuration — deliberately absent from
// the CLI's known_vars().
export const DELEGATION_GUARD_ENV = "TINA4_CLI_DELEGATED";

// 127 is the conventional "command not found" and covers both ways the client
// can be unreachable (absent from PATH, or the loop guard tripping).
export const EXIT_CLIENT_UNAVAILABLE = 127;
export const EXIT_UNKNOWN_COMMAND = 1;

const CLIENT_INSTALL_HINT =
  "  Install it:  curl -fsSL https://tina4.com/install.sh | sh\n" +
  "  Windows:     irm https://tina4.com/install.ps1 | iex";

/**
 * Absolute path of the `tina4` client on PATH, or null if it isn't there.
 *
 * Scans PATH directly rather than shelling out to which/where — one less process
 * and it behaves the same on every platform.
 */
function findClient(): string | null {
  const windows = process.platform === "win32";
  const names = windows
    ? [`${CLIENT_BINARY}.exe`, `${CLIENT_BINARY}.cmd`, `${CLIENT_BINARY}.bat`]
    : [CLIENT_BINARY];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not there — keep looking
      }
    }
  }
  return null;
}

/**
 * Run `tina4 <command> <args...>`, returning the client's exit code.
 *
 * Returns EXIT_CLIENT_UNAVAILABLE (127) with an actionable message when the
 * client is not on PATH, or when the re-entry guard shows the resolved `tina4`
 * came back to a framework CLI (a delegation loop).
 */
export function delegateToClient(command: string, args: string[]): number {
  if (process.env[DELEGATION_GUARD_ENV] === command) {
    console.error(
      `  Refusing to delegate '${command}' again — the 'tina4' on your PATH\n` +
      `  resolved back to a framework CLI instead of the tina4 client.\n\n` +
      `  Check which 'tina4' comes first on your PATH and put the client first.`,
    );
    return EXIT_CLIENT_UNAVAILABLE;
  }

  const client = findClient();
  if (client === null) {
    console.error(
      `  '${command}' is provided by the tina4 client, which is not on your PATH.\n\n` +
      `${CLIENT_INSTALL_HINT}\n\n` +
      `  Then run:    ${CLIENT_BINARY} ${command}`,
    );
    return EXIT_CLIENT_UNAVAILABLE;
  }

  // stdio is inherited, so the client's interactive prompts (setup) and colour
  // output work exactly as if it had been invoked directly.
  const result = spawnSync(client, [command, ...args], {
    stdio: "inherit",
    env: { ...process.env, [DELEGATION_GUARD_ENV]: command },
  });
  if (result.error) {
    console.error(`  Could not start the tina4 client at ${client}: ${result.error.message}`);
    return EXIT_CLIENT_UNAVAILABLE;
  }
  return result.status ?? EXIT_CLIENT_UNAVAILABLE;
}

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

  if (command in DELEGATED) {
    process.exit(delegateToClient(command, cmdArgs));
  }

  // A genuinely unknown command is an ERROR: exit non-zero so a typo in a script
  // or CI step fails loudly instead of reporting success.
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(EXIT_UNKNOWN_COMMAND);
}

// Run only when invoked as the entrypoint — importing this module (e.g. in a
// test to inspect COMMANDS / buildCommandManifest) must NOT dispatch a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { initProject } from "./commands/init.js";
import { serveProject } from "./commands/serve.js";
import { runMigrations } from "./commands/migrate.js";
import { createMigration } from "./commands/migrateCreate.js";
import { migrateStatus } from "./commands/migrateStatus.js";
import { migrateRollback } from "./commands/migrateRollback.js";
import { listRoutes } from "./commands/routes.js";
import { runTests } from "./commands/test.js";
import { generate } from "./commands/generate.js";
import { runSeeds } from "./commands/seed.js";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const command = args[0];

const HELP = `
  tina4nodejs — This is not a framework.

  Usage:
    tina4nodejs init [dir]            Create a new Tina4 project (default: current directory)
    tina4nodejs serve                 Start the dev server with hot-reload
    tina4nodejs migrate               Run pending SQL migrations
    tina4nodejs migrate:create <desc> Create a new migration file pair (.sql + .down.sql)
    tina4nodejs migrate:status        Show completed and pending migrations
    tina4nodejs migrate:rollback      Roll back the last batch of migrations
    tina4nodejs routes                List all registered routes
    tina4nodejs test [file]           Run project tests
    tina4nodejs seed [file]           Run database seed files from src/seeds/
    tina4nodejs ai                    Install AI coding assistant context files
    tina4nodejs help                  Show this help message

  Generators:
    tina4nodejs generate model <Name> [--fields "name:string,price:float"]
    tina4nodejs generate route <name> [--model Name]
    tina4nodejs generate crud <Name> [--fields "..."]   Model + migration + routes + form + view + test
    tina4nodejs generate migration <description>
    tina4nodejs generate middleware <Name>
    tina4nodejs generate test <name>
    tina4nodejs generate form <Name> [--fields "..."]   Form template with inputs matching model fields
    tina4nodejs generate view <Name> [--fields "..."]   List + detail templates for viewing records
    tina4nodejs generate auth                           Login/register/logout routes + User model + templates

  Field types: string, int, float, bool, text, datetime
  Table names: singular by default (Product → product)

  Options:
    --port <number>      Server port (default: 7148)
    --no-browser         Don't open the browser on serve
    --all                Install AI context for all tools (with ai command)
    --force              Overwrite existing AI context files (with ai command)
    --help               Show this help message
`;

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

async function main(): Promise<void> {
  switch (command) {
    case "init": {
      const name = args[1] || ".";
      await initProject(name);
      break;
    }
    case "serve": {
      const portIndex = args.indexOf("--port");
      const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 7148;
      const noBrowser = args.includes("--no-browser");

      // Kill any existing process on the port
      killProcessOnPort(port);

      await serveProject({ port, noBrowser });
      break;
    }
    case "migrate": {
      await runMigrations(args[1]);
      break;
    }
    case "migrate:create": {
      const description = args.slice(1).join(" ");
      await createMigration(description || undefined);
      break;
    }
    case "migrate:status": {
      await migrateStatus(args[1]);
      break;
    }
    case "migrate:rollback": {
      await migrateRollback(args[1]);
      break;
    }
    case "routes": {
      await listRoutes();
      break;
    }
    case "test": {
      await runTests(args[1]);
      break;
    }
    case "generate": {
      const what = args[1];
      const genName = args[2] || "";
      const extraArgs = args.slice(3);
      await generate(what, genName, extraArgs);
      break;
    }
    case "seed": {
      await runSeeds(args[1]);
      break;
    }
    case "ai": {
      const { showMenu, installSelected, installAll } = await import("../../core/src/ai.js");
      const root = args[1] || ".";

      if (args.includes("--all")) {
        installAll(root);
      } else {
        const selection = await showMenu(root);
        if (selection) {
          installSelected(root, selection);
        }
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

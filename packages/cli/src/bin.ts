import { initProject } from "./commands/init.js";
import { serveProject } from "./commands/serve.js";
import { runMigrations } from "./commands/migrate.js";
import { createMigration } from "./commands/migrateCreate.js";
import { listRoutes } from "./commands/routes.js";
import { runTests } from "./commands/test.js";

const args = process.argv.slice(2);
const command = args[0];

const HELP = `
  tina4nodejs — This is not a framework.

  Usage:
    tina4nodejs init [dir]            Create a new Tina4 project (default: current directory)
    tina4nodejs serve                 Start the dev server with hot-reload
    tina4nodejs migrate               Run pending SQL migrations
    tina4nodejs migrate:create <desc> Create a new migration file
    tina4nodejs routes                List all registered routes
    tina4nodejs test [file]           Run project tests
    tina4nodejs ai                    Detect AI coding tools and install context
    tina4nodejs help                  Show this help message

  Options:
    --port <number>      Server port (default: 3000)
    --all                Install AI context for all tools (with ai command)
    --force              Overwrite existing AI context files (with ai command)
    --help               Show this help message
`;

async function main(): Promise<void> {
  switch (command) {
    case "init": {
      const name = args[1] || ".";
      await initProject(name);
      break;
    }
    case "serve": {
      const portIndex = args.indexOf("--port");
      const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3000;
      await serveProject({ port });
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
    case "routes": {
      await listRoutes();
      break;
    }
    case "test": {
      await runTests(args[1]);
      break;
    }
    case "ai": {
      const { detectAi, installAiContext, installAllAiContext, aiStatusReport } = await import("../../core/src/ai.js");
      const root = args[1] || ".";
      const installAll = args.includes("--all");
      const force = args.includes("--force");

      // Show status
      console.log(aiStatusReport(root));

      // Install context
      if (installAll) {
        const created = installAllAiContext(root, force);
        if (created.length > 0) {
          console.log("Installed AI context files:");
          for (const f of created) {
            console.log(`  + ${f}`);
          }
        } else {
          console.log("All AI context files already exist (use --force to overwrite).");
        }
      } else {
        const created = installAiContext(root, { force });
        if (created.length > 0) {
          console.log("Installed AI context files:");
          for (const f of created) {
            console.log(`  + ${f}`);
          }
        } else {
          console.log("No new AI context files needed.");
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

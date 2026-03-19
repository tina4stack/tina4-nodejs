import { initProject } from "./commands/init.js";
import { serveProject } from "./commands/serve.js";

const args = process.argv.slice(2);
const command = args[0];

const HELP = `
  tina4 — This is not a framework.

  Usage:
    tina4 init <name>    Create a new Tina4 project
    tina4 serve          Start the dev server with hot-reload

  Options:
    --port <number>      Server port (default: 3000)
    --help               Show this help message
`;

async function main(): Promise<void> {
  switch (command) {
    case "init": {
      const name = args[1];
      if (!name) {
        console.error("Error: Project name is required.\n  Usage: tina4 init <name>");
        process.exit(1);
      }
      await initProject(name);
      break;
    }
    case "serve": {
      const portIndex = args.indexOf("--port");
      const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3000;
      await serveProject({ port });
      break;
    }
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

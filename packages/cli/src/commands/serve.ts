import { resolve } from "node:path";
import { existsSync } from "node:fs";

export interface ServeOptions {
  port?: number;
  noBrowser?: boolean;
  noReload?: boolean;
}

export async function serveProject(options: ServeOptions): Promise<void> {
  if (options.noReload) {
    process.env.TINA4_NO_RELOAD = "true";
  }

  const port = options.port ?? 7148;
  const cwd = process.cwd();

  const routesDir = resolve(cwd, "src/routes");
  const ormDir = resolve(cwd, "src/orm");
  const modelsDir = resolve(cwd, "src/models");
  const templatesDir = resolve(cwd, "src/templates");
  const staticDir = resolve(cwd, "public");

  if (!existsSync(routesDir) && !existsSync(modelsDir) && !existsSync(ormDir)) {
    console.error("  Error: Not a Tina4 project. Run this from a project created with 'tina4 init'.");
    process.exit(1);
  }

  const { startServer } = await import("../../../core/src/index.js");

  const server = await startServer({
    port,
    routesDir,
    modelsDir,
    templatesDir,
    staticDir,
  });

  // File watching is handled by the Rust CLI (tina4 serve). The framework
  // only needs POST /__dev/api/reload to update the mtime counter for browser polling.
  // No internal file watcher.

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down...");
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

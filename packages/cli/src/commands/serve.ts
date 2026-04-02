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
  const { watchForChanges } = await import("../../../core/src/watcher.js");

  const server = await startServer({
    port,
    routesDir,
    modelsDir,
    templatesDir,
    staticDir,
  });

  // Watch for file changes and reload routes
  const noReload = ["true", "1", "yes"].includes((process.env.TINA4_NO_RELOAD ?? "").toLowerCase());
  const watchDirs = [routesDir, ormDir, modelsDir, templatesDir].filter((d) => existsSync(d));
  let watcher: { close: () => void } | null = null;
  if (!noReload) {
    watcher = watchForChanges(watchDirs, async () => {
      try {
        const { discoverRoutes } = await import("../../../core/src/index.js");
        // Clear routes BEFORE re-discovery to avoid stale duplicates
        server.router.clear();
        const routes = await discoverRoutes(routesDir);
        for (const route of routes) {
          server.router.addRoute(route);
        }
        console.log(`  Reloaded ${routes.length} route(s)`);
      } catch (err) {
        console.error("  Error reloading routes:", err);
      }
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down...");
    watcher?.close();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

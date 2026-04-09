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

  // Watch for file changes.
  //
  // Templates and static assets are re-read from disk every request in dev mode,
  // so we only need to touch the router when a .ts/.js route file actually
  // changes. Clearing the router on every edit (including templates) leaves a
  // brief window where the router is empty — any request hitting that window
  // gets a 404 whose response path bypasses the dev toolbar injection, so the
  // toolbar appears to "vanish" after a hot reload. Route-file-only clearing
  // matches the behaviour of Python's DevReload and the fix made in PHP v3.10.87.
  const noReload = ["true", "1", "yes"].includes((process.env.TINA4_NO_RELOAD ?? "").toLowerCase());
  const watchDirs = [routesDir, ormDir, modelsDir, templatesDir].filter((d) => existsSync(d));
  let watcher: { close: () => void } | null = null;
  if (!noReload) {
    watcher = watchForChanges(watchDirs, async ({ code }) => {
      if (!code) {
        // Template/CSS/JS asset change — nothing to do in the server. The
        // browser will re-fetch on its own reload cycle and the request will
        // be served against the existing route set with the toolbar intact.
        return;
      }
      try {
        // Re-discover routes. discoverRoutes() cache-busts imports via ?t=<timestamp>,
        // so the new modules are loaded fresh. Build the new list first, then
        // replace the router's state in one back-to-back block to minimise the
        // window where the router is empty.
        const { discoverRoutes } = await import("../../../core/src/index.js");
        const routes = await discoverRoutes(routesDir);
        server.router.clear();
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

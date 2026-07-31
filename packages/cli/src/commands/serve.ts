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

  // Graceful shutdown is owned by startServer() (packages/core/src/server.ts),
  // which traps SIGTERM/SIGINT, stops accepting, DRAINS in-flight requests
  // within TINA4_SHUTDOWN_TIMEOUT, closes the database and exits 0.
  //
  // This function used to install its own `server.close(); process.exit(0)`.
  // Node's docs are explicit that close() is asynchronous and "keeps existing
  // connections", so exiting on the very next line killed every request the
  // close was waiting to drain - measured, a request 0.6s into a 2s handler
  // came back as "connection closed without response".
  void server;
}

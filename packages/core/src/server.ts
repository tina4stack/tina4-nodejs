import { createServer } from "node:http";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Tina4Config, Tina4Request, Tina4Response } from "./types.js";
import { Router, defaultRouter, runRouteMiddlewares } from "./router.js";
import { discoverRoutes } from "./routeDiscovery.js";
import { createRequest, parseBody } from "./request.js";
import { createResponse } from "./response.js";
import { MiddlewareChain, cors, requestLogger } from "./middleware.js";
import { tryServeStatic } from "./static.js";
import { loadEnv } from "./dotenv.js";
import { createHealthRoute } from "./health.js";
import { rateLimiter } from "./rateLimiter.js";
import { Log } from "./logger.js";
import { DevAdmin, RequestInspector } from "./devAdmin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Built-in error templates directory (ships with @tina4/core). */
const BUILTIN_ERROR_TEMPLATES_DIR = resolve(__dirname, "..", "templates");

const TINA4_VERSION = "3.0.0";

/**
 * Resolve port and host with priority: explicit config > ENV var > default.
 * Exported for testability.
 */
export function resolvePortAndHost(config?: { port?: number; host?: string }): { port: number; host: string } {
  const port = config?.port
    ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : undefined)
    ?? 7148;
  const host = config?.host
    ?? process.env.HOST
    ?? "0.0.0.0";
  return { port, host };
}

function isDevMode(): boolean {
  return process.env.TINA4_ENV !== "production" && process.env.NODE_ENV !== "production";
}

/**
 * Render an error page using Twig templates via Frond.
 * Priority: user override (src/templates/errors/{code}.twig) > built-in default > JSON fallback.
 */
async function renderErrorPage(
  code: number,
  data: Record<string, unknown>,
  templatesDir: string,
): Promise<string | null> {
  try {
    const { Frond } = await import("@tina4/frond");
    const templateFile = `errors/${code}.twig`;

    // 1. Try user override in the project's templates directory
    const userTemplatePath = join(templatesDir, templateFile);
    if (existsSync(userTemplatePath)) {
      const frond = new Frond(templatesDir);
      return frond.render(templateFile, data);
    }

    // 2. Try built-in framework default
    const builtinTemplatePath = join(BUILTIN_ERROR_TEMPLATES_DIR, templateFile);
    if (existsSync(builtinTemplatePath)) {
      const frond = new Frond(BUILTIN_ERROR_TEMPLATES_DIR);
      return frond.render(templateFile, data);
    }

    // 3. No template found
    return null;
  } catch {
    // Frond not available or template rendering failed — fall back to JSON
    return null;
  }
}

function injectDevOverlay(html: string): string {
  const overlay = DevAdmin.renderOverlayScript();
  if (html.includes("</body>")) {
    return html.replace("</body>", overlay + "\n</body>");
  }
  return html + overlay;
}

function renderLandingPage(routes: Array<{ method: string; pattern: string; flags?: string[] }>): string {
  const mode = process.env.NODE_ENV === "production" ? "Production" : "Development";
  const routeRows = routes
    .map(
      (r) =>
        `<tr><td><span class="method method-${r.method.toLowerCase()}">${r.method}</span></td><td>${r.pattern}</td><td>${(r.flags ?? []).join(", ") || "&mdash;"}</td></tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Tina4 Node.js</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#333;background:#f5f5f5}
  .hero{background:linear-gradient(135deg,#2e7d32,#388e3c);color:#fff;padding:3rem 2rem;text-align:center}
  .hero h1{font-size:2.5rem;margin-bottom:.5rem}
  .hero p{font-size:1.1rem;opacity:.9}
  .container{max-width:900px;margin:2rem auto;padding:0 1rem}
  .card{background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.08);padding:1.5rem;margin-bottom:1.5rem}
  .card h2{font-size:1.3rem;margin-bottom:1rem;color:#2e7d32}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #eee}
  th{font-weight:600;color:#555;font-size:.85rem;text-transform:uppercase;letter-spacing:.5px}
  .method{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.8rem;font-weight:700;color:#fff}
  .method-get{background:#2e7d32}.method-post{background:#1565c0}.method-put{background:#ef6c00}.method-delete{background:#c62828}.method-patch{background:#6a1b9a}
  .get-started{background:#e8f5e9;border-left:4px solid #2e7d32}
  .get-started h2{color:#2e7d32}
  code,pre{font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace}
  pre{background:#e8f5e9;color:#2e7d32;padding:1rem;border-radius:6px;overflow-x:auto;font-size:.9rem;margin:.75rem 0}
  a{color:#2e7d32;text-decoration:none}
  a:hover{text-decoration:underline}
  .links{display:flex;gap:1rem;flex-wrap:wrap}
  .links a{display:inline-block;padding:.5rem 1rem;border:1px solid #2e7d32;border-radius:6px;transition:background .2s,color .2s}
  .links a:hover{background:#2e7d32;color:#fff;text-decoration:none}
</style>
</head>
<body>
<div class="hero">
  <h1>Tina4 Node.js</h1>
  <p>This is not a 4ramework &mdash; v${TINA4_VERSION} &mdash; ${mode}</p>
</div>
<div class="container">
  <div class="card">
    <h2>Registered Routes</h2>
    <table>
      <thead><tr><th>Method</th><th>Path</th><th>Flags</th></tr></thead>
      <tbody>${routeRows || "<tr><td colspan=\"3\">No routes registered yet.</td></tr>"}</tbody>
    </table>
  </div>
  <div class="card get-started">
    <h2>Get Started</h2>
    <p>Create a file-based route to get going:</p>
    <pre><code>// src/routes/api/hello/get.ts
export default (req, res) =&gt; res.json({ hello: &quot;world&quot; });</code></pre>
  </div>
  <div class="card">
    <h2>Quick Links</h2>
    <div class="links">
      <a href="/health">Health Check</a>
      <a href="/swagger">Swagger Docs</a>
      <a href="https://tina4.com" target="_blank" rel="noopener">tina4.com</a>
    </div>
  </div>
</div>
</body>
</html>`;
}

export async function startServer(config?: Tina4Config): Promise<{
  close: () => void;
  router: Router;
  port: number;
}> {
  const { port, host } = resolvePortAndHost(config);
  const routesDir = resolve(config?.routesDir ?? "src/routes");
  const modelsDir = resolve(config?.modelsDir ?? "src/models");
  const staticDir = resolve(config?.staticDir ?? "public");
  const templatesDir = resolve(config?.templatesDir ?? "src/templates");

  // Load .env file
  loadEnv();

  const router = new Router();
  const middleware = new MiddlewareChain();

  // Merge routes registered via top-level get(), post(), etc.
  for (const route of defaultRouter.getRoutes()) {
    router.addRoute(route);
  }

  // Register health check endpoint
  const healthRoute = createHealthRoute(TINA4_VERSION);
  router.addRoute(healthRoute);

  // Initialize Twig if available
  let twigAvailable = false;
  try {
    const twig = await import("@tina4/twig");
    twig.setTemplatesDir(templatesDir);
    twigAvailable = true;
  } catch {
    // Twig not installed, res.render() won't be available
  }

  // Built-in middleware
  middleware.use(cors());
  middleware.use(requestLogger());
  middleware.use(rateLimiter());

  // Discover file-based routes
  if (existsSync(routesDir)) {
    const routes = await discoverRoutes(routesDir);
    for (const route of routes) {
      router.addRoute(route);
    }
    console.log(`\n  Routes discovered:`);
    for (const route of routes) {
      console.log(`    \x1b[36m${route.method.padEnd(7)}\x1b[0m ${route.pattern}`);
    }
  } else {
    console.log(`\n  No routes directory found at ${routesDir}`);
  }

  // Initialize ORM if models directory exists
  if (existsSync(modelsDir)) {
    try {
      const orm = await import("@tina4/orm");
      const dbConfig = config?.database ?? {};
      await orm.initDatabase({
        type: dbConfig.type ?? "sqlite",
        path: dbConfig.path ?? "./data/tina4.db",
      });

      const models = await orm.discoverModels(modelsDir);
      if (models.length > 0) {
        console.log(`\n  Models discovered:`);
        orm.syncModels(models);
        for (const { definition } of models) {
          console.log(`    \x1b[35m${definition.tableName}\x1b[0m (${Object.keys(definition.fields).length} fields)`);
        }

        // Generate auto-CRUD routes (file-based routes take precedence)
        const crudRoutes = orm.generateCrudRoutes(models);
        for (const route of crudRoutes) {
          // Only add if no file-based route already handles this
          const existing = router.match(route.method, route.pattern.replace(/\{(\w+)\}/g, "test").replace(/\[(\w+)\]/g, "test"));
          if (!existing) {
            router.addRoute(route);
          }
        }

        console.log(`\n  Auto-CRUD endpoints:`);
        for (const route of crudRoutes) {
          console.log(`    \x1b[33m${route.method.padEnd(7)}\x1b[0m ${route.pattern}`);
        }
      }
    } catch (err) {
      console.warn(`\n  ORM not available (install @tina4/orm to enable):`, err);
    }
  }

  // Initialize Swagger
  try {
    const swagger = await import("@tina4/swagger");
    const allRoutes = router.getRoutes();

    // Collect model definitions for schema generation
    let modelDefs: Array<{ tableName: string; fields: Record<string, unknown> }> = [];
    try {
      const orm = await import("@tina4/orm");
      if (existsSync(modelsDir)) {
        const models = await orm.discoverModels(modelsDir);
        modelDefs = models.map((m) => m.definition);
      }
    } catch {
      // ORM not available, swagger will work without model schemas
    }

    const getSpec = () => swagger.generateOpenAPISpec(allRoutes, modelDefs as any);
    const swaggerRoutes = swagger.createSwaggerRoutes(getSpec);
    for (const route of swaggerRoutes) {
      router.addRoute(route);
    }
  } catch {
    // Swagger not available
  }

  // Register dev admin dashboard routes
  if (DevAdmin.isEnabled()) {
    DevAdmin.register(router);
    console.log(`  Dev dashboard at  \x1b[36mhttp://localhost:${port}/__dev\x1b[0m`);
  }

  const server = createServer(async (rawReq, rawRes) => {
    const req = createRequest(rawReq);
    const res = createResponse(rawRes);

    // Add res.render() if Twig is available
    if (twigAvailable) {
      try {
        const twig = await import("@tina4/twig");
        twig.addRenderMethod(res);
      } catch { /* ignore */ }
    }

    try {
      // Run middleware chain
      await middleware.run(req, res);
      if (res.raw.writableEnded) return;

      // Parse request body
      await parseBody(req);

      const pathname = (req.url ?? "/").split("?")[0];

      // Track request start time for dev inspector
      const reqStartTime = DevAdmin.isEnabled() ? Date.now() : 0;

      // Wrap res.raw.end to inject dev overlay and capture requests
      if (isDevMode() && !pathname.startsWith("/__dev")) {
        const originalEnd = res.raw.end.bind(res.raw);

        const wrappedEnd: typeof res.raw.end = function (
          chunk?: unknown,
          encodingOrCb?: BufferEncoding | (() => void),
          cb?: () => void,
        ) {
          // Capture request for dev inspector
          if (reqStartTime > 0) {
            const duration = Date.now() - reqStartTime;
            const status = res.raw.statusCode ?? 200;
            RequestInspector.capture(req.method ?? "GET", pathname, status, duration);
          }

          const contentType = res.raw.getHeader("content-type");
          if (typeof contentType === "string" && contentType.includes("text/html")) {
            if (typeof chunk === "string") {
              chunk = injectDevOverlay(chunk);
            } else if (Buffer.isBuffer(chunk)) {
              const html = chunk.toString("utf-8");
              chunk = injectDevOverlay(html);
            }
          }
          if (typeof encodingOrCb === "function") {
            return originalEnd(chunk, encodingOrCb);
          }
          if (encodingOrCb !== undefined) {
            return originalEnd(chunk, encodingOrCb, cb);
          }
          return originalEnd(chunk, cb);
        };
        res.raw.end = wrappedEnd;
      }

      // Try static files first
      if (existsSync(staticDir) && tryServeStatic(staticDir, req, res)) {
        return;
      }

      // Match route
      const match = router.match(req.method ?? "GET", pathname);
      if (match) {
        req.params = match.params;

        // Run per-route middlewares if any
        if (match.middlewares && match.middlewares.length > 0) {
          const proceed = await runRouteMiddlewares(match.middlewares, req, res);
          if (!proceed || res.raw.writableEnded) return;
        }

        await match.handler(req, res);
        if (!res.raw.writableEnded) {
          res.raw.end();
        }
        return;
      }

      // Show landing page on "/" if no route matched and no index template exists
      if (pathname === "/" && (req.method ?? "GET") === "GET") {
        const hasIndexHtml = existsSync(resolve(templatesDir, "index.html"));
        const hasIndexTwig = existsSync(resolve(templatesDir, "index.twig"));
        if (!hasIndexHtml && !hasIndexTwig) {
          const allRoutes = router.getRoutes().map((r) => ({
            method: r.method,
            pattern: r.pattern,
            flags: [] as string[],
          }));
          const html = renderLandingPage(allRoutes);
          res.raw.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.raw.end(html);
          return;
        }
      }

      // 404
      const html404 = await renderErrorPage(404, { path: pathname }, templatesDir);
      if (html404) {
        res.raw.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.raw.end(html404);
      } else {
        res({ error: "Not Found", statusCode: 404, message: `No route found for ${req.method} ${pathname}` }, 404);
      }
    } catch (err) {
      console.error("  Error:", err);
      if (!res.raw.writableEnded) {
        const errorMessage = process.env.NODE_ENV === "production" ? "Internal Server Error" : String(err);
        const html500 = await renderErrorPage(500, {
          error_message: errorMessage,
          request_id: `${Date.now().toString(36)}`,
          path: (req.url ?? "/").split("?")[0],
        }, templatesDir);
        if (html500) {
          res.raw.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.raw.end(html500);
        } else {
          res({ error: "Internal Server Error", statusCode: 500, message: errorMessage }, 500);
        }
      }
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      const displayHost = host === "0.0.0.0" ? "localhost" : host;
      const devLine = DevAdmin.isEnabled() ? `\n  Dev dashboard at  \x1b[36mhttp://${displayHost}:${port}/__dev\x1b[0m` : "";
      console.log(`
  \x1b[1mtina4\x1b[0m — This is not a framework.

  Server running at \x1b[36mhttp://${displayHost}:${port}\x1b[0m  (bound to ${host})
  Swagger docs at  \x1b[36mhttp://${displayHost}:${port}/swagger\x1b[0m${devLine}
`);
      resolvePromise({
        close: () => {
          server.close();
          // Close database if ORM was initialized
          import("@tina4/orm").then((orm) => orm.closeDatabase()).catch(() => {});
        },
        router,
        port,
      });
    });
  });
}

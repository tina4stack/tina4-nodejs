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

function renderLandingPage(routes: Array<{ method: string; pattern: string; flags?: string[] }>, port: number = 7148): string {
  const version = TINA4_VERSION;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Tina4</title>
</head>
<body style="margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;position:relative;overflow-x:hidden;">

<!-- Background watermark -->
<img src="/images/logo.png" alt="" style="position:fixed;bottom:-40px;right:-40px;width:420px;height:420px;opacity:0.04;pointer-events:none;z-index:0;" />

<div style="position:relative;z-index:1;max-width:860px;margin:0 auto;padding:3rem 1.5rem 2rem;">

  <!-- Logo + Title -->
  <div style="text-align:center;margin-bottom:2.5rem;">
    <img src="/images/logo.png" alt="Tina4" style="width:120px;height:120px;margin-bottom:1rem;" />
    <h1 style="font-size:2.8rem;font-weight:800;margin:0;letter-spacing:-1px;">Tina4</h1>
    <p style="font-size:1.1rem;color:#94a3b8;margin-top:0.4rem;">This is not a framework</p>
  </div>

  <!-- Action Buttons -->
  <div style="display:flex;justify-content:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:2.5rem;">
    <a href="/dev-admin" style="display:inline-block;padding:0.6rem 1.4rem;border-radius:8px;background:#2e7d32;color:#fff;text-decoration:none;font-weight:600;font-size:0.95rem;transition:opacity 0.2s;">Dev Admin</a>
    <a href="#gallery" style="display:inline-block;padding:0.6rem 1.4rem;border-radius:8px;background:transparent;color:#e2e8f0;text-decoration:none;font-weight:600;font-size:0.95rem;border:1px solid #334155;transition:background 0.2s;">Gallery</a>
  </div>

  <!-- Status Bar -->
  <div style="display:flex;justify-content:center;align-items:center;gap:1.5rem;margin-bottom:2.5rem;font-size:0.85rem;color:#94a3b8;">
    <span style="display:flex;align-items:center;gap:0.4rem;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80;"></span> Server running</span>
    <span>Port ${port}</span>
    <span>v${version}</span>
  </div>

  <!-- Getting Started -->
  <div style="background:#1e293b;border-radius:12px;padding:1.5rem 1.75rem;margin-bottom:2rem;">
    <h2 style="font-size:1.25rem;font-weight:700;margin:0 0 1rem 0;color:#e2e8f0;">Getting Started</h2>
    <pre style="background:#0f172a;color:#4ade80;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:0.875rem;padding:1.25rem;border-radius:8px;overflow-x:auto;margin:0;line-height:1.6;"><code>// app.ts
import { startServer, Router } from &quot;tina4-nodejs&quot;;

Router.get(&quot;/hello&quot;, async (req, res) =&gt; {
  return res.json({ message: &quot;Hello World!&quot; });
});

startServer({ port: 7148 });</code></pre>
  </div>

  <!-- Gallery: What You Can Build -->
  <h2 id="gallery" style="font-size:1.25rem;font-weight:700;margin:0 0 1rem 0;color:#e2e8f0;">What You Can Build</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-bottom:2.5rem;">
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.25rem;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#3b82f6;border-radius:12px 12px 0 0;"></div>
      <div style="font-size:1.5rem;margin-bottom:0.75rem;">&#128640;</div>
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 0.5rem;color:#e2e8f0;">REST API</h3>
      <p style="font-size:0.85rem;color:#94a3b8;margin:0;line-height:1.5;">Define routes with one decorator</p>
      <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SFMono-Regular',Consolas,monospace;">Router.get(&quot;/api/users&quot;, async (req, res) =&gt; {
  return res.json({ users: [] });
});</pre>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.25rem;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#22c55e;border-radius:12px 12px 0 0;"></div>
      <div style="font-size:1.5rem;margin-bottom:0.75rem;">&#128451;</div>
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 0.5rem;color:#e2e8f0;">ORM</h3>
      <p style="font-size:0.85rem;color:#94a3b8;margin:0;line-height:1.5;">Active record models, zero config</p>
      <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SFMono-Regular',Consolas,monospace;">class User extends ORM {
  static fields = {
    id: { type: &quot;integer&quot;, primaryKey: true },
    name: { type: &quot;string&quot; }
  };
}</pre>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.25rem;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#a78bfa;border-radius:12px 12px 0 0;"></div>
      <div style="font-size:1.5rem;margin-bottom:0.75rem;">&#128274;</div>
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 0.5rem;color:#e2e8f0;">Auth</h3>
      <p style="font-size:0.85rem;color:#94a3b8;margin:0;line-height:1.5;">JWT tokens built-in</p>
      <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SFMono-Regular',Consolas,monospace;">const token = Auth.createToken({ userId: 1 });
const valid = Auth.validateToken(token);</pre>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.25rem;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#3b82f6;border-radius:12px 12px 0 0;"></div>
      <div style="font-size:1.5rem;margin-bottom:0.75rem;">&#9889;</div>
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 0.5rem;color:#e2e8f0;">Queue</h3>
      <p style="font-size:0.85rem;color:#94a3b8;margin:0;line-height:1.5;">Background jobs, no Redis needed</p>
      <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SFMono-Regular',Consolas,monospace;">const producer = new Producer(new Queue(&quot;emails&quot;));
producer.produce({ to: &quot;a@b.com&quot; });</pre>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.25rem;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#22c55e;border-radius:12px 12px 0 0;"></div>
      <div style="font-size:1.5rem;margin-bottom:0.75rem;">&#128196;</div>
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 0.5rem;color:#e2e8f0;">Templates</h3>
      <p style="font-size:0.85rem;color:#94a3b8;margin:0;line-height:1.5;">Twig templates with auto-reload</p>
      <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SFMono-Regular',Consolas,monospace;">Router.get(&quot;/dashboard&quot;, async (req, res) =&gt; {
  return res.render(&quot;dashboard.twig&quot;, data);
});</pre>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.25rem;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#a78bfa;border-radius:12px 12px 0 0;"></div>
      <div style="font-size:1.5rem;margin-bottom:0.75rem;">&#128225;</div>
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 0.5rem;color:#e2e8f0;">Database</h3>
      <p style="font-size:0.85rem;color:#94a3b8;margin:0;line-height:1.5;">Multi-engine, one API</p>
      <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SFMono-Regular',Consolas,monospace;">const db = initDatabase(&quot;sqlite:///app.db&quot;);
const result = await db.fetch(&quot;SELECT * FROM users&quot;);</pre>
    </div>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding-top:1rem;border-top:1px solid #1e293b;">
    <p style="font-size:0.8rem;color:#475569;margin:0;">Zero dependencies &middot; Convention over configuration</p>
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
            // Remove content-length since overlay injection changes body size
            if (!res.raw.headersSent) {
              res.raw.removeHeader("content-length");
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
          const html = renderLandingPage(allRoutes, port);
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

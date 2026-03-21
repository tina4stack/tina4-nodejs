import { createServer } from "node:http";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import type { Tina4Config, Tina4Request, Tina4Response } from "./types.js";
import { Router, defaultRouter, runRouteMiddlewares } from "./router.js";
import { discoverRoutes } from "./routeDiscovery.js";
import { createRequest, parseBody } from "./request.js";
import { createResponse } from "./response.js";
import { MiddlewareChain, cors, requestLogger } from "./middleware.js";
import { tryServeStatic } from "./static.js";
import { loadEnv, isTruthy } from "./dotenv.js";
import { createHealthRoute } from "./health.js";
import { rateLimiter } from "./rateLimiter.js";
import { Log } from "./logger.js";
import { DevAdmin, RequestInspector } from "./devAdmin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Built-in error templates directory (ships with @tina4/core). */
const BUILTIN_ERROR_TEMPLATES_DIR = resolve(__dirname, "..", "templates");

/** Built-in public directory for framework-bundled static assets. */
const BUILTIN_PUBLIC_DIR = resolve(__dirname, "..", "public");

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
  return isTruthy(process.env.TINA4_DEBUG);
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

interface DevToolbarContext {
  version: string;
  method: string;
  path: string;
  matchedPattern: string;
  requestId: string;
  routeCount: number;
}

function injectDevToolbar(html: string, ctx: DevToolbarContext): string {
  const toolbar = DevAdmin.renderToolbarHtml(ctx);
  if (html.includes("</body>")) {
    return html.replace("</body>", toolbar + "\n</body>");
  }
  return html + toolbar;
}

function renderLandingPage(routes: Array<{ method: string; pattern: string; flags?: string[] }>, port: number = 7148): string {
  const version = TINA4_VERSION;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tina4NodeJs</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;position:relative}
.bg-watermark{position:fixed;bottom:-5%;right:-5%;width:45%;opacity:0.04;pointer-events:none;z-index:0}
.hero{text-align:center;z-index:1;padding:3rem 2rem 2rem}
.logo{width:120px;height:120px;margin-bottom:1.5rem}
h1{font-size:3rem;font-weight:700;margin-bottom:0.25rem;letter-spacing:-1px}
.tagline{color:#64748b;font-size:1.1rem;margin-bottom:2rem}
.actions{display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;margin-bottom:2.5rem}
.btn{padding:0.6rem 1.5rem;border-radius:0.5rem;font-size:0.9rem;font-weight:600;cursor:pointer;text-decoration:none;transition:all 0.15s;border:1px solid #334155;color:#94a3b8;background:transparent;min-width:140px;text-align:center;display:inline-block}
.btn:hover{border-color:#64748b;color:#e2e8f0}
.status{display:flex;gap:2rem;justify-content:center;align-items:center;color:#64748b;font-size:0.85rem;margin-bottom:1.5rem}
.status .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:0.4rem}
.footer{color:#334155;font-size:0.8rem;letter-spacing:0.5px}
.section{z-index:1;width:100%;max-width:800px;padding:0 2rem;margin-bottom:2.5rem}
.card{background:#1e293b;border-radius:0.75rem;padding:2rem;border:1px solid #334155}
.card h2{font-size:1.4rem;font-weight:600;margin-bottom:1.25rem;color:#e2e8f0}
.code-block{background:#0f172a;border-radius:0.5rem;padding:1.25rem;overflow-x:auto;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:0.85rem;line-height:1.6;color:#4ade80;border:1px solid #1e293b}
.gallery{z-index:1;width:100%;max-width:800px;padding:0 2rem;margin-bottom:3rem}
.gallery h2{font-size:1.4rem;font-weight:600;margin-bottom:1.25rem;color:#e2e8f0;text-align:center}
.gallery-grid{display:flex;gap:1rem;flex-wrap:wrap}
.gallery-card{flex:1 1 220px;background:#1e293b;border:1px solid #334155;border-radius:0.75rem;padding:1.5rem;position:relative;overflow:hidden}
.gallery-card .accent{position:absolute;top:0;left:0;right:0;height:3px}
.gallery-card .accent-blue{background:#2e7d32}
.gallery-card .accent-green{background:#22c55e}
.gallery-card .accent-purple{background:#a78bfa}
.gallery-card .icon{font-size:1.5rem;margin-bottom:0.75rem}
.gallery-card h3{font-size:1rem;font-weight:600;margin-bottom:0.5rem;color:#e2e8f0}
.gallery-card p{font-size:0.85rem;color:#94a3b8;line-height:1.5}
</style>
</head>
<body>
<img src="/images/tina4-logo-icon.webp" class="bg-watermark" alt="">
<div class="hero">
    <img src="/images/tina4-logo-icon.webp" class="logo" alt="Tina4">
    <h1>Tina4NodeJs</h1>
    <p class="tagline">This is not a framework</p>
    <div class="actions">
        <a href="https://tina4.com/nodejs" class="btn" target="_blank">Website</a>
        <a href="/__dev" class="btn">Dev Admin</a>
        <a href="#gallery" class="btn">Gallery</a>
        <a href="https://github.com/tina4stack/tina4-nodejs" class="btn" target="_blank">GitHub</a>
        <a href="https://github.com/tina4stack/tina4-nodejs/stargazers" class="btn" target="_blank">&#11088; Star</a>
    </div>
    <div class="status">
        <span><span class="dot"></span>Server running</span>
        <span>Port ${port}</span>
        <span>v${version}</span>
    </div>
    <p class="footer">Zero dependencies &middot; Convention over configuration</p>
</div>
<div class="section">
    <div class="card">
        <h2>Getting Started</h2>
        <pre class="code-block"><code><span style="color:#64748b">// app.ts</span>
<span style="color:#c084fc">import</span> { startServer, Router } <span style="color:#c084fc">from</span> <span style="color:#4ade80">"tina4-nodejs"</span>;

Router.get(<span style="color:#4ade80">"/hello"</span>, <span style="color:#c084fc">async</span> (<span style="color:#38bdf8">req</span>, <span style="color:#38bdf8">res</span>) =&gt; {
    <span style="color:#c084fc">return</span> res.json({ message: <span style="color:#4ade80">"Hello World!"</span> });
});

startServer({ port: 7148 });  <span style="color:#64748b">// starts on port 7148</span></code></pre>
    </div>
</div>
<div class="gallery">
    <h2 id="gallery">What You Can Build</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;">
        <div class="gallery-card">
            <div class="accent accent-blue"></div>
            <div class="icon">&#128640;</div>
            <h3>REST API</h3>
            <p>Define routes with one decorator</p>
            <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SF Mono',SFMono-Regular,Consolas,monospace;">Router.get("/api/users", async (req, res) =&gt; {
    return res.json({ users: [] });
});</pre>
        </div>
        <div class="gallery-card">
            <div class="accent accent-green"></div>
            <div class="icon">&#128451;</div>
            <h3>ORM</h3>
            <p>Active record models, zero config</p>
            <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SF Mono',SFMono-Regular,Consolas,monospace;">class User extends ORM {
    static fields = {
        id: { type: "integer", primaryKey: true },
        name: { type: "string" }
    };
}</pre>
        </div>
        <div class="gallery-card">
            <div class="accent accent-purple"></div>
            <div class="icon">&#128274;</div>
            <h3>Auth</h3>
            <p>JWT tokens built-in</p>
            <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SF Mono',SFMono-Regular,Consolas,monospace;">const token = Auth.createToken({ userId: 1 });
const valid = Auth.validateToken(token);</pre>
        </div>
        <div class="gallery-card">
            <div class="accent accent-blue"></div>
            <div class="icon">&#9889;</div>
            <h3>Queue</h3>
            <p>Background jobs, no Redis needed</p>
            <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SF Mono',SFMono-Regular,Consolas,monospace;">const producer = new Producer(new Queue("emails"));
producer.produce({ to: "a@b.com" });</pre>
        </div>
        <div class="gallery-card">
            <div class="accent accent-green"></div>
            <div class="icon">&#128196;</div>
            <h3>Templates</h3>
            <p>Twig templates with auto-reload</p>
            <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SF Mono',SFMono-Regular,Consolas,monospace;">Router.get("/dashboard", async (req, res) =&gt; {
    return res.render("dashboard.twig", data);
});</pre>
        </div>
        <div class="gallery-card">
            <div class="accent accent-purple"></div>
            <div class="icon">&#128225;</div>
            <h3>Database</h3>
            <p>Multi-engine, one API</p>
            <pre style="background:#0f172a;color:#4ade80;padding:0.75rem;border-radius:0.375rem;font-size:0.75rem;overflow-x:auto;margin-top:0.5rem;font-family:'SF Mono',SFMono-Regular,Consolas,monospace;">const db = initDatabase("sqlite:///app.db");
const result = await db.fetch("SELECT * FROM users");</pre>
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

      // Mutable ref so wrappedEnd can read the matched pattern after route matching
      let matchedPattern = "";
      const requestId = Date.now().toString(36);

      // Wrap res.raw.end to inject dev toolbar and capture requests
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
            const toolbarCtx: DevToolbarContext = {
              version: TINA4_VERSION,
              method: req.method ?? "GET",
              path: pathname,
              matchedPattern: matchedPattern || pathname,
              requestId,
              routeCount: router.getRoutes().length,
            };
            if (typeof chunk === "string") {
              chunk = injectDevToolbar(chunk, toolbarCtx);
            } else if (Buffer.isBuffer(chunk)) {
              const html = chunk.toString("utf-8");
              chunk = injectDevToolbar(html, toolbarCtx);
            }
            // Remove content-length since toolbar injection changes body size
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

      // Try static files first (project public dir, then framework built-in public dir)
      if (existsSync(staticDir) && tryServeStatic(staticDir, req, res)) {
        return;
      }
      if (tryServeStatic(BUILTIN_PUBLIC_DIR, req, res)) {
        return;
      }

      // Match route
      const match = router.match(req.method ?? "GET", pathname);
      if (match) {
        req.params = match.params;
        matchedPattern = match.pattern;

        // Run per-route middlewares if any
        if (match.middlewares && match.middlewares.length > 0) {
          const proceed = await runRouteMiddlewares(match.middlewares, req, res);
          if (!proceed || res.raw.writableEnded) return;
        }

        const result = await match.handler(req, res);

        // If the route exports a template and the handler returned a plain object,
        // render it through the template engine instead of sending as JSON.
        if (
          !res.raw.writableEnded &&
          match.template &&
          result !== null &&
          result !== undefined &&
          typeof result === "object" &&
          !Buffer.isBuffer(result)
        ) {
          await res.template(match.template, result as Record<string, unknown>);
        }

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
        const errorMessage = !isTruthy(process.env.TINA4_DEBUG) ? "Internal Server Error" : String(err);
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
      const isDebug = isTruthy(process.env.TINA4_DEBUG);
      const logLevel = (process.env.TINA4_LOG_LEVEL ?? "DEBUG").toUpperCase();

      // Green color for Node.js, only when stdout is a TTY
      const isTty = isatty(1);
      const color = isTty ? "\x1b[32m" : "";
      const reset = isTty ? "\x1b[0m" : "";

      // Banner goes to stdout via console.log — NOT through the framework logger
      console.log(`${color}
  ______ _             __ __
 /_  __/(_)___  ____ _/ // /
  / /  / / __ \\/ __ \`/ // /_
 / /  / / / / / /_/ /__  __/
/_/  /_/_/ /_/\\__,_/  /_/
${reset}
  Tina4 Node.js v${TINA4_VERSION} — This is not a framework

  Server:    http://${displayHost}:${port}
  Swagger:   http://localhost:${port}/swagger
  Dashboard: http://localhost:${port}/__dev
  Debug:     ${isDebug ? "ON" : "OFF"} (Log level: ${logLevel})
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

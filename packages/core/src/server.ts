import { createServer } from "node:http";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
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

export async function startServer(config?: Tina4Config): Promise<{
  close: () => void;
  router: Router;
  port: number;
}> {
  const port = config?.port ?? 3000;
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
  const healthRoute = createHealthRoute("3.0.0");
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

      // 404
      res({ error: "Not Found", statusCode: 404, message: `No route found for ${req.method} ${pathname}` }, 404);
    } catch (err) {
      console.error("  Error:", err);
      if (!res.raw.writableEnded) {
        res({ error: "Internal Server Error", statusCode: 500, message: process.env.NODE_ENV === "production" ? "Internal Server Error" : String(err) }, 500);
      }
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(port, () => {
      console.log(`
  \x1b[1mtina4\x1b[0m — This is not a framework.

  Server running at \x1b[36mhttp://localhost:${port}\x1b[0m
  Swagger docs at  \x1b[36mhttp://localhost:${port}/swagger\x1b[0m
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

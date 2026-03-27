import type { RouteHandler, RouteDefinition, RouteMeta, Middleware, Tina4Request, Tina4Response, WebSocketRouteHandler, WebSocketRouteDefinition } from "./types.js";

interface MatchResult {
  handler: RouteHandler;
  params: Record<string, string>;
  pattern: string;
  meta?: RouteMeta;
  middlewares?: Middleware[];
  template?: string;
  secure?: boolean;
  cached?: boolean;
  noAuth?: boolean;
}

interface CompiledRoute {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  meta?: RouteMeta;
  filePath?: string;
  middlewares?: Middleware[];
  secure?: boolean;
  cached?: boolean;
  noAuth?: boolean;
  cacheStore?: Map<string, { data: unknown; expires: number }>;
  cacheTtl?: number;
  template?: string;
}

/**
 * Thin reference to a registered route, enabling chained modifiers.
 *
 * Usage:
 *   router.get("/api/data", handler).secure().cache();
 */
export class RouteRef {
  constructor(private route: CompiledRoute) {}

  /** Mark this route as requiring bearer-token authentication. */
  secure(): this {
    this.route.secure = true;
    return this;
  }

  /** Opt out of secure-by-default auth (for public write routes). */
  noAuth(): this {
    this.route.noAuth = true;
    return this;
  }

  /** Mark this route's response as cacheable. */
  cache(): this {
    this.route.cached = true;
    return this;
  }
}

export interface RouteInfo {
  method: string;
  path: string;
  handler: string;
  middlewareCount: number;
  cached: boolean;
  secure: boolean;
}

export class Router {
  private routes: Map<string, CompiledRoute[]> = new Map();
  private wsRoutes: WebSocketRouteDefinition[] = [];

  /** Class-based middleware registered via `use()` / `Router.use()`. */
  private static _classMiddlewares: any[] = [];

  /**
   * Register a class-based middleware (beforeX / afterX convention).
   * Classes are stored globally and executed by MiddlewareRunner.
   */
  static use(middlewareClass: any): void {
    Router._classMiddlewares.push(middlewareClass);
  }

  /**
   * Get all registered class-based middleware classes.
   */
  static getClassMiddlewares(): any[] {
    return Router._classMiddlewares;
  }

  /**
   * Clear all registered class-based middleware (useful for testing).
   */
  static clearClassMiddlewares(): void {
    Router._classMiddlewares = [];
  }

  /**
   * Add a raw route definition (used internally and by file-based routing).
   */
  addRoute(definition: RouteDefinition): RouteRef {
    const method = definition.method.toUpperCase();
    const { regex, paramNames } = this.compilePattern(definition.pattern);

    if (!this.routes.has(method)) {
      this.routes.set(method, []);
    }

    const routes = this.routes.get(method)!;

    // Remove existing route with same pattern (for hot-reload)
    const existingIndex = routes.findIndex((r) => r.pattern === definition.pattern);
    if (existingIndex !== -1) {
      routes.splice(existingIndex, 1);
    }

    // Write methods (POST/PUT/PATCH/DELETE) are secure by default
    const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    const isWrite = WRITE_METHODS.has(method);
    const secureDefault = isWrite ? (definition.secure ?? true) : definition.secure;

    const compiled: CompiledRoute = {
      pattern: definition.pattern,
      regex,
      paramNames,
      handler: definition.handler,
      meta: definition.meta,
      filePath: definition.filePath,
      middlewares: definition.middlewares,
      secure: secureDefault,
      cached: definition.cached,
      noAuth: definition.noAuth,
      template: definition.template,
    };
    routes.push(compiled);
    return new RouteRef(compiled);
  }

  /**
   * Register a GET route programmatically.
   */
  get(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "GET", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a POST route programmatically.
   */
  post(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "POST", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a PUT route programmatically.
   */
  put(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "PUT", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a PATCH route programmatically.
   */
  patch(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "PATCH", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a DELETE route programmatically.
   */
  delete(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "DELETE", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a route that matches ANY HTTP method.
   */
  any(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    let lastRef!: RouteRef;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      lastRef = this.addRoute({ method, pattern: path, handler, middlewares, meta });
    }
    return lastRef;
  }

  /**
   * Create a route group with a shared prefix and optional middlewares.
   */
  group(prefix: string, callback: (group: RouteGroup) => void, middlewares?: Middleware[]): void {
    const group = new RouteGroup(this, prefix, middlewares);
    callback(group);
  }

  /**
   * Match a request method + pathname to a registered route.
   */
  match(method: string, pathname: string): MatchResult | null {
    const upperMethod = method.toUpperCase();

    // Try exact method first, then ANY routes are already registered under each method
    const routes = this.routes.get(upperMethod);
    if (!routes) return null;

    for (const route of routes) {
      const match = route.regex.exec(pathname);
      if (match) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
        }
        return {
          handler: route.handler,
          params,
          pattern: route.pattern,
          meta: route.meta,
          middlewares: route.middlewares,
          template: route.template,
          secure: route.secure,
          cached: route.cached,
          noAuth: route.noAuth,
        };
      }
    }

    return null;
  }

  /**
   * Get all registered route definitions.
   */
  getRoutes(): RouteDefinition[] {
    const all: RouteDefinition[] = [];
    for (const [method, routes] of this.routes) {
      for (const route of routes) {
        all.push({
          method,
          pattern: route.pattern,
          handler: route.handler,
          meta: route.meta,
          filePath: route.filePath,
          middlewares: route.middlewares,
          template: route.template,
          secure: route.secure,
          cached: route.cached,
          noAuth: route.noAuth,
        });
      }
    }
    return all;
  }

  /**
   * List all routes in a debug-friendly format for CLI output.
   */
  listRoutes(): RouteInfo[] {
    const info: RouteInfo[] = [];
    for (const [method, routes] of this.routes) {
      for (const route of routes) {
        info.push({
          method,
          path: route.pattern,
          handler: route.filePath ?? (route.handler.name || "(anonymous)"),
          middlewareCount: route.middlewares?.length ?? 0,
          cached: route.cached ?? false,
          secure: route.secure ?? false,
        });
      }
    }
    return info;
  }

  /**
   * Register a WebSocket route.
   */
  websocket(path: string, handler: WebSocketRouteHandler): void {
    // Remove existing ws route with same pattern (for hot-reload)
    this.wsRoutes = this.wsRoutes.filter((r) => r.pattern !== path);
    this.wsRoutes.push({ pattern: path, handler });
  }

  /**
   * Get all registered WebSocket route definitions.
   */
  getWebSocketRoutes(): WebSocketRouteDefinition[] {
    return [...this.wsRoutes];
  }

  /**
   * Match a WebSocket upgrade request path to a registered ws route.
   */
  matchWebSocket(pathname: string): WebSocketRouteDefinition | null {
    for (const route of this.wsRoutes) {
      if (route.pattern === pathname) return route;
    }
    return null;
  }

  clear(): void {
    this.routes.clear();
    this.wsRoutes = [];
  }

  // ── Static convenience methods ───────────────────────────────
  // These delegate to the defaultRouter singleton so users can write
  //   Router.get("/path", handler)
  // as an alternative to importing the top-level get(), post(), etc.

  /**
   * Register a GET route on the default global router.
   */
  static get(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return defaultRouter.get(path, handler, middlewares, meta);
  }

  /**
   * Register a POST route on the default global router.
   */
  static post(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return defaultRouter.post(path, handler, middlewares, meta);
  }

  /**
   * Register a PUT route on the default global router.
   */
  static put(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return defaultRouter.put(path, handler, middlewares, meta);
  }

  /**
   * Register a PATCH route on the default global router.
   */
  static patch(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return defaultRouter.patch(path, handler, middlewares, meta);
  }

  /**
   * Register a DELETE route on the default global router.
   */
  static delete(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return defaultRouter.delete(path, handler, middlewares, meta);
  }

  /**
   * Register a route that matches ANY HTTP method on the default global router.
   */
  static any(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return defaultRouter.any(path, handler, middlewares, meta);
  }

  /**
   * Register a WebSocket route on the default global router.
   */
  static websocket(path: string, handler: WebSocketRouteHandler): void {
    defaultRouter.websocket(path, handler);
  }

  /**
   * Create a route group on the default global router.
   */
  static group(prefix: string, callback: (group: RouteGroup) => void, middlewares?: Middleware[]): void {
    defaultRouter.group(prefix, callback, middlewares);
  }

  private compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    // Supports {id} (primary, matches Python), [id] (file-based dirs), and :id (Express-style)
    const regexStr = pattern
      .split("/")
      .map((segment) => {
        // Catch-all: {...slug} or [...slug]
        if (
          (segment.startsWith("{...") && segment.endsWith("}")) ||
          (segment.startsWith("[...") && segment.endsWith("]"))
        ) {
          const name = segment.startsWith("{") ? segment.slice(4, -1) : segment.slice(4, -1);
          paramNames.push(name);
          return "(.+)";
        }
        // Dynamic param: {id}, {id:int}, {id:float}, {id:path} (matching Python/Ruby)
        if (segment.startsWith("{") && segment.endsWith("}")) {
          const inner = segment.slice(1, -1);
          const colonIdx = inner.indexOf(":");
          const name = colonIdx >= 0 ? inner.slice(0, colonIdx) : inner;
          const type = colonIdx >= 0 ? inner.slice(colonIdx + 1) : "string";
          paramNames.push(name);
          switch (type) {
            case "int":
            case "integer":
              return "(\\d+)";
            case "float":
            case "number":
              return "([\\d.]+)";
            case "path":
            case ".*":
              return "(.+)";
            default:
              return "([^/]+)";
          }
        }
        // Dynamic param: [id] (file-based routing internal syntax)
        if (segment.startsWith("[") && segment.endsWith("]")) {
          const name = segment.slice(1, -1);
          paramNames.push(name);
          return "([^/]+)";
        }
        // Express-style param: :id
        if (segment.startsWith(":")) {
          const name = segment.slice(1);
          paramNames.push(name);
          return "([^/]+)";
        }
        return segment;
      })
      .join("/");

    return {
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
    };
  }
}

/**
 * Route group for grouping routes under a shared prefix with optional middlewares.
 */
export class RouteGroup {
  constructor(
    private router: Router,
    private prefix: string,
    private groupMiddlewares?: Middleware[],
  ) {}

  private mergeMiddlewares(routeMiddlewares?: Middleware[]): Middleware[] | undefined {
    const group = this.groupMiddlewares ?? [];
    const route = routeMiddlewares ?? [];
    const merged = [...group, ...route];
    return merged.length > 0 ? merged : undefined;
  }

  get(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "GET",
      pattern: this.prefix + path,
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  post(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "POST",
      pattern: this.prefix + path,
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  put(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "PUT",
      pattern: this.prefix + path,
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  patch(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "PATCH",
      pattern: this.prefix + path,
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  delete(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "DELETE",
      pattern: this.prefix + path,
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  any(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    let lastRef!: RouteRef;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      lastRef = this.router.addRoute({
        method,
        pattern: this.prefix + path,
        handler,
        middlewares: this.mergeMiddlewares(middlewares),
        meta,
      });
    }
    return lastRef;
  }

  /**
   * Nested groups.
   */
  group(prefix: string, callback: (group: RouteGroup) => void, middlewares?: Middleware[]): void {
    const nestedGroup = new RouteGroup(
      this.router,
      this.prefix + prefix,
      this.mergeMiddlewares(middlewares),
    );
    callback(nestedGroup);
  }
}

/**
 * Run per-route middleware chain, then call the handler.
 */
export async function runRouteMiddlewares(
  middlewares: Middleware[],
  req: Tina4Request,
  res: Tina4Response,
): Promise<boolean> {
  for (const mw of middlewares) {
    let nextCalled = false;
    await mw(req, res, () => {
      nextCalled = true;
    });
    if (res.raw.writableEnded) return false;
    if (!nextCalled) return false;
  }
  return true;
}

/**
 * Default global router instance.
 * Top-level get(), post(), etc. register routes here.
 * The server merges these routes on startup.
 */
export const defaultRouter = new Router();

/**
 * Top-level route registration functions — mirrors Python's decorator pattern.
 *
 * Usage:
 *   import { get, post } from "@tina4/core";
 *
 *   get("/hello", async (req, res) => {
 *     res.json({ message: "Hello" });
 *   });
 *
 *   post("/users/{id}", async (req, res) => {
 *     res.json({ id: req.params.id }, 201);
 *   });
 */
export function get(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
  return defaultRouter.get(path, handler, middlewares, meta);
}

export function post(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
  return defaultRouter.post(path, handler, middlewares, meta);
}

export function put(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
  return defaultRouter.put(path, handler, middlewares, meta);
}

export function patch(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
  return defaultRouter.patch(path, handler, middlewares, meta);
}

// Named "del" to avoid conflict with the "delete" keyword; also exported as "delete" alias below.
export function del(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
  return defaultRouter.delete(path, handler, middlewares, meta);
}

export function any(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
  return defaultRouter.any(path, handler, middlewares, meta);
}

export function websocket(path: string, handler: WebSocketRouteHandler): void {
  defaultRouter.websocket(path, handler);
}

// Re-export "del" as "delete" for developer convenience (use: import { delete as del } from "@tina4/core")
export { del as delete };

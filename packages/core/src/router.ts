import type { RouteHandler, RouteDefinition, RouteMeta, Middleware, Tina4Request, Tina4Response, WebSocketRouteHandler, WebSocketRouteDefinition } from "./types.js";
import { isTruthy } from "./dotenv.js";

/**
 * Whether `TINA4_TRAILING_SLASH_REDIRECT` is enabled.
 *
 * Default: false. When true, a request to `/foo/` that has no exact match
 * but matches `/foo` will be treated as a hit on `/foo` — callers can use
 * the returned pattern to issue a 308 redirect (Python parity).
 */
export function isTrailingSlashRedirectEnabled(): boolean {
  return isTruthy(process.env.TINA4_TRAILING_SLASH_REDIRECT);
}

/**
 * Coerce a matched path param to its declared type. Mirrors Python/PHP/Ruby:
 * `{id:int}`/`{id:integer}` arrive as a JS integer `number`, `{p:float}`/
 * `{p:number}` as a float `number`, and every other type (string/alpha/alnum/
 * slug/uuid/path) plus untyped `{id}` stay the decoded string. The URL regex
 * already constrains what reaches here (`int` only matches `\d+`), so a cast
 * should never fail — but we never throw: a NaN result falls back to the raw
 * string so a malformed value can't take the router down.
 */
function coerceParam(raw: string, type: string | undefined): string | number {
  switch (type) {
    case "int":
    case "integer": {
      const n = parseInt(raw, 10);
      return Number.isNaN(n) ? raw : n;
    }
    case "float":
    case "number": {
      const n = parseFloat(raw);
      return Number.isNaN(n) ? raw : n;
    }
    default:
      return raw;
  }
}

interface MatchResult {
  handler: RouteHandler;
  params: Record<string, string | number>;
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
  paramTypes: string[];
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

  /** Append middleware class(es) to this route. */
  middleware(...middlewareClasses: Middleware[]): this {
    this.route.middlewares = [...(this.route.middlewares ?? []), ...middlewareClasses];
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
    const { regex, paramNames, paramTypes } = this.compilePattern(definition.pattern);

    if (!this.routes.has(method)) {
      this.routes.set(method, []);
    }

    const routes = this.routes.get(method)!;

    // Remove existing route with same pattern (for hot-reload)
    const existingIndex = routes.findIndex((r) => r.pattern === definition.pattern);
    if (existingIndex !== -1) {
      routes.splice(existingIndex, 1);
    }

    // Write methods (POST/PUT/PATCH/DELETE) are secure by default. Middleware is
    // purely additive — registering custom middleware must NOT silently disable the
    // built-in Bearer-token gate (parity with PY-10-02). Use `noAuth()` to open a
    // write route explicitly.
    const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    const isWrite = WRITE_METHODS.has(method);
    const secureDefault = isWrite ? (definition.secure ?? true) : definition.secure;

    const compiled: CompiledRoute = {
      pattern: definition.pattern,
      regex,
      paramNames,
      paramTypes,
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
   * Register an explicit HEAD route. By default the framework auto-handles
   * HEAD by falling back to the GET route and stripping the body
   * (RFC 9110 §9.3.2). Use this only when you need a HEAD handler that
   * does something different from GET — e.g. cheaper existence-check
   * logic, custom validator headers without the cost of building the body.
   * The framework still strips the response body for you on the way out.
   */
  head(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "HEAD", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register an explicit OPTIONS route. By default the framework auto-
   * handles OPTIONS by building an Allow header from every method
   * registered for the path and returning 204 (RFC 9110 §9.3.7). Use
   * this to take over that behaviour.
   */
  options(path: string, handler: RouteHandler, middlewares?: Middleware[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "OPTIONS", pattern: path, handler, middlewares, meta });
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
   *
   * When `TINA4_TRAILING_SLASH_REDIRECT=true` and the request path ends in
   * a trailing slash that doesn't match a registered route, retry without
   * the trailing slash. Returning the de-slashed pattern lets callers issue
   * a 308 redirect instead of a hard 404 — Python parity.
   */
  match(method: string, path: string): MatchResult | null {
    const upperMethod = method.toUpperCase();

    // Try exact method first, then ANY routes are already registered under each method
    const routes = this.routes.get(upperMethod);
    if (routes) {
      const direct = this.matchRoute(routes, path);
      if (direct) return direct;

      // Trailing-slash redirect — strip a single trailing "/" and retry.
      // Root "/" is intentionally excluded (it's its own route).
      if (
        isTrailingSlashRedirectEnabled() &&
        path.length > 1 &&
        path.endsWith("/")
      ) {
        const stripped = path.replace(/\/+$/, "");
        if (stripped.length > 0) {
          const retry = this.matchRoute(routes, stripped);
          if (retry) return retry;
        }
      }
    }

    // RFC 9110 §9.3.2: HEAD is identical to GET except for the absence
    // of a response body. If no explicit HEAD route matched, fall back
    // to the GET route — the dispatcher strips the body on the way out.
    if (upperMethod === "HEAD") {
      const getRoutes = this.routes.get("GET");
      if (getRoutes) {
        return this.matchRoute(getRoutes, path);
      }
    }

    return null;
  }

  /**
   * Return the list of HTTP methods registered for ``path``, in canonical
   * order GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS. Used by the
   * dispatcher to build the ``Allow:`` header on 405 / OPTIONS responses
   * (RFC 9110 §10.2.1, §9.3.7).
   *
   * If GET is registered, HEAD is appended implicitly (HEAD auto-fallback).
   * OPTIONS is appended whenever any method exists for the path (the
   * framework auto-handles OPTIONS).
   */
  methodsAllowedForPath(path: string): string[] {
    const order = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    const seen = new Set<string>();
    for (const m of order) {
      const routes = this.routes.get(m);
      if (!routes) continue;
      if (this.matchRoute(routes, path)) {
        seen.add(m);
      }
    }
    if (seen.size > 0) {
      if (seen.has("GET")) seen.add("HEAD");
      seen.add("OPTIONS");
    }
    return order.filter((m) => seen.has(m));
  }

  /** Inner match against a list of compiled routes, no trailing-slash logic. */
  private matchRoute(routes: CompiledRoute[], path: string): MatchResult | null {
    for (const route of routes) {
      const match = route.regex.exec(path);
      if (match) {
        const params: Record<string, string | number> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const raw = decodeURIComponent(match[i + 1]);
          params[route.paramNames[i]] = coerceParam(raw, route.paramTypes[i]);
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

  /** Alias for getRoutes(). */
  allRoutes(): RouteDefinition[] {
    return this.getRoutes();
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
   * Register a route for a specific HTTP method.
   * Core registration method — all convenience methods delegate here.
   */
  static add(method: string, path: string, handler: RouteHandler, middleware?: Middleware[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    const m = method.toUpperCase();
    if (m === "ANY") {
      return defaultRouter.any(path, handler, middleware, swaggerMeta);
    }
    return defaultRouter.addRoute({ method: m, pattern: path, handler, middlewares: middleware, meta: swaggerMeta, template });
  }

  /**
   * Register a GET route on the default global router.
   */
  static get(path: string, handler: RouteHandler, middleware?: Middleware[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.get(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a POST route on the default global router.
   */
  static post(path: string, handler: RouteHandler, middleware?: Middleware[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.post(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a PUT route on the default global router.
   */
  static put(path: string, handler: RouteHandler, middleware?: Middleware[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.put(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a PATCH route on the default global router.
   */
  static patch(path: string, handler: RouteHandler, middleware?: Middleware[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.patch(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a DELETE route on the default global router.
   */
  static delete(path: string, handler: RouteHandler, middleware?: Middleware[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.delete(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a route that matches ANY HTTP method on the default global router.
   */
  static any(path: string, handler: RouteHandler, middleware?: Middleware[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.any(path, handler, middleware, swaggerMeta);
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

  /**
   * Supported typed-parameter constraints. Mirrored verbatim in
   * tina4-python / tina4-php / tina4-ruby for cross-framework parity.
   *
   * Any type name not in this table throws at route registration time —
   * we never silently fall through to the default matcher, because a
   * typo like `{id:inetger}` would otherwise match anything and create
   * a security footgun (see tina4-book#125).
   */
  private static readonly PARAM_TYPE_PATTERNS: Record<string, string> = {
    string: "[^/]+",            // default, any non-slash segment
    int: "\\d+",
    integer: "\\d+",
    float: "[\\d.]+",
    number: "[\\d.]+",
    alpha: "[A-Za-z]+",         // letters only
    alnum: "[A-Za-z0-9]+",      // letters + digits
    slug: "[a-z0-9-]+",         // URL slug
    uuid: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    path: ".+",                  // greedy
    ".*": ".+",
  };

  private compilePattern(pattern: string): { regex: RegExp; paramNames: string[]; paramTypes: string[] } {
    const paramNames: string[] = [];
    // Declared type per capture group, parallel to paramNames. Drives value
    // coercion at match time (int/integer/float/number → JS number). Every
    // capture below pushes a type so the two arrays stay index-aligned; only
    // {name:type} carries a non-"string" type — all other forms are "string".
    const paramTypes: string[] = [];

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
          paramTypes.push("string");
          return "(.+)";
        }
        // Dynamic param: {id}, {id:int}, {id:float}, {id:path} (matching Python/Ruby)
        if (segment.startsWith("{") && segment.endsWith("}")) {
          const inner = segment.slice(1, -1);
          const colonIdx = inner.indexOf(":");
          const name = colonIdx >= 0 ? inner.slice(0, colonIdx) : inner;
          const type = colonIdx >= 0 ? inner.slice(colonIdx + 1) : "string";
          paramNames.push(name);
          paramTypes.push(type);
          const table = Router.PARAM_TYPE_PATTERNS;
          if (!Object.prototype.hasOwnProperty.call(table, type)) {
            const valid = Object.keys(table).filter((k) => k !== ".*").sort().join(", ");
            throw new Error(
              `Unknown param type '${type}' in route '${pattern}'. Valid types: ${valid}.`
            );
          }
          return `(${table[type]})`;
        }
        // Dynamic param: [id] (file-based routing internal syntax)
        if (segment.startsWith("[") && segment.endsWith("]")) {
          const name = segment.slice(1, -1);
          paramNames.push(name);
          paramTypes.push("string");
          return "([^/]+)";
        }
        // Express-style param: :id
        if (segment.startsWith(":")) {
          const name = segment.slice(1);
          paramNames.push(name);
          paramTypes.push("string");
          return "([^/]+)";
        }
        // Wildcard: * (catch-all, param key is "*")
        if (segment === "*") {
          paramNames.push("*");
          paramTypes.push("string");
          return "(.+)";
        }
        return segment;
      })
      .join("/");

    return {
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
      paramTypes,
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

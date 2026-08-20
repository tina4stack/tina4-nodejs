import type { RouteHandler, RouteDefinition, RouteMeta, Middleware, MiddlewareSpec, Tina4Request, Tina4Response, WebSocketRouteHandler, WebSocketRouteDefinition } from "./types.js";
import { isTruthy } from "./dotenv.js";
import { MiddlewareRunner, isMiddlewareClass } from "./middleware.js";

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

/**
 * Join a route-group prefix with a route's own path.
 *
 * Feature 32 (RG-DEC-01): ports PHP's normalization grammar verbatim
 * (`Tina4/Router.php` `addRoute` — the reference) so Node converges with
 * PHP/Python/Ruby instead of `RouteGroup`'s old bare concatenation. One
 * separator between prefix and path, a single leading slash, no trailing
 * slash, and any run of slashes collapsed to one — so `group("/api")` +
 * `get("users")`, `get("/users")`, and `group("/api/")` + `get("/users")`
 * all resolve to the SAME `/api/users`. Before this fix, `this.prefix +
 * path` bare-concatenated with NO normalization at all — the worst of the
 * four, since Node's `RouteGroup` prefix isn't even trailing-slash-trimmed
 * on construction (unlike Python's `rstrip`/Ruby's `chomp`).
 */
function joinGroupPath(prefix: string, path: string): string {
  const full = `${prefix}/${path.replace(/^\/+/, "")}`;
  const trimmed = `/${full.replace(/^\/+|\/+$/g, "")}`;
  return trimmed.replace(/\/+/g, "/");
}

interface MatchResult {
  handler: RouteHandler;
  params: Record<string, string | number>;
  pattern: string;
  meta?: RouteMeta;
  middlewares?: MiddlewareSpec[];
  template?: string;
  secure?: boolean;
  cached?: boolean;
  noAuth?: boolean;
  requiredRoles?: string[][];
  requiredPerms?: string[][];
}

interface CompiledRoute {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  paramTypes: string[];
  handler: RouteHandler;
  meta?: RouteMeta;
  filePath?: string;
  middlewares?: MiddlewareSpec[];
  secure?: boolean;
  cached?: boolean;
  noAuth?: boolean;
  cacheStore?: Map<string, { data: unknown; expires: number }>;
  cacheTtl?: number;
  template?: string;
  /** RBAC guard groups (Feature 138): OR within a group, AND across groups. */
  requiredRoles?: string[][];
  requiredPerms?: string[][];
}

/**
 * Thin reference to a registered WebSocket route, enabling chained modifiers
 * — the WS analogue of {@link RouteRef}.
 *
 * Usage:
 *   router.websocket("/ws/secure", handler).secure();
 */
export class WsRouteRef {
  constructor(private route: WebSocketRouteDefinition) {}

  /** Mark this WS route as requiring a valid JWT on the upgrade handshake. */
  secure(): this {
    this.route.authRequired = true;
    return this;
  }
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

  /**
   * RBAC: require ONE of the named roles (OR). Reads the verified JWT `roles`
   * claim. Chain .role()/.can() for AND. Implies auth. Feature 138 / ADR-0058.
   */
  role(...names: string[]): this {
    const clean = names.filter((n) => n !== "");
    if (clean.length > 0) {
      (this.route.requiredRoles ??= []).push(clean);
      this.route.secure = true;
    }
    return this;
  }

  /**
   * RBAC: require ONE of the named permissions (OR). Reads the verified JWT
   * `permissions` claim; granted-side wildcards (`posts.*`, `*`) satisfy a
   * concrete requirement. Chain for AND. Implies auth. Feature 138.
   */
  can(...permissions: string[]): this {
    const clean = permissions.filter((p) => p !== "");
    if (clean.length > 0) {
      (this.route.requiredPerms ??= []).push(clean);
      this.route.secure = true;
    }
    return this;
  }

  /** Mark this route's response as cacheable. */
  cache(): this {
    this.route.cached = true;
    return this;
  }

  /**
   * Append middleware to this route. Accepts middleware functions and/or
   * string specs (e.g. `"ResponseCache:300"`), resolved when the route runs.
   */
  middleware(...middlewareClasses: MiddlewareSpec[]): this {
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
      requiredRoles: definition.requiredRoles,
      requiredPerms: definition.requiredPerms,
    };
    routes.push(compiled);
    return new RouteRef(compiled);
  }

  /**
   * Register a GET route programmatically.
   */
  get(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "GET", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a POST route programmatically.
   */
  post(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "POST", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a PUT route programmatically.
   */
  put(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "PUT", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a PATCH route programmatically.
   */
  patch(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "PATCH", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a DELETE route programmatically.
   */
  delete(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
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
  head(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "HEAD", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register an explicit OPTIONS route. By default the framework auto-
   * handles OPTIONS by building an Allow header from every method
   * registered for the path and returning 204 (RFC 9110 §9.3.7). Use
   * this to take over that behaviour.
   */
  options(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.addRoute({ method: "OPTIONS", pattern: path, handler, middlewares, meta });
  }

  /**
   * Register a route that matches ANY HTTP method.
   */
  any(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    let lastRef!: RouteRef;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      lastRef = this.addRoute({ method, pattern: path, handler, middlewares, meta });
    }
    return lastRef;
  }

  /**
   * Create a route group with a shared prefix and optional middlewares.
   */
  group(prefix: string, callback: (group: RouteGroup) => void, middlewares?: MiddlewareSpec[]): void {
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
          requiredRoles: route.requiredRoles,
          requiredPerms: route.requiredPerms,
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
          requiredRoles: route.requiredRoles,
          requiredPerms: route.requiredPerms,
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
   *
   * A WS route is PUBLIC by default (mirrors GET). It can be marked secured in
   * EITHER way the HTTP routes support:
   *   • imperatively — `websocket(path, fn, { secured: true })`, or chain the
   *     returned ref: `websocket(path, fn).secure()`;
   *   • decorator-style — a `_secured` flag on the handler function, set in
   *     either order relative to registration (the ref keeps a back-reference
   *     to the route so a later `.secure()` / `_secured` still flips it).
   *
   * When secured, the upgrade handshake requires a valid JWT (Authorization
   * header / `bearer` subprotocol / `?token=`) or the upgrade is rejected.
   */
  websocket(path: string, handler: WebSocketRouteHandler, options?: { secured?: boolean }): WsRouteRef {
    // Remove existing ws route with same pattern (for hot-reload)
    this.wsRoutes = this.wsRoutes.filter((r) => r.pattern !== path);
    const route: WebSocketRouteDefinition = {
      pattern: path,
      handler,
      // Public unless explicitly secured via options OR a handler `_secured` flag.
      authRequired: Boolean(options?.secured ?? handler._secured ?? false),
    };
    this.wsRoutes.push(route);
    return new WsRouteRef(route);
  }

  /**
   * Get all registered WebSocket route definitions.
   */
  getWebSocketRoutes(): WebSocketRouteDefinition[] {
    return [...this.wsRoutes];
  }

  /**
   * Match a WebSocket upgrade request path to a registered ws route.
   * Returns the route only; use {@link matchWebSocketWithParams} when the
   * upgrade handler needs the extracted `{param}` values.
   */
  matchWebSocket(pathname: string): WebSocketRouteDefinition | null {
    return this.matchWebSocketWithParams(pathname)?.route ?? null;
  }

  /**
   * Match a WebSocket upgrade path AND extract its `{param}` values, using the
   * same pattern compiler as HTTP routes. A literal pattern (`/ws/chat`) still
   * matches exactly with empty params; a parameterised pattern
   * (`/ws/rtc/{room}`) matches `/ws/rtc/abc` and yields `{ room: "abc" }`.
   * (Previously WS matching was exact-string only, so `{param}` routes never
   * matched and `connection.params` was always empty.)
   */
  matchWebSocketWithParams(
    pathname: string,
  ): { route: WebSocketRouteDefinition; params: Record<string, string> } | null {
    for (const route of this.wsRoutes) {
      if (route.pattern === pathname) return { route, params: {} };
      const { regex, paramNames } = this.compilePattern(route.pattern);
      const match = regex.exec(pathname);
      if (match) {
        const params: Record<string, string> = {};
        paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
        return { route, params };
      }
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
  static add(method: string, path: string, handler: RouteHandler, middleware?: MiddlewareSpec[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    const m = method.toUpperCase();
    if (m === "ANY") {
      return defaultRouter.any(path, handler, middleware, swaggerMeta);
    }
    return defaultRouter.addRoute({ method: m, pattern: path, handler, middlewares: middleware, meta: swaggerMeta, template });
  }

  /**
   * Register a GET route on the default global router.
   */
  static get(path: string, handler: RouteHandler, middleware?: MiddlewareSpec[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.get(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a POST route on the default global router.
   */
  static post(path: string, handler: RouteHandler, middleware?: MiddlewareSpec[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.post(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a PUT route on the default global router.
   */
  static put(path: string, handler: RouteHandler, middleware?: MiddlewareSpec[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.put(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a PATCH route on the default global router.
   */
  static patch(path: string, handler: RouteHandler, middleware?: MiddlewareSpec[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.patch(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a DELETE route on the default global router.
   */
  static delete(path: string, handler: RouteHandler, middleware?: MiddlewareSpec[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.delete(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a route that matches ANY HTTP method on the default global router.
   */
  static any(path: string, handler: RouteHandler, middleware?: MiddlewareSpec[], swaggerMeta?: RouteMeta, template?: string): RouteRef {
    return defaultRouter.any(path, handler, middleware, swaggerMeta);
  }

  /**
   * Register a WebSocket route on the default global router.
   */
  static websocket(path: string, handler: WebSocketRouteHandler, options?: { secured?: boolean }): WsRouteRef {
    return defaultRouter.websocket(path, handler, options);
  }

  /**
   * Match a WebSocket upgrade path against routes on the default global router.
   * Returns the matched route definition (with its `authRequired` flag) or null.
   */
  static matchWebSocket(pathname: string): WebSocketRouteDefinition | null {
    return defaultRouter.matchWebSocket(pathname);
  }

  static matchWebSocketWithParams(
    pathname: string,
  ): { route: WebSocketRouteDefinition; params: Record<string, string> } | null {
    return defaultRouter.matchWebSocketWithParams(pathname);
  }

  /** All WebSocket route definitions on the default global router. */
  static getWebSocketRoutes(): WebSocketRouteDefinition[] {
    return defaultRouter.getWebSocketRoutes();
  }

  /**
   * Create a route group on the default global router.
   */
  static group(prefix: string, callback: (group: RouteGroup) => void, middlewares?: MiddlewareSpec[]): void {
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
        // Literal segment -- escape every regex metacharacter so it matches
        // itself only (real-bug pre-merge, 3.13.99). Before this, a literal
        // segment was interpolated into the pattern string UNESCAPED: e.g.
        // registering `/blocked-xss(1)` compiled `(1)` as a capture group,
        // so `new RegExp('^/blocked-xss(1)$')` actually required the URL
        // WITHOUT the parens -- the exact literal path it was registered
        // for 404'd. Mirrors Python's re.escape / Ruby's Regexp.escape /
        // PHP's preg_quote, all already correct here.
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    private groupMiddlewares?: MiddlewareSpec[],
  ) {}

  private mergeMiddlewares(routeMiddlewares?: MiddlewareSpec[]): MiddlewareSpec[] | undefined {
    const group = this.groupMiddlewares ?? [];
    const route = routeMiddlewares ?? [];
    const merged = [...group, ...route];
    return merged.length > 0 ? merged : undefined;
  }

  get(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "GET",
      pattern: joinGroupPath(this.prefix, path),
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  post(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "POST",
      pattern: joinGroupPath(this.prefix, path),
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  put(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "PUT",
      pattern: joinGroupPath(this.prefix, path),
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  patch(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "PATCH",
      pattern: joinGroupPath(this.prefix, path),
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  delete(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    return this.router.addRoute({
      method: "DELETE",
      pattern: joinGroupPath(this.prefix, path),
      handler,
      middlewares: this.mergeMiddlewares(middlewares),
      meta,
    });
  }

  any(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
    let lastRef!: RouteRef;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      lastRef = this.router.addRoute({
        method,
        pattern: joinGroupPath(this.prefix, path),
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
  group(prefix: string, callback: (group: RouteGroup) => void, middlewares?: MiddlewareSpec[]): void {
    const nestedGroup = new RouteGroup(
      this.router,
      this.prefix + prefix,
      this.mergeMiddlewares(middlewares),
    );
    callback(nestedGroup);
  }
}

/**
 * Resolve a string-form middleware spec to a middleware function.
 *
 * Forms (parity with Python/PHP/Ruby):
 *   "ResponseCache"      → responseCache() with the default/env TTL
 *   "ResponseCache:300"  → responseCache({ ttl: 300 })
 *
 * The head before the first ":" names the middleware; any trailing
 * colon-separated parts are its arguments (numeric parts are parsed as
 * integers). Unknown names throw so a typo surfaces instead of silently
 * dropping the middleware. `responseCache` is loaded via a dynamic import so
 * the router carries no import-time dependency on the cache module.
 *
 * Exported so route dispatch (and tests) can turn a spec into a runnable
 * middleware.
 */
export async function resolveStringMiddleware(spec: string): Promise<Middleware> {
  const colon = spec.indexOf(":");
  const name = colon >= 0 ? spec.slice(0, colon) : spec;
  const rawArgs = colon >= 0 ? spec.slice(colon + 1).split(":") : [];

  switch (name) {
    case "ResponseCache": {
      const { responseCache } = await import("./cache.js");
      // First arg (if any) is the TTL in seconds.
      const ttlArg = rawArgs[0];
      const ttl = ttlArg !== undefined && /^\d+$/.test(ttlArg) ? parseInt(ttlArg, 10) : undefined;
      return responseCache(ttl !== undefined ? { ttl } : undefined);
    }
    default:
      throw new Error(
        `Unknown middleware "${name}". Known string middleware: ResponseCache. ` +
        `For custom middleware, pass the function directly to .middleware(fn).`,
      );
  }
}

/**
 * Resolve a single route-middleware spec to a middleware function. Functions
 * pass through unchanged; strings are resolved via resolveStringMiddleware.
 * A middleware CLASS never reaches here — runRouteMiddlewares runs it through
 * the MiddlewareRunner instead.
 */
async function resolveMiddlewareSpec(spec: MiddlewareSpec): Promise<Middleware> {
  return typeof spec === "string" ? resolveStringMiddleware(spec) : spec as Middleware;
}

/**
 * Run the per-route middleware chain. Returns false when it short-circuited
 * and the handler must be skipped.
 *
 * Accepts middleware functions, middleware CLASSES, and string specs
 * (e.g. "ResponseCache:300"). A function or string spec is resolved and
 * invoked as `mw(req, res, next)` exactly as before.
 *
 * A CLASS runs its beforeX hooks through the SAME `MiddlewareRunner.runBefore`
 * and the SAME return-value table as global middleware — no parallel runner.
 * Its afterX hooks run with the global after pass once the handler is done
 * (server.ts / testClient.ts append the route's classes to that list), because
 * "after" means after the handler, not after this function. Every spec used to
 * be invoked as `mw(req, res, next)`, which for a class throws "Class
 * constructor cannot be invoked without 'new'", so a class attached per-route
 * was inert. Python and PHP both ran per-route class hooks already.
 */
export async function runRouteMiddlewares(
  middlewares: MiddlewareSpec[],
  req: Tina4Request,
  res: Tina4Response,
): Promise<boolean> {
  for (const spec of middlewares) {
    if (isMiddlewareClass(spec)) {
      // tina4: a class hook that returns a DIFFERENT [req, res] pair cannot be
      // rebound here — this returns a bool and is public API (four of this
      // repo's own test files import it). Node's req/res are per-request
      // singletons, so every built-in returns the same pair back; widen the
      // return type if that ever stops being true.
      const [, , proceed] = await MiddlewareRunner.runBefore([spec], req, res);
      if (!proceed || res.raw.writableEnded) return false;
      continue;
    }

    const mw = await resolveMiddlewareSpec(spec);
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
export function get(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
  return defaultRouter.get(path, handler, middlewares, meta);
}

export function post(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
  return defaultRouter.post(path, handler, middlewares, meta);
}

export function put(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
  return defaultRouter.put(path, handler, middlewares, meta);
}

export function patch(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
  return defaultRouter.patch(path, handler, middlewares, meta);
}

// Named "del" to avoid conflict with the "delete" keyword; also exported as "delete" alias below.
export function del(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
  return defaultRouter.delete(path, handler, middlewares, meta);
}

export function any(path: string, handler: RouteHandler, middlewares?: MiddlewareSpec[], meta?: RouteMeta): RouteRef {
  return defaultRouter.any(path, handler, middlewares, meta);
}

export function websocket(path: string, handler: WebSocketRouteHandler, options?: { secured?: boolean }): WsRouteRef {
  return defaultRouter.websocket(path, handler, options);
}

// Re-export "del" as "delete" for developer convenience (use: import { delete as del } from "@tina4/core")
export { del as delete };

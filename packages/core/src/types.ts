import type { IncomingMessage, ServerResponse } from "node:http";

export interface UploadedFile {
  fieldName: string;
  filename: string;
  type: string;
  content: Buffer;
  size: number;
}

export interface Tina4Session {
  get(key: string, defaultValue?: unknown): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
  save(): void;
  readonly id: string;
}

export interface Tina4Request extends IncomingMessage {
  /**
   * Path params. Typed params arrive coerced: `{id:int}`/`{id:integer}` and
   * `{p:float}`/`{p:number}` are JS `number`s; every other type and untyped
   * `{id}` stay `string` (parity with Python/PHP/Ruby).
   */
  params: Record<string, string | number>;
  query: Record<string, string>;
  /**
   * Request path only — no query string. Matches `request.path` in
   * Python/PHP/Ruby. Example: `/users/42`.
   */
  path: string;
  /**
   * Raw query string with no leading "?". Matches `request.query_string`
   * (Python/Ruby) and `request.queryString` (PHP). Example: `"page=2"`.
   */
  queryString: string;
  /**
   * Full absolute URL — `scheme://host[:port]/path[?query]`.
   * Honours X-Forwarded-Proto / X-Forwarded-Host. Matches PHP/Ruby/Python parity.
   *
   * Note: this overrides Node's native `IncomingMessage.url` (which contains
   * only path+query). Inside Tina4 handlers, `req.url` is always the full URL.
   */
  url: string;
  body: unknown;
  ip: string;
  /**
   * Raw socket peer address - NEVER honours X-Forwarded-For (which any
   * caller can spoof), so it can be trusted for security decisions.
   * Empty for in-process / synthetic requests. Parity with Python's
   * request.remote_ip and PHP's Request::$remoteIp.
   */
  remoteIp: string;
  files: Record<string, UploadedFile | UploadedFile[]>;
  cookies: Record<string, string>;
  contentType: string;
  /**
   * NULL when the session backend was unusable for this request (ADR-0021).
   * The request path logs the failure and degrades rather than 500-ing, so a
   * request really can arrive without a session and the type has to say so -
   * `req.session?.get(...)`. Parity with Python, where `request.session` is
   * `None` on the same path.
   */
  session: Tina4Session | null;
  user?: Record<string, unknown>;
  /** Get a specific header value by name (case-insensitive). */
  header(name: string): string | undefined;
  /** Extract the Bearer token from the Authorization header. */
  bearerToken(): string | null;
  /**
   * Get a parameter by key from merged params (route + query). Route params
   * may be coerced numbers (e.g. `{id:int}`); query params are always strings.
   */
  param(key: string, defaultValue?: string | number): string | number | undefined;
  /** Parse the request body based on content type. */
  parseBody(): Promise<void>;
}

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface Tina4ResponseMethods {
  json(data: unknown, status?: number): Tina4Response;
  html(content: string, status?: number): Tina4Response;
  text(content: string, status?: number): Tina4Response;
  xml(content: string, status?: number): Tina4Response;
  status(code: number): Tina4Response;
  header(name: string, value: string | number | readonly string[]): Tina4Response;
  addHeader(name: string, value: string): void;
  send(data: unknown, statusCode?: number, contentType?: string): Tina4Response;
  redirect(url: string, code?: number): Tina4Response;
  cookie(name: string, value: string, options?: CookieOptions): Tina4Response;
  clearCookie(name: string, options?: CookieOptions): Tina4Response;
  file(path: string, options?: { download?: boolean; contentType?: string }): Tina4Response;
  error(code: string, message: string, status?: number): Tina4Response;
  render(template: string, data?: Record<string, unknown>, status?: number, templateDir?: string): Promise<Tina4Response>;
  /** Stream response from an async generator (SSE or chunked). */
  stream(source: AsyncIterable<string | Buffer>, contentType?: string): Promise<Tina4Response>;
  /** The underlying ServerResponse for advanced use */
  raw: ServerResponse;
}

/**
 * Tina4 Response — callable AND has methods.
 *
 *   return response({ users: [] });                    // Auto-JSON
 *   return response({ ok: true }, HTTP_CREATED);       // JSON with status
 *   return response("<h1>Hi</h1>");                    // Auto-HTML
 *   return response("Not found", HTTP_NOT_FOUND);      // Plain text
 *   return response(data, HTTP_OK, APPLICATION_JSON);  // Explicit
 *   return response.json(data, 201);                   // Explicit method
 *   return response.redirect("/login");                // Special case
 */
export type Tina4Response =
  ((data?: unknown, statusCode?: number, contentType?: string) => Tina4Response)
  & Tina4ResponseMethods;

// A route handler may resolve `void` (it wrote to `res` directly) OR return the
// `Tina4Response` from `res.json(...)` / `response(...)` - the established
// convention across the framework's own routes, realtime handlers, and the
// `generate` scaffolding (`return res.json(...)`). The dispatcher tolerates a
// returned response; the type just has to allow it.
export type RouteHandler = (
  req: Tina4Request,
  res: Tina4Response,
) => Tina4Response | void | Promise<Tina4Response | void>;

export interface RouteDefinition {
  method: string;
  pattern: string;
  handler: RouteHandler;
  filePath?: string;
  meta?: RouteMeta;
  /** Middleware functions and/or string specs (e.g. "ResponseCache:300"). */
  middlewares?: MiddlewareSpec[];
  /** Template file to render when handler returns a plain object */
  template?: string;
  /** Whether this route requires bearer-token authentication */
  secure?: boolean;
  /** Whether this route's response should be cached */
  cached?: boolean;
  /** Opt out of secure-by-default auth on write routes */
  noAuth?: boolean;
}

export interface RouteMeta {
  summary?: string;
  description?: string;
  tags?: string[];
  responses?: Record<string, { description: string }>;
  /** Request-body example surfaced in the OpenAPI requestBody. */
  example?: unknown;
  /** Marks the operation deprecated in the spec. */
  deprecated?: boolean;
  /**
   * Per-route security requirement (v3.13.42). Overrides the default scheme.
   * Accepted forms (normalized by the generator into a security-requirement list):
   *   "bearerAuth"                          -> [{ bearerAuth: [] }]
   *   "public" | "none" | []                -> [] (explicitly no auth)
   *   { apiKeyAuth: [] }                    -> [{ apiKeyAuth: [] }]   (AND within one map)
   *   [{ oauth2: ["read"] }, { bearerAuth: [] }]  -> verbatim (OR across maps)
   */
  security?: string | string[] | Record<string, string[]> | Array<Record<string, string[]>>;
  /** Scopes for a single named scheme passed as `security: "oauth2"` + `scopes: [...]`. */
  scopes?: string[];
  /**
   * Reference a registered component schema as the request body (v3.13.42):
   *   requestSchema: "CreateUser"  OR  { name: "CreateUser", contentType: "application/json" }
   * Emits `$ref: #/components/schemas/CreateUser` and lands the schema in components.schemas.
   */
  requestSchema?: string | { name: string; contentType?: string };
  /**
   * Reference registered component schemas as response bodies, keyed by status (v3.13.42):
   *   responseSchemas: { 200: "User", 201: { name: "User", isList: true } }
   */
  responseSchemas?: Record<string, string | { name: string; isList?: boolean }>;
}

export interface Tina4Config {
  port?: number;
  host?: string;
  /** Base directory for the project. When set, routesDir, modelsDir, templatesDir,
   *  and staticDir are resolved relative to this path instead of process.cwd(). */
  basePath?: string;
  routesDir?: string;
  modelsDir?: string;
  templatesDir?: string;
  staticDir?: string;
  database?: {
    type?: "sqlite" | "postgres" | "mysql";
    path?: string;
    url?: string;
  };
}

export type Middleware = (
  req: Tina4Request,
  res: Tina4Response,
  next: () => void
) => void | Promise<void>;

/**
 * A class-based middleware: static `beforeX` / `afterX` hooks discovered by
 * `MiddlewareRunner`. The hooks are a NAMING CONVENTION, not an interface —
 * exactly as in Python/PHP/Ruby — so this is deliberately just "a class".
 */
export type MiddlewareClass = abstract new (...args: never[]) => unknown;

/**
 * A route middleware entry: a middleware function, a middleware CLASS, or a
 * string spec resolved by the router to a built-in middleware.
 *
 * String forms (parity with Python/PHP/Ruby):
 *   "ResponseCache"      → responseCache() with the default/env TTL
 *   "ResponseCache:300"  → responseCache({ ttl: 300 })
 *
 * The router resolves string specs to middleware functions when the route
 * runs, so callers can register a response-cache middleware without importing
 * `responseCache`. A CLASS runs its beforeX/afterX hooks through the same
 * `MiddlewareRunner` as global middleware — Python and PHP already ran
 * per-route class hooks; Node used to invoke every spec as `mw(req, res, next)`
 * and a class was therefore inert.
 */
export type MiddlewareSpec = Middleware | MiddlewareClass | string;

/**
 * Handler for WebSocket routes.
 * connection — object with send/broadcast/close methods and route params.
 * event — one of "open", "message", or "close".
 * data — the incoming text message (only present for "message" events).
 */
export type WebSocketRouteHandler = ((
  connection: import("./websocketConnection.js").WebSocketConnection,
  event: "open" | "message" | "close",
  data: string,
) => void | Promise<void>) & {
  /**
   * Decorator-style secured flag — mirrors Python's `handler._secured`. When
   * truthy the WS route requires a valid JWT on the upgrade. `Router.websocket`
   * reads this into the route's `authRequired`. Lets a handler be marked
   * secured in EITHER order (before or after registration).
   */
  _secured?: boolean;
};

export interface WebSocketRouteDefinition {
  pattern: string;
  handler: WebSocketRouteHandler;
  /**
   * True when this WS route requires a valid JWT on the upgrade. Public by
   * default (mirrors GET). Set imperatively via `Router.websocket(path, fn,
   * { secured: true })` / the returned `.secure()`, or by a `_secured` flag on
   * the handler (decorator style).
   */
  authRequired?: boolean;
}

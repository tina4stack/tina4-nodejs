import type { ServerResponse } from "node:http";
import fs from "node:fs";
import nodePath from "node:path";
import type { Tina4Response, CookieOptions } from "./types.js";

/** Cache Frond instances by template directory to avoid repeated instantiation. */
const _frondCache = new Map<string, InstanceType<any>>();

/** Default templates directory — set via setDefaultTemplatesDir(). */
let _defaultTemplatesDir: string | null = null;

/** Global user Frond engine — set via setFrond(). */
let _globalFrond: InstanceType<any> | null = null;

/** Singleton framework Frond engine for built-in templates. */
let _frameworkFrond: InstanceType<any> | null = null;

/**
 * Set the default templates directory for render().
 * Called by server.ts during startup.
 */
export function setDefaultTemplatesDir(dir: string): void {
  _defaultTemplatesDir = dir;
}

/**
 * Return the global Frond engine, creating a default if needed.
 */
export async function getFrond(): Promise<InstanceType<any>> {
  if (_globalFrond) return _globalFrond;
  const dir = _defaultTemplatesDir ?? nodePath.resolve(process.cwd(), "src/templates");
  let engine = _frondCache.get(dir);
  if (!engine) {
    const { Frond } = await import("@tina4/frond");
    engine = new Frond(dir);
    _frondCache.set(dir, engine);
  }
  _globalFrond = engine;
  return engine;
}

/**
 * Return the singleton Frond engine for built-in framework templates.
 * Syncs custom filters/globals from the user engine.
 */
export async function getFrameworkFrond(): Promise<InstanceType<any> | null> {
  const frameworkDir = nodePath.resolve(nodePath.dirname(import.meta.url.replace("file://", "")), "..", "templates");
  if (!_frameworkFrond && fs.existsSync(frameworkDir)) {
    try {
      const { Frond } = await import("@tina4/frond");
      _frameworkFrond = new Frond(frameworkDir);
    } catch { return null; }
  }
  // Sync custom filters/globals from the user engine
  if (_frameworkFrond && _globalFrond) {
    if (typeof _globalFrond._filters === "object") {
      Object.assign(_frameworkFrond._filters ??= {}, _globalFrond._filters);
    }
    if (typeof _globalFrond._globals === "object") {
      Object.assign(_frameworkFrond._globals ??= {}, _globalFrond._globals);
    }
  }
  return _frameworkFrond;
}

/**
 * Register a pre-configured Frond engine for response.render().
 */
export function setFrond(engine: InstanceType<any>): void {
  _globalFrond = engine;
}

/**
 * Creates a callable response object.
 *
 *   return response({ users: [] });                    // Auto-JSON
 *   return response({ ok: true }, HTTP_CREATED);       // JSON with status
 *   return response("<h1>Hi</h1>");                    // Auto-HTML
 *   return response("Not found", HTTP_NOT_FOUND);      // Plain text
 *   return response(data, HTTP_OK, APPLICATION_JSON);  // Explicit
 *   return response.json(data, 201);                   // Method
 *   return response.redirect("/login");                // Special
 */
/**
 * Normalise domain objects into JSON-serialisable values so handlers can
 * `return response(model)` / `res.json(model)` without calling .toDict() by hand:
 *
 *   return response(user);               // ORM model       -> object
 *   return response(await User.all());   // model[]          -> object[]
 *   return response(await db.fetch(sql));// DatabaseResult   -> object[]
 *
 * Duck-typed (no @tina4/orm import — avoids a package cycle): a callable
 * `toDict` marks a model; a `records` array plus a `toArray` method marks a
 * query result. Plain objects / arrays / scalars pass through unchanged.
 */
function toJsonable(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Buffer.isBuffer(data)) {
    return data;
  }
  const obj = data as Record<string, unknown>;
  // Query result (DatabaseResult-like): records array + toArray method.
  if (Array.isArray(obj.records) && typeof obj.toArray === "function") {
    return obj.records;
  }
  // ORM model: callable toDict().
  if (typeof obj.toDict === "function") {
    return (obj.toDict as () => unknown)();
  }
  // Collections: normalise each element (array of models -> array of objects).
  if (Array.isArray(data)) {
    return data.map((item) => toJsonable(item));
  }
  return data;
}

export function createResponse(res: ServerResponse): Tina4Response {

  // ── Guard: prevent writing after headers are sent ──
  const safeEnd = (chunk?: string | Buffer, encoding?: BufferEncoding) => {
    if (res.headersSent) return;
    if (chunk === undefined) {
      res.end();
    } else if (encoding === undefined) {
      res.end(chunk);
    } else {
      res.end(chunk, encoding);
    }
  };
  const safeSetHeader = (name: string, value: string | number | readonly string[]) => {
    if (!res.headersSent) res.setHeader(name, value);
  };

  // ── The callable: response(data, status, contentType) ──
  const response = function (data?: unknown, statusCode?: number, contentType?: string): Tina4Response {
    if (res.headersSent) return response;

    // Normalise ORM models / collections / query results so handlers can
    // `return response(model)` without serialising by hand.
    data = toJsonable(data);

    if (statusCode !== undefined) {
      res.statusCode = statusCode;
    }

    if (contentType) {
      // Explicit content type
      safeSetHeader("Content-Type", contentType);
      if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) {
        safeEnd(JSON.stringify(data));
      } else {
        safeEnd(data == null ? "" : String(data));
      }
    } else if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) {
      // dict/array → auto JSON
      safeSetHeader("Content-Type", "application/json");
      safeEnd(JSON.stringify(data));
    } else if (typeof data === "string") {
      const trimmed = data.trim();
      if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
        safeSetHeader("Content-Type", "text/html; charset=utf-8");
      } else {
        safeSetHeader("Content-Type", "text/plain; charset=utf-8");
      }
      safeEnd(data);
    } else if (Buffer.isBuffer(data)) {
      if (!res.getHeader("Content-Type")) {
        safeSetHeader("Content-Type", "application/octet-stream");
      }
      safeEnd(data);
    } else if (data == null) {
      safeEnd("");
    } else {
      safeSetHeader("Content-Type", "text/plain; charset=utf-8");
      safeEnd(String(data));
    }

    return response;
  } as Tina4Response;

  // ── Attach the underlying ServerResponse ──
  response.raw = res;

  // ── Explicit methods ──

  response.json = function (data: unknown, status?: number): Tina4Response {
    if (res.headersSent) return response;
    if (status !== undefined) res.statusCode = status;
    safeSetHeader("Content-Type", "application/json");
    safeEnd(JSON.stringify(toJsonable(data)));
    return response;
  };

  response.html = function (content: string, status?: number): Tina4Response {
    if (res.headersSent) return response;
    if (status !== undefined) res.statusCode = status;
    safeSetHeader("Content-Type", "text/html; charset=utf-8");
    safeEnd(content);
    return response;
  };

  response.text = function (content: string, status?: number): Tina4Response {
    if (res.headersSent) return response;
    if (status !== undefined) res.statusCode = status;
    safeSetHeader("Content-Type", "text/plain; charset=utf-8");
    safeEnd(content);
    return response;
  };

  response.xml = function (content: string, status?: number): Tina4Response {
    if (res.headersSent) return response;
    if (status !== undefined) res.statusCode = status;
    safeSetHeader("Content-Type", "application/xml; charset=utf-8");
    safeEnd(content);
    return response;
  };

  response.send = function (data: unknown, statusCode?: number, contentType?: string): Tina4Response {
    return response(data, statusCode, contentType);
  };

  response.status = function (code: number): Tina4Response {
    if (!res.headersSent) res.statusCode = code;
    return response;
  };

  response.header = function (name: string, value: string | number | readonly string[]): Tina4Response {
    safeSetHeader(name, value);
    return response;
  };

  /**
   * Add a single response header (primary method — parity with Python/PHP/Ruby).
   */
  response.addHeader = function (name: string, value: string): void {
    safeSetHeader(name, value);
  };

  response.redirect = function (url: string, code?: number): Tina4Response {
    if (res.headersSent) return response;
    res.statusCode = code ?? 302;
    safeSetHeader("Location", url);
    safeEnd();
    return response;
  };

  response.cookie = function (name: string, value: string, options?: CookieOptions): Tina4Response {
    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
    if (options?.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
    if (options?.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
    if (options?.path) parts.push(`Path=${options.path}`);
    if (options?.domain) parts.push(`Domain=${options.domain}`);
    if (options?.secure) parts.push("Secure");
    if (options?.httpOnly) parts.push("HttpOnly");
    if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`);

    const existing = res.getHeader("Set-Cookie");
    const cookies: string[] = [];
    if (Array.isArray(existing)) cookies.push(...(existing as string[]));
    else if (typeof existing === "string") cookies.push(existing);
    cookies.push(parts.join("; "));
    safeSetHeader("Set-Cookie", cookies);

    return response;
  };

  response.clearCookie = function (name: string, options?: CookieOptions): Tina4Response {
    return response.cookie(name, "", { ...options, maxAge: 0, expires: new Date(0) });
  };

  response.error = function (code: string, message: string, status?: number): Tina4Response {
    const statusCode = status ?? 400;
    return response.json({ error: true, code, message, status: statusCode }, statusCode);
  };

  response.file = function (filePath: string, options?: { download?: boolean; contentType?: string }): Tina4Response {
    if (res.headersSent) return response;

    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      safeEnd("File not found");
      return response;
    }

    const content = fs.readFileSync(filePath);
    const ext = nodePath.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
      ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
      ".pdf": "application/pdf", ".zip": "application/zip", ".csv": "text/csv",
      ".xml": "application/xml", ".webp": "image/webp", ".ico": "image/x-icon",
      ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
      ".txt": "text/plain", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
    };

    safeSetHeader("Content-Type", options?.contentType || mimeTypes[ext] || "application/octet-stream");
    safeSetHeader("Content-Length", content.length);
    if (options?.download) {
      safeSetHeader("Content-Disposition", `attachment; filename="${nodePath.basename(filePath)}"`);
    }
    safeEnd(content);
    return response;
  };

  // ── Template rendering via Frond ──

  response.render = async function (
    templateName: string,
    data?: Record<string, unknown>,
    status?: number,
    templateDir?: string,
  ): Promise<Tina4Response> {
    try {
      const { Frond } = await import("@tina4/frond");
      const dir = templateDir ?? _defaultTemplatesDir ?? nodePath.resolve(process.cwd(), "src/templates");
      let engine = _frondCache.get(dir);
      if (!engine) {
        engine = new Frond(dir);
        _frondCache.set(dir, engine);
      }
      const html = engine.render(templateName, data ?? {});
      if (res.headersSent) return response;
      if (status !== undefined) res.statusCode = status;
      else res.statusCode = 200;
      safeSetHeader("Content-Type", "text/html; charset=utf-8");
      safeEnd(html);
      return response;
    } catch (err) {
      res.statusCode = 500;
      response.json({
        error: "Template engine error",
        statusCode: 500,
        message: err instanceof Error ? err.message : "Frond template engine is not available. Ensure @tina4/frond is installed.",
      });
      return response;
    }
  };

  /**
   * Stream response from an async generator for Server-Sent Events (SSE).
   *
   * Usage:
   *   export default async function (req, res) {
   *     res.stream(async function* () {
   *       for (let i = 0; i < 10; i++) {
   *         yield `data: message ${i}\n\n`;
   *         await new Promise(r => setTimeout(r, 1000));
   *       }
   *     }());
   *   }
   */
  (response as any).stream = async function (
    source: AsyncIterable<string | Buffer>,
    contentType: string = "text/event-stream",
  ): Promise<Tina4Response> {
    if (res.headersSent) return response;
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    for await (const chunk of source) {
      const data = typeof chunk === "string" ? chunk : chunk.toString();
      res.write(data);
    }

    res.end();
    return response;
  };

  return response;
}

/**
 * Build a standard error response envelope (standalone helper).
 *
 * Usage:
 *   return response(errorResponse("VALIDATION_FAILED", "Email is required", 400), 400);
 */
export function errorResponse(code: string, message: string, status: number = 400): Record<string, unknown> {
  return { error: true, code, message, status };
}

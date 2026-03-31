import type { ServerResponse } from "node:http";
import fs from "node:fs";
import nodePath from "node:path";
import type { Tina4Response, CookieOptions } from "./types.js";

/** Cache Frond instances by template directory to avoid repeated instantiation. */
const _frondCache = new Map<string, InstanceType<any>>();

/** Default templates directory — set via setDefaultTemplatesDir(). */
let _defaultTemplatesDir: string | null = null;

/**
 * Set the default templates directory for render()/template().
 * Called by server.ts during startup.
 */
export function setDefaultTemplatesDir(dir: string): void {
  _defaultTemplatesDir = dir;
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
export function createResponse(res: ServerResponse): Tina4Response {

  // ── Guard: prevent writing after headers are sent ──
  const safeEnd = (...args: Parameters<typeof res.end>) => {
    if (!res.headersSent) (res.end as Function)(...args);
  };
  const safeSetHeader = (name: string, value: string | number | readonly string[]) => {
    if (!res.headersSent) res.setHeader(name, value);
  };

  // ── The callable: response(data, status, contentType) ──
  const response = function (data?: unknown, statusCode?: number, contentType?: string): Tina4Response {
    if (res.headersSent) return response;

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
    safeEnd(JSON.stringify(data));
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

  response.template = async function (
    name: string,
    data?: Record<string, unknown>,
    status?: number,
    templateDir?: string,
  ): Promise<Tina4Response> {
    return response.render(name, data, status, templateDir);
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

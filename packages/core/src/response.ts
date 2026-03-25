import type { ServerResponse } from "node:http";
import fs from "node:fs";
import nodePath from "node:path";
import type { Tina4Response, CookieOptions } from "./types.js";

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

  // ── The callable: response(data, status, contentType) ──
  const response = function (data?: unknown, statusCode?: number, contentType?: string): Tina4Response {
    if (statusCode !== undefined) {
      res.statusCode = statusCode;
    }

    if (contentType) {
      // Explicit content type
      res.setHeader("Content-Type", contentType);
      if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) {
        res.end(JSON.stringify(data));
      } else {
        res.end(data == null ? "" : String(data));
      }
    } else if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) {
      // dict/array → auto JSON
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } else if (typeof data === "string") {
      const trimmed = data.trim();
      if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
      } else {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.end(data);
    } else if (Buffer.isBuffer(data)) {
      if (!res.getHeader("Content-Type")) {
        res.setHeader("Content-Type", "application/octet-stream");
      }
      res.end(data);
    } else if (data == null) {
      res.end("");
    } else {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(String(data));
    }

    return response;
  } as Tina4Response;

  // ── Attach the underlying ServerResponse ──
  response.raw = res;

  // ── Explicit methods ──

  response.json = function (data: unknown, status?: number): Tina4Response {
    if (status !== undefined) res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
    return response;
  };

  response.html = function (content: string, status?: number): Tina4Response {
    if (status !== undefined) res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(content);
    return response;
  };

  response.text = function (content: string, status?: number): Tina4Response {
    if (status !== undefined) res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(content);
    return response;
  };

  response.send = function (data: unknown, statusCode?: number, contentType?: string): Tina4Response {
    return response(data, statusCode, contentType);
  };

  response.status = function (code: number): Tina4Response {
    res.statusCode = code;
    return response;
  };

  response.header = function (name: string, value: string | number | readonly string[]): Tina4Response {
    res.setHeader(name, value);
    return response;
  };

  response.redirect = function (url: string, code?: number): Tina4Response {
    res.statusCode = code ?? 302;
    res.setHeader("Location", url);
    res.end();
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
    res.setHeader("Set-Cookie", cookies);

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
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end("File not found");
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

    res.setHeader("Content-Type", options?.contentType || mimeTypes[ext] || "application/octet-stream");
    res.setHeader("Content-Length", content.length);
    if (options?.download) {
      res.setHeader("Content-Disposition", `attachment; filename="${nodePath.basename(filePath)}"`);
    }
    res.end(content);
    return response;
  };

  // Default render/template stubs — overwritten by server.ts when Frond is available
  response.render = async function (templateName: string, _data?: Record<string, unknown>): Promise<Tina4Response> {
    res.statusCode = 500;
    response.json({
      error: "Template engine not available",
      statusCode: 500,
      message: "Frond template engine is not initialized. Ensure @tina4/frond is installed.",
    });
    return response;
  };

  response.template = async function (name: string, data?: Record<string, unknown>): Promise<Tina4Response> {
    return response.render(name, data);
    }
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

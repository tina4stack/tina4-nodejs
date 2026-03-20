import type { ServerResponse } from "node:http";
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

  return response;
}

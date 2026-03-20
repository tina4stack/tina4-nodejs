import type { ServerResponse } from "node:http";
import type { Tina4Response, CookieOptions } from "./types.js";

export function createResponse(res: ServerResponse): Tina4Response {
  const tRes = res as Tina4Response;

  tRes.json = function (data: unknown, status?: number): Tina4Response {
    if (status !== undefined) {
      this.statusCode = status;
    }
    this.setHeader("Content-Type", "application/json");
    this.end(JSON.stringify(data));
    return this;
  };

  tRes.html = function (content: string, status?: number): Tina4Response {
    if (status !== undefined) {
      this.statusCode = status;
    }
    this.setHeader("Content-Type", "text/html; charset=utf-8");
    this.end(content);
    return this;
  };

  tRes.text = function (content: string, status?: number): Tina4Response {
    if (status !== undefined) {
      this.statusCode = status;
    }
    this.setHeader("Content-Type", "text/plain; charset=utf-8");
    this.end(content);
    return this;
  };

  tRes.status = function (code: number): Tina4Response {
    this.statusCode = code;
    return this;
  };

  tRes.header = function (name: string, value: string | number | readonly string[]): Tina4Response {
    this.setHeader(name, value);
    return this;
  };

  tRes.send = function (data: unknown, statusCode?: number, contentType?: string): Tina4Response {
    if (statusCode !== undefined) {
      this.statusCode = statusCode;
    }
    if (contentType) {
      this.setHeader("Content-Type", contentType);
      if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) {
        this.end(JSON.stringify(data));
      } else {
        this.end(data == null ? "" : String(data));
      }
    } else if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) {
      // dict/array → auto JSON
      this.setHeader("Content-Type", "application/json");
      this.end(JSON.stringify(data));
    } else if (typeof data === "string") {
      const trimmed = data.trim();
      if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
        this.setHeader("Content-Type", "text/html; charset=utf-8");
      } else {
        this.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      this.end(data);
    } else if (Buffer.isBuffer(data)) {
      if (!this.getHeader("Content-Type")) {
        this.setHeader("Content-Type", "application/octet-stream");
      }
      this.end(data);
    } else if (data == null) {
      this.end("");
    } else {
      this.setHeader("Content-Type", "text/plain; charset=utf-8");
      this.end(String(data));
    }
    return this;
  };

  tRes.redirect = function (url: string, code?: number): Tina4Response {
    this.statusCode = code ?? 302;
    this.setHeader("Location", url);
    this.end();
    return this;
  };

  tRes.cookie = function (name: string, value: string, options?: CookieOptions): Tina4Response {
    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

    if (options?.maxAge !== undefined) {
      parts.push(`Max-Age=${options.maxAge}`);
    }
    if (options?.expires) {
      parts.push(`Expires=${options.expires.toUTCString()}`);
    }
    if (options?.path) {
      parts.push(`Path=${options.path}`);
    }
    if (options?.domain) {
      parts.push(`Domain=${options.domain}`);
    }
    if (options?.secure) {
      parts.push("Secure");
    }
    if (options?.httpOnly) {
      parts.push("HttpOnly");
    }
    if (options?.sameSite) {
      parts.push(`SameSite=${options.sameSite}`);
    }

    // Append to existing Set-Cookie headers
    const existing = this.getHeader("Set-Cookie");
    const cookies: string[] = [];
    if (Array.isArray(existing)) {
      cookies.push(...(existing as string[]));
    } else if (typeof existing === "string") {
      cookies.push(existing);
    }
    cookies.push(parts.join("; "));
    this.setHeader("Set-Cookie", cookies);

    return this;
  };

  tRes.clearCookie = function (name: string, options?: CookieOptions): Tina4Response {
    return this.cookie(name, "", {
      ...options,
      maxAge: 0,
      expires: new Date(0),
    });
  };

  return tRes;
}

import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { join, extname } from "node:path";
import type { Tina4Request, Tina4Response } from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};

export function tryServeStatic(
  staticDir: string,
  req: Tina4Request,
  res: Tina4Response
): boolean {
  // Prefer req.path (always path-only, set by createRequest). Fall back to
  // parsing req.url for hand-rolled request objects in unit tests.
  let pathname = req.path;
  if (!pathname) {
    const raw = req.url ?? "/";
    pathname = raw.startsWith("http")
      ? new URL(raw).pathname
      : raw.split("?")[0];
  }

  // Try exact file match, then index.html for directory requests
  const candidates = [
    join(staticDir, pathname),
    join(staticDir, pathname, "index.html"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;

    const stat = statSync(filePath);
    if (!stat.isFile()) continue;

    // Prevent directory traversal
    if (!filePath.startsWith(staticDir)) continue;

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    // Cheap validators from the file's size + mtime — no hashing needed. A weak
    // ETag (W/) is correct here: two representations with the same size+mtime
    // are treated as equivalent for caching. Last-Modified is second-resolution
    // per HTTP.
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    const lastModified = stat.mtime.toUTCString();

    // A static asset MAY be cached but MUST be revalidated before use, so a
    // redeployed file reaches the browser on the next load without a manual hard
    // refresh; an unchanged asset costs a cheap 304, not a re-download. These
    // ride on both the 200 and the 304 so the client always has fresh
    // validators. Parity with the Python master static handler.
    res.raw.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.raw.setHeader("ETag", etag);
    res.raw.setHeader("Last-Modified", lastModified);

    // Conditional request → 304 Not Modified with no body.
    if (isNotModified(req, etag, stat)) {
      res.raw.statusCode = 304;
      res.raw.end();
      return true;
    }

    res.raw.setHeader("Content-Type", contentType);
    res.raw.setHeader("Content-Length", stat.size);
    res.raw.end(readFileSync(filePath));
    return true;
  }

  return false;
}

/**
 * Read a conditional-request header off the incoming request. Works with the
 * real `IncomingMessage` (`req.headers`, already lower-cased by Node) AND with
 * the hand-rolled request objects used in unit tests. Header names must be
 * lower-case. Returns "" when absent.
 */
function conditionalHeader(req: Tina4Request, name: string): string {
  const headers = (req as { headers?: Record<string, string | string[] | undefined> }).headers;
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Answer whether the cached representation the client already holds is still
 * current. `If-None-Match` wins over `If-Modified-Since` (RFC 7232 §3.3): when
 * the client sends an entity tag we compare against that alone.
 */
function isNotModified(req: Tina4Request, etag: string, stat: Stats): boolean {
  const ifNoneMatch = conditionalHeader(req, "if-none-match");
  if (ifNoneMatch) {
    return etagMatches(ifNoneMatch, etag);
  }
  const ifModifiedSince = conditionalHeader(req, "if-modified-since");
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    if (!Number.isNaN(since)) {
      // Last-Modified is second-resolution; floor the mtime so sub-second
      // precision never reports a spurious "modified".
      const modified = Math.floor(stat.mtimeMs / 1000) * 1000;
      return modified <= since;
    }
  }
  return false;
}

/**
 * Weak comparison of an `If-None-Match` value against our ETag. The header may
 * be `*`, a single tag, or a comma-separated list; the `W/` weak prefix is
 * stripped on both sides before comparing (RFC 7232 §2.3.2 weak comparison).
 */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = strip(etag);
  return ifNoneMatch.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || strip(trimmed) === target;
  });
}

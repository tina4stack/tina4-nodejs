import { existsSync, readFileSync, statSync } from "node:fs";
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

    res.raw.setHeader("Content-Type", contentType);
    res.raw.setHeader("Content-Length", stat.size);
    res.raw.end(readFileSync(filePath));
    return true;
  }

  return false;
}

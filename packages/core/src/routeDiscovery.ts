import { readdirSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import type { RouteDefinition, RouteHandler, RouteMeta } from "./types.js";

const VALID_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

export async function discoverRoutes(routesDir: string): Promise<RouteDefinition[]> {
  const definitions: RouteDefinition[] = [];
  const files = walkDir(routesDir);

  for (const filePath of files) {
    const ext = extname(filePath);
    if (ext !== ".ts" && ext !== ".js") continue;

    const name = basename(filePath, ext).toLowerCase();
    if (!VALID_METHODS.has(name)) continue;

    const method = name.toUpperCase();
    const relativePath = relative(routesDir, filePath);
    const pattern = filePathToPattern(relativePath);

    try {
      // Cache-bust for hot-reload
      const moduleUrl = `file://${filePath}?t=${Date.now()}`;
      const mod = await import(moduleUrl);

      const handler: RouteHandler = mod.default ?? mod.handler;
      if (typeof handler !== "function") {
        console.warn(`  Warning: ${relativePath} does not export a handler function, skipping`);
        continue;
      }

      const meta: RouteMeta | undefined = mod.meta;
      const template: string | undefined = typeof mod.template === "string" ? mod.template : undefined;

      definitions.push({ method, pattern, handler, filePath, meta, template });
    } catch (err) {
      console.error(`  Error loading route ${relativePath}:`, err);
    }
  }

  return definitions;
}

function filePathToPattern(relativePath: string): string {
  // Remove the filename (get.ts, post.ts, etc.) to get the directory path
  // Normalise backslashes for Windows compatibility
  const parts = relativePath.replace(/\\/g, "/").split("/").slice(0, -1);

  // Convert directory segments to URL pattern
  // File system uses [id] notation, but URL patterns use {id} to match Python
  const urlParts = parts.map((part) => {
    if (part.startsWith("[...") && part.endsWith("]")) {
      // Catch-all: [...slug] -> {...slug}
      const name = part.slice(4, -1);
      return `{...${name}}`;
    }
    if (part.startsWith("[") && part.endsWith("]")) {
      // Dynamic param: [id] -> {id}
      const name = part.slice(1, -1);
      return `{${name}}`;
    }
    return part;
  });

  return "/" + urlParts.join("/");
}

function walkDir(dir: string): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...walkDir(fullPath));
      } else {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist yet, that's fine
  }

  return files;
}

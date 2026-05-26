import { readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import type { RouteDefinition, RouteHandler, RouteMeta } from "./types.js";

const VALID_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

/**
 * Files already discovered by a prior scan. Lets rediscoverRoutes() pick up
 * only the freshly-added files without double-registering anything that was
 * already loaded.
 */
const _seenFiles = new Set<string>();

/** The last directory passed to discoverRoutes() — used by rediscoverRoutes(). */
let _lastRoutesDir = "";

export async function discoverRoutes(routesDir: string): Promise<RouteDefinition[]> {
  _lastRoutesDir = routesDir;
  const definitions: RouteDefinition[] = [];
  const files = walkDir(routesDir);

  let routeFileCount = 0;
  let registeredFromThisScan = 0;

  for (const filePath of files) {
    const ext = extname(filePath);
    if (ext !== ".ts" && ext !== ".js") continue;

    const name = basename(filePath, ext).toLowerCase();
    if (!VALID_METHODS.has(name)) continue;

    routeFileCount++;

    if (_seenFiles.has(filePath)) continue;

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
      _seenFiles.add(filePath);
      registeredFromThisScan++;
    } catch (err) {
      console.error(`  Error loading route ${relativePath}:`, err);
      recordBrokenImport(filePath, err as Error);
    }
  }

  // Zero-routes warning: src/routes/ has method-named files but none of them
  // produced a route this scan. Could mean every file failed to import, or
  // the handler exports are missing — both situations the user wants to know
  // about loudly. Only fires on the first scan when nothing came back.
  if (routeFileCount > 0 && registeredFromThisScan === 0 && _seenFiles.size === 0) {
    console.warn(
      `  Warning: ${routeFileCount} method-named file(s) in ${routesDir} but no routes registered. ` +
      `Each route file must \`export default async function (req, res) { ... }\`.`,
    );
  }

  return definitions;
}

/**
 * Re-run the most recent route scan — called by POST /__dev/api/reload so a
 * newly-added file in src/routes/ registers without a server restart. Already
 * loaded files are skipped. No-op if discoverRoutes() has never been called.
 */
export async function rediscoverRoutes(): Promise<RouteDefinition[]> {
  if (!_lastRoutesDir) return [];
  return discoverRoutes(_lastRoutesDir);
}

/** Test-only: reset the seen-files state so tests can replay the same dir. */
export function _resetRouteDiscovery(): void {
  _seenFiles.clear();
  _lastRoutesDir = "";
}

/**
 * Write a .broken sentinel so /health and the dev dashboard surface auto-discover
 * failures rather than swallowing them into a console line nobody reads.
 */
function recordBrokenImport(filePath: string, error: Error): void {
  try {
    const brokenDir = join(process.cwd(), "data", ".broken");
    if (!existsSync(brokenDir)) mkdirSync(brokenDir, { recursive: true });
    const slug = filePath.replace(/[/\\]/g, "_");
    const payload = JSON.stringify({
      type: "auto_discover_failure",
      file: filePath,
      error: `${error.name}: ${error.message}`,
    }, null, 2);
    writeFileSync(join(brokenDir, `discover_${slug}.broken`), payload);
  } catch {
    // .broken write itself failed — the original error is already logged.
  }
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

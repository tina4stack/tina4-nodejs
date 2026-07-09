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

/**
 * Last-seen mtime (ms) per route file. A file is (re)imported when it is new
 * OR its mtime has increased since the previous scan — so editing an existing
 * route file hot-reloads its handler instead of serving the stale one. The
 * mtime also drives the import cache-bust query, so unchanged files don't
 * needlessly re-execute.
 */
const _seenMtimes = new Map<string, number>();

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

    // Skip ONLY if we've already imported this exact file at its current mtime.
    // A new file (not in _seenFiles) or an edited one (mtime increased) falls
    // through and gets re-imported, so a hot-reload picks up the new handler.
    const currentMtime = statSync(filePath).mtimeMs;
    if (_seenFiles.has(filePath) && _seenMtimes.get(filePath) === currentMtime) continue;

    const method = name.toUpperCase();
    const relativePath = relative(routesDir, filePath);
    const pattern = filePathToPattern(relativePath);

    try {
      // Cache-bust for hot-reload, keyed on mtime: identical content reuses the
      // same module URL (no needless re-import), an edit produces a fresh URL.
      const moduleUrl = `file://${filePath}?t=${currentMtime}`;
      const mod = await import(moduleUrl);

      const handler: RouteHandler = mod.default ?? mod.handler;
      if (typeof handler !== "function") {
        console.warn(`  Warning: ${relativePath} does not export a handler function, skipping`);
        continue;
      }

      const meta: RouteMeta | undefined = mod.meta;
      const template: string | undefined = typeof mod.template === "string" ? mod.template : undefined;
      // Auth opt-outs a route file can export (parity with the imperative
      // `.noAuth()` / AutoCrud `secure: false`). A generated public write file
      // (`generate route … --public`, or the always-public auth login/register)
      // does `export const secure = false;`; without threading it here the
      // router would keep its secure-by-default write gate and the opt-out
      // would be inert. Only booleans are honoured — anything else is ignored.
      const secure: boolean | undefined = typeof mod.secure === "boolean" ? mod.secure : undefined;
      const noAuth: boolean | undefined = typeof mod.noAuth === "boolean" ? mod.noAuth : undefined;

      definitions.push({ method, pattern, handler, filePath, meta, template, secure, noAuth });
      _seenFiles.add(filePath);
      _seenMtimes.set(filePath, currentMtime);
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
 * newly-added OR edited file in src/routes/ registers without a server restart.
 * A file is re-imported when it's new or its mtime increased; unchanged files
 * are skipped. The router replaces routes by pattern, so a re-imported route
 * overwrites the stale handler. No-op if discoverRoutes() has never been called.
 */
export async function rediscoverRoutes(): Promise<RouteDefinition[]> {
  if (!_lastRoutesDir) return [];
  return discoverRoutes(_lastRoutesDir);
}

/** Test-only: reset the seen-files state so tests can replay the same dir. */
export function _resetRouteDiscovery(): void {
  _seenFiles.clear();
  _seenMtimes.clear();
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

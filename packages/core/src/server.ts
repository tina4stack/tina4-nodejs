import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve, dirname, join, relative } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { execFileSync, exec } from "node:child_process";
import cluster from "node:cluster";
import os from "node:os";
import type { Socket } from "node:net";
import type { Tina4Config, Tina4Request, Tina4Response } from "./types.js";
import { Router, defaultRouter, runRouteMiddlewares } from "./router.js";
import { enforceRouteAuth } from "./authGate.js";
import { discoverRoutes } from "./routeDiscovery.js";
import { createRequest } from "./request.js";
import { createResponse, setDefaultTemplatesDir } from "./response.js";
import { MiddlewareChain, MiddlewareRunner, cors, requestLogger } from "./middleware.js";
import { tryServeStatic } from "./static.js";
import { loadEnv, isTruthy } from "./dotenv.js";
import { createHealthRoutes } from "./health.js";
import { rateLimiter } from "./rateLimiter.js";
import { Log } from "./logger.js";
import { DevAdmin, RequestInspector, WsTracker } from "./devAdmin.js";
import { devReloadWs, serveWebSocketRoute, wsRouteManager } from "./websocket.js";
import { feedbackEnabled, injectFeedbackWidget } from "./feedback.js";
import { I18n } from "./i18n.js";
import { stopAllBackgroundTasks } from "./background.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Built-in error templates directory (ships with @tina4/core). */
const BUILTIN_ERROR_TEMPLATES_DIR = resolve(__dirname, "..", "templates");

/** Built-in public directory for framework-bundled static assets. */
const BUILTIN_PUBLIC_DIR = resolve(__dirname, "..", "public");

/**
 * Whether the framework's bundled Swagger UI assets (public/swagger/*) may be
 * served.
 *
 * Static files are resolved BEFORE routes, so the shipped
 * public/swagger/index.html answered `GET /swagger` even when
 * `swaggerEnabled()` was false -- serving the Swagger UI in production and
 * bypassing the documented TINA4_SWAGGER_ENABLED / TINA4_DEBUG gate entirely.
 * The symptom was a 200 on /swagger with a 404 on /swagger/openapi.json (the
 * gated route never registered, the static file still won).
 *
 * Set from `swaggerEnabled()` at boot. Stays false when swagger is disabled OR
 * when the swagger module fails to load -- fail closed, never expose.
 */
let swaggerAssetsEnabled = false;

/** Bundled Swagger UI asset paths that must honour the swagger gate. */
function isSwaggerAssetPath(pathname: string): boolean {
  return pathname === "/swagger" || pathname.startsWith("/swagger/");
}

/**
 * Build the startup banner's optional surface lines (issue #99).
 *
 * Only advertise a surface that is actually REACHABLE. In production, or with
 * TINA4_DEBUG off, /swagger and /__dev return 404 -- printing them anyway both
 * misleads an operator into believing a dev surface is exposed and sends a
 * developer to a dead link.
 *
 * Kept as a pure function of (port, two booleans) so the contract is unit
 * testable without booting a server and grepping stdout. Parity: Python
 * banner_surface_lines, PHP App::bannerSurfaceLines, Ruby
 * Tina4.banner_surface_lines.
 *
 * @returns [swaggerLine, dashboardLine] -- each empty, or a newline plus the
 *          banner row, ready to interpolate.
 */
export function bannerSurfaceLines(
  port: number,
  opts: { swaggerEnabled: boolean; devAdminEnabled: boolean },
): [string, string] {
  return [
    opts.swaggerEnabled ? `\n  Swagger:   http://localhost:${port}/swagger` : "",
    opts.devAdminEnabled ? `\n  Dashboard: http://localhost:${port}/__dev` : "",
  ];
}

/**
 * Whether the startup banner should ADVERTISE /swagger (issue #99).
 *
 * Mirrors `swaggerEnabled()` in packages/swagger/src/ui.ts: an explicit
 * TINA4_SWAGGER_ENABLED wins, otherwise fall back to TINA4_DEBUG.
 *
 * Read from env here rather than importing the swagger package, because the
 * CLUSTER PRIMARY prints its banner before any optional module is loaded (and a
 * dynamic import for one banner line is not worth the boot cost). Keep this in
 * sync with ui.ts -- it is the same two-line contract.
 */
function swaggerAdvertised(): boolean {
  const TRUTHY = ["true", "1", "yes", "on"];
  const raw = (process.env.TINA4_SWAGGER_ENABLED ?? "").trim().toLowerCase();
  if (raw === "") {
    return TRUTHY.includes((process.env.TINA4_DEBUG ?? "").trim().toLowerCase());
  }
  return TRUTHY.includes(raw);
}

/**
 * Apply pending DB migrations on startup — NON-BREAKING.
 *
 * When a `migrations/` folder exists (with at least one `.sql` file, excluding
 * `.down.sql`) and `TINA4_AUTO_MIGRATE` is not disabled (default "true";
 * false/0/no/off disable), pending migrations are applied during boot so the
 * schema is current with no manual `tina4 migrate` step. A failure here is
 * logged LOUD via `Log.error` and the service STILL starts — a bad migration
 * must never take the backend down. (The explicit `tina4 migrate` CLI stays
 * fail-fast so CI still gets a non-zero exit. Only this startup hook swallows.)
 *
 * Disable with `TINA4_AUTO_MIGRATE=false` — e.g. multi-instance production that
 * migrates as a separate deploy step (concurrent first-apply can race).
 *
 * @param migrationDir - migrations directory (default "migrations", relative to base)
 * @param base - project root used to resolve the migrations directory
 */
export async function autoMigrateOnStartup(
  migrationDir = "migrations",
  base = process.cwd(),
): Promise<void> {
  const dir = resolve(base, migrationDir);

  // Gate 1: a migrations/ folder with at least one .sql (non-down) file.
  if (!existsSync(dir)) return;
  let hasSql = false;
  try {
    hasSql = readdirSync(dir).some((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"));
  } catch {
    return; // unreadable dir → nothing to do (silent)
  }
  if (!hasSql) return;

  // Gate 2: TINA4_AUTO_MIGRATE not falsy (default "true").
  const flag = process.env.TINA4_AUTO_MIGRATE;
  if (flag != null && !isTruthy(flag)) {
    Log.debug("TINA4_AUTO_MIGRATE is off — skipping startup migrations");
    return;
  }

  // Gate 3: a DB adapter must be resolvable. (initDatabase() has already run by
  // the time this is called from startServer.)
  let orm: typeof import("../../orm/src/index.js");
  try {
    orm = await import("../../orm/src/index.js");
    orm.getAdapter(); // throws if no adapter configured
  } catch (err) {
    Log.debug(`Startup migrations skipped (no database configured): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Run the EXISTING migrate runner inside try/catch — NEVER re-raise out of
  // the startup hook (non-breaking).
  try {
    const result = await orm.migrate(undefined, { migrationsDir: dir });
    if (result.applied.length > 0) {
      Log.info(`Applied ${result.applied.length} pending migration(s) on startup`);
    }
  } catch (err) {
    Log.error(
      `Startup auto-migration failed: ${err instanceof Error ? err.message : String(err)} — ` +
      "the service is starting anyway. Run `tina4 migrate` to retry.",
    );
  }
}

/** Read version from root package.json so the banner always matches the published version. */
function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const TINA4_VERSION = readPackageVersion();

/** Cache Frond instances by template directory to avoid repeated instantiation. */
const frondCache = new Map<string, InstanceType<any>>();

// ─── Legacy env var guard (v3.12 hard rename) ────────────────────────────
// All framework env vars now require the TINA4_ prefix. If any of these
// pre-3.12 names are present in the environment we refuse to boot —
// silently ignoring them would cause auth/db/mail to fall back to
// defaults with no warning. Each maps to its new TINA4_-prefixed
// canonical name.
const _LEGACY_ENV_VARS: Record<string, string> = {
  DATABASE_URL:           "TINA4_DATABASE_URL",
  DATABASE_USERNAME:      "TINA4_DATABASE_USERNAME",
  DATABASE_PASSWORD:      "TINA4_DATABASE_PASSWORD",
  DB_URL:                 "TINA4_DATABASE_URL",
  SECRET:                 "TINA4_SECRET",
  API_KEY:                "TINA4_API_KEY",
  JWT_ALGORITHM:          "TINA4_JWT_ALGORITHM",
  SMTP_HOST:              "TINA4_MAIL_HOST",
  SMTP_PORT:              "TINA4_MAIL_PORT",
  SMTP_USERNAME:          "TINA4_MAIL_USERNAME",
  SMTP_PASSWORD:          "TINA4_MAIL_PASSWORD",
  SMTP_FROM:              "TINA4_MAIL_FROM",
  SMTP_FROM_NAME:         "TINA4_MAIL_FROM_NAME",
  IMAP_HOST:              "TINA4_MAIL_IMAP_HOST",
  IMAP_PORT:              "TINA4_MAIL_IMAP_PORT",
  IMAP_USER:              "TINA4_MAIL_IMAP_USERNAME",
  IMAP_PASS:              "TINA4_MAIL_IMAP_PASSWORD",
  HOST_NAME:              "TINA4_HOST_NAME",
  SWAGGER_TITLE:          "TINA4_SWAGGER_TITLE",
  SWAGGER_DESCRIPTION:    "TINA4_SWAGGER_DESCRIPTION",
  SWAGGER_VERSION:        "TINA4_SWAGGER_VERSION",
  ORM_PLURAL_TABLE_NAMES: "TINA4_ORM_PLURAL_TABLE_NAMES",
};

/**
 * Refuse to boot if pre-3.12 un-prefixed env vars are still set.
 *
 * Tina4 v3.12 hard-renamed every framework-specific env var to use the
 * `TINA4_` prefix. Booting silently with a legacy `DATABASE_URL` or
 * `SECRET` would let auth, DB, or mail fall back to insecure defaults
 * while the user thought their config was being read. Better to die
 * loudly with a list of names to fix.
 *
 * Bypass with `TINA4_ALLOW_LEGACY_ENV=true` in CI / migration scripts
 * that genuinely need both names set during a transition window.
 */
export function _checkLegacyEnvVars(): void {
  if (isTruthy(process.env.TINA4_ALLOW_LEGACY_ENV)) {
    return;
  }
  const found = Object.keys(_LEGACY_ENV_VARS)
    .filter((name) => process.env[name] !== undefined)
    .sort();
  if (found.length === 0) {
    return;
  }
  const bar = "─".repeat(72);
  const lines: string[] = [
    "",
    bar,
    "Tina4 v3.12 requires TINA4_ prefix on all framework env vars.",
    "Your environment still has these legacy names:",
    "",
  ];
  for (const old of found) {
    const next = _LEGACY_ENV_VARS[old];
    lines.push(`    ${old.padEnd(28)}  →  ${next}`);
  }
  lines.push(
    "",
    "Note: these may come from a .env file loaded by dotenv, not just",
    "the runtime environment — check your image / build context (a .env",
    "baked into a Docker image is loaded at startup) as well as k8s/CI env.",
    "",
    "FIX: run `tina4 env --migrate` to rewrite your .env automatically",
    "(it renames every legacy name to its TINA4_ form in place).",
    "Or rename manually. See https://tina4.com/release/3.12.0",
    "Set TINA4_ALLOW_LEGACY_ENV=true to bypass during migration.",
    bar,
    "",
  );
  process.stderr.write(lines.join("\n") + "\n");
  process.exit(2);
}

/**
 * Kill whatever process is listening on *port*.
 * Uses lsof on macOS/Linux and netstat + taskkill on Windows.
 * Throws if the port cannot be freed.
 */
function killPort(port: number): void {
  // execFileSync is imported at the top of the file
  console.log(`  Port ${port} in use — killing existing process...`);
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf-8", timeout: 5000 });
      for (const line of out.split("\n")) {
        if (line.includes(`:${port}`) && (line.includes("LISTENING") || line.includes("ESTABLISHED"))) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (/^\d+$/.test(pid)) {
            execFileSync("taskkill", ["/PID", pid, "/F"], { timeout: 5000 });
            break;
          }
        }
      }
    } else {
      const pids = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf-8", timeout: 5000 })
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const pid of pids) {
        if (/^\d+$/.test(pid.trim())) {
          process.kill(parseInt(pid.trim(), 10), "SIGTERM");
        }
      }
    }
    // Brief pause for the OS to reclaim the port
    execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { timeout: 2000 });
    console.log(`  Port ${port} freed`);
  } catch (err) {
    throw new Error(`Could not free port ${port}: ${err}`);
  }
}

/**
 * Check if *port* is available; if not, kill the process on it and return *port*.
 * The auto-increment behaviour is intentionally removed — the server always
 * claims the requested port.
 */
function findAvailablePort(start: number): number {
  try {
    execFileSync(process.execPath, ["-e", `
      const s = require("net").createServer();
      s.listen(${start}, "0.0.0.0", () => { s.close(); process.exit(0); });
      s.on("error", () => process.exit(1));
    `], { timeout: 1000 });
    return start;
  } catch {
    killPort(start);
    return start;
  }
}

/**
 * Open the user's default browser after a short delay so the server is ready.
 */
function openBrowser(url: string) {
  // exec imported at top of file (ESM)
  setTimeout(() => {
    if (process.platform === "darwin") exec(`open ${url}`);
    else if (process.platform === "win32") exec(`start "" "${url}"`);
    else exec(`xdg-open ${url}`);
  }, 2000);
}

/**
 * Resolve port and host with priority: explicit config > ENV var > default.
 * Exported for testability.
 *
 * Host resolution prefers `TINA4_HOST` (the framework-prefixed name —
 * matches Python parity) and falls back to the unprefixed `HOST` env var
 * for backwards compatibility.
 */
export function resolvePortAndHost(config?: { port?: number; host?: string }): { port: number; host: string } {
  const port = config?.port
    ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : undefined)
    ?? 7148;
  const host = config?.host
    ?? process.env.TINA4_HOST
    ?? process.env.HOST
    ?? "0.0.0.0";
  return { port, host };
}

/**
 * Whether the boot banner should be suppressed. Set TINA4_SUPPRESS=true to
 * silence the ASCII-art banner and route table on startup — useful in CI,
 * test runners, and embedded contexts where stdout is consumed by another
 * process.
 */
export function isBannerSuppressed(): boolean {
  return isTruthy(process.env.TINA4_SUPPRESS);
}

function isDevMode(): boolean {
  return isTruthy(process.env.TINA4_DEBUG);
}

/**
 * Render an error page using Twig templates via Frond.
 * Priority: user override (src/templates/errors/{code}.twig) > built-in default > JSON fallback.
 */
async function renderErrorPage(
  code: number,
  data: Record<string, unknown>,
  templatesDir: string,
): Promise<string | null> {
  try {
    const { Frond } = await import("../../frond/src/engine.js");
    const templateFile = `errors/${code}.twig`;

    // Helper: get-or-create a cached Frond instance for a directory
    const getCachedFrond = (dir: string) => {
      let instance = frondCache.get(dir);
      if (!instance) {
        instance = new Frond(dir);
        frondCache.set(dir, instance);
      }
      return instance;
    };

    // 1. Try user override in the project's templates directory
    const userTemplatePath = join(templatesDir, templateFile);
    if (existsSync(userTemplatePath)) {
      return getCachedFrond(templatesDir).render(templateFile, data);
    }

    // 2. Try built-in framework default
    const builtinTemplatePath = join(BUILTIN_ERROR_TEMPLATES_DIR, templateFile);
    if (existsSync(builtinTemplatePath)) {
      return getCachedFrond(BUILTIN_ERROR_TEMPLATES_DIR).render(templateFile, data);
    }

    // 3. No template found
    return null;
  } catch {
    // Frond not available or template rendering failed — fall back to JSON
    return null;
  }
}

interface DevToolbarContext {
  version: string;
  method: string;
  path: string;
  matchedPattern: string;
  requestId: string;
  routeCount: number;
}

function injectDevToolbar(html: string, ctx: DevToolbarContext): string {
  const toolbar = DevAdmin.renderToolbarHtml(ctx);
  if (html.includes("</body>")) {
    return html.replace("</body>", toolbar + "\n</body>");
  }
  return html + toolbar;
}

function walkGalleryFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) results.push(...walkGalleryFiles(full));
    else results.push(full);
  }
  return results;
}

function getGalleryDeployedState(): Record<string, boolean> {
  const galleryDir = resolve(__dirname, "..", "gallery");
  const state: Record<string, boolean> = {};
  if (!existsSync(galleryDir)) return state;
  try {
    const entries = readdirSync(galleryDir).sort();
    for (const entry of entries) {
      const entryPath = join(galleryDir, entry);
      const metaFile = join(entryPath, "meta.json");
      if (statSync(entryPath).isDirectory() && existsSync(metaFile)) {
        const srcDir = join(entryPath, "src");
        if (existsSync(srcDir)) {
          const files = walkGalleryFiles(srcDir);
          const projectSrc = resolve(process.cwd(), "src");
          state[entry] = files.every((f) => existsSync(join(projectSrc, relative(srcDir, f))));
        } else {
          state[entry] = false;
        }
      }
    }
  } catch { /* ignore */ }
  return state;
}

/**
 * Auto-routing scans this single subdirectory of src/templates/. Only files
 * in src/templates/pages/ become URLs — everything else (partials, layouts,
 * base.twig, errors, components, macros) is never URL-exposed and remains
 * renderable only via {% include %} / {% extends %} / res.render().
 *
 * Convention adapted from Next.js' pages/ directory and Nuxt's pages/ folder.
 * Explicit, secure by default, no skip lists to maintain.
 */
const TEMPLATE_PAGES_DIR = "pages";

/**
 * Honour TINA4_TEMPLATE_ROUTING=off|false|0|no|disabled as an explicit kill
 * switch. Default: enabled. Drop a file in src/templates/pages/ and it serves
 * at the matching URL — the zero-config Tina4 convention. Operators who want
 * explicit-only routing can set TINA4_TEMPLATE_ROUTING=off and every URL
 * must be registered via get() / post() (or be a static file).
 */
export function templateAutoRoutingEnabled(): boolean {
  const val = (process.env.TINA4_TEMPLATE_ROUTING ?? "on").trim().toLowerCase();
  return !["off", "false", "0", "no", "disabled"].includes(val);
}

/**
 * RFC 7231 / RFC 9110 status reason phrases. Used to write a correct HTTP
 * status line — previously some paths wrote "HTTP/1.1 404 OK" because the
 * canonical phrase wasn't being looked up per code.
 */
const HTTP_REASON_PHRASES: Record<number, string> = {
  100: "Continue", 101: "Switching Protocols",
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently", 302: "Found", 303: "See Other",
  304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable",
  409: "Conflict", 410: "Gone", 413: "Content Too Large",
  415: "Unsupported Media Type", 422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error", 501: "Not Implemented",
  502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

/**
 * Return the canonical HTTP reason phrase for `status`. Falls back to a
 * sensible label when an exotic status is used. Never returns an empty string.
 */
export function httpReason(status: number): string {
  const phrase = HTTP_REASON_PHRASES[status];
  if (phrase) return phrase;
  return status >= 200 && status < 300 ? "OK" : "Error";
}

/** Template cache: url_path -> template_file. Null until first production lookup. */
let templateCache: Map<string, string> | null = null;

/**
 * Reset the production template cache. Tests use this between scenarios so
 * a fresh scan picks up fixture files in a tmp project.
 */
export function resetTemplateCache(): void {
  templateCache = null;
}

/**
 * Resolve a URL path to a template file in src/templates/pages/.
 *
 * Only files inside `src/templates/pages/` auto-route from a URL. Anything
 * in `src/templates/` outside `pages/` (partials, layouts, base.twig,
 * errors, components) is never served standalone.
 *
 * Dev mode: checks filesystem every time for live changes.
 * Production: uses a cached lookup built once at startup.
 *
 * The whole feature can be turned off with `TINA4_TEMPLATE_ROUTING=off`.
 */
export function resolveTemplate(pathname: string, templatesDir: string): string | null {
  if (!templateAutoRoutingEnabled()) return null;

  const cleanPath = pathname.replace(/^\/+/, "").replace(/\/+$/, "") || "index";
  const isDev = (process.env.TINA4_DEBUG ?? "false").toLowerCase() === "true";

  if (isDev) {
    // Skip underscore-prefixed files even within pages/ — they're private
    // by Hugo/Jekyll convention (helpers, fragments) and shouldn't auto-serve.
    if (cleanPath.split("/").some((seg) => seg.startsWith("_"))) return null;
    const pagesDir = resolve(templatesDir, TEMPLATE_PAGES_DIR);
    for (const ext of [".twig", ".html"]) {
      if (existsSync(resolve(pagesDir, cleanPath + ext))) {
        return `${TEMPLATE_PAGES_DIR}/${cleanPath}${ext}`;
      }
    }
    return null;
  }

  // Production: cached lookup
  if (!templateCache) {
    templateCache = new Map();
    const pagesDir = resolve(templatesDir, TEMPLATE_PAGES_DIR);
    if (existsSync(pagesDir)) {
      const scan = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          // Skip private files even within pages/ (e.g. pages/_helper.twig)
          if (entry.name.startsWith("_")) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            scan(resolve(dir, entry.name), rel);
          } else if (entry.name.endsWith(".twig") || entry.name.endsWith(".html")) {
            const urlPath = rel.replace(/\.(twig|html)$/, "");
            if (!templateCache!.has(urlPath)) {
              templateCache!.set(urlPath, `${TEMPLATE_PAGES_DIR}/${rel}`);
            }
          }
        }
      };
      scan(pagesDir, "");
    }
  }
  return templateCache.get(cleanPath) ?? null;
}

function renderLandingPage(routes: Array<{ method: string; pattern: string; flags?: string[] }>, port: number = 7148): string {
  const version = TINA4_VERSION;

  const galleryItems = [
    { id: "rest-api", icon: "&#128640;", name: "REST API", desc: "A simple JSON API with GET and POST endpoints", accent: "accent-blue", tryUrl: "/api/gallery/hello" },
    { id: "orm", icon: "&#128451;", name: "ORM", desc: "Product model with CRUD endpoints", accent: "accent-green", tryUrl: "/api/gallery/products" },
    { id: "auth", icon: "&#128274;", name: "Auth", desc: "JWT login form with token display", accent: "accent-purple", tryUrl: "/gallery/auth" },
    { id: "queue", icon: "&#9889;", name: "Queue", desc: "Background job producer and consumer", accent: "accent-blue", tryUrl: "/api/gallery/queue/produce" },
    { id: "templates", icon: "&#128196;", name: "Templates", desc: "Twig template with dynamic data", accent: "accent-green", tryUrl: "/gallery/page" },
    { id: "database", icon: "&#128225;", name: "Database", desc: "Raw SQL queries with the Database class", accent: "accent-purple", tryUrl: "/api/gallery/db/tables" },
    { id: "error-overlay", icon: "&#128165;", name: "Error Overlay", desc: "See the rich debug error page with stack trace", accent: "accent-blue", tryUrl: "/api/gallery/crash" },
  ];

  const deployed = getGalleryDeployedState();

  const galleryCards = galleryItems.map((item) => {
    const isDeployed = deployed[item.id] === true;
    const tryBtn = isDeployed
      ? `<a href="${item.tryUrl}" class="gbtn gbtn-try" target="_blank">Try It</a>`
      : "";
    const viewBtn = isDeployed
      ? `<a href="${item.tryUrl}" class="gbtn gbtn-view" target="_blank">View</a>`
      : "";
    const deployBtn = isDeployed
      ? `<span class="gbtn gbtn-deployed">Deployed</span>`
      : `<button class="gbtn gbtn-deploy" onclick="deployGallery('${item.id}')">Deploy</button>`;
    return `<div class="gallery-card">
            <div class="accent ${item.accent}"></div>
            <div class="icon">${item.icon}</div>
            <h3>${item.name}</h3>
            <p>${item.desc}</p>
            <div class="gallery-actions">${tryBtn}${viewBtn}${deployBtn}</div>
        </div>`;
  }).join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tina4NodeJs</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;position:relative}
.bg-watermark{position:fixed;bottom:-5%;right:-5%;width:45%;opacity:0.04;pointer-events:none;z-index:0}
.hero{text-align:center;z-index:1;padding:3rem 2rem 2rem}
.logo{width:120px;height:120px;margin-bottom:1.5rem}
h1{font-size:3rem;font-weight:700;margin-bottom:0.25rem;letter-spacing:-1px}
.tagline{color:#64748b;font-size:1.1rem;margin-bottom:2rem}
.actions{display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;margin-bottom:2.5rem}
.btn{padding:0.6rem 1.5rem;border-radius:0.5rem;font-size:0.9rem;font-weight:600;cursor:pointer;text-decoration:none;transition:all 0.15s;border:1px solid #334155;color:#94a3b8;background:transparent;min-width:140px;text-align:center;display:inline-block}
.btn:hover{border-color:#64748b;color:#e2e8f0}
.status{display:flex;gap:2rem;justify-content:center;align-items:center;color:#64748b;font-size:0.85rem;margin-bottom:1.5rem}
.status .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:0.4rem}
.footer{color:#334155;font-size:0.8rem;letter-spacing:0.5px}
.section{z-index:1;width:100%;max-width:800px;padding:0 2rem;margin-bottom:2.5rem}
.card{background:#1e293b;border-radius:0.75rem;padding:2rem;border:1px solid #334155}
.card h2{font-size:1.4rem;font-weight:600;margin-bottom:1.25rem;color:#e2e8f0}
.code-block{background:#0f172a;border-radius:0.5rem;padding:1.25rem;overflow-x:auto;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:0.85rem;line-height:1.6;color:#4ade80;border:1px solid #1e293b}
.gallery{z-index:1;width:100%;max-width:800px;padding:0 2rem;margin-bottom:3rem}
.gallery h2{font-size:1.4rem;font-weight:600;margin-bottom:1.25rem;color:#e2e8f0;text-align:center}
.gallery-card{background:#1e293b;border:1px solid #334155;border-radius:0.75rem;padding:1.5rem;position:relative;overflow:hidden}
.gallery-card .accent{position:absolute;top:0;left:0;right:0;height:3px}
.gallery-card .accent-blue{background:#2e7d32}
.gallery-card .accent-green{background:#22c55e}
.gallery-card .accent-purple{background:#a78bfa}
.gallery-card .icon{font-size:1.5rem;margin-bottom:0.75rem}
.gallery-card h3{font-size:1rem;font-weight:600;margin-bottom:0.5rem;color:#e2e8f0}
.gallery-card p{font-size:0.85rem;color:#94a3b8;line-height:1.5;margin-bottom:0.75rem}
.gallery-actions{display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem}
.gbtn{padding:0.35rem 0.75rem;border-radius:0.375rem;font-size:0.75rem;font-weight:600;cursor:pointer;text-decoration:none;border:none;display:inline-block;text-align:center;transition:all 0.15s}
.gbtn-try{background:#22c55e;color:#0f172a}
.gbtn-try:hover{background:#16a34a}
.gbtn-view{background:transparent;border:1px solid #334155;color:#94a3b8}
.gbtn-view:hover{border-color:#64748b;color:#e2e8f0}
.gbtn-deploy{background:#3b82f6;color:#fff}
.gbtn-deploy:hover{background:#2563eb}
.gbtn-deployed{background:transparent;border:1px solid #22c55e;color:#22c55e;cursor:default;font-size:0.7rem}
@keyframes wiggle{0%{transform:rotate(0deg)}15%{transform:rotate(14deg)}30%{transform:rotate(-10deg)}45%{transform:rotate(8deg)}60%{transform:rotate(-4deg)}75%{transform:rotate(2deg)}100%{transform:rotate(0deg)}}
.star-wiggle{display:inline-block;transform-origin:center}
</style>
</head>
<body>
<img src="/images/tina4-logo-icon.webp" class="bg-watermark" alt="">
<div class="hero">
    <img src="/images/tina4-logo-icon.webp" class="logo" alt="Tina4">
    <h1>Tina4NodeJs</h1>
    <p class="tagline">The Intelligent Native Application 4ramework</p>
    <div class="actions">
        <a href="https://tina4.com/nodejs" class="btn" target="_blank">Website</a>
        <a href="/__dev" class="btn">Dev Admin</a>
        <a href="#gallery" class="btn">Gallery</a>
        <a href="https://github.com/tina4stack/tina4-nodejs" class="btn" target="_blank">GitHub</a>
        <a href="https://github.com/tina4stack/tina4-nodejs/stargazers" class="btn" target="_blank"><span class="star-wiggle">&#9734;</span> Star</a>
    </div>
    <div class="status">
        <span><span class="dot"></span>Server running</span>
        <span>Port ${port}</span>
        <span>v${version}</span>
    </div>
    <p class="footer">Zero dependencies &middot; Convention over configuration</p>
</div>
<div class="section">
    <div class="card">
        <h2>Getting Started</h2>
        <pre class="code-block"><code><span style="color:#64748b">// app.ts</span>
<span style="color:#c084fc">import</span> { startServer, Router } <span style="color:#c084fc">from</span> <span style="color:#4ade80">"tina4-nodejs"</span>;

Router.get(<span style="color:#4ade80">"/hello"</span>, <span style="color:#c084fc">async</span> (<span style="color:#38bdf8">req</span>, <span style="color:#38bdf8">res</span>) =&gt; {
    <span style="color:#c084fc">return</span> res.json({ message: <span style="color:#4ade80">"Hello World!"</span> });
});

startServer({ port: 7148 });  <span style="color:#64748b">// starts on port 7148</span></code></pre>
    </div>
</div>
<div class="gallery">
    <h2 id="gallery">What You Can Build</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;">
        ${galleryCards}
    </div>
</div>
<script>
function deployGallery(name) {
    if (!confirm('Deploy the "' + name + '" gallery example into your project? This will copy files into src/.')) return;
    fetch('/__dev/api/gallery/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
        if (d.error) {
            alert('Deploy failed: ' + d.error);
        } else {
            // Brief delay to allow newly deployed routes to register before reloading
            setTimeout(function() {
                window.location.reload();
            }, 500);
        }
    })
    .catch(function(e) { alert('Deploy error: ' + e.message); });
}
(function(){
    var star=document.querySelector('.star-wiggle');
    if(!star)return;
    function doWiggle(){
        star.style.animation='wiggle 1.2s ease-in-out';
        star.addEventListener('animationend',function onEnd(){
            star.removeEventListener('animationend',onEnd);
            star.style.animation='none';
            var delay=3000+Math.random()*15000;
            setTimeout(doWiggle,delay);
        });
    }
    setTimeout(doWiggle,3000);
})();
</script>
</body>
</html>`;
}

// Module-level dispatch function — assigned when startServer() is called.
// Allows handle() to route requests without requiring a reference to the server.
let _dispatchFn: ((rawReq: IncomingMessage, rawRes: ServerResponse) => Promise<void>) | null = null;

// Lazily-resolved Database.resetRequestCaches binding (or null if the ORM is
// not installed). Memoised so the dynamic import happens once, then every
// request reuses the resolved function — see the request-scoped cache boundary
// in dispatch().
let _resetRequestCaches: Promise<(() => void) | null> | undefined;

/** Module-level server handle for start()/stop() parity. */
let _serverHandle: { close: () => void; router: Router; port: number } | null = null;

/**
 * Start the Tina4 HTTP server.
 * Thin wrapper around startServer() for cross-framework parity with PHP and Ruby.
 */
export async function start(config?: Tina4Config): Promise<{ close: () => void; router: Router; port: number }> {
  const isManaged = process.argv.includes('--managed');
  if (!isManaged && process.env.TINA4_OVERRIDE_CLIENT !== 'true') {
    console.log();
    console.log('='.repeat(60));
    console.log();
    console.log('  Tina4 must be started with the tina4 CLI:');
    console.log();
    console.log('    tina4 serve              (development)');
    console.log('    tina4 serve --production (production)');
    console.log();
    console.log('  Install: cargo install tina4');
    console.log('  Docs:    https://tina4.com');
    console.log();
    console.log('  To run directly, add to .env:');
    console.log('    TINA4_OVERRIDE_CLIENT=true');
    console.log();
    console.log('='.repeat(60));
    console.log();
    process.exit(1);
  }

  _serverHandle = await startServer(config);
  return _serverHandle;
}

/**
 * Stop the running Tina4 server gracefully.
 */
export function stop(): void {
  if (_serverHandle) {
    _serverHandle.close();
    _serverHandle = null;
  }
}

/**
 * Dispatch a raw Node.js request through the Tina4 router and write the response.
 * Requires startServer() to have been called first.
 * Useful for testing and embedding.
 */
export async function handle(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<void> {
  if (!_dispatchFn) throw new Error("Tina4 server not started — call startServer() first");
  return _dispatchFn(rawReq, rawRes);
}

export async function startServer(config?: Tina4Config): Promise<{
  close: () => void;
  router: Router;
  port: number;
}> {
  // Load env early so TINA4_DEBUG is available for the cluster decision.
  // Precedence MUST be: real environment (set before boot) > .env.local > .env.
  // loadEnv(override=false) is first-wins (only sets a key not already present),
  // so load .env.local BEFORE .env — both with override=false. A real env var
  // set before boot is already present and wins over both; .env.local fills
  // local-only keys; .env fills whatever neither set. Loading .env.local with
  // override=true would let a stray gitignored .env.local clobber an explicitly
  // set real env var (e.g. a production TINA4_SECRET) — never do that.
  loadEnv(".env.local");
  loadEnv();

  // Auto-generate a per-machine dev secret to a gitignored .env.local when one
  // is missing (dev only, never CI/prod). Must run after env load and before
  // any auth use. Local import avoids a load-time cycle through auth.
  const { ensureDevSecret } = await import("./auth.js");
  ensureDevSecret();

  // Refuse to boot with pre-3.12 un-prefixed env vars set.
  _checkLegacyEnvVars();

  const resolved = resolvePortAndHost(config);
  const host = resolved.host;
  let port = resolved.port;

  // Claim the requested port — kill whatever is on it if needed
  port = findAvailablePort(port);

  // Cluster mode for production: fork workers based on CPU count
  // Only when --production is explicitly set (via TINA4_PRODUCTION env var)
  const isProduction = (process.env.TINA4_PRODUCTION ?? "").toLowerCase() === "true";
  if (cluster.isPrimary && isProduction) {
    const numCPUs = os.cpus().length;
    if (numCPUs > 1) {
      const displayHost = host === "0.0.0.0" ? "localhost" : host;
      const isTty = isatty(1);
      const color = isTty ? "\x1b[32m" : "";
      const reset = isTty ? "\x1b[0m" : "";
      const logLevel = (process.env.TINA4_LOG_LEVEL ?? "DEBUG").toUpperCase();

      if (!isBannerSuppressed()) {
        // Only advertise a surface that is actually reachable (issue #99).
        // Cluster mode is the production path: debug is OFF, so /__dev always
        // 404s here and is never advertised; /swagger only when explicitly on.
        // Cluster mode is the production path: debug is OFF, so /__dev never
        // advertises here.
        const [swaggerLine] = bannerSurfaceLines(port, {
          swaggerEnabled: swaggerAdvertised(),
          devAdminEnabled: false,
        });
        console.log(`${color}
  ______ _             __ __
 /_  __/(_)___  ____ _/ // /
  / /  / / __ \\/ __ \`/ // /_
 / /  / / / / / /_/ /__  __/
/_/  /_/_/ /_/\\__,_/  /_/
${reset}
  Tina4 Node.js v${TINA4_VERSION} — The Intelligent Native Application 4ramework

  Server:    http://${displayHost}:${port} (cluster, ${numCPUs} workers)${swaggerLine}
  Debug:     OFF (Log level: ${logLevel})
`);
      }

      for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
      }

      cluster.on("exit", (worker, code, _signal) => {
        if (code !== 0) {
          console.log(`  Worker ${worker.process.pid} exited (code ${code}), restarting...`);
          cluster.fork();
        }
      });

      // Return a handle that kills all workers
      return {
        close: () => {
          stopAllBackgroundTasks();
          for (const id in cluster.workers) {
            cluster.workers[id]?.kill();
          }
        },
        router: new Router(),
        port,
      };
    }
  }

  const base = config?.basePath ? resolve(config.basePath) : process.cwd();
  const routesDir = resolve(base, config?.routesDir ?? "src/routes");
  const modelsDir = resolve(base, config?.modelsDir ?? "src/models");
  const ormDir = resolve(base, "src/orm");
  const staticDir = resolve(base, config?.staticDir ?? "public");
  // src/public is the second-tier static dir (Python parity). When the user
  // ships a Vite/SPA build there, src/public/index.html auto-serves at "/".
  const srcPublicDir = resolve(base, "src/public");
  const templatesDir = resolve(base, config?.templatesDir ?? "src/templates");

  // .env already loaded above for cluster decision

  const router = new Router();
  const middleware = new MiddlewareChain();

  // Expose the active server router globally so dev tools (e.g. the MCP
  // route_list tool) can introspect the real, fully-populated route table —
  // startServer builds a fresh Router rather than using defaultRouter, so
  // file-discovered routes only live here. Mirrors the globalThis.__tina4_db
  // hook other dev tools read.
  (globalThis as any).__tina4_router = router;

  // Merge routes registered via top-level get(), post(), etc.
  for (const route of defaultRouter.getRoutes()) {
    router.addRoute(route);
  }

  // Register health check endpoint(s). createHealthRoutes returns both the
  // env-configured path (default /__health) and a /health legacy alias.
  for (const healthRoute of createHealthRoutes(TINA4_VERSION)) {
    router.addRoute(healthRoute);
  }

  // Initialize Frond template engine
  let frondEngine: any = null;
  setDefaultTemplatesDir(templatesDir);
  try {
    const { Frond } = await import("../../frond/src/engine.js");
    frondEngine = new Frond(templatesDir);

    // Always-on Frond {% live %} refresh endpoint. Re-renders a server-rendered
    // live block on demand (poll / sse), re-running its provider with the live
    // request so auth re-applies. Parity with Python/PHP/Ruby /__frond/live/{name}.
    router.addRoute({
      method: "GET",
      pattern: "/__frond/live/{name}",
      handler: (req: any, res: any) => {
        const { status, body } = Frond.respondLive(req, String(req.params?.name ?? ""));
        return res.html(body, status);
      },
      meta: {
        summary: "Frond live block refresh",
        description: "Re-render a server-rendered {% live %} block by name.",
        tags: ["System"],
      },
    });

    // Wire the WebSocket broadcaster so Frond.pushLive can push live-block
    // updates to connected clients (best-effort). Broadcasts to the block's
    // declared data-ws path, else falls back to a path named after the block.
    Frond.setLiveBroadcaster((wsPath: string | null, name: string, envelope: string) => {
      wsRouteManager.broadcastPath(wsPath || name, envelope);
    });
  } catch {
    // Frond not available
  }

  // Auto-wire i18n → template global t() when locale files exist
  if (frondEngine) {
    const localeDir = resolve(base, process.env.TINA4_LOCALE_DIR ?? "src/locales");
    if (existsSync(localeDir)) {
      try {
        const localeFiles = readdirSync(localeDir).filter((f: string) => f.endsWith(".json"));
        if (localeFiles.length > 0 && !frondEngine.globals?.t) {
          const i18nInstance = new I18n(process.env.TINA4_LOCALE ?? "en", localeDir);
          frondEngine.addGlobal("t", (key: string, params?: Record<string, string>) => i18nInstance.t(key, params));
        }
      } catch {
        // Locale directory unreadable — skip auto-wire
      }
    }
  }

  // Built-in middleware
  middleware.use(cors());
  middleware.use(requestLogger());
  middleware.use(rateLimiter());

  // Discover file-based routes
  if (existsSync(routesDir)) {
    const routes = await discoverRoutes(routesDir);
    for (const route of routes) {
      router.addRoute(route);
    }
    console.log(`\n  Routes discovered:`);
    for (const route of routes) {
      console.log(`    \x1b[36m${route.method.padEnd(7)}\x1b[0m ${route.pattern}`);
    }
  } else {
    console.log(`\n  No routes directory found at ${routesDir}`);
  }

  // Initialize ORM if models directory exists (check src/orm/ first, then src/models/)
  const hasOrmDir = existsSync(ormDir);
  const hasModelsDir = existsSync(modelsDir);
  if (hasOrmDir || hasModelsDir) {
    try {
      const orm = await import("../../orm/src/index.js");
      const dbConfig = config?.database ?? {};
      await orm.initDatabase({
        type: dbConfig.type ?? "sqlite",
        path: dbConfig.path ?? "./data/tina4.db",
      });

      // Discover from src/orm/ (primary) and src/models/ (fallback), merge results
      let models = hasOrmDir ? await orm.discoverModels(ormDir) : [];
      if (hasModelsDir) {
        const extraModels = await orm.discoverModels(modelsDir);
        // Only add models not already discovered (src/orm/ takes priority)
        const existingTables = new Set(models.map((m: any) => m.definition.tableName));
        for (const m of extraModels) {
          if (!existingTables.has(m.definition.tableName)) {
            models.push(m);
          }
        }
      }
      if (models.length > 0) {
        console.log(`\n  Models discovered:`);
        await orm.syncModels(models);
        for (const { definition } of models) {
          console.log(`    \x1b[35m${definition.tableName}\x1b[0m (${Object.keys(definition.fields).length} fields)`);
        }

        // Generate auto-CRUD routes ONLY for models that explicitly opted in via
        // `static autoCrud = true` (the documented opt-in gate; default false). The
        // server previously generated the 5 CRUD endpoints for every discovered model
        // regardless of the flag, contradicting the documented contract. (Python's
        // AutoCrud is opt-in too — via an explicit AutoCrud.register/discover call.)
        const crudModels = orm.crudEligibleModels(models);
        const crudRoutes = crudModels.length > 0 ? orm.generateCrudRoutes(crudModels) : [];
        for (const route of crudRoutes) {
          // Only add if no file-based route already handles this
          const existing = router.match(route.method, route.pattern.replace(/\{(\w+)\}/g, "test").replace(/\[(\w+)\]/g, "test"));
          if (!existing) {
            router.addRoute(route);
          }
        }

        if (crudRoutes.length > 0) {
          console.log(`\n  Auto-CRUD endpoints:`);
          for (const route of crudRoutes) {
            console.log(`    \x1b[33m${route.method.padEnd(7)}\x1b[0m ${route.pattern}`);
          }
        }
      }
    } catch (err) {
      console.warn(`\n  ORM not available (install @tina4/orm to enable):`, err);
    }

    // Auto-run pending migrations on startup — AFTER initDatabase()/model sync,
    // BEFORE the server listens. Non-breaking: a failure is logged and boot
    // continues (the helper never throws). Gated on a migrations/ dir + the
    // TINA4_AUTO_MIGRATE flag (default on) + a resolvable DB adapter.
    await autoMigrateOnStartup("migrations", base);
  }

  // Initialize Swagger — gated on TINA4_SWAGGER_ENABLED (default: enabled
  // in debug mode, off in production). Loading the swagger module also
  // pulls in route discovery for the generator, so skip the import entirely
  // when disabled.
  try {
    const swagger = await import("../../swagger/src/index.js");
    // Single source of truth for BOTH the gated routes and the bundled
    // public/swagger assets (which static serving would otherwise expose).
    swaggerAssetsEnabled = swagger.swaggerEnabled();
    if (!swaggerAssetsEnabled) {
      // Skip the rest of the swagger block when disabled.
      throw new Error("__swagger_disabled__");
    }
    const allRoutes = router.getRoutes();

    // Collect model definitions for schema generation
    let modelDefs: Array<{ tableName: string; fields: Record<string, unknown> }> = [];
    try {
      const orm = await import("../../orm/src/index.js");
      const allModelDirs = [ormDir, modelsDir].filter((d) => existsSync(d));
      const seenTables = new Set<string>();
      for (const dir of allModelDirs) {
        const discovered = await orm.discoverModels(dir);
        for (const m of discovered) {
          if (!seenTables.has(m.definition.tableName)) {
            modelDefs.push(m.definition);
            seenTables.add(m.definition.tableName);
          }
        }
      }
    } catch {
      // ORM not available, swagger will work without model schemas
    }

    const getSpec = () => swagger.generate(allRoutes, modelDefs as any);
    const swaggerRoutes = swagger.createSwaggerRoutes(getSpec);
    for (const route of swaggerRoutes) {
      router.addRoute(route);
    }
  } catch {
    // Swagger not available
  }

  // Register dev admin dashboard routes
  if (DevAdmin.isEnabled()) {
    DevAdmin.register(router);
    console.log(`  Dev dashboard at  \x1b[36mhttp://localhost:${port}/__dev\x1b[0m`);
    // Live Docs MCP discovery — write .tina4/mcp.json so AI tools find this server.
    try {
      const { writeMcpDiscovery } = await import("./docsAutoDiscovery.js");
      writeMcpDiscovery(process.cwd(), Number(port));
    } catch (e) {
      console.log(`  (mcp discovery skipped: ${(e as Error).message})`);
    }
  }

  async function dispatch(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<void> {
    const req = createRequest(rawReq);
    const res = createResponse(rawRes);

    // Request-scoped DB query cache boundary: clear the request-scoped cache on
    // every live connection at the START of each request so it never serves
    // rows across requests (persistent-mode connections are left alone). The
    // ORM is loaded lazily and may be absent — failures here must never break a
    // request, so this is best-effort. Mirrors Python's dispatcher calling
    // Database.reset_request_caches(). The cached() promise resolves once on
    // first use; subsequent requests reuse the resolved module.
    if (_resetRequestCaches === undefined) {
      _resetRequestCaches = import("../../orm/src/index.js")
        .then((orm) => orm.resetRequestCaches as () => void)
        .catch(() => null);
    }
    try {
      const reset = await _resetRequestCaches;
      if (reset) reset();
    } catch {
      /* ORM not installed / cache unavailable — non-fatal */
    }

    // RFC 9110 §9.3.2: the server MUST NOT send content in a HEAD response.
    // Intercept rawRes.write / rawRes.end so every code path — explicit
    // Router.head() handler, GET auto-fallback, 405 / 404 responses — drops
    // its body. Content-Length is preserved when present, so cache
    // validators / link checkers / monitoring probes still see the size
    // the equivalent GET would have sent.
    if ((rawReq.method ?? "GET").toUpperCase() === "HEAD") {
      const origEnd = rawRes.end.bind(rawRes);
      const origWrite = rawRes.write.bind(rawRes);
      let accumulated = 0;
      rawRes.write = ((chunk?: any, _enc?: any, cb?: any): boolean => {
        if (chunk != null) {
          accumulated += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        }
        if (typeof cb === "function") cb();
        return true;
      }) as typeof rawRes.write;
      rawRes.end = ((chunk?: any, _enc?: any, cb?: any): any => {
        if (chunk != null && typeof chunk !== "function") {
          accumulated += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        }
        if (accumulated > 0 && !rawRes.headersSent && !rawRes.hasHeader("Content-Length")) {
          rawRes.setHeader("Content-Length", String(accumulated));
        }
        const realCb = typeof chunk === "function" ? chunk : cb;
        void origWrite; // referenced to keep tsc happy
        return typeof realCb === "function" ? origEnd(realCb) : origEnd();
      }) as typeof rawRes.end;
    }

    // Auto-start session — read cookie, create session, save + set cookie on response end
    {
      const { Session, buildSessionCookie, sessionCookieName } = await import("./session.js");
      const cookieHeader = rawReq.headers.cookie ?? "";
      // Read the incoming session cookie by the SAME configured name the write
      // side emits (TINA4_SESSION_NAME, default tina4_session) via the shared
      // sessionCookieName() resolver — otherwise a renamed cookie would be
      // written but never read back and the session would silently never
      // resume. Match a whole cookie pair by its exact `name=` prefix (split on
      // ";", trim, startsWith) so `tina4_session` never matches
      // `tina4_session_foo=` nor a value mid-header. Parity with Python
      // core/server._init_session.
      const cookiePrefix = sessionCookieName() + "=";
      let existingSid: string | undefined;
      for (const part of cookieHeader.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith(cookiePrefix)) {
          existingSid = trimmed.slice(cookiePrefix.length);
          break;
        }
      }
      const sess = new Session();
      sess.start(existingSid);
      (req as any).session = sess;

      const origEnd = rawRes.end.bind(rawRes);
      rawRes.end = function (...args: any[]) {
        sess.save();

        // Probabilistic garbage collection (~1% of requests)
        if (Math.floor(Math.random() * 100) === 0) {
          try { sess.gc(); } catch { /* GC failure is non-critical */ }
        }

        const newSid = (sess as any).sessionId ?? (sess as any).getSessionId?.();
        if (newSid && newSid !== existingSid && !rawRes.headersSent) {
          const ttl = parseInt(process.env.TINA4_SESSION_TTL ?? "3600", 10);
          // Thread the client's real scheme in so an HTTPS deploy behind a
          // TLS-terminating proxy ships the session cookie with `Secure`
          // (nodejs#34). `x-forwarded-proto` is the same header request.ts
          // trusts for URL construction; native socket TLS is the fallback.
          const xfProto = rawReq.headers["x-forwarded-proto"];
          const forwardedProto = Array.isArray(xfProto) ? xfProto[0] : xfProto;
          const socketEncrypted = (rawReq.socket as { encrypted?: boolean })?.encrypted === true;
          rawRes.setHeader("Set-Cookie", buildSessionCookie(newSid, ttl, undefined, forwardedProto, socketEncrypted));
        }
        return origEnd(...args);
      } as typeof rawRes.end;
    }

    // res.render() is handled natively by response.ts via Frond

    try {
      // Run middleware chain
      await middleware.run(req, res);
      if (res.raw.writableEnded) return;

      // Parse request body
      await req.parseBody();

      const pathname = req.path;

      // Track request start time for dev inspector
      const reqStartTime = DevAdmin.isEnabled() ? Date.now() : 0;

      // Mutable ref so wrappedEnd can read the matched pattern after route matching
      let matchedPattern = "";
      const requestId = Date.now().toString(36);

      // Wrap res.raw.end to inject dev toolbar and capture requests
      // Skip toolbar injection on the AI port (no-reload behaviour)
      const isAiPortRequest = !!(rawReq as any)._tina4AiPort;

      // AI port: block /__dev_reload so AI tools never trigger a browser reload
      if (isAiPortRequest && pathname === "/__dev_reload") {
        res.raw.writeHead(404, { "Content-Type": "application/json" });
        res.raw.end(JSON.stringify({ error: "Not available on AI port" }));
        return;
      }

      if (isDevMode() && !pathname.startsWith("/__dev") && !isAiPortRequest) {
        const originalEnd = res.raw.end.bind(res.raw);

        const wrappedEnd: typeof res.raw.end = function (
          chunk?: unknown,
          encodingOrCb?: BufferEncoding | (() => void),
          cb?: () => void,
        ) {
          // Capture request for dev inspector
          if (reqStartTime > 0) {
            const duration = Date.now() - reqStartTime;
            const status = res.raw.statusCode ?? 200;
            RequestInspector.capture(req.method ?? "GET", pathname, status, duration);
          }

          const contentType = res.raw.getHeader("content-type");
          if (typeof contentType === "string" && contentType.includes("text/html")) {
            const toolbarCtx: DevToolbarContext = {
              version: TINA4_VERSION,
              method: req.method ?? "GET",
              path: pathname,
              matchedPattern: matchedPattern || pathname,
              requestId,
              routeCount: router.getRoutes().length,
            };
            if (typeof chunk === "string") {
              chunk = injectDevToolbar(chunk, toolbarCtx);
              chunk = injectFeedbackWidget(req, chunk as string);
            } else if (Buffer.isBuffer(chunk)) {
              const html = chunk.toString("utf-8");
              chunk = injectFeedbackWidget(req, injectDevToolbar(html, toolbarCtx));
            }
            // Remove content-length since toolbar injection changes body size
            if (!res.raw.headersSent) {
              res.raw.removeHeader("content-length");
            }
          }
          if (typeof encodingOrCb === "function") {
            return originalEnd(chunk, encodingOrCb);
          }
          if (encodingOrCb !== undefined) {
            return originalEnd(chunk, encodingOrCb, cb);
          }
          return originalEnd(chunk, cb);
        };
        res.raw.end = wrappedEnd;
      } else if (
        feedbackEnabled() &&
        !pathname.startsWith("/__dev") &&
        !pathname.startsWith("/__feedback")
      ) {
        // Production / non-dev path: still inject the feedback widget for
        // whitelisted users. The injector itself re-checks the whitelist,
        // path, and html marker so the wrapper is cheap when it no-ops.
        const originalEnd = res.raw.end.bind(res.raw);
        const wrappedEnd: typeof res.raw.end = function (
          chunk?: unknown,
          encodingOrCb?: BufferEncoding | (() => void),
          cb?: () => void,
        ) {
          const contentType = res.raw.getHeader("content-type");
          if (
            typeof contentType === "string" &&
            contentType.includes("text/html")
          ) {
            if (typeof chunk === "string") {
              chunk = injectFeedbackWidget(req, chunk);
            } else if (Buffer.isBuffer(chunk)) {
              chunk = injectFeedbackWidget(req, chunk.toString("utf-8"));
            }
            if (!res.raw.headersSent) {
              res.raw.removeHeader("content-length");
            }
          }
          if (typeof encodingOrCb === "function") {
            return originalEnd(chunk, encodingOrCb);
          }
          if (encodingOrCb !== undefined) {
            return originalEnd(chunk, encodingOrCb, cb);
          }
          return originalEnd(chunk, cb);
        };
        res.raw.end = wrappedEnd;
      }

      // PRE-MATCH global middleware: runs before a route is even looked up, so
      // CORS and anything else that must survive a short-circuit can set
      // headers that outlive a 401/403. Opt in with `static preMatch = true`.
      const allGlobalMiddleware = [
        ...new Set([...Router.getClassMiddlewares(), ...MiddlewareRunner.getGlobal()]),
      ];
      const { pre: preMatchMiddleware, post: postMatchMiddleware } =
        MiddlewareRunner.partitionByMatchPhase(allGlobalMiddleware);

      if (preMatchMiddleware.length > 0) {
        const [, , proceed] = await MiddlewareRunner.runBefore(preMatchMiddleware, req, res);
        if (!proceed || res.raw.writableEnded) {
          await MiddlewareRunner.runAfter(preMatchMiddleware, req, res);
          if (!res.raw.writableEnded) res.raw.end();
          return;
        }
      }

      // Match route. ROUTES BEAT FILES (ADR-0010): static assets resolve in
      // the not-found fallback below, only once no route has claimed the path.
      // A file in public/ can arrive from a build step, an upload directory or
      // a careless deploy, and it must never silently shadow a reviewed route.
      const match = router.match(req.method ?? "GET", pathname);
      if (match) {
        req.params = match.params;
        matchedPattern = match.pattern;

        // Global class-based middleware registered via Router.use(...) /
        // MiddlewareRunner.use(...) — run the beforeX hooks before the handler.
        // beforeX may set response headers (they persist through the handler's
        // write), mutate the request, or short-circuit on a >= 400 status.
        // (Parity with Python/PHP/Ruby, whose Router.use class middleware runs.)
        // POST-MATCH global middleware: the default. It runs here, after the
        // route matched, because middleware like CSRF reads the matched route's
        // metadata to honour noAuth. The pre-match set already ran above.
        const globalMiddleware = postMatchMiddleware;
        if (globalMiddleware.length > 0) {
          const [, , proceed] = await MiddlewareRunner.runBefore(globalMiddleware, req, res);
          if (!proceed || res.raw.writableEnded) {
            // AFTER-ON-4xx RULE (M2): after_* ALWAYS run even when a before_*
            // short-circuited (4xx / clean 500 / response ended), so they can
            // still add headers / logging. Run them, then stop the handler.
            await MiddlewareRunner.runAfter(globalMiddleware, req, res);
            if (!res.raw.writableEnded) res.raw.end();
            return;
          }
        }

        // Auth enforcement: secure routes require a valid token. Extracted into
        // enforceRouteAuth (authGate.ts) so the in-process TestClient enforces
        // the EXACT same gate (parity with Python #PY2 — a tokenless write must
        // 401 in tests too, or a green test hides a live 401). Dev admin routes
        // (/__dev) are always public. Returns true when a 401 was written.
        //
        // Order: post-match globals -> THIS GATE -> the route's own middleware.
        //
        // The globals run BEFORE the gate so a rate limiter can throttle a
        // brute-force login and an access log records the 401 - neither is
        // possible if they only run on authenticated requests (Django enforces
        // in a view decorator after all MIDDLEWARE; Laravel's `web` group runs
        // before the `auth` route middleware; ASP.NET puts UseAuthorization
        // last before the endpoint).
        //
        // The route's OWN middleware runs AFTER, so middleware attached to a
        // secured route never processes an unauthenticated request - Node used
        // to run it first, which meant a body-parsing or audit middleware on a
        // secured route saw traffic that was about to be rejected. Laravel
        // orders `->middleware(['auth', ...])` the same way; Django puts
        // @login_required outermost. Aligned across all four (ADR-0012).
        const isDevAdmin = pathname.startsWith("/__dev");
        if (enforceRouteAuth(req, res, match, isDevAdmin)) {
          return;
        }

        // Run per-route middlewares if any
        if (match.middlewares && match.middlewares.length > 0) {
          const proceed = await runRouteMiddlewares(match.middlewares, req, res);
          if (!proceed || res.raw.writableEnded) return;
        }

        // Inject path params by name into handler arguments, then request/response
        let result: unknown;
        const routeParams = req.params || {};
        const fnStr = match.handler.toString();
        const argMatch = fnStr.match(/^(?:async\s*)?(?:function\s*\w*)?\s*\(([^)]*)\)/);
        const argNames = argMatch?.[1]?.split(",").map((s: string) => s.trim().replace(/[:=].*/,"")) ?? [];
        const filteredArgs = argNames.filter((n: string) => n.length > 0);

        if (filteredArgs.length === 0) {
          result = await (match.handler as any)();
        } else {
          const args = filteredArgs.map((name: string) => {
            if (name in routeParams) return routeParams[name];
            if (name === "request" || name === "req") return req;
            return res;
          });
          result = await (match.handler as any)(...args);
        }

        // If the route exports a template and the handler returned a plain object,
        // render it through the template engine instead of sending as JSON.
        if (
          !res.raw.writableEnded &&
          match.template &&
          result !== null &&
          result !== undefined &&
          typeof result === "object" &&
          !Buffer.isBuffer(result)
        ) {
          await res.render(match.template, result as Record<string, unknown>);
        }

        // Global class-based middleware afterX hooks (logging / post-processing).
        // Header mutations here are no-ops once the response is flushed (Node
        // sends headers with the body) — set response headers in beforeX.
        if (globalMiddleware.length > 0) {
          await MiddlewareRunner.runAfter(globalMiddleware, req, res);
        }

        if (!res.raw.writableEnded) {
          res.raw.end();
        }
        return;
      }

      // Try serving a template file (e.g. /hello -> src/templates/pages/hello.twig)
      if ((req.method ?? "GET") === "GET") {
        const tplFile = resolveTemplate(pathname, templatesDir);
        if (tplFile) {
          // Render through Frond so {% include %} / {% extends %} work,
          // not raw readFileSync.
          if (frondEngine) {
            const html = frondEngine.render(tplFile, {});
            res.raw.writeHead(200, undefined, { "Content-Type": "text/html; charset=utf-8" });
            res.raw.end(html);
          } else {
            const html = readFileSync(resolve(templatesDir, tplFile), "utf-8");
            res.raw.writeHead(200, undefined, { "Content-Type": "text/html; charset=utf-8" });
            res.raw.end(html);
          }
          return;
        }

        // Landing page renders only at "/" AND only when TINA4_DEBUG=true.
        // In production "/" with no static index.html and no pages/index.twig
        // falls through to a clean 404 — the framework's branded welcome,
        // gallery and version never leak to real users.
        if (pathname === "/" && isDevMode()) {
          const allRoutes = router.getRoutes().map((r) => ({
            method: r.method,
            pattern: r.pattern,
            flags: [] as string[],
          }));
          const html = renderLandingPage(allRoutes, port);
          res.raw.writeHead(200, undefined, { "Content-Type": "text/html; charset=utf-8" });
          res.raw.end(html);
          return;
        }
      }

      // RFC 9110 conformance — before falling through to 404, check whether
      // the PATH is registered under any OTHER method.
      //   - OPTIONS request → 204 with Allow header (§9.3.7)
      //   - Any other method (PUT on GET-only, TRACE, CONNECT, etc.)
      //     → 405 with Allow header (§15.5.6 + §10.2.1)
      const allowedMethods = router.methodsAllowedForPath(pathname);
      if (allowedMethods.length > 0) {
        const allowHeader = allowedMethods.join(", ");
        const requestMethod = (req.method ?? "GET").toUpperCase();
        if (requestMethod === "OPTIONS") {
          res.raw.writeHead(204, undefined, { Allow: allowHeader, "Content-Length": "0" });
          res.raw.end();
          return;
        }
        const body = JSON.stringify({
          error: "Method Not Allowed",
          path: pathname,
          method: requestMethod,
          allow: allowedMethods,
          statusCode: 405,
        });
        res.raw.writeHead(405, httpReason(405), {
          Allow: allowHeader,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        });
        res.raw.end(body);
        return;
      }

      // No route claimed the path. NOW try the filesystem, per ADR-0010.
      // Index resolution: "/" or "/foo/" picks up index.html so SPA builds Just Work.
      if (existsSync(staticDir) && tryServeStatic(staticDir, req, res)) {
        return;
      }
      if (existsSync(srcPublicDir) && tryServeStatic(srcPublicDir, req, res)) {
        return;
      }
      // Framework-bundled assets. The Swagger UI lives here (public/swagger/),
      // so this path MUST honour the swagger gate or /swagger is served in
      // production regardless of TINA4_SWAGGER_ENABLED / TINA4_DEBUG.
      if (swaggerAssetsEnabled || !isSwaggerAssetPath(pathname)) {
        if (tryServeStatic(BUILTIN_PUBLIC_DIR, req, res)) {
          return;
        }
      }

      // 404 — pass canonical reason phrase so the status line is well-formed
      const html404 = await renderErrorPage(404, { path: pathname }, templatesDir);
      if (html404) {
        res.raw.writeHead(404, httpReason(404), { "Content-Type": "text/html; charset=utf-8" });
        res.raw.end(html404);
      } else {
        res({ error: "Not Found", statusCode: 404, message: `No route found for ${req.method} ${pathname}` }, 404);
      }
    } catch (err) {
      // v3.13.7: log structured + surface to observability BEFORE rendering.
      // Listeners get the canonical {exception, request} payload mirrored
      // by Python / PHP / Ruby. Listener errors are swallowed + warning-
      // logged so a broken listener can't break the 500 page.
      Log.error(`Route error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`, {
        method: req?.method,
        path: req?.path,
      });
      try {
        const { Events } = await import("./events.js");
        Events.emit("tina4.request.error", { exception: err, request: req });
      } catch (listenerErr) {
        try {
          Log.warn(
            `Listener for tina4.request.error raised: ${
              listenerErr instanceof Error
                ? `${listenerErr.name}: ${listenerErr.message}`
                : String(listenerErr)
            }`
          );
        } catch {
          // Log failures must never block the 500 render.
        }
      }

      if (!res.raw.writableEnded) {
        if (isDevMode() && err instanceof Error) {
          // Rich error overlay with stack trace, source context, and line numbers
          const { renderErrorOverlay } = await import("./errorOverlay.js");
          const overlayHtml = renderErrorOverlay(err, req);
          res.raw.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.raw.end(overlayHtml);
        } else {
          // v3.13.7 SECURITY (CWE-209): production response body must NOT
          // contain the stack trace or exception message. Pass an empty
          // error_message — the 500.twig template only renders the trace
          // block when error_message is truthy.
          const html500 = await renderErrorPage(500, {
            error_message: "",
            request_id: `${Date.now().toString(36)}`,
            path: req.path,
          }, templatesDir);
          if (html500) {
            res.raw.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.raw.end(html500);
          } else {
            res({ error: "Internal Server Error", statusCode: 500 }, 500);
          }
        }
      }
    }
  }

  // Assign to module-level so handle() can dispatch without a server reference
  _dispatchFn = dispatch;

  // Dual-port (debug + no TINA4_NO_AI_PORT): the MAIN port hot-reloads for the human
  // dev; the stable AI port (port+1000, created below) suppresses reload/toolbar so an
  // AI tool can drive it without its own edits triggering refreshes. The tina4 client
  // posts /__dev/api/reload to the MAIN port. Matches Python (master).
  const server = createServer(dispatch);

  // WebSocket upgrade handling on the MAIN port. Two responsibilities:
  //
  //  1. WebSocket-primary DevReload (debug only): accept and hold /__dev_reload
  //     upgrades so POST /__dev/api/reload can push an instant reload. Mirrors
  //     Python's _register_dev_reload_ws + _ws_manager.broadcast(path=…).
  //
  //  2. USER WS ROUTES (always): a route registered via Router.websocket() /
  //     WebSocketServer.route() is dispatched to a live open/message/close
  //     lifecycle on the real connection — parity with Python/PHP/Ruby. Per-route
  //     auth is enforced here on the upgrade (serveWebSocketRoute): a @secured /
  //     .secure() route rejects a missing/invalid JWT before accepting; public
  //     routes pass. Previously the integrated server only handled /__dev_reload,
  //     so user WS routes never reached a live connection.
  //
  // Tracking goes through WsTracker so connections show in the dev-admin list.
  if (isDevMode()) {
    devReloadWs.setTracker(
      (remoteAddress, p) => WsTracker.add(remoteAddress, p),
      (id) => { WsTracker.remove(id); },
    );
    wsRouteManager.setTracker(
      (remoteAddress, p) => WsTracker.add(remoteAddress, p),
      (id) => { WsTracker.remove(id); },
    );
  }
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const upPath = (req.url ?? "/").split("?")[0];
    // Dev-reload channel (debug only).
    if (isDevMode() && upPath === "/__dev_reload") {
      devReloadWs.handleUpgrade(req, socket, head);
      return;
    }
    // User-registered WS route — enforces per-route auth, then drives the
    // open/message/close lifecycle on this connection. Returns false only when
    // no WS route matches this path.
    if (serveWebSocketRoute(req, socket, head)) {
      return;
    }
    // No dev-reload and no matching user route — refuse cleanly.
    try {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    } catch {
      /* socket already gone */
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      const displayHost = host === "0.0.0.0" ? "localhost" : host;
      const isDebug = isTruthy(process.env.TINA4_DEBUG);
      const logLevel = (process.env.TINA4_LOG_LEVEL ?? "DEBUG").toUpperCase();

      // Green color for Node.js, only when stdout is a TTY
      const isTty = isatty(1);
      const color = isTty ? "\x1b[32m" : "";
      const reset = isTty ? "\x1b[0m" : "";

      // Determine server mode label
      const serverMode = isDebug ? "single" : (cluster.isWorker ? "cluster-worker" : "single");

      // AI dual-port: main port = hot-reload (human dev); port+1000 = stable AI port
      // (reload/toolbar suppressed) so an AI tool can drive it without its edits
      // triggering refreshes. The tina4 client fires reloads at the MAIN port. Matches Python.
      const noAiPort = isTruthy(process.env.TINA4_NO_AI_PORT ?? "");
      let aiServer: ReturnType<typeof createServer> | null = null;
      let testPort = port + 1000;

      if (isDebug && !noAiPort) {
        // Stable AI port (port+1000): tag requests so /__dev_reload + toolbar are suppressed.
        aiServer = createServer(async (req, res) => {
          (req as any)._tina4AiPort = true;
          await dispatch(req, res);
        });

        // Stable AI port never accepts /__dev_reload (or any) WS upgrade — an AI
        // tool driving it must never get a reload channel that its own edits trip.
        aiServer.on("upgrade", (_req: IncomingMessage, socket) => {
          try {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
          } catch {
            /* socket already gone */
          }
        });

        aiServer.on("error", (err: any) => {
          if (err.code === "EADDRINUSE") {
            Log.warn(`Test port ${testPort} in use — skipping`);
            aiServer = null;
          }
        });

        aiServer.listen(testPort, host);
      }

      // Banner goes to stdout via console.log — NOT through the framework logger
      const dualPortLines = (isDebug && !noAiPort)
        ? `\n  Test Port: http://localhost:${testPort} (stable — no hot-reload)`
        : "";

      if (!isBannerSuppressed()) {
        // Only advertise a surface that is actually reachable (issue #99). With
        // debug off / in production these endpoints 404, and printing a dead URL
        // both misleads an operator into believing a dev surface is exposed and
        // sends a developer to a 404.
        const [swaggerLine, dashboardLine] = bannerSurfaceLines(port, {
          swaggerEnabled: swaggerAdvertised(),
          devAdminEnabled: isDebug,
        });
        console.log(`${color}
  ______ _             __ __
 /_  __/(_)___  ____ _/ // /
  / /  / / __ \\/ __ \`/ // /_
 / /  / / / / / /_/ /__  __/
/_/  /_/_/ /_/\\__,_/  /_/
${reset}
  Tina4 Node.js v${TINA4_VERSION} — The Intelligent Native Application 4ramework

  Server:    http://${displayHost}:${port} (${serverMode})${swaggerLine}${dashboardLine}
  Debug:     ${isDebug ? "ON" : "OFF"} (Log level: ${logLevel})${dualPortLines}
`);
      }
      const noBrowser = isTruthy(process.env.TINA4_NO_BROWSER);
      if (!noBrowser) {
        // Open the browser on the MAIN port — that's the hot-reload port.
        openBrowser(`http://${displayHost}:${port}`);
      }
      resolvePromise({
        close: () => {
          // Clear any registered background timers so graceful shutdown actually exits.
          stopAllBackgroundTasks();
          if (aiServer) aiServer.close();
          server.close();
          // Close database if ORM was initialized
          import("../../orm/src/index.js").then((orm) => orm.closeDatabase()).catch(() => {});
        },
        router,
        port,
      });
    });
  });
}

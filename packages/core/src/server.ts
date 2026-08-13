import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
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
import {
  takeOverPort,
  isDev as isTakeoverDev,
  noTakeoverOptedOut,
  writePidfile,
  removePidfile,
  TAKEOVER_KILLED,
  TAKEOVER_REFUSALS,
} from "./portTakeover.js";
import { createRequest } from "./request.js";
import {
  resetRequestCaches,
  headStripIntercept,
  compressionEtagIntercept,
  sessionAutoStart,
} from "./dispatchPipeline.js";
import { createResponse, setDefaultTemplatesDir, wantsJson, negotiatedErrorBody } from "./response.js";
import { MiddlewareChain, MiddlewareRunner, cors, requestLogger, isMiddlewareClass, attachCsrfFromEnv, SecurityHeadersMiddleware } from "./middleware.js";
import { tryServeStatic } from "./static.js";
import { loadEnv, isTruthy } from "./dotenv.js";
import { isDebugMode } from "./errorOverlay.js";
import { createHealthRoutes } from "./health.js";
import { rateLimiter } from "./rateLimiter.js";
import { Log } from "./logger.js";
import { DevAdmin, RequestInspector, WsTracker, devMutationDenial, DEV_SAFE_METHODS } from "./devAdmin.js";
import { CLOSE_GOING_AWAY, devReloadWs, serveWebSocketRoute, wsRouteManager } from "./websocket.js";
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

/** How long a graceful shutdown waits for in-flight requests, in seconds. */
export const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 30;

/**
 * Resolve the shutdown budget from `TINA4_SHUTDOWN_TIMEOUT` (seconds).
 *
 * 30s matches Kubernetes' default `terminationGracePeriodSeconds` and
 * Gunicorn's `graceful_timeout`, so the drain finishes just BEFORE the
 * orchestrator's SIGKILL rather than being truncated by it. Same env var and
 * same default as tina4-ruby's `Tina4::Shutdown`.
 *
 * A non-numeric or negative value falls back to the default rather than
 * silently disabling the drain - a typo must not turn shutdown into a
 * zero-second force-kill.
 */
export function shutdownTimeoutSeconds(): number {
  const raw = process.env.TINA4_SHUTDOWN_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_TIMEOUT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    Log.warning(
      `TINA4_SHUTDOWN_TIMEOUT="${raw}" is not a valid number of seconds - using ${DEFAULT_SHUTDOWN_TIMEOUT_SECONDS}`,
    );
    return DEFAULT_SHUTDOWN_TIMEOUT_SECONDS;
  }
  return parsed;
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
/**
 * Reclaim `port` from a stale Tina4 dev server via the shared, guarded path.
 *
 * This is the runtime bind-failure fallback. It used to SIGTERM whatever held
 * the port with NONE of the CLI's guards -- no identity check, no container
 * guard, no PID-safety filter -- so a foreign holder (another dev server, a
 * database) was killed on any bind failure. It now routes through the SAME
 * identity-checked helper the CLI uses (TAKEOVER-DEC-02), so only a
 * PID-file-confirmed Tina4 dev server is ever signalled.
 *
 * Throws when the port is held by a non-Tina4 process (or takeover is opted out
 * / disabled outside dev), so the bind fails loudly with a clear message instead
 * of killing an innocent process.
 */
export function killPort(port: number): void {
  const result = takeOverPort(port, isTakeoverDev(), noTakeoverOptedOut());
  if (result.status === TAKEOVER_KILLED) {
    console.log(`  ${result.message}`);
    return;
  }
  if (TAKEOVER_REFUSALS.includes(result.status)) {
    throw new Error(result.message);
  }
  // NOTHING / container: nothing to reclaim -- let the real bind decide.
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
  // Port: explicit config > TINA4_PORT > PORT (deprecated) > default.
  //
  // This read PORT and nothing else, so TINA4_PORT - the name the CLI
  // documents and prefers, and the one devAdmin.ts itself reads first - was
  // IGNORED on the path that binds the socket. Setting it did nothing and said
  // nothing.
  //
  // Bare PORT stays honoured so no deployment breaks, and warns so the
  // migration happens. Removal is 3.14.
  const tina4Port = process.env.TINA4_PORT;
  const legacyPort = process.env.PORT;
  let port: number;
  if (config?.port !== undefined) {
    port = config.port;
  } else if (tina4Port && /^\d+$/.test(tina4Port)) {
    port = parseInt(tina4Port, 10);
  } else if (legacyPort && /^\d+$/.test(legacyPort)) {
    port = parseInt(legacyPort, 10);
    warnDeprecatedPort(port);
  } else {
    port = 7148;
  }

  // DEVADMIN-DEC-02: in dev/serve mode (TINA4_DEBUG) the /__dev dashboard exposes
  // an unauthenticated file/SQL/RCE surface, so the DEFAULT bind is loopback, not
  // 0.0.0.0. Only the default changes: an explicit config.host / TINA4_HOST / HOST
  // still wins (production passes one and does not set TINA4_DEBUG), so a developer
  // who WANTS network exposure sets TINA4_HOST=0.0.0.0 to override deliberately.
  const defaultHost = isTruthy(process.env.TINA4_DEBUG) ? "127.0.0.1" : "0.0.0.0";
  const host = config?.host
    ?? process.env.TINA4_HOST
    ?? process.env.HOST
    ?? defaultHost;
  return { port, host };
}

/**
 * Warn ONCE that bare PORT was used instead of TINA4_PORT.
 *
 * Once, because resolvePortAndHost can be called more than once per process
 * and a warning repeated on every call is a warning people filter out.
 */
let portDeprecationWarned = false;
function warnDeprecatedPort(port: number): void {
  if (portDeprecationWarned) return;
  portDeprecationWarned = true;
  Log.warning(
    `PORT is deprecated and will be removed in 3.14 - use TINA4_PORT instead ` +
    `(binding port ${port} from PORT)`,
  );
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
  // OVERLAY-DEC-04: unify the debug gate on the overlay module's isDebugMode() so the
  // error-overlay gate (and every other dev gate that calls isDevMode) has ONE
  // definition, instead of recomputing isTruthy(TINA4_DEBUG) separately. Same value.
  return isDebugMode();
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

/** Module-level server handle for start()/stop() parity. */
let _serverHandle: { close: () => void; router: Router; port: number } | null = null;

/**
 * Start the Tina4 HTTP server.
 * Thin wrapper around startServer() for cross-framework parity with PHP and Ruby.
 */
/**
 * Watch for a handler that occupies the event loop, and say so.
 *
 * Node runs ONE loop. An `await`ing handler yields it and blocks nobody -
 * measured, /fast answers in 0.030s while a route awaits a 2s timer. A
 * CPU-BOUND handler does not yield, and everything else waits: the same /fast
 * took 1.575s during a 2s busy loop.
 *
 * That is inherent to a single-loop runtime, not a bug to engineer away. PHP
 * fixed its equivalent by forking per request because `sleep()` is the obvious
 * thing to write there and it blocks; in JavaScript the obvious thing is
 * `await`, which does not. So the exposure here is narrower - CPU-bound work
 * and synchronous I/O - and the honest fix is to make it VISIBLE rather than
 * to move handlers onto threads a closure cannot cross.
 *
 * The mechanism is loop lag: a timer set for TICK_MS fires late by however
 * long the loop was blocked. If that lateness passes the threshold, something
 * held the loop and the developer wants to know which.
 *
 * A 100ms repeating timer is the classic way to pin a process open forever, so
 * there are two guards against it: close() stops the timer, and the timer is
 * unref'd. Measured: either one alone is enough, and the signal path exits
 * regardless of both. They are kept together because they cost nothing and
 * cover different exits - close() covers the in-process handle, unref() covers
 * a path that never reaches close() at all.
 */
const LOOP_WATCHDOG_TICK_MS = 100;

function startLoopWatchdog(): { stop: () => void } {
  const raw = (process.env.TINA4_LOOP_LAG_WARN_MS ?? "").trim();
  // 0 or a negative value disables it; a non-numeric value falls to the
  // default rather than silently disabling a diagnostic.
  const threshold = /^\d+$/.test(raw) ? parseInt(raw, 10) : 250;
  if (threshold <= 0) {
    return { stop: () => {} };
  }

  let last = Date.now();
  let warned = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - LOOP_WATCHDOG_TICK_MS;
    last = now;
    if (lag < threshold) return;

    // Rate-limited: a handler that blocks on every request would otherwise
    // produce a wall of identical warnings, which people filter out.
    warned++;
    if (warned > 5 && warned % 20 !== 0) return;
    Log.warning(
      `Event loop blocked for ${lag}ms. Node serves every request on one loop, ` +
      `so a handler doing CPU-bound work or synchronous I/O stalls all the ` +
      `others for that long. Move the work to Tina4's queue, or await it. ` +
      `Set TINA4_LOOP_LAG_WARN_MS to change the ${threshold}ms threshold, or 0 to silence.`,
    );
  }, LOOP_WATCHDOG_TICK_MS);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}

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

/**
 * Run one global-middleware pass.
 *
 * The pre-match and post-match passes had byte-identical bodies; this is that
 * body, once.
 *
 * AFTER-ON-4xx RULE (M2): the after_* hooks ALWAYS run when a before_*
 * short-circuited (4xx, a clean 500, or the response already ended), so they
 * can still add headers and logging. Consistent across all four frameworks.
 *
 * @returns true when the pass answered the request and the handler must be skipped
 */
async function runGlobalMiddlewarePass(
  middleware: unknown[],
  req: Tina4Request,
  res: Tina4Response,
): Promise<boolean> {
  if (middleware.length === 0) return false;

  const [, , proceed] = await MiddlewareRunner.runBefore(middleware as never, req, res);
  if (proceed && !res.raw.writableEnded) return false;

  await MiddlewareRunner.runAfter(middleware as never, req, res);
  if (!res.raw.writableEnded) res.raw.end();
  return true;
}

/**
 * Invoke a matched route's handler, binding path params BY NAME.
 *
 * A handler declares whatever it needs - `(id, request, response)`, `(req, res)`,
 * or nothing - and each parameter is resolved by its name: a path param wins,
 * then `request`/`req`, then the response.
 */
async function invokeRouteHandler(
  match: { handler: unknown },
  req: Tina4Request,
  res: Tina4Response,
): Promise<unknown> {
  const routeParams = req.params || {};
  const fnStr = (match.handler as { toString(): string }).toString();
  const argMatch = fnStr.match(/^(?:async\s*)?(?:function\s*\w*)?\s*\(([^)]*)\)/);
  const argNames = argMatch?.[1]?.split(",").map((a: string) => a.trim().replace(/[:=].*/, "")) ?? [];
  const filteredArgs = argNames.filter((n: string) => n.length > 0);

  if (filteredArgs.length === 0) return await (match.handler as any)();

  const args = filteredArgs.map((name: string) => {
    if (name in routeParams) return routeParams[name];
    if (name === "request" || name === "req") return req;
    return res;
  });
  return await (match.handler as any)(...args);
}

/**
 * Render a template route's return value, when it is one.
 *
 * A route that exports a template AND whose handler returned a plain object
 * renders through the template engine instead of being sent as JSON. Every
 * other shape - a handler that already wrote, no template, null/undefined, a
 * string, a Buffer - is left exactly as it was.
 */
async function renderIfTemplateRoute(
  match: { template?: string },
  res: Tina4Response,
  result: unknown,
): Promise<void> {
  if (res.raw.writableEnded) return;
  if (!match.template) return;
  if (result === null || result === undefined) return;
  if (typeof result !== "object" || Buffer.isBuffer(result)) return;

  await res.render(match.template, result as Record<string, unknown>);
}

/** State the matched-route pipeline needs. */
interface MatchedRouteContext {
  req: Tina4Request;
  res: Tina4Response;
  pathname: string;
  match: { params?: Record<string, unknown>; handler: unknown; template?: string; middlewares?: unknown[] };
  postMatchMiddleware: unknown[];
  /**
   * EVERY global middleware, both phases. The after pass runs over all of it,
   * not just the post-match group - see runMatchedRoute.
   */
  allGlobalMiddleware: unknown[];
}

/**
 * Run a matched route end to end.
 *
 * Order, and it is BEHAVIOUR (ADR-0012):
 *   post-match globals -> auth gate -> the route's own middleware -> handler
 *
 * The globals run BEFORE the gate so a rate limiter can throttle a brute-force
 * login and an access log records the 401 - neither is possible if they only
 * run on authenticated requests (Django enforces auth in a view decorator after
 * all MIDDLEWARE; Laravel's `web` group runs before the `auth` route
 * middleware; ASP.NET puts UseAuthorization last before the endpoint).
 *
 * The route's OWN middleware runs AFTER, so middleware attached to a secured
 * route never processes an unauthenticated request. Node used to run it first,
 * which meant a body-parsing or audit middleware on a secured route saw traffic
 * that was about to be rejected.
 */
async function runMatchedRoute(ctx: MatchedRouteContext): Promise<void> {
  const { req, res, match, postMatchMiddleware } = ctx;
  req.params = match.params as never;

  // DEVADMIN-DEC-01/02: fail-closed same-origin + loopback gate on every /__dev
  // write (POST/PUT/PATCH/DELETE), BEFORE the handler runs. Closes drive-by CSRF
  // (a cross-origin page POSTing to /file/save then /reload) and a network-exposed
  // debug box. Scoped to /__dev so /__feedback + /ai are unaffected; GET/HEAD/
  // OPTIONS are safe and skip the gate. The MCP endpoints keep their own 404 gate
  // (devMutationDenial skips the mcp prefixes for the loopback part).
  const devMethod = (req.method ?? "GET").toUpperCase();
  if (ctx.pathname.startsWith("/__dev") && !DEV_SAFE_METHODS.has(devMethod)) {
    const denial = devMutationDenial(req);
    if (denial) {
      res.json({ ok: false, error: denial.error }, denial.status);
      return;
    }
  }

  if (await runGlobalMiddlewarePass(postMatchMiddleware, req, res)) return;

  // Auth enforcement lives in enforceRouteAuth (authGate.ts) so the in-process
  // TestClient enforces the EXACT same gate - parity with Python #PY2, where a
  // tokenless write must 401 in tests too, or a green test hides a live 401.
  // Dev admin routes (/__dev) are always public.
  if (enforceRouteAuth(req, res, match as never, ctx.pathname.startsWith("/__dev"))) return;

  // The route's OWN class middleware: its beforeX hooks run inside
  // runRouteMiddlewares, its afterX hooks join the after pass below - one
  // effective list for the response phase, the way Python merges the globals
  // and the route's middleware into `_effective_middleware` for both passes.
  const routeMiddlewareClasses = (match.middlewares ?? []).filter(isMiddlewareClass);

  let handlerSkipped = false;
  if (match.middlewares && match.middlewares.length > 0) {
    const proceed = await runRouteMiddlewares(match.middlewares as never, req, res);
    handlerSkipped = !proceed || res.raw.writableEnded;
  }

  if (!handlerSkipped) {
    await renderIfTemplateRoute(match, res, await invokeRouteHandler(match, req, res));
  }

  // Global afterX hooks (logging / post-processing), over EVERY global
  // middleware - both phases, not just the post-match group - PLUS the route's
  // own middleware classes.
  //
  // The response phase must cover everything the request phase entered, so it
  // also runs when the ROUTE's middleware short-circuited - the after hooks of a
  // middleware whose before hook denied the request are exactly what add the
  // headers and the access-log line for that denial. Dispatch used to return
  // early there, so a cache HIT (a route middleware that answers and ends)
  // skipped every global after hook, and a route middleware that short-circuited
  // WITHOUT ending the response left the request hanging with no end() at all.
  //
  // Running only the post-match group meant a `preMatch` middleware's afterX NEVER ran
  // on a successful request: measured 0 runs in 5 requests. An acquire/release
  // pair leaked one slot per request, unbounded; a timer started in beforeX was
  // never stopped; an access log saw the request and never the response - the
  // very hole ADR-0012 moved the globals ahead of the auth gate to close.
  //
  // Worse, it inverted: the pre-match afterX DID run when the pre-match pass
  // short-circuited, so it fired on the error path and not the happy one.
  //
  // Django unwinds its single MIDDLEWARE list in reverse, Laravel runs the
  // response/terminate phase for global, group AND route middleware, Rails runs
  // every declared after_action, ASP.NET unwinds through every component
  // entered. Ruby and PHP already did this. Splitting the BEFORE pass by
  // dependency (ADR-0012) says nothing about the after pass: an after hook adds
  // headers or logging and needs no route metadata either way.
  //
  // No double-run: when the pre-match pass short-circuits, dispatch returns
  // before ever reaching this.
  //
  // Header mutations here are no-ops once the response is flushed - Node sends
  // headers with the body - so response headers belong in beforeX.
  const afterMiddleware = [...ctx.allGlobalMiddleware, ...routeMiddlewareClasses];
  if (afterMiddleware.length > 0) {
    await MiddlewareRunner.runAfter(afterMiddleware as never, req, res);
  }

  if (!res.raw.writableEnded) res.raw.end();
}

/** State the response-end wrappers need. */
interface ResponseWrapContext {
  req: Tina4Request;
  res: Tina4Response;
  pathname: string;
  router: Router;
  reqStartTime: number;
  requestId: string;
  /** Holder, because the wrapper reads this at end() time - after route matching. */
  matchedPattern: { value: string };
  isAiPortRequest: boolean;
}

/**
 * Block /__dev_reload on the AI port so AI tools never trigger a browser reload.
 *
 * @returns true when the request was answered
 */
function blockAiPortReload(res: Tina4Response, pathname: string, isAiPortRequest: boolean): boolean {
  if (!isAiPortRequest || pathname !== "/__dev_reload") return false;

  res.raw.writeHead(404, { "Content-Type": "application/json" });
  res.raw.end(JSON.stringify({ error: "Not available on AI port" }));
  return true;
}

/**
 * Rebuild the arguments `end` was called with.
 *
 * Node's `end` has three overloads and the wrappers must forward exactly the
 * shape they were given, or a callback lands in the encoding slot.
 */
function callOriginalEnd(
  originalEnd: (...args: any[]) => any,
  chunk: unknown,
  encodingOrCb?: BufferEncoding | (() => void),
  cb?: () => void,
): any {
  if (typeof encodingOrCb === "function") return originalEnd(chunk, encodingOrCb);
  if (encodingOrCb !== undefined) return originalEnd(chunk, encodingOrCb, cb);
  return originalEnd(chunk, cb);
}

/** Whether the response is declaring itself as HTML. */
function isHtmlResponse(res: Tina4Response): boolean {
  const contentType = res.raw.getHeader("content-type");
  return typeof contentType === "string" && contentType.includes("text/html");
}

/** The chunk as an HTML string, or null when it is neither a string nor a Buffer. */
function asHtmlString(chunk: unknown): string | null {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf-8");
  return null;
}

/**
 * Inject the dev toolbar (dev mode only) and the feedback widget into an HTML body.
 *
 * The feedback injector re-checks the whitelist, path and html marker itself,
 * so calling it unconditionally is cheap when it no-ops.
 */
function injectIntoHtml(ctx: ResponseWrapContext, devToolbar: boolean, html: string): string {
  if (!devToolbar) return injectFeedbackWidget(ctx.req, html);

  const toolbarCtx: DevToolbarContext = {
    version: TINA4_VERSION,
    method: ctx.req.method ?? "GET",
    path: ctx.pathname,
    matchedPattern: ctx.matchedPattern.value || ctx.pathname,
    requestId: ctx.requestId,
    routeCount: ctx.router.getRoutes().length,
  };
  return injectFeedbackWidget(ctx.req, injectDevToolbar(html, toolbarCtx));
}

/**
 * Wrap `res.raw.end` to inject the dev toolbar and/or the feedback widget, and
 * to capture the request for the dev inspector.
 *
 * Two modes, and the distinction is deliberate:
 *   * dev mode (off the AI port, outside /__dev) gets the toolbar, the feedback
 *     widget and inspector capture;
 *   * otherwise a whitelisted user still gets the feedback widget alone. The
 *     injector re-checks the whitelist, path and html marker itself, so the
 *     wrapper is cheap when it no-ops.
 *
 * Content-Length is removed on injection because the body size changes.
 */
function wrapResponseEnd(ctx: ResponseWrapContext): void {
  const { req, res, pathname } = ctx;
  const devToolbar = isDevMode() && !pathname.startsWith("/__dev") && !ctx.isAiPortRequest;
  const feedbackOnly =
    !devToolbar &&
    feedbackEnabled() &&
    !pathname.startsWith("/__dev") &&
    !pathname.startsWith("/__feedback");

  if (!devToolbar && !feedbackOnly) return;

  const originalEnd = res.raw.end.bind(res.raw);
  res.raw.end = function (
    chunk?: unknown,
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ) {
    if (devToolbar && ctx.reqStartTime > 0) {
      RequestInspector.capture(
        req.method ?? "GET",
        pathname,
        res.raw.statusCode ?? 200,
        Date.now() - ctx.reqStartTime,
      );
    }

    if (isHtmlResponse(res)) {
      const html = asHtmlString(chunk);
      if (html !== null) chunk = injectIntoHtml(ctx, devToolbar, html);
      // Dropped for ANY html response, not only one carrying a body: that is
      // what the two original wrappers did, and a refactor does not get to
      // narrow it. An end() with no chunk on a text/html response still has
      // its stale content-length removed.
      if (!res.raw.headersSent) res.raw.removeHeader("content-length");
    }

    return callOriginalEnd(originalEnd, chunk, encodingOrCb, cb);
  } as typeof res.raw.end;
}

/**
 * Turn an uncaught dispatch error into a response, and surface it.
 *
 * v3.13.7: log structured + surface to observability BEFORE rendering.
 * Listeners get the canonical {exception, request} payload mirrored by Python /
 * PHP / Ruby. Listener errors are swallowed and warning-logged so a broken
 * listener cannot break the 500 page.
 *
 * SECURITY (CWE-209): the production response body must NOT contain the stack
 * trace or the exception message. `error_message` is passed empty - 500.twig
 * only renders the trace block when it is truthy. The rich overlay with stack
 * and source context is dev-only.
 *
 * @param err          The thrown value (not necessarily an Error)
 * @param req          The request, for the log line and the error page
 * @param res          The response; untouched if it has already ended
 * @param templatesDir Where to look for 500.twig
 */
async function renderDispatchError(
  err: unknown,
  req: Tina4Request,
  res: Tina4Response,
  templatesDir: string,
): Promise<void> {
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

  if (res.raw.writableEnded) return;

  if (isDevMode() && err instanceof Error) {
    // OVERLAY-DEC-03: guard the dev-overlay render. This call site sits INSIDE the
    // dispatch catch, so if the overlay itself throws (a malformed frame, an
    // unrenderable request value) it would double-fault out of dispatch. Wrap it and
    // fall through to the same safe production page, so a broken overlay still yields a
    // bounded 500 — never a crash.
    try {
      const { renderErrorOverlay } = await import("./errorOverlay.js");
      const overlayHtml = renderErrorOverlay(err, req);
      res.raw.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.raw.end(overlayHtml);
      return;
    } catch (overlayErr) {
      try {
        Log.warn(
          `Error overlay render failed, serving the safe page: ${
            overlayErr instanceof Error ? `${overlayErr.name}: ${overlayErr.message}` : String(overlayErr)
          }`
        );
      } catch {
        // Log failures must never block the 500 render.
      }
      // fall through to the safe production page below
    }
  }

  // The canonical per-request id (set at the top of dispatch), so the id a
  // user reports off the 500 page matches the log lines and the X-Request-ID
  // response header - not a throwaway base36 clock value.
  const requestId = Log.getRequestId() ?? randomBytes(4).toString("hex");

  // ERR-DEC-02: a JSON API client gets the JSON error body directly. The
  // message is ALWAYS the generic "Internal Server Error" here - CWE-209 -
  // never the real exception (same guarantee as error_message='' below).
  if (wantsJson(req)) {
    const body = negotiatedErrorBody(500, "Internal Server Error", requestId);
    res.raw.writeHead(500, { "Content-Type": "application/json" });
    res.raw.end(JSON.stringify(body));
    return;
  }

  const html500 = await renderErrorPage(500, {
    error_message: "",
    request_id: requestId,
    path: req.path,
  }, templatesDir);
  if (html500) {
    res.raw.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.raw.end(html500);
  } else {
    res(negotiatedErrorBody(500, "Internal Server Error", requestId), 500);
  }
}

/**
 * State the not-found fallback stages need.
 *
 * Passed explicitly rather than closed over, so each stage is callable on its
 * own instead of only from inside `dispatch`. That coupling is what the
 * extraction removes.
 */
interface FallbackContext {
  req: Tina4Request;
  res: Tina4Response;
  pathname: string;
  router: Router;
  port: number;
  staticDir: string;
  srcPublicDir: string;
  templatesDir: string;
  frondEngine: { render(file: string, data: Record<string, unknown>): string } | null;
  swaggerAssetsEnabled: boolean;
}

/**
 * Serve a template file for a GET (e.g. /hello -> src/templates/pages/hello.twig).
 *
 * Rendered through Frond so {% include %} / {% extends %} work, rather than a
 * raw readFileSync.
 */
function serveTemplateFallback(ctx: FallbackContext): boolean {
  if ((ctx.req.method ?? "GET") !== "GET") return false;

  const tplFile = resolveTemplate(ctx.pathname, ctx.templatesDir);
  if (!tplFile) return false;

  const html = ctx.frondEngine
    ? ctx.frondEngine.render(tplFile, {})
    : readFileSync(resolve(ctx.templatesDir, tplFile), "utf-8");
  ctx.res.raw.writeHead(200, undefined, { "Content-Type": "text/html; charset=utf-8" });
  ctx.res.raw.end(html);
  return true;
}

/**
 * The branded landing page.
 *
 * Renders only at "/" AND only when TINA4_DEBUG=true. In production "/" with no
 * static index.html and no pages/index.twig falls through to a clean 404, so
 * the framework's welcome, gallery and version never leak to real users.
 */
function serveLandingPage(ctx: FallbackContext): boolean {
  if ((ctx.req.method ?? "GET") !== "GET") return false;
  if (ctx.pathname !== "/" || !isDevMode()) return false;

  const allRoutes = ctx.router.getRoutes().map((r) => ({
    method: r.method,
    pattern: r.pattern,
    flags: [] as string[],
  }));
  ctx.res.raw.writeHead(200, undefined, { "Content-Type": "text/html; charset=utf-8" });
  ctx.res.raw.end(renderLandingPage(allRoutes, ctx.port));
  return true;
}

/**
 * RFC 9110 conformance - before falling through to 404, check whether the PATH
 * is registered under any OTHER method.
 *   - OPTIONS -> 204 with Allow (s9.3.7)
 *   - Any other method (PUT on GET-only, TRACE, CONNECT) -> 405 with Allow
 *     (s15.5.6 + s10.2.1)
 */
function serveMethodNotAllowed(ctx: FallbackContext): boolean {
  const allowedMethods = ctx.router.methodsAllowedForPath(ctx.pathname);
  if (allowedMethods.length === 0) return false;

  const allowHeader = allowedMethods.join(", ");
  const requestMethod = (ctx.req.method ?? "GET").toUpperCase();

  if (requestMethod === "OPTIONS") {
    ctx.res.raw.writeHead(204, undefined, { Allow: allowHeader, "Content-Length": "0" });
    ctx.res.raw.end();
    return true;
  }

  const body = JSON.stringify({
    error: "Method Not Allowed",
    path: ctx.pathname,
    method: requestMethod,
    allow: allowedMethods,
    statusCode: 405,
  });
  ctx.res.raw.writeHead(405, httpReason(405), {
    Allow: allowHeader,
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  ctx.res.raw.end(body);
  return true;
}

/**
 * No route claimed the path, so NOW try the filesystem (ADR-0010).
 *
 * Index resolution: "/" or "/foo/" picks up index.html so SPA builds Just Work.
 * The framework-bundled directory holds the Swagger UI (public/swagger/), so
 * that lookup MUST honour the swagger gate or /swagger is served in production
 * regardless of TINA4_SWAGGER_ENABLED / TINA4_DEBUG.
 */
function serveStaticAsset(ctx: FallbackContext): boolean {
  // ONE search order across the four frameworks (ST-SEARCHDIR-DIVERGE):
  // TINA4_PUBLIC_DIR override first (ST-PUBLICDIR-ENV-PARTIAL), then the app's
  // public then src/public, then the framework built-in public last.
  const custom = process.env.TINA4_PUBLIC_DIR;
  if (custom && existsSync(custom) && tryServeStatic(custom, ctx.req, ctx.res)) return true;
  if (existsSync(ctx.staticDir) && tryServeStatic(ctx.staticDir, ctx.req, ctx.res)) return true;
  if (existsSync(ctx.srcPublicDir) && tryServeStatic(ctx.srcPublicDir, ctx.req, ctx.res)) return true;

  if (ctx.swaggerAssetsEnabled || !isSwaggerAssetPath(ctx.pathname)) {
    if (tryServeStatic(BUILTIN_PUBLIC_DIR, ctx.req, ctx.res)) return true;
  }
  return false;
}

/** Terminal stage: 404, with the canonical reason phrase so the status line is well-formed. */
async function serveNotFound(ctx: FallbackContext): Promise<boolean> {
  // The canonical per-request id (set at the top of dispatch), so the id a
  // user reports off the 404 matches the log lines and the X-Request-ID
  // response header - not a throwaway (ERR-404-REQUESTID).
  const requestId = Log.getRequestId() ?? randomBytes(4).toString("hex");

  // ERR-DEC-02: a JSON API client gets the JSON error body directly - no
  // need to even try the HTML template.
  if (wantsJson(ctx.req)) {
    const body = negotiatedErrorBody(404, "Not Found", requestId);
    ctx.res.raw.writeHead(404, httpReason(404), { "Content-Type": "application/json" });
    ctx.res.raw.end(JSON.stringify(body));
    return true;
  }

  const html404 = await renderErrorPage(404, { path: ctx.pathname, request_id: requestId }, ctx.templatesDir);
  if (html404) {
    ctx.res.raw.writeHead(404, httpReason(404), { "Content-Type": "text/html; charset=utf-8" });
    ctx.res.raw.end(html404);
  } else {
    ctx.res(negotiatedErrorBody(404, `No route found for ${ctx.req.method} ${ctx.pathname}`, requestId), 404);
  }
  return true;
}

/**
 * The not-found fallback chain, in order. Data, so the pipeline can be read and
 * compared across frameworks without reading an implementation.
 *
 * Order is BEHAVIOUR: a template beats the landing page (so a project's own
 * pages/index.twig wins at "/"), 405 beats static (a known path with the wrong
 * method is not a missing file), and the 404 is terminal.
 */
const FALLBACK_STAGES: Array<(ctx: FallbackContext) => boolean | Promise<boolean>> = [
  serveTemplateFallback,
  serveLandingPage,
  serveMethodNotAllowed,
  serveStaticAsset,
  serveNotFound,
];

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

  // Claim the requested port — kill whatever is on it if needed.
  //
  // NOT in a cluster worker. A worker does not own the port: the primary binds
  // it once and hands the handle down through cluster's IPC. A worker running
  // this finds the port "in use" (the primary is holding it) and KILLS the
  // process holding it, which is its own parent. Every worker did that, then
  // died itself with `write EPIPE` from cluster._getServer because the primary
  // it needed to ask for the socket was gone. Cluster mode never served a
  // single request.
  if (!cluster.isWorker) {
    port = findAvailablePort(port);
  }

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

  // Security headers: register in the default chain UNCONDITIONALLY
  // (secure-by-default, SECHDR-DEC-01). It is CLASS middleware (a beforeSecurity
  // hook), so it goes in the MiddlewareRunner registry like CsrfMiddleware — no
  // opt-in: a default app ships X-Frame-Options/X-Content-Type-Options/CSP/etc.
  // HSTS stays HTTPS-only. Idempotent (MiddlewareRunner.use de-dupes).
  MiddlewareRunner.use(SecurityHeadersMiddleware);

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

  // Auto-attach CSRF when TINA4_CSRF is enabled — AFTER route discovery, BEFORE
  // listen. OFF by default: unset means no CSRF gate; TINA4_CSRF=true/1/yes/on
  // attaches CsrfMiddleware globally so every write is gated (CSRF-DEC-02).
  // Idempotent. Mirrors Python's attach_csrf_from_env in server boot.
  if (attachCsrfFromEnv()) {
    console.log(`\n  \x1b[36mCSRF\x1b[0m protection enabled (TINA4_CSRF)`);
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
    // Feature 43: PER-REQUEST correlation id. Honour a sanitized inbound
    // X-Request-ID so a client or upstream service can thread its own id
    // through - a CR/LF, over-long or illegal-charset value is rejected (never
    // echoed) - else generate one. Echo it on the response by stamping the raw
    // response NOW, so every outcome (200/404/500/413, Tina4Response OR a raw
    // rawRes.end) carries it. Then establish it in an AsyncLocalStorage so every
    // log line for this request - across every await - carries it, and two
    // requests interleaving on the one event loop never read each other's id.
    const requestId = Log.sanitizeRequestId(rawReq.headers["x-request-id"]) ?? randomBytes(4).toString("hex");
    if (!rawRes.headersSent) rawRes.setHeader("x-request-id", requestId);
    return Log.runWithRequestId(requestId, () => dispatchInner(rawReq, rawRes, requestId));
  }

  async function dispatchInner(rawReq: IncomingMessage, rawRes: ServerResponse, requestId: string): Promise<void> {
    const req = createRequest(rawReq);
    const res = createResponse(rawRes);

    // PROLOGUE STAGES. Extracted to dispatchPipeline.ts - see PROLOGUE_STAGES
    // there for the ordered list and why the order is behaviour, not taste.
    // These four close over nothing from startServer, which is why they went
    // first: no context object is needed for them at all.
    await resetRequestCaches();
    headStripIntercept(rawReq, rawRes);
    // Feature 40 (CE-DEC-01/02): gzip + ETag + conditional-GET for every
    // dynamic response. Installed right after headStripIntercept so it runs
    // (execution order is the REVERSE of installation for these monkey-patch
    // interceptors) AFTER the dev-toolbar/feedback injection but BEFORE the
    // HEAD body-strip - see compressionEtagIntercept's docblock.
    compressionEtagIntercept(rawReq, rawRes);

    // res.render() is handled natively by response.ts via Frond

    try {
      // sessionAutoStart is the one prologue stage INSIDE the try. It degrades
      // on its own (ADR-0021), so the only thing that escapes it is a
      // TINA4_SESSION_STRICT refusal - and that must become a 500 through the
      // normal error renderer, like Python's raise becomes a 500 in the ASGI
      // server. Outside the try it rejected `dispatch`, and nothing awaits the
      // listener http.createServer() calls: an unhandled rejection that takes
      // the whole worker down is not "refuse this request".
      await sessionAutoStart(rawReq, rawRes, req);

      // Run middleware chain
      await middleware.run(req, res);
      if (res.raw.writableEnded) return;

      // Parse request body.
      //
      // A body that breaks a documented limit is the client's error, not the
      // server's. PayloadTooLargeError already carried `statusCode = 413` and
      // nothing read it, so an oversized upload answered 500 - which tells the
      // caller to retry the exact request that will fail again.
      try {
        await req.parseBody();
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (typeof status === "number" && status >= 400 && status < 500) {
          if (!rawRes.writableEnded) {
            rawRes.statusCode = status;
            rawRes.setHeader("content-type", "application/json");
            rawRes.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }
        throw err;
      }

      const pathname = req.path;

      // Track request start time for dev inspector
      const reqStartTime = DevAdmin.isEnabled() ? Date.now() : 0;

      // Mutable ref so wrappedEnd can read the matched pattern after route matching
      // A HOLDER, not a plain string: the end-wrapper below reads it at end()
      // time, after route matching has assigned it.
      const matchedPattern = { value: "" };

      // Wrap res.raw.end to inject dev toolbar and capture requests
      // Skip toolbar injection on the AI port (no-reload behaviour)
      const isAiPortRequest = !!(rawReq as any)._tina4AiPort;

      // AI port: block /__dev_reload so AI tools never trigger a browser reload.
      if (blockAiPortReload(res, pathname, isAiPortRequest)) return;

      // Wrap res.raw.end so the dev toolbar / feedback widget can be injected
      // and the request captured for the inspector. Extracted - see
      // wrapResponseEnd. matchedPattern is a HOLDER because the wrapper reads
      // it at end() time, long after route matching has assigned it.
      wrapResponseEnd({
        req, res, pathname, router,
        reqStartTime, requestId, matchedPattern, isAiPortRequest,
      });

      // Global middleware, split by what it depends on (ADR-0012). The
      // PRE-match set runs before a route is even looked up, so CORS and
      // anything else that must survive a short-circuit can set headers that
      // outlive a 401/403; opt in with `static preMatch = true`.
      const { pre: preMatchMiddleware, post: postMatchMiddleware } =
        MiddlewareRunner.partitionByMatchPhase([
          ...new Set([...Router.getClassMiddlewares(), ...MiddlewareRunner.getGlobal()]),
        ]);

      if (await runGlobalMiddlewarePass(preMatchMiddleware, req, res)) return;

      // Match route. ROUTES BEAT FILES (ADR-0010): static assets resolve in
      // the not-found fallback below, only once no route has claimed the path.
      // A file in public/ can arrive from a build step, an upload directory or
      // a careless deploy, and it must never silently shadow a reviewed route.
      const match = router.match(req.method ?? "GET", pathname);
      if (match) {
        matchedPattern.value = match.pattern;
        await runMatchedRoute({
          req, res, pathname, match, postMatchMiddleware,
          allGlobalMiddleware: [...preMatchMiddleware, ...postMatchMiddleware],
        });
        return;
      }

      // NOT-FOUND FALLBACK STAGES. Nothing matched a route, so walk the
      // fallback chain in order - see FALLBACK_STAGES. Each returns true when
      // it has answered the request.
      //
      // ADR-0010 (routes beat files) is why this chain runs AFTER matching: a
      // file dropped into public/ by a build step or a careless deploy must
      // never shadow a reviewed route.
      const fallback: FallbackContext = {
        req, res, pathname, router, port, staticDir, srcPublicDir,
        templatesDir, frondEngine, swaggerAssetsEnabled,
      };
      for (const stage of FALLBACK_STAGES) {
        if (await stage(fallback)) return;
      }
    } catch (err) {
      await renderDispatchError(err, req, res, templatesDir);
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
      // Record THIS process as the Tina4 dev server on this port, so a later
      // `tina4 serve` can identify it as reclaimable (TAKEOVER-DEC-01). Only the
      // single dev process needs it; takeover is dev-gated off in cluster/prod.
      if (!cluster.isWorker) writePidfile(port);
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

      // A DERIVED port is still a port. `port + 1000` leaves the legal range as
      // soon as the base port is above 64535, and Node's listen() validates the
      // number and throws ERR_SOCKET_BAD_PORT SYNCHRONOUSLY — it is not an
      // "error" event, so the handler below never sees it. Thrown here it
      // escapes this listen callback ABOVE the resolvePromise() at the end of
      // it, and in debug mode devAdmin's ErrorTracker has already installed an
      // uncaughtException handler that only RECORDS the error. Net effect,
      // measured: the main port stayed bound and served traffic while
      // `await startServer(...)` never settled — a half-started server that
      // hangs the caller with nothing printed. `PORT=65000 TINA4_DEBUG=true`
      // was enough to trigger it; in the test suite an OS-assigned ephemeral
      // base port (macOS hands out 49152-65535) hit it about one run in
      // sixteen and the whole file vanished from the counts.
      const aiPortInRange = testPort <= 65535;

      if (isDebug && !noAiPort && !aiPortInRange) {
        Log.warning(
          `Stable AI/test port ${testPort} is out of range (a port must be <= 65535), ` +
          `so it is disabled for base port ${port}. Use a base port of 64535 or lower, ` +
          `or set TINA4_NO_AI_PORT=true to silence this.`,
        );
      }

      if (isDebug && !noAiPort && aiPortInRange) {
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

      // Banner goes to stdout via console.log — NOT through the framework logger.
      // Only advertise the test port when one was actually attempted: an
      // out-of-range derived port is not bound, and printing it would send a
      // developer to a URL that cannot exist (same rule as the swagger/dashboard
      // lines below).
      const dualPortLines = (isDebug && !noAiPort && aiPortInRange)
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
      // ── Graceful shutdown ─────────────────────────────────────────────
      // A container orchestrator sends SIGTERM and SIGKILLs after a grace
      // period, so dropping in-flight requests here is a production defect,
      // not a style question. The order below mirrors Python/PHP/Ruby:
      // stop accepting -> let in-flight requests finish -> release resources
      // -> exit 0.
      //
      // Two traps this replaces, both measured against a real signal:
      //
      //  1. Nothing here trapped the signal at all, so a plain startServer()
      //     app died on SIGTERM's DEFAULT disposition: process gone in ~150ms,
      //     every in-flight response dropped, exit 143.
      //  2. `server.close()` is ASYNCHRONOUS and, in Node's own words, "keeps
      //     existing connections". The CLI's `server.close(); process.exit(0)`
      //     therefore killed the very requests close() was waiting to drain.
      //     The close CALLBACK is the only honest "everything drained" signal.
      let shuttingDown = false;

      const closeListeners = (): Promise<void> =>
        new Promise((done) => {
          let pending = aiServer ? 2 : 1;
          const one = (): void => {
            if (--pending === 0) done();
          };
          server.close(one);
          if (aiServer) aiServer.close(one);
          // A keep-alive socket with no request on it still counts as an open
          // connection, so close() would sit on it until the client wandered
          // off. Without this a fully drained server still burns the whole
          // shutdown budget.
          server.closeIdleConnections();
          aiServer?.closeIdleConnections();
        });

      const gracefulShutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        Log.info(`Received ${signal}, shutting down gracefully...`);

        // Drop our identity marker so a later takeover does not match a dead PID.
        if (!cluster.isWorker) removePidfile(port);

        stopAllBackgroundTasks();

        // Tell live WebSocket peers we are going away (RFC 6455 s7.4.1 code
        // 1001) BEFORE closing the listeners. A WS connection never "finishes"
        // the way a request does, so waiting for one to drain would burn the
        // whole budget every time; the honest move is a proper close frame so
        // a tina4-js client reconnects on a schedule instead of erroring on a
        // socket that simply vanished.
        const wsClosed =
          wsRouteManager.closeAll(CLOSE_GOING_AWAY, "server shutting down") +
          devReloadWs.closeAll(CLOSE_GOING_AWAY, "server shutting down");
        if (wsClosed > 0) {
          Log.info(`Closed ${wsClosed} WebSocket connection(s) with 1001 going away`);
        }

        // Race the drain against the shutdown budget. Whatever is still in
        // flight when the budget expires gets force-closed: SIGKILL is what
        // arrives next, so a bounded drain is strictly better than an
        // unbounded one that the orchestrator truncates anyway.
        const budgetSeconds = shutdownTimeoutSeconds();
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          closeListeners().then(() => "drained" as const),
          new Promise<"timeout">((r) => {
            timer = setTimeout(() => r("timeout"), budgetSeconds * 1000);
            timer.unref();
          }),
        ]);
        if (timer) clearTimeout(timer);

        if (outcome === "timeout") {
          Log.warning(
            `Shutdown timeout (${budgetSeconds}s) reached with requests still in flight - forcing close`,
          );
          server.closeAllConnections();
          aiServer?.closeAllConnections();
        }

        try {
          const orm = await import("../../orm/src/index.js");
          await orm.closeDatabase();
        } catch {
          /* ORM never initialised - nothing to close */
        }

        Log.info("Server stopped.");
        // Exit 0: this process was ASKED to stop and did so cleanly. 128+signum
        // is what waitpid reports for a process killed BY a signal, i.e. one
        // that did NOT handle it - it is a diagnosis, not a target. Gunicorn
        // and Puma both halt 0 on a handled TERM, and a container exiting 0 is
        // a clean termination rather than a signal-kill.
        process.exit(0);
      };

      const onSigterm = (): void => {
        void gracefulShutdown("SIGTERM");
      };
      const onSigint = (): void => {
        void gracefulShutdown("SIGINT");
      };
      process.on("SIGTERM", onSigterm);
      process.on("SIGINT", onSigint);

      const loopWatchdog = startLoopWatchdog();

      resolvePromise({
        close: () => {
          loopWatchdog.stop();
          // An explicit close() is not a signal shutdown: drop the handlers so
          // a test that starts many servers in one process does not pile up
          // listeners (and trip Node's MaxListeners warning).
          process.off("SIGTERM", onSigterm);
          process.off("SIGINT", onSigint);
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

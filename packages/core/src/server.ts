import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve, dirname, join, relative } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { execFileSync, exec } from "node:child_process";
import cluster from "node:cluster";
import os from "node:os";
import type { Tina4Config, Tina4Request, Tina4Response } from "./types.js";
import { Router, defaultRouter, runRouteMiddlewares } from "./router.js";
import { validToken, getPayload, refreshToken } from "./auth.js";
import { discoverRoutes } from "./routeDiscovery.js";
import { createRequest } from "./request.js";
import { createResponse, setDefaultTemplatesDir } from "./response.js";
import { MiddlewareChain, cors, requestLogger } from "./middleware.js";
import { tryServeStatic } from "./static.js";
import { loadEnv, isTruthy } from "./dotenv.js";
import { createHealthRoute } from "./health.js";
import { rateLimiter } from "./rateLimiter.js";
import { Log } from "./logger.js";
import { DevAdmin, RequestInspector } from "./devAdmin.js";
import { I18n } from "./i18n.js";
import { stopAllBackgroundTasks } from "./background.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Built-in error templates directory (ships with @tina4/core). */
const BUILTIN_ERROR_TEMPLATES_DIR = resolve(__dirname, "..", "templates");

/** Built-in public directory for framework-bundled static assets. */
const BUILTIN_PUBLIC_DIR = resolve(__dirname, "..", "public");

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
 */
export function resolvePortAndHost(config?: { port?: number; host?: string }): { port: number; host: string } {
  const port = config?.port
    ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : undefined)
    ?? 7148;
  const host = config?.host
    ?? process.env.HOST
    ?? "0.0.0.0";
  return { port, host };
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

/** Template cache: url_path -> template_file. Null until first production lookup. */
let templateCache: Map<string, string> | null = null;

/**
 * Resolve a URL path to a template file in src/templates/.
 * Dev mode: checks filesystem every time for live changes.
 * Production: uses a cached lookup built once at startup.
 */
function resolveTemplate(pathname: string, templatesDir: string): string | null {
  const cleanPath = pathname.replace(/^\//, "") || "index";
  const isDev = (process.env.TINA4_DEBUG ?? "false").toLowerCase() === "true";

  if (isDev) {
    for (const ext of [".twig", ".html"]) {
      const candidate = cleanPath + ext;
      if (existsSync(resolve(templatesDir, candidate))) {
        return candidate;
      }
    }
    return null;
  }

  // Production: cached lookup
  if (!templateCache) {
    templateCache = new Map();
    if (existsSync(templatesDir)) {
      const scan = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            scan(resolve(dir, entry.name), rel);
          } else if (entry.name.endsWith(".twig") || entry.name.endsWith(".html")) {
            const urlPath = rel.replace(/\.(twig|html)$/, "");
            if (!templateCache!.has(urlPath)) {
              templateCache!.set(urlPath, rel);
            }
          }
        }
      };
      scan(templatesDir, "");
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
  // Load .env early so TINA4_DEBUG is available for cluster decision
  loadEnv();

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

      console.log(`${color}
  ______ _             __ __
 /_  __/(_)___  ____ _/ // /
  / /  / / __ \\/ __ \`/ // /_
 / /  / / / / / /_/ /__  __/
/_/  /_/_/ /_/\\__,_/  /_/
${reset}
  Tina4 Node.js v${TINA4_VERSION} — The Intelligent Native Application 4ramework

  Server:    http://${displayHost}:${port} (cluster, ${numCPUs} workers)
  Swagger:   http://localhost:${port}/swagger
  Dashboard: http://localhost:${port}/__dev
  Debug:     OFF (Log level: ${logLevel})
`);

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
  const templatesDir = resolve(base, config?.templatesDir ?? "src/templates");

  // .env already loaded above for cluster decision

  const router = new Router();
  const middleware = new MiddlewareChain();

  // Merge routes registered via top-level get(), post(), etc.
  for (const route of defaultRouter.getRoutes()) {
    router.addRoute(route);
  }

  // Register health check endpoint
  const healthRoute = createHealthRoute(TINA4_VERSION);
  router.addRoute(healthRoute);

  // Initialize Frond template engine
  let frondEngine: any = null;
  setDefaultTemplatesDir(templatesDir);
  try {
    const { Frond } = await import("../../frond/src/engine.js");
    frondEngine = new Frond(templatesDir);
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
          const i18nInstance = new I18n(localeDir, process.env.TINA4_LOCALE ?? "en");
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
        orm.syncModels(models);
        for (const { definition } of models) {
          console.log(`    \x1b[35m${definition.tableName}\x1b[0m (${Object.keys(definition.fields).length} fields)`);
        }

        // Generate auto-CRUD routes for all discovered models
        const crudRoutes = orm.generateCrudRoutes(models);
        for (const route of crudRoutes) {
          // Only add if no file-based route already handles this
          const existing = router.match(route.method, route.pattern.replace(/\{(\w+)\}/g, "test").replace(/\[(\w+)\]/g, "test"));
          if (!existing) {
            router.addRoute(route);
          }
        }

        console.log(`\n  Auto-CRUD endpoints:`);
        for (const route of crudRoutes) {
          console.log(`    \x1b[33m${route.method.padEnd(7)}\x1b[0m ${route.pattern}`);
        }
      }
    } catch (err) {
      console.warn(`\n  ORM not available (install @tina4/orm to enable):`, err);
    }
  }

  // Initialize Swagger
  try {
    const swagger = await import("../../swagger/src/index.js");
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

    // Auto-start session — read cookie, create session, save + set cookie on response end
    {
      const { Session } = await import("./session.js");
      const cookieHeader = rawReq.headers.cookie ?? "";
      const sidMatch = cookieHeader.match(/tina4_session=([^;]+)/);
      const existingSid = sidMatch ? sidMatch[1] : undefined;
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
          const sameSite = process.env.TINA4_SESSION_SAMESITE ?? "Lax";
          rawRes.setHeader("Set-Cookie", `tina4_session=${newSid}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${ttl}`);
        }
        return origEnd(...args);
      } as typeof rawRes.end;
    }

    // res.render() / res.template() are handled natively by response.ts via Frond

    try {
      // Run middleware chain
      await middleware.run(req, res);
      if (res.raw.writableEnded) return;

      // Parse request body
      await req.parseBody();

      const pathname = (req.url ?? "/").split("?")[0];

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
            } else if (Buffer.isBuffer(chunk)) {
              const html = chunk.toString("utf-8");
              chunk = injectDevToolbar(html, toolbarCtx);
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
      }

      // Try static files first (project public dir, then framework built-in public dir)
      if (existsSync(staticDir) && tryServeStatic(staticDir, req, res)) {
        return;
      }
      if (tryServeStatic(BUILTIN_PUBLIC_DIR, req, res)) {
        return;
      }

      // Match route
      const match = router.match(req.method ?? "GET", pathname);
      if (match) {
        req.params = match.params;
        matchedPattern = match.pattern;

        // Run per-route middlewares if any
        if (match.middlewares && match.middlewares.length > 0) {
          const proceed = await runRouteMiddlewares(match.middlewares, req, res);
          if (!proceed || res.raw.writableEnded) return;
        }

        // Auth enforcement: secure routes require a valid token
        // Check sources in priority order: Authorization header > body formToken > session token
        // Dev admin routes (/__dev) are always public
        const isDevAdmin = pathname.startsWith("/__dev");
        if (match.secure === true && match.noAuth !== true && !isDevAdmin) {
          const authHeader = req.headers.authorization ?? "";
          const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

          // Priority 1: Authorization Bearer header
          let resolvedToken = "";
          let tokenSource: "header" | "body" | "session" | "" = "";

          if (headerToken && validToken(headerToken)) {
            resolvedToken = headerToken;
            tokenSource = "header";
          }

          // Priority 2: formToken from request body
          if (!resolvedToken) {
            const bodyToken = (req.body as Record<string, unknown>)?.formToken as string | undefined;
            if (bodyToken && validToken(bodyToken)) {
              resolvedToken = bodyToken;
              tokenSource = "body";
            }
          }

          // Priority 3: Session token
          if (!resolvedToken) {
            const sessionToken = (req as any).session?.get?.("token") as string | undefined;
            if (sessionToken && validToken(sessionToken)) {
              resolvedToken = sessionToken;
              tokenSource = "session";
            }
          }

          if (!resolvedToken) {
            res.raw.writeHead(401, { "Content-Type": "application/json" });
            res.raw.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }

          req.user = getPayload(resolvedToken) ?? {};

          // When body formToken validates, return a FreshToken header with a refreshed JWT
          if (tokenSource === "body") {
            const fresh = refreshToken(resolvedToken);
            if (fresh) {
              res.header("FreshToken", fresh);
            }
          }
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

        if (!res.raw.writableEnded) {
          res.raw.end();
        }
        return;
      }

      // Try serving a template file (e.g. /hello -> src/templates/hello.twig or hello.html)
      if ((req.method ?? "GET") === "GET") {
        const tplFile = resolveTemplate(pathname, templatesDir);
        if (tplFile) {
          const html = readFileSync(resolve(templatesDir, tplFile), "utf-8");
          res.raw.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.raw.end(html);
          return;
        }

        // Show landing page for "/" when no template exists
        if (pathname === "/") {
          const allRoutes = router.getRoutes().map((r) => ({
            method: r.method,
            pattern: r.pattern,
            flags: [] as string[],
          }));
          const html = renderLandingPage(allRoutes, port);
          res.raw.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.raw.end(html);
          return;
        }
      }

      // 404
      const html404 = await renderErrorPage(404, { path: pathname }, templatesDir);
      if (html404) {
        res.raw.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.raw.end(html404);
      } else {
        res({ error: "Not Found", statusCode: 404, message: `No route found for ${req.method} ${pathname}` }, 404);
      }
    } catch (err) {
      console.error("  Error:", err);
      if (!res.raw.writableEnded) {
        if (isDevMode() && err instanceof Error) {
          // Rich error overlay with stack trace, source context, and line numbers
          const { renderErrorOverlay } = await import("./errorOverlay.js");
          const overlayHtml = renderErrorOverlay(err, req);
          res.raw.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.raw.end(overlayHtml);
        } else {
          const errorMessage = !isTruthy(process.env.TINA4_DEBUG) ? "Internal Server Error" : String(err);
          const html500 = await renderErrorPage(500, {
            error_message: errorMessage,
            request_id: `${Date.now().toString(36)}`,
            path: (req.url ?? "/").split("?")[0],
          }, templatesDir);
          if (html500) {
            res.raw.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.raw.end(html500);
          } else {
            res({ error: "Internal Server Error", statusCode: 500, message: errorMessage }, 500);
          }
        }
      }
    }
  }

  // Assign to module-level so handle() can dispatch without a server reference
  _dispatchFn = dispatch;

  // When dual-port is active (debug mode + no TINA4_NO_AI_PORT), tag main port requests
  // as AI port to suppress reload/toolbar injection. Test port (port+1000) gets full reload.
  const _dualPortActive = isTruthy(process.env.TINA4_DEBUG ?? "") &&
    !isTruthy(process.env.TINA4_NO_AI_PORT ?? "");
  const mainPortDispatch = _dualPortActive
    ? async (req: IncomingMessage, res: ServerResponse) => {
        (req as any)._tina4AiPort = true;
        await dispatch(req, res);
      }
    : dispatch;
  const server = createServer(mainPortDispatch);

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

      // AI dual-port: main port = AI dev port (no reload), port+1000 = user testing port (hot-reload)
      // When TINA4_DEBUG=true and TINA4_NO_AI_PORT is not set, main server suppresses reload/toolbar
      // and a second server on port+1000 provides the normal hot-reload experience.
      const noAiPort = isTruthy(process.env.TINA4_NO_AI_PORT ?? "");
      let aiServer: ReturnType<typeof createServer> | null = null;
      let testPort = port + 1000;

      if (isDebug && !noAiPort) {
        // Test port (port+1000): normal dispatch with full hot-reload
        aiServer = createServer(async (req, res) => {
          await dispatch(req, res);
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

      console.log(`${color}
  ______ _             __ __
 /_  __/(_)___  ____ _/ // /
  / /  / / __ \\/ __ \`/ // /_
 / /  / / / / / /_/ /__  __/
/_/  /_/_/ /_/\\__,_/  /_/
${reset}
  Tina4 Node.js v${TINA4_VERSION} — The Intelligent Native Application 4ramework

  Server:    http://${displayHost}:${port} (${serverMode})
  Swagger:   http://localhost:${port}/swagger
  Dashboard: http://localhost:${port}/__dev
  Debug:     ${isDebug ? "ON" : "OFF"} (Log level: ${logLevel})${dualPortLines}
`);
      const noBrowser = isTruthy(process.env.TINA4_NO_BROWSER);
      if (!noBrowser) {
        // Open browser on test port (hot-reload) if available, otherwise main port
        const browserTarget = (isDebug && !noAiPort && aiServer)
          ? `http://${displayHost}:${testPort}`
          : `http://${displayHost}:${port}`;
        openBrowser(browserTarget);
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

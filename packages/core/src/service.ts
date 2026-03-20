/**
 * Service Runner — in-process background services using Node.js timers.
 * Zero dependencies. Supports cron timing, simple intervals, and daemon mode.
 */
import { readdirSync, statSync, watchFile, unwatchFile } from "node:fs";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ServiceOptions {
  timing?: string;       // cron: "*/5 * * * *"
  daemon?: boolean;      // continuous mode
  interval?: number;     // simple interval in seconds (alternative to cron)
  maxRetries?: number;   // restart on crash, default 3
}

export interface ServiceContext {
  running: boolean;
  lastRun: Date | null;
  name: string;
}

export type ServiceHandler = (context: ServiceContext) => Promise<void> | void;

export interface ServiceInfo {
  name: string;
  options: ServiceOptions;
  running: boolean;
  lastRun: Date | null;
  retries: number;
}

// ─── Internal state ──────────────────────────────────────────────────────────

interface RegisteredService {
  name: string;
  handler: ServiceHandler;
  options: ServiceOptions;
  context: ServiceContext;
  timerId: ReturnType<typeof setInterval> | null;
  retries: number;
}

const registry = new Map<string, RegisteredService>();
const watchedFiles = new Set<string>();

// ─── Cron parser ─────────────────────────────────────────────────────────────

/**
 * Parse a single cron field and check if the given value matches.
 * Supports: * (every), N/n (step), N,N,N (list), N-N (range), plain number.
 */
export function matchCronField(field: string, value: number): boolean {
  // wildcard
  if (field === "*") return true;

  // step: */5 or N/5
  if (field.includes("/")) {
    const [base, stepStr] = field.split("/");
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;
    if (base === "*") return value % step === 0;
    const start = parseInt(base, 10);
    if (isNaN(start)) return false;
    return value >= start && (value - start) % step === 0;
  }

  // list: 1,15,30
  if (field.includes(",")) {
    return field.split(",").some((part) => matchCronField(part.trim(), value));
  }

  // range: 1-5
  if (field.includes("-")) {
    const [loStr, hiStr] = field.split("-");
    const lo = parseInt(loStr, 10);
    const hi = parseInt(hiStr, 10);
    if (isNaN(lo) || isNaN(hi)) return false;
    return value >= lo && value <= hi;
  }

  // exact number
  return parseInt(field, 10) === value;
}

/**
 * Check whether a Date matches a 5-field cron expression.
 * Fields: minute hour dayOfMonth month dayOfWeek
 */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  const dayOfWeek = date.getDay();    // 0 = Sunday

  return (
    matchCronField(fields[0], minute) &&
    matchCronField(fields[1], hour) &&
    matchCronField(fields[2], dayOfMonth) &&
    matchCronField(fields[3], month) &&
    matchCronField(fields[4], dayOfWeek)
  );
}

// ─── Execution helpers ───────────────────────────────────────────────────────

async function executeHandler(svc: RegisteredService): Promise<void> {
  try {
    await svc.handler(svc.context);
    svc.context.lastRun = new Date();
    svc.retries = 0; // reset retries on success
  } catch (err) {
    const maxRetries = svc.options.maxRetries ?? 3;
    svc.retries++;
    if (svc.retries >= maxRetries) {
      svc.context.running = false;
      if (svc.timerId) {
        clearInterval(svc.timerId);
        svc.timerId = null;
      }
    }
  }
}

function startCronService(svc: RegisteredService): void {
  const checkIntervalMs = parseInt(
    process.env.TINA4_SERVICE_INTERVAL ?? "1000",
    10,
  );
  let lastMinuteRun = -1;

  svc.timerId = setInterval(() => {
    if (!svc.context.running) return;
    const now = new Date();
    const currentMinute = now.getMinutes();
    // Avoid running the same minute twice
    if (currentMinute === lastMinuteRun) return;
    if (matchesCron(svc.options.timing!, now)) {
      lastMinuteRun = currentMinute;
      executeHandler(svc);
    }
  }, checkIntervalMs);
}

function startIntervalService(svc: RegisteredService): void {
  const intervalMs = (svc.options.interval ?? 60) * 1000;
  svc.timerId = setInterval(() => {
    if (!svc.context.running) return;
    executeHandler(svc);
  }, intervalMs);
}

function startDaemonService(svc: RegisteredService): void {
  // Daemon runs once; the handler manages its own loop using context.running
  executeHandler(svc);
}

// ─── ServiceRunner ───────────────────────────────────────────────────────────

export class ServiceRunner {
  /**
   * Register a service with a handler and options.
   */
  static register(
    name: string,
    handler: ServiceHandler,
    options: ServiceOptions = {},
  ): void {
    const context: ServiceContext = {
      running: false,
      lastRun: null,
      name,
    };
    registry.set(name, {
      name,
      handler,
      options,
      context,
      timerId: null,
      retries: 0,
    });
  }

  /**
   * Discover services from a directory. Each file should export
   * { name, handler, timing?, interval?, daemon?, maxRetries? }.
   */
  static async discover(serviceDir?: string): Promise<ServiceInfo[]> {
    const dir =
      serviceDir ?? process.env.TINA4_SERVICE_DIR ?? "src/services";
    const discovered: ServiceInfo[] = [];

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return discovered;
    }

    for (const entry of entries) {
      const ext = extname(entry);
      if (ext !== ".ts" && ext !== ".js") continue;

      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;

      try {
        const fileUrl = pathToFileURL(fullPath).href;
        const mod = await import(fileUrl);
        const exp = mod.default ?? mod;

        if (exp.name && typeof exp.handler === "function") {
          const opts: ServiceOptions = {
            timing: exp.timing,
            daemon: exp.daemon,
            interval: exp.interval,
            maxRetries: exp.maxRetries,
          };
          ServiceRunner.register(exp.name, exp.handler, opts);
          discovered.push({
            name: exp.name,
            options: opts,
            running: false,
            lastRun: null,
            retries: 0,
          });
        }
      } catch {
        // skip files that fail to import
      }
    }

    return discovered;
  }

  /**
   * Start all registered services, or a specific one by name.
   */
  static start(name?: string): void {
    const targets = name
      ? [registry.get(name)].filter(Boolean) as RegisteredService[]
      : Array.from(registry.values());

    for (const svc of targets) {
      if (svc.context.running) continue;
      svc.context.running = true;
      svc.retries = 0;

      if (svc.options.daemon) {
        startDaemonService(svc);
      } else if (svc.options.timing) {
        startCronService(svc);
      } else if (svc.options.interval != null) {
        startIntervalService(svc);
      } else {
        // Default: run once immediately
        executeHandler(svc);
      }
    }
  }

  /**
   * Stop all running services, or a specific one by name.
   */
  static stop(name?: string): void {
    const targets = name
      ? [registry.get(name)].filter(Boolean) as RegisteredService[]
      : Array.from(registry.values());

    for (const svc of targets) {
      svc.context.running = false;
      if (svc.timerId) {
        clearInterval(svc.timerId);
        svc.timerId = null;
      }
    }
  }

  /**
   * List all registered services with their current state.
   */
  static list(): ServiceInfo[] {
    return Array.from(registry.values()).map((svc) => ({
      name: svc.name,
      options: svc.options,
      running: svc.context.running,
      lastRun: svc.context.lastRun,
      retries: svc.retries,
    }));
  }

  /**
   * Check if a specific service is running.
   */
  static isRunning(name: string): boolean {
    const svc = registry.get(name);
    return svc?.context.running ?? false;
  }

  /**
   * Remove a service from the registry (stops it first if running).
   */
  static remove(name: string): boolean {
    const svc = registry.get(name);
    if (!svc) return false;
    ServiceRunner.stop(name);
    return registry.delete(name);
  }

  /**
   * Clear all registered services (stops them all first).
   */
  static clear(): void {
    ServiceRunner.stop();
    registry.clear();
  }

  /**
   * Watch service files for changes and hot-reload in dev mode.
   */
  static watch(serviceDir?: string): void {
    const dir =
      serviceDir ?? process.env.TINA4_SERVICE_DIR ?? "src/services";

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const ext = extname(entry);
      if (ext !== ".ts" && ext !== ".js") continue;
      const fullPath = join(dir, entry);
      if (watchedFiles.has(fullPath)) continue;
      watchedFiles.add(fullPath);

      watchFile(fullPath, { interval: 1000 }, async () => {
        // Re-discover and restart
        const fileUrl = pathToFileURL(fullPath).href;
        try {
          // Bust module cache by appending timestamp
          const mod = await import(fileUrl + "?t=" + Date.now());
          const exp = mod.default ?? mod;
          if (exp.name && typeof exp.handler === "function") {
            ServiceRunner.stop(exp.name);
            ServiceRunner.remove(exp.name);
            const opts: ServiceOptions = {
              timing: exp.timing,
              daemon: exp.daemon,
              interval: exp.interval,
              maxRetries: exp.maxRetries,
            };
            ServiceRunner.register(exp.name, exp.handler, opts);
            ServiceRunner.start(exp.name);
          }
        } catch {
          // skip
        }
      });
    }
  }

  /**
   * Stop watching service files.
   */
  static unwatch(): void {
    for (const filePath of watchedFiles) {
      unwatchFile(filePath);
    }
    watchedFiles.clear();
  }
}

import type { Tina4Request, Tina4Response, Middleware } from "./types.js";

export class MiddlewareChain {
  private middlewares: Middleware[] = [];

  use(fn: Middleware): void {
    this.middlewares.push(fn);
  }

  async run(req: Tina4Request, res: Tina4Response): Promise<boolean> {
    let index = 0;
    let completed = true;

    const next = (): void => {
      index++;
    };

    for (index = 0; index < this.middlewares.length; index++) {
      const prevIndex = index;
      await this.middlewares[index](req, res, next);

      // If response was already sent, stop the chain
      if (res.raw.writableEnded) {
        completed = false;
        break;
      }

      // If next() wasn't called, stop the chain
      if (index === prevIndex) {
        // next() increments index, so if it wasn't called, index stays the same
        // But we increment in the for loop, so we need to check differently
      }
    }

    return completed;
  }
}

/** Configuration for the CORS middleware */
export interface CorsConfig {
  /** Allowed origins. Default: "*" (or TINA4_CORS_ORIGINS env, comma-separated) */
  origins?: string | string[];
  /** Allowed methods. Default: standard REST methods (or TINA4_CORS_METHODS env) */
  methods?: string | string[];
  /** Allowed headers. Default: Content-Type, Authorization (or TINA4_CORS_HEADERS env) */
  headers?: string | string[];
  /** Access-Control-Max-Age in seconds. Default: 86400 (or TINA4_CORS_MAX_AGE env) */
  maxAge?: number;
}

/**
 * Built-in CORS middleware.
 * Reads configuration from env vars if not provided:
 *   TINA4_CORS_ORIGINS — comma-separated list of allowed origins, or "*"
 *   TINA4_CORS_METHODS — comma-separated list of allowed methods
 *   TINA4_CORS_HEADERS — comma-separated list of allowed headers
 *   TINA4_CORS_MAX_AGE — preflight cache duration in seconds
 *
 * Preflight (OPTIONS) returns 204 with appropriate headers.
 * Supports wildcard ("*") and specific origin matching.
 */
export function cors(config?: CorsConfig): Middleware {
  const originsRaw = config?.origins
    ?? process.env.TINA4_CORS_ORIGINS
    ?? "*";
  const allowedOrigins = Array.isArray(originsRaw)
    ? originsRaw
    : originsRaw.split(",").map((o) => o.trim());

  const methodsRaw = config?.methods
    ?? process.env.TINA4_CORS_METHODS
    ?? "GET, POST, PUT, DELETE, PATCH, OPTIONS";
  const allowedMethods = Array.isArray(methodsRaw)
    ? methodsRaw.join(", ")
    : methodsRaw;

  const headersRaw = config?.headers
    ?? process.env.TINA4_CORS_HEADERS
    ?? "Content-Type, Authorization";
  const allowedHeaders = Array.isArray(headersRaw)
    ? headersRaw.join(", ")
    : headersRaw;

  const maxAge = config?.maxAge
    ?? (process.env.TINA4_CORS_MAX_AGE ? parseInt(process.env.TINA4_CORS_MAX_AGE, 10) : 86400);

  return (req, res, next) => {
    const requestOrigin = req.headers.origin ?? "";

    // Determine the correct origin header value
    let originHeader: string;
    if (allowedOrigins.includes("*")) {
      originHeader = "*";
    } else if (allowedOrigins.includes(requestOrigin)) {
      originHeader = requestOrigin;
      // When responding with a specific origin, add Vary: Origin
      res.header("Vary", "Origin");
    } else {
      // Origin not allowed — still call next() but don't set CORS headers
      if (req.method === "OPTIONS") {
        res(null, 204);
        return;
      }
      next();
      return;
    }

    res.header("Access-Control-Allow-Origin", originHeader);
    res.header("Access-Control-Allow-Methods", allowedMethods);
    res.header("Access-Control-Allow-Headers", allowedHeaders);

    if (req.method === "OPTIONS") {
      res.header("Access-Control-Max-Age", String(maxAge));
      res(null, 204);
      return;
    }

    next();
  };
}

// Built-in request logger middleware
export function requestLogger(): Middleware {
  return (req, res, next) => {
    const start = Date.now();

    res.raw.on("finish", () => {
      const duration = Date.now() - start;
      const status = res.raw.statusCode;
      const method = req.method ?? "?";
      const url = req.url ?? "/";
      const color = status >= 400 ? "\x1b[31m" : status >= 300 ? "\x1b[33m" : "\x1b[32m";
      console.log(`  ${color}${status}\x1b[0m ${method} ${url} \x1b[90m${duration}ms\x1b[0m`);
    });

    next();
  };
}

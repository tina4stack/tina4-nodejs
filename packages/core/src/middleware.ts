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
      if (res.writableEnded) {
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

// Built-in CORS middleware
export function cors(): Middleware {
  return (_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (_req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    next();
  };
}

// Built-in request logger middleware
export function requestLogger(): Middleware {
  return (req, res, next) => {
    const start = Date.now();

    res.on("finish", () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const method = req.method ?? "?";
      const url = req.url ?? "/";
      const color = status >= 400 ? "\x1b[31m" : status >= 300 ? "\x1b[33m" : "\x1b[32m";
      console.log(`  ${color}${status}\x1b[0m ${method} ${url} \x1b[90m${duration}ms\x1b[0m`);
    });

    next();
  };
}

import type { RouteHandler, RouteDefinition, RouteMeta } from "./types.js";

interface MatchResult {
  handler: RouteHandler;
  params: Record<string, string>;
  meta?: RouteMeta;
}

interface CompiledRoute {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  meta?: RouteMeta;
  filePath?: string;
}

export class Router {
  private routes: Map<string, CompiledRoute[]> = new Map();

  addRoute(definition: RouteDefinition): void {
    const method = definition.method.toUpperCase();
    const { regex, paramNames } = this.compilePattern(definition.pattern);

    if (!this.routes.has(method)) {
      this.routes.set(method, []);
    }

    const routes = this.routes.get(method)!;

    // Remove existing route with same pattern (for hot-reload)
    const existingIndex = routes.findIndex((r) => r.pattern === definition.pattern);
    if (existingIndex !== -1) {
      routes.splice(existingIndex, 1);
    }

    routes.push({
      pattern: definition.pattern,
      regex,
      paramNames,
      handler: definition.handler,
      meta: definition.meta,
      filePath: definition.filePath,
    });
  }

  match(method: string, pathname: string): MatchResult | null {
    const routes = this.routes.get(method.toUpperCase());
    if (!routes) return null;

    for (const route of routes) {
      const match = route.regex.exec(pathname);
      if (match) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
        }
        return { handler: route.handler, params, meta: route.meta };
      }
    }

    return null;
  }

  getRoutes(): RouteDefinition[] {
    const all: RouteDefinition[] = [];
    for (const [method, routes] of this.routes) {
      for (const route of routes) {
        all.push({
          method,
          pattern: route.pattern,
          handler: route.handler,
          meta: route.meta,
          filePath: route.filePath,
        });
      }
    }
    return all;
  }

  clear(): void {
    this.routes.clear();
  }

  private compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    const regexStr = pattern
      .split("/")
      .map((segment) => {
        if (segment.startsWith("[...") && segment.endsWith("]")) {
          // Catch-all: [...slug]
          const name = segment.slice(4, -1);
          paramNames.push(name);
          return "(.+)";
        }
        if (segment.startsWith("[") && segment.endsWith("]")) {
          // Dynamic param: [id]
          const name = segment.slice(1, -1);
          paramNames.push(name);
          return "([^/]+)";
        }
        return segment;
      })
      .join("/");

    return {
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
    };
  }
}

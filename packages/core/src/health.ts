import type { RouteDefinition, RouteHandler } from "./types.js";

/** Server start time, set when health route is created */
let startTime: number;

/**
 * Resolve the health route path. Priority:
 *   1. `TINA4_HEALTH_PATH` env var
 *   2. Default `/__health` (matches Python parity — under-prefix avoids
 *      colliding with app routes named /health)
 */
export function healthPath(): string {
  const raw = (process.env.TINA4_HEALTH_PATH ?? "").trim();
  if (raw.length === 0) return "/__health";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function buildHandler(version: string): RouteHandler {
  return (_req, res) => {
    const uptimeSeconds = (Date.now() - startTime) / 1000;
    res.json({
      status: "ok",
      version,
      uptime: Math.round(uptimeSeconds * 100) / 100,
      framework: "tina4-nodejs",
    });
  };
}

/**
 * Create the primary health route definition.
 *
 * Tests use this directly. Server bootstrap goes through createHealthRoutes()
 * to also register the legacy `/health` alias when TINA4_HEALTH_PATH points
 * elsewhere — matching Python behaviour so existing probes don't break.
 */
export function createHealthRoute(version: string = "3.0.0"): RouteDefinition {
  startTime = Date.now();

  return {
    method: "GET",
    pattern: healthPath(),
    handler: buildHandler(version),
    meta: {
      summary: "Health check",
      description: "Returns server health status, version, and uptime.",
      tags: ["System"],
    },
  };
}

/**
 * Create one or two health routes — the env-defined path always, plus a
 * legacy `/health` alias when the env path differs. Mirrors
 * tina4-python's two-line registration in `core/server.py`.
 */
export function createHealthRoutes(version: string = "3.0.0"): RouteDefinition[] {
  startTime = Date.now();
  const routes: RouteDefinition[] = [];
  const path = healthPath();

  routes.push({
    method: "GET",
    pattern: path,
    handler: buildHandler(version),
    meta: {
      summary: "Health check",
      description: "Returns server health status, version, and uptime.",
      tags: ["System"],
    },
  });

  // Always register /health for backwards compatibility with existing probes
  // (Kubernetes liveness/readiness, load balancers, monitoring scripts).
  if (path !== "/health") {
    routes.push({
      method: "GET",
      pattern: "/health",
      handler: buildHandler(version),
      meta: {
        summary: "Health check (legacy alias)",
        description: "Backwards-compatible alias for the configured health path.",
        tags: ["System"],
      },
    });
  }

  return routes;
}

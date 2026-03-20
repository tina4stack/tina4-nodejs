import type { RouteDefinition } from "./types.js";

/** Server start time, set when health route is created */
let startTime: number;

/**
 * Create the /health route definition.
 * Returns a RouteDefinition that can be added to the router.
 */
export function createHealthRoute(version: string = "3.0.0"): RouteDefinition {
  startTime = Date.now();

  return {
    method: "GET",
    pattern: "/health",
    handler: (_req, res) => {
      const uptimeSeconds = (Date.now() - startTime) / 1000;
      res.json({
        status: "ok",
        version,
        uptime: Math.round(uptimeSeconds * 100) / 100,
        framework: "tina4-nodejs",
      });
    },
    meta: {
      summary: "Health check",
      description: "Returns server health status, version, and uptime.",
      tags: ["System"],
    },
  };
}

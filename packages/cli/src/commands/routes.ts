/**
 * CLI command: routes — List all registered routes.
 *
 * Discovers routes from src/routes/ and displays them in a table.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function listRoutes(): Promise<void> {
  const routesDir = resolve("src/routes");

  if (!existsSync(routesDir)) {
    console.error("  No src/routes/ directory found. Are you in a Tina4 project?");
    process.exit(1);
  }

  let discoverRoutes: typeof import("@tina4/core").discoverRoutes;

  try {
    const core = await import("@tina4/core");
    discoverRoutes = core.discoverRoutes;
  } catch {
    console.error("  Error: @tina4/core is required to list routes.");
    process.exit(1);
  }

  const routes = await discoverRoutes(routesDir);

  if (routes.length === 0) {
    console.log("  No routes found.");
    return;
  }

  // Sort by path then method
  routes.sort((a: { path: string; method: string }, b: { path: string; method: string }) => {
    const pathCmp = a.path.localeCompare(b.path);
    return pathCmp !== 0 ? pathCmp : a.method.localeCompare(b.method);
  });

  console.log("");
  console.log("  Registered Routes:");
  console.log("  " + "-".repeat(70));
  console.log(
    "  " +
      "METHOD".padEnd(10) +
      "PATH".padEnd(40) +
      "SUMMARY"
  );
  console.log("  " + "-".repeat(70));

  for (const route of routes) {
    const method = route.method.toUpperCase().padEnd(10);
    const path = route.path.padEnd(40);
    const summary = route.meta?.summary ?? "";
    console.log(`  ${method}${path}${summary}`);
  }

  console.log("  " + "-".repeat(70));
  console.log(`  Total: ${routes.length} route(s)`);
  console.log("");
}

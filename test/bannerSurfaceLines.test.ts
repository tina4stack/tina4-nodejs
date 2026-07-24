/**
 * Lock-in: the startup banner only advertises surfaces that are REACHABLE.
 *
 * Regression this pins down (issue #99)
 * -------------------------------------
 * The banner printed
 *
 *     Swagger:   http://localhost:7148/swagger
 *     Dashboard: http://localhost:7148/__dev
 *
 * unconditionally. In production (or with TINA4_DEBUG off) both of those return
 * 404, so the banner (a) told an operator a dev surface was exposed when it was
 * not, and (b) sent a developer to a dead link.
 *
 * Node had a second banner site the others did not: the CLUSTER (production)
 * path prints its own banner, and that is exactly the path where a "Dashboard:"
 * line is guaranteed wrong -- cluster mode means debug is off. Both sites now
 * route through this one pure helper.
 *
 * Pure function of (port, two booleans): no dependency, no double -- this is
 * not a mock test.
 *
 * Parity: Python banner_surface_lines, PHP App::bannerSurfaceLines, Ruby
 * Tina4.banner_surface_lines.
 *
 * Run with: npx tsx test/bannerSurfaceLines.test.ts
 */
import { bannerSurfaceLines } from "../packages/core/src/server.ts";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 7148;

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

// Production: neither surface reachable, so neither advertised.
{
  const [swaggerLine, dashboardLine] = bannerSurfaceLines(PORT, {
    swaggerEnabled: false,
    devAdminEnabled: false,
  });
  assert("both off: swagger line empty", swaggerLine === "", JSON.stringify(swaggerLine));
  assert("both off: dashboard line empty", dashboardLine === "", JSON.stringify(dashboardLine));

  const combined = swaggerLine + dashboardLine;
  assert("both off: never leaks /swagger", !combined.includes("/swagger"));
  assert("both off: never leaks /__dev", !combined.includes("/__dev"));
}

// Swagger exposed in production (TINA4_SWAGGER_ENABLED=true), debug off.
{
  const [swaggerLine, dashboardLine] = bannerSurfaceLines(PORT, {
    swaggerEnabled: true,
    devAdminEnabled: false,
  });
  assert(
    "swagger only: swagger row present",
    swaggerLine === `\n  Swagger:   http://localhost:${PORT}/swagger`,
    JSON.stringify(swaggerLine),
  );
  assert("swagger only: no dashboard row", dashboardLine === "");
}

// Debug on but swagger explicitly disabled (TINA4_SWAGGER_ENABLED=false).
{
  const [swaggerLine, dashboardLine] = bannerSurfaceLines(PORT, {
    swaggerEnabled: false,
    devAdminEnabled: true,
  });
  assert("dev admin only: no swagger row", swaggerLine === "");
  assert(
    "dev admin only: dashboard row present",
    dashboardLine === `\n  Dashboard: http://localhost:${PORT}/__dev`,
    JSON.stringify(dashboardLine),
  );
}

// Ordinary dev: both live, both advertised.
{
  const [swaggerLine, dashboardLine] = bannerSurfaceLines(PORT, {
    swaggerEnabled: true,
    devAdminEnabled: true,
  });
  assert(
    "both on: swagger row present",
    swaggerLine === `\n  Swagger:   http://localhost:${PORT}/swagger`,
  );
  assert(
    "both on: dashboard row present",
    dashboardLine === `\n  Dashboard: http://localhost:${PORT}/__dev`,
  );
}

// The printed link must carry the port the server actually bound.
{
  const [swaggerLine, dashboardLine] = bannerSurfaceLines(9999, {
    swaggerEnabled: true,
    devAdminEnabled: true,
  });
  assert("port interpolated into swagger row", swaggerLine.includes("9999"));
  assert("port interpolated into dashboard row", dashboardLine.includes("9999"));
  assert("no stale default port", !swaggerLine.includes(String(PORT)));
}

// Each row owns exactly one newline (they interpolate into one banner string).
{
  for (const line of bannerSurfaceLines(PORT, {
    swaggerEnabled: true,
    devAdminEnabled: true,
  })) {
    assert(
      `row starts its own line: ${JSON.stringify(line.trim())}`,
      line.startsWith("\n") && line.split("\n").length === 2,
    );
  }
}

// The cluster (production) banner must never advertise the dashboard: cluster
// mode implies debug off. Pin that it asks for devAdminEnabled: false.
{
  const source = readFileSync(
    resolve(__dirname, "..", "packages", "core", "src", "server.ts"),
    "utf8",
  );
  const clusterCall = source.match(
    /const \[swaggerLine\] = bannerSurfaceLines\(port, \{[^}]*\}/,
  );
  assert("cluster banner uses the shared helper", clusterCall !== null);
  assert(
    "cluster banner hard-codes devAdminEnabled: false",
    clusterCall !== null && /devAdminEnabled:\s*false/.test(clusterCall[0]),
    clusterCall ? clusterCall[0] : "no match",
  );
}

console.log(
  `\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`,
);
process.exit(fail > 0 ? 1 : 0);

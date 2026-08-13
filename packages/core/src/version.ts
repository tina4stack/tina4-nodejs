/**
 * The single Tina4 framework version resolver (feature 130, VERSION-DEC-01).
 *
 * Before this file, three surfaces inside @tina4/core each read their own copy
 * of package.json independently: server.ts's `readPackageVersion()` was a
 * FIXED `../../../package.json` (three levels up from wherever this file
 * physically sits) with no fallback -- correct in the monorepo dev tree, but
 * silently `"0.0.0"` the moment @tina4/core is relocated (a published npm
 * install, a bundled dist/, a pnpm .pnpm store symlink) because the fixed
 * depth no longer lands on a package.json at all. devAdmin.ts tried two fixed
 * paths (`../../../package.json` then `../../package.json`) with the same
 * "0.0.0" floor. mcp.ts's default dev MCP server never read a manifest at
 * all -- its serverInfo.version was just the constructor's generic '1.0.0'
 * default. Three readers, three ways to drift from the real version and from
 * each other.
 *
 * The CLI (`packages/cli/src/bin.ts` `readCliVersion()`) already had the
 * RIGHT algorithm: walk up from this file's own location to the NEAREST
 * package.json that declares a version, rather than assuming a fixed depth.
 * That is robust to being relocated because it does not care how many
 * directories separate it from the root -- it finds whichever package.json is
 * actually adjacent to wherever this code ended up running from (its own
 * package's manifest in a published install, the monorepo root in the dev
 * tree). This file ports that exact algorithm into @tina4/core so the THREE
 * in-package readers collapse into ONE. (The CLI keeps its own small copy
 * rather than importing this one: `packages/cli` deliberately avoids a
 * top-level import of `@tina4/core` so a bare `tina4nodejs --help` does not
 * pay to load the whole bundled core package -- see the port-takeover comment
 * in bin.ts. Both copies run the identical walk-up, so in any real deployment
 * layout they resolve to the same value.)
 *
 * Cheap and side-effect-free: filesystem reads only, no bootstrap.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this file to the nearest package.json carrying a non-empty
 * `version` field. Stops at the first hit (nearest wins), so a published
 * `@tina4/core` install resolves its OWN package.json, and the monorepo dev
 * tree resolves the workspace root's -- both the real, current version.
 * Falls back to "0.0.0" only if none is found within the walk (a layout with
 * no package.json anywhere in its ancestry at all).
 */
export function resolveFrameworkVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (typeof pkg.version === "string" && pkg.version) return pkg.version;
      } catch {
        // keep walking -- a malformed package.json isn't ours
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

/** Resolved once at module load -- every @tina4/core surface imports this. */
export const TINA4_VERSION = resolveFrameworkVersion();

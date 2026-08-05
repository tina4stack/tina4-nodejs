/**
 * Make named packages genuinely unresolvable for THIS process.
 *
 * Some tests can only run in an environment that is the opposite of the normal
 * one. "throws a helpful error when the pg package is missing" cannot run on a
 * box where pg is installed, so on the lab -- where every driver is present by
 * design -- four such tests skipped forever. A skip is not a pass; it is a test
 * nobody has seen succeed.
 *
 * PHP solves this with PHP_INI_SCAN_DIR pointed at a pruned conf.d. Node has no
 * equivalent, and the obvious workaround -- moving node_modules/<pkg> aside --
 * mutates a shared checkout and leaves the package missing if the run dies
 * halfway. This does it per-process instead: nothing on disk changes, and the
 * effect ends when the process does.
 *
 * All four ORM adapters resolve their driver through
 * `createRequire(import.meta.url)`, which is CJS resolution, so patching
 * Module._resolveFilename covers every one of them. The error carries
 * code MODULE_NOT_FOUND because that is exactly what the adapters catch to
 * decide a driver is absent -- a different error would take a different branch
 * and the test would be exercising the wrong path.
 *
 * Usage:
 *   TINA4_HIDE_PACKAGES=pg,mysql2 node --import ./test/_hidePackages.mjs ...
 *
 * An empty or unset list is a no-op, so leaving the import in place costs
 * nothing on a normal run.
 */
import Module from "node:module";

const hidden = new Set(
  (process.env.TINA4_HIDE_PACKAGES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (hidden.size > 0) {
  const realResolve = Module._resolveFilename;

  Module._resolveFilename = function (request, ...rest) {
    // Match the bare package name and anything under it ("pg" hides
    // "pg/lib/foo" too), but never a path that merely starts with the same
    // letters ("pg-pool" must stay resolvable unless it is named explicitly).
    const bare = request.startsWith("@")
      ? request.split("/").slice(0, 2).join("/")
      : request.split("/")[0];

    if (hidden.has(bare)) {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return realResolve.call(this, request, ...rest);
  };

  // Say so on stderr. A silent environment change is how a run ends up proving
  // something other than what its output claims.
  process.stderr.write(
    `[hidePackages] resolution disabled for: ${[...hidden].join(", ")}\n`,
  );
}

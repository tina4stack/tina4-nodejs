/**
 * Last-resort finder for `@tina4/core/<subpath>` under Node's ESM resolver.
 *
 * The `exports` map registers `"./*": "./dist/_missing.js"` as the LAST entry.
 * Any subpath that no earlier entry matched (a typo, a guess, an ORM name
 * imported from the core entry, etc.) lands here at import time and throws a
 * helpful Error that names every REAL subpath — parsed at throw time from the
 * OWN package.json's `exports` map so the message can never drift from what's
 * actually exported.
 *
 * NODE PARITY GAP (accepted, ADR-0062).
 *
 * Node's wildcard resolver invokes this file with the RESOLVED target path,
 * not the ORIGINAL requested subpath — so we cannot know what the caller
 * typed. Python / PHP / Ruby's finders receive the raw request and can point
 * at the closest match ("did you mean `router`?"). Node's message is
 * necessarily generic: it lists ALL real subpaths as a browsable set. For an
 * AI-agent consumer (or a human agent), the browsable list is enough to make
 * the correct next call; the asymmetry is called out here so nobody wonders
 * why Node's message lacks the pointed "did you mean" line.
 *
 * The module SIDE-EFFECT throws — importing this file is enough to raise,
 * whether the caller does a bare-`import` or a named-`import { X }`. That is
 * what routes the wildcard's fallback through this file: Node evaluates the
 * module body BEFORE resolving named bindings.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Read the OWN package.json (walking up from this file's URL) and return the
 * real subpaths — everything in `exports` except `.` (the root) and the
 * wildcard `./*` itself. Order matches the declaration in package.json, which
 * is the order a maintainer curated for discoverability.
 */
function realSubpaths(): { pkgName: string; subpaths: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ (or src/ under tsx) → package root is one level up
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    name?: string;
    exports?: Record<string, unknown>;
  };
  const pkgName = pkg.name ?? "@tina4/core";
  const exportsMap = pkg.exports ?? {};
  const subpaths: string[] = [];
  for (const key of Object.keys(exportsMap)) {
    if (key === "." || key === "./*") continue;
    // Strip the leading "./" so a caller sees "router" not "./router"
    subpaths.push(key.startsWith("./") ? key.slice(2) : key);
  }
  return { pkgName, subpaths };
}

const { pkgName, subpaths } = realSubpaths();

// The message shape matches the Python / PHP / Ruby import-hint format so an
// AI-agent consumer that switches languages sees a recognisable string.
const message =
  `${pkgName}: no such subpath. ` +
  `Real subpaths: ${subpaths.join(", ")}. ` +
  `(Node's wildcard resolver can't see the original request, so this message ` +
  `lists every real subpath rather than pointing at the closest match — ` +
  `see ADR-0062.)`;

throw new Error(message);

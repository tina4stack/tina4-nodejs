/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A project path is a path, not a URL.
 *
 * The ESM loader takes a URL, and the framework used to build one by hand
 * (`file://${path}`) or pass the raw path (`import(fullPath)`). Both break the
 * moment the path holds a character a URL treats specially: `#` starts a
 * fragment, `%41` decodes to `A`, and on Windows `D:\...` is read as a scheme.
 * The project below lives under a directory named with all of them, so these
 * checks fail on Linux CI as well as Windows if the hand-built URLs come back.
 *
 * The same project also proves the broken-import marker is named without the
 * `:` of a drive letter (on Linux the directory name carries a real `:`, since
 * Linux allows one; on Windows the drive letter supplies it). NTFS reads a `:`
 * in a file name as an alternate data stream, so that marker used to vanish
 * from every `data/.broken/*.broken` listing.
 *
 * Real files, real imports, real discovery - nothing is simulated.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverRoutes, _resetRouteDiscovery } from "../packages/core/src/routeDiscovery.ts";
import { getFrameworkFrond } from "../packages/core/src/response.ts";
import { FakeData } from "../packages/core/src/fakeData.ts";
import { discoverModels } from "../packages/orm/src/model.ts";
import { removeTempDir } from "./_tempDir.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== Module paths are converted to URLs, not pasted into them ===\n");

const REPO = resolve(import.meta.dirname, "..");
const base = mkdtempSync(join(tmpdir(), "tina4-modpath-"));
// Windows forbids ':' in a name; its absolute paths already start with one.
const awkward = process.platform === "win32" ? "proj #1 %41" : "proj #1 %41 drive:c";
const project = join(base, awkward);
const routes = join(project, "src", "routes");
const models = join(project, "src", "models");
const seeds = join(project, "src", "seeds");
for (const d of [join(routes, "hello"), models, seeds]) mkdirSync(d, { recursive: true });

writeFileSync(join(routes, "hello", "get.ts"),
  "export default async function (_req: any, res: any) { return res.json({ hello: true }); }\n");
writeFileSync(join(models, "Gadget.ts"),
  "export default class Gadget {\n  static tableName = \"gadgets\";\n" +
  "  static fields = { id: { type: \"integer\" as const, primaryKey: true } };\n}\n");
const seedMarker = join(base, "seed-ran.txt");
writeFileSync(join(seeds, "001_gadgets.ts"),
  "import { writeFileSync } from \"node:fs\";\n" +
  `export default async function () { writeFileSync(${JSON.stringify(seedMarker)}, "ran"); }\n`);

const origCwd = process.cwd();
try {
  // ── Route discovery ──────────────────────────────────────────────
  _resetRouteDiscovery();
  const found = await discoverRoutes(routes);
  assert("a route under a path with '#' and '%41' is discovered",
    found.some((r) => r.pattern === "/hello" && r.method === "GET"),
    JSON.stringify(found.map((r) => `${r.method} ${r.pattern}`)));

  // ── Model discovery ──────────────────────────────────────────────
  const discovered = await discoverModels(models);
  assert("a model under a path with '#' and '%41' is discovered",
    discovered.some((m) => m.definition.tableName === "gadgets"),
    JSON.stringify(discovered.map((m) => m.definition.tableName)));

  // ── Seed files ───────────────────────────────────────────────────
  const executed = await new FakeData().seedDir(seeds);
  assert("seedDir() runs a seed file under a path with '#' and '%41'",
    executed.length === 1 && existsSync(seedMarker),
    `executed=${JSON.stringify(executed)} marker=${existsSync(seedMarker)}`);

  // ── Broken-import marker name ────────────────────────────────────
  writeFileSync(join(routes, "hello", "post.ts"), "export default async function ( {\n");
  process.chdir(project);
  _resetRouteDiscovery();
  await discoverRoutes(routes);
  const brokenDir = join(project, "data", ".broken");
  const markers = existsSync(brokenDir)
    ? readdirSync(brokenDir).filter((f) => f.startsWith("discover_") && f.endsWith(".broken"))
    : [];
  assert("a broken route leaves a marker that a *.broken listing finds", markers.length === 1,
    `found ${JSON.stringify(markers)}`);
  assert("the marker name carries no ':' (NTFS would hide it in a stream)",
    markers.length === 1 && !markers[0]!.includes(":"), JSON.stringify(markers));
  assert("the marker still names the broken file",
    markers.length === 1 && readFileSync(join(brokenDir, markers[0]!), "utf-8").includes("post.ts"));
} finally {
  process.chdir(origCwd);
  removeTempDir(base);
}

// ── The framework's own template directory ──────────────────────────
// getFrameworkFrond() locates packages/core/templates from import.meta.url.
// With the old `.replace("file://", "")` that is "/D:/..." on Windows and a
// percent-encoded path anywhere the checkout path has a space, so it returned
// null and every error page fell back to JSON.
const frond = await getFrameworkFrond();
assert("getFrameworkFrond() finds the framework templates", frond !== null);

// ── No hand-built file URLs anywhere in the framework source ────────
// The behavioural checks above cover the call sites that exist today; this
// catches a new one. A file URL must come from pathToFileURL, and a path from
// fileURLToPath - never from string concatenation or a "file://" replace.
{
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
          if (/`file:\/\/\$\{|["'`]file:\/\/["'`]\s*\+|replace\(\s*["'`]file:\/\/["'`]/.test(line)) {
            offenders.push(`${full.slice(REPO.length + 1)}:${i + 1}`);
          }
        });
      }
    }
  };
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    const src = join(REPO, "packages", pkg, "src");
    if (existsSync(src)) walk(src);
  }
  assert("no framework source builds or strips a file:// URL by hand", offenders.length === 0,
    offenders.join(", "));
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);

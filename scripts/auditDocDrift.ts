/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * auditDocDrift.ts -- fail when the packaged CLAUDE.md documents a framework
 * import the code does not actually export.
 *
 * This is the Node/TypeScript side of the First Principle ("Documentation
 * Matches Code Reality"), aimed at the file that ships INSIDE the npm package
 * and is read by AI agents: the repo-root `CLAUDE.md` (listed in package.json
 * `files`). Every `import { ... } from "@tina4/<pkg>"` in a TypeScript fence is
 * checked against the LIVE public surface of that package -- read straight from
 * the package's own barrel (`packages/<pkg>/src/index.ts`) with the TypeScript
 * compiler, never a hand-kept list -- so the gate cannot itself drift. If the
 * barrel names a symbol its source does not export, `npm run typecheck` fails
 * first, so the barrel is authoritative here.
 *
 * It catches the Node twin of the tina4-js `import { mount }` drift: a
 * documented import (value OR type) of a name no package exports, or a default
 * import from a package that has no default export.
 *
 * Usage:
 *   npx tsx scripts/auditDocDrift.ts            # report (exit 0)
 *   npx tsx scripts/auditDocDrift.ts --strict   # CI gate (exit 1 on drift)
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(SCRIPT_DIR, "..");

/** The public export surface of a @tina4/<pkg> package, or null if unreadable. */
interface PackageSurface {
  /** Every named export (values AND types), after any `as` rename. */
  names: Set<string>;
  /** True when the barrel has a `export default` / `export = `. */
  hasDefault: boolean;
}

const surfaceCache = new Map<string, PackageSurface | null>();

/**
 * Map a `@tina4/<name>` specifier to its barrel and read the exported names
 * with the TypeScript compiler. Handles `export { a, b as c }`,
 * `export type { T }`, per-element `export { type T }`, and any
 * `export function|const|class|interface|type|enum` in the barrel. There are no
 * `export *` re-exports in these barrels, so the named exports ARE the surface.
 */
export function packageSurface(specifier: string, root: string = REPO_ROOT): PackageSurface | null {
  const match = /^@tina4\/([\w-]+)$/.exec(specifier);
  if (!match) return null;
  const cacheKey = `${root}::${match[1]}`;
  if (surfaceCache.has(cacheKey)) return surfaceCache.get(cacheKey) ?? null;

  const indexPath = join(root, "packages", match[1], "src", "index.ts");
  if (!existsSync(indexPath)) {
    surfaceCache.set(cacheKey, null);
    return null;
  }

  const source = ts.createSourceFile(
    indexPath,
    readFileSync(indexPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  let hasDefault = false;

  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of source.statements) {
    // export { a, b as c } from "..."  /  export type { T } from "..."
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
      continue;
    }
    // export default ... / export = ...
    if (ts.isExportAssignment(statement)) {
      hasDefault = true;
      continue;
    }
    // export function|class|interface|type|enum Name / export const Name = ...
    if (hasExportModifier(statement)) {
      const isDefault = (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault) { hasDefault = true; continue; }
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) && statement.name
      ) {
        names.add(statement.name.text);
      }
    }
  }

  const surface: PackageSurface = { names, hasDefault };
  surfaceCache.set(cacheKey, surface);
  return surface;
}

/** Yield [startLine, code] for every fenced block whose language is ts/typescript/tsx. */
export function* iterTypeScriptFences(markdown: string): Generator<[number, string]> {
  const fence = /```(ts|tsx|typescript)\b[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) {
    const startLine = markdown.slice(0, m.index).split("\n").length + 1;
    yield [startLine, m[2]];
  }
}

interface ImportBinding {
  name: string;   // the LOCAL/imported name as written (before any `as`)
  imported: string; // the name in the module (what must exist), i.e. the part before `as`
  kind: "named" | "default" | "namespace";
}

/**
 * Parse the import statements in one code fence. Returns, per statement, the
 * module specifier and the bindings pulled from it. Namespace imports
 * (`* as X`) bind the whole module, so they carry no checkable name.
 */
export function parseImports(code: string): { specifier: string; bindings: ImportBinding[] }[] {
  const out: { specifier: string; bindings: ImportBinding[] }[] = [];
  // import <clause> from "<spec>";  -- clause may span lines (the { } block does).
  const importRe = /import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    const clauseIsType = Boolean(m[1]);
    const clause = m[2].trim();
    const specifier = m[3];
    const bindings: ImportBinding[] = [];

    // Named block: { a, b as c, type d }
    const brace = /\{([\s\S]*?)\}/.exec(clause);
    if (brace) {
      for (const raw of brace[1].split(",")) {
        let part = raw.trim();
        if (!part) continue;
        part = part.replace(/^type\s+/, ""); // per-element `type X`
        const imported = part.split(/\s+as\s+/)[0].trim();
        if (imported) bindings.push({ name: imported, imported, kind: "named" });
      }
    }

    // Namespace: * as X (before or instead of a block)
    if (/\*\s+as\s+\w+/.test(clause)) {
      bindings.push({ name: "*", imported: "*", kind: "namespace" });
    }

    // Default binding: a leading bare identifier (not part of { } or * as).
    const defaultMatch = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (defaultMatch && !clauseIsType) {
      bindings.push({ name: defaultMatch[1], imported: "default", kind: "default" });
    }

    out.push({ specifier, bindings });
  }
  return out;
}

/**
 * Check the @tina4 imports in an arbitrary markdown string against the LIVE
 * package surfaces under `root`. Split out so the gate's own tests can feed a
 * mutated document while still resolving names against the real packages.
 */
export function checkMarkdownText(text: string, root: string = REPO_ROOT, label = "CLAUDE.md"): string[] {
  const problems: string[] = [];

  for (const [startLine, code] of iterTypeScriptFences(text)) {
    for (const { specifier, bindings } of parseImports(code)) {
      const surface = packageSurface(specifier, root);
      if (surface === null) continue; // not a @tina4 package (or barrel unreadable)
      // approximate the line of this import inside the file for the message
      const offset = code.indexOf(`"${specifier}"`) >= 0 ? code.indexOf(`"${specifier}"`) : code.indexOf(`'${specifier}'`);
      const line = offset >= 0 ? startLine + code.slice(0, offset).split("\n").length - 1 : startLine;

      for (const binding of bindings) {
        if (binding.kind === "namespace") continue; // whole-module binding, nothing to resolve
        if (binding.kind === "default") {
          if (!surface.hasDefault) {
            problems.push(
              `${label}:${line}: \`import ${binding.name} from "${specifier}"\` -- ` +
                `${specifier} has no default export`,
            );
          }
          continue;
        }
        if (!surface.names.has(binding.imported)) {
          problems.push(
            `${label}:${line}: \`import { ${binding.imported} } from "${specifier}"\` -- ` +
              `\`${binding.imported}\` is not exported by ${specifier}`,
          );
        }
      }
    }
  }
  return problems;
}

/** Check the packaged CLAUDE.md. Returns a list of human-readable problems. */
export function checkClaudeMd(root: string = REPO_ROOT): string[] {
  const path = join(root, "CLAUDE.md");
  if (!existsSync(path)) return [`${path}: packaged CLAUDE.md not found`];
  return checkMarkdownText(readFileSync(path, "utf8"), root, "CLAUDE.md");
}

export function check(root: string = REPO_ROOT): string[] {
  return checkClaudeMd(root);
}

function main(): number {
  const strict = process.argv.includes("--strict");
  const problems = check(REPO_ROOT);
  if (problems.length > 0) {
    console.log(`Doc-drift audit: ${problems.length} problem(s) found:\n`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log("\nFix the docs to match the code (or the code to match the docs).");
    return strict ? 1 : 0;
  }
  console.log("Doc-drift audit: clean -- every documented @tina4 import resolves against the live code.");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}

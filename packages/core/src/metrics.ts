// Tina4 Code Metrics — regex-based static analysis for the dev dashboard.
/**
 * Two-tier analysis:
 *   1. Quick metrics (instant): LOC, file counts, class/function counts
 *   2. Full analysis (on-demand, cached): cyclomatic complexity, maintainability
 *      index, coupling, Halstead metrics, violations
 *
 * Zero dependencies — uses only Node.js built-in modules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ── Helpers ──────────────────────────────────────────────────

function walkFiles(
  dir: string,
  extensions: string[],
  exclude: string[] = ["node_modules", ".git", "dist", "build"]
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!exclude.includes(entry.name)) {
        results.push(...walkFiles(fullPath, extensions, exclude));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (
        extensions.includes(ext) &&
        !entry.name.endsWith(".d.ts")
      ) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function relativePath(filePath: string): string {
  return path.relative(".", filePath);
}

// ── Test file detection ─────────────────────────────────────

function hasMatchingTest(relPath: string): boolean {
  const name = relPath.split('/').pop()?.replace('.ts', '').replace('.js', '') || '';
  const patterns = [
    `test/${name}.test.ts`,
    `${relPath.replace('.ts', '.test.ts').replace('.js', '.test.js')}`,
    `tests/${name}.test.ts`,
  ];
  return patterns.some(p => fs.existsSync(p));
}

// ── Line counting ────────────────────────────────────────────

interface LineCounts {
  loc: number;
  blank: number;
  comment: number;
}

function countLines(source: string): LineCounts {
  const lines = source.split("\n");
  let loc = 0;
  let blank = 0;
  let comment = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const stripped = line.trim();

    if (!stripped) {
      blank++;
      continue;
    }

    if (inBlockComment) {
      comment++;
      if (stripped.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }

    if (stripped.startsWith("/*")) {
      comment++;
      if (!stripped.includes("*/") || stripped.endsWith("/*")) {
        inBlockComment = true;
      }
      continue;
    }

    if (stripped.startsWith("//")) {
      comment++;
      continue;
    }

    loc++;
  }

  return { loc, blank, comment };
}

// ── Class & function counting (quick) ────────────────────────

function countClassesQuick(source: string): number {
  // Match class declarations: class Foo, export class Foo, abstract class Foo
  const matches = source.match(
    /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/g
  );
  return matches ? matches.length : 0;
}

function countFunctionsQuick(source: string): number {
  let count = 0;
  // function declarations: function foo(, async function foo(, export function foo(
  const funcDecls = source.match(
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/g
  );
  if (funcDecls) count += funcDecls.length;

  // Method declarations inside classes: name(, async name(, static name(, get name(, set name(
  const methods = source.match(
    /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/g
  );
  if (methods) count += methods.length;

  // Arrow functions assigned to const/let/var
  const arrows = source.match(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/g
  );
  if (arrows) count += arrows.length;

  return count;
}

// ── Cyclomatic complexity ────────────────────────────────────

function cycloMaticComplexity(funcBody: string): number {
  let cc = 1;

  // Count decision points via regex
  // if statements (not inside strings ideally, but regex-based is approximate)
  const patterns: [RegExp, number][] = [
    [/\bif\s*\(/g, 1],
    [/\belse\s+if\s*\(/g, 1],
    [/\bcase\s+/g, 1],
    [/\bfor\s*\(/g, 1],
    [/\bwhile\s*\(/g, 1],
    [/\bdo\s*\{/g, 1],
    [/\bcatch\s*\(/g, 1],
    [/&&/g, 1],
    [/\|\|/g, 1],
    [/\?\?/g, 1],
    // Ternary ? — but not ?. (optional chaining) and not ?: in type annotations
    [/[^?]\?[^?.:\s]/g, 1],
  ];

  for (const [pattern, weight] of patterns) {
    const matches = funcBody.match(pattern);
    if (matches) cc += matches.length * weight;
  }

  return cc;
}

// ── Function extraction (regex-based) ─────────────────────────

interface FunctionInfo {
  name: string;
  line: number;
  complexity: number;
  loc: number;
  args: string[];
  file?: string;
}

function extractFunctions(source: string, filePath: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = source.split("\n");

  // Patterns to match function/method declarations
  const patterns = [
    // function name(args) or async function name(args)
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
    // Class method: name(args) { or async name(args) {
    /(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/,
    // Arrow: const name = (args) => or const name = async (args) =>
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*=>/,
  ];

  // Track which class we're in
  let currentClass: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();

    // Detect class entry
    const classMatch = stripped.match(
      /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/
    );
    if (classMatch) {
      currentClass = classMatch[1];
    }

    for (const pattern of patterns) {
      const match = stripped.match(pattern);
      if (match && match[1]) {
        const funcName = match[1];

        // Skip keywords that look like function calls
        if (
          ["if", "for", "while", "switch", "catch", "return", "new", "class", "import", "export", "from", "constructor"].includes(funcName) &&
          !stripped.includes("constructor")
        ) {
          if (funcName !== "constructor") continue;
        }

        // Handle constructor specifically
        const displayName =
          funcName === "constructor" && currentClass
            ? `${currentClass}.constructor`
            : currentClass && !stripped.startsWith("function") &&
              !stripped.startsWith("export function") &&
              !stripped.startsWith("async function") &&
              !stripped.startsWith("export async function") &&
              !stripped.startsWith("const ") &&
              !stripped.startsWith("let ") &&
              !stripped.startsWith("var ") &&
              !stripped.startsWith("export const ") &&
              !stripped.startsWith("export let ")
            ? `${currentClass}.${funcName}`
            : funcName;

        // Extract function body by brace matching
        const funcBody = extractFunctionBody(lines, i);
        const funcLoc = funcBody.split("\n").length;
        const complexity = cycloMaticComplexity(funcBody);

        // Parse args
        const argsStr = match[2] || "";
        const args = argsStr
          .split(",")
          .map((a) => a.trim().split(":")[0].split("=")[0].replace("?", "").trim())
          .filter((a) => a && a !== "this");

        functions.push({
          name: displayName,
          line: i + 1,
          complexity,
          loc: funcLoc,
          args,
          file: relativePath(filePath),
        });

        break; // Only match first pattern per line
      }
    }

    // Detect class exit (simple heuristic: closing brace at column 0)
    if (
      currentClass &&
      stripped === "}" &&
      line.match(/^\}/) // brace at start of line
    ) {
      currentClass = null;
    }
  }

  return functions;
}

function extractFunctionBody(lines: string[], startLine: number): string {
  let braceCount = 0;
  let started = false;
  const bodyLines: string[] = [];

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    bodyLines.push(line);

    for (const ch of line) {
      if (ch === "{") {
        braceCount++;
        started = true;
      } else if (ch === "}") {
        braceCount--;
      }
    }

    if (started && braceCount <= 0) {
      break;
    }

    // Safety: limit to 1000 lines
    if (bodyLines.length > 1000) break;
  }

  // For arrow functions without braces, just take the line
  if (!started) {
    return bodyLines.join("\n");
  }

  return bodyLines.join("\n");
}

// ── Import extraction ────────────────────────────────────────

function extractImports(source: string): string[] {
  const imports: string[] = [];

  // import ... from "module"
  const esImports = source.matchAll(
    /import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g
  );
  for (const match of esImports) {
    imports.push(match[1]);
  }

  // import "module" (side-effect)
  const sideEffects = source.matchAll(/import\s+["']([^"']+)["']/g);
  for (const match of sideEffects) {
    imports.push(match[1]);
  }

  // require("module")
  const requires = source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g);
  for (const match of requires) {
    imports.push(match[1]);
  }

  // Deduplicate
  return [...new Set(imports)];
}

// ── Halstead metrics ─────────────────────────────────────────

interface HalsteadStats {
  operators: number;
  operands: number;
  uniqueOperators: Set<string>;
  uniqueOperands: Set<string>;
}

function countHalstead(source: string): HalsteadStats {
  const stats: HalsteadStats = {
    operators: 0,
    operands: 0,
    uniqueOperators: new Set(),
    uniqueOperands: new Set(),
  };

  // Operators
  const operatorPatterns = [
    /[+\-*/%]=?/g,
    /[<>!=]=?=?/g,
    /&&/g,
    /\|\|/g,
    /\?\?/g,
    /\.\.\./g,
    /\b(typeof|instanceof|void|delete|in|of|new|yield|await)\b/g,
  ];

  for (const pat of operatorPatterns) {
    const matches = source.match(pat);
    if (matches) {
      for (const m of matches) {
        stats.operators++;
        stats.uniqueOperators.add(m);
      }
    }
  }

  // Operands: identifiers and literals
  const identifiers = source.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g);
  if (identifiers) {
    const keywords = new Set([
      "if", "else", "for", "while", "do", "switch", "case", "break",
      "continue", "return", "function", "class", "const", "let", "var",
      "import", "export", "from", "default", "try", "catch", "finally",
      "throw", "new", "delete", "typeof", "instanceof", "void", "in",
      "of", "async", "await", "yield", "this", "super", "true", "false",
      "null", "undefined", "extends", "implements", "interface", "type",
      "enum", "public", "private", "protected", "static", "abstract",
      "readonly", "as", "is", "keyof", "infer", "never", "unknown",
      "any", "string", "number", "boolean", "symbol", "bigint", "object",
    ]);
    for (const id of identifiers) {
      if (!keywords.has(id)) {
        stats.operands++;
        stats.uniqueOperands.add(id);
      }
    }
  }

  // Number literals
  const numbers = source.match(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/g);
  if (numbers) {
    for (const n of numbers) {
      stats.operands++;
      stats.uniqueOperands.add(n);
    }
  }

  // String literals
  const strings = source.match(
    /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g
  );
  if (strings) {
    for (const s of strings) {
      stats.operands++;
      stats.uniqueOperands.add(s.substring(0, 50));
    }
  }

  return stats;
}

// ── Maintainability Index ────────────────────────────────────

function maintainabilityIndex(
  halsteadVolume: number,
  avgCC: number,
  loc: number
): number {
  if (loc <= 0) return 100.0;
  const v = Math.max(halsteadVolume, 1);
  const mi =
    171 - 5.2 * Math.log(v) - 0.23 * avgCC - 16.2 * Math.log(loc);
  return Math.max(0, Math.min(100, (mi * 100) / 171));
}

// ── Violations ───────────────────────────────────────────────

interface Violation {
  type: "error" | "warning";
  rule: string;
  message: string;
  file: string;
  line: number;
}

function detectViolations(
  functions: FunctionInfo[],
  fileMetrics: Record<string, any>[]
): Violation[] {
  const violations: Violation[] = [];

  for (const f of functions) {
    if (f.complexity > 20) {
      violations.push({
        type: "error",
        rule: "high_complexity",
        message: `${f.name} has cyclomatic complexity ${f.complexity} (max 20)`,
        file: f.file || "",
        line: f.line,
      });
    } else if (f.complexity > 10) {
      violations.push({
        type: "warning",
        rule: "moderate_complexity",
        message: `${f.name} has cyclomatic complexity ${f.complexity} (recommended max 10)`,
        file: f.file || "",
        line: f.line,
      });
    }
  }

  for (const fm of fileMetrics) {
    if (fm.loc > 500) {
      violations.push({
        type: "warning",
        rule: "large_file",
        message: `${fm.path} has ${fm.loc} LOC (recommended max 500)`,
        file: fm.path,
        line: 1,
      });
    }
    if (fm.functions > 20) {
      violations.push({
        type: "warning",
        rule: "too_many_functions",
        message: `${fm.path} has ${fm.functions} functions (recommended max 20)`,
        file: fm.path,
        line: 1,
      });
    }
    if (fm.maintainability < 20) {
      violations.push({
        type: "error",
        rule: "low_maintainability",
        message: `${fm.path} has maintainability index ${fm.maintainability} (min 20)`,
        file: fm.path,
        line: 1,
      });
    } else if (fm.maintainability < 40) {
      violations.push({
        type: "warning",
        rule: "moderate_maintainability",
        message: `${fm.path} has maintainability index ${fm.maintainability} (recommended min 40)`,
        file: fm.path,
        line: 1,
      });
    }
  }

  violations.sort((a, b) => {
    const typeDiff = (a.type === "error" ? 0 : 1) - (b.type === "error" ? 0 : 1);
    if (typeDiff !== 0) return typeDiff;
    return a.file.localeCompare(b.file);
  });

  return violations;
}

// ── Root Resolution ──────────────────────────────────────────

/**
 * Pick the right directory to scan.
 *
 * If the root dir has .ts files, scan the user's project code.
 * Otherwise, scan the framework itself — so the bubble chart is never empty.
 */
function resolveRoot(root: string = "src"): string {
  const rootPath = path.resolve(root);
  if (fs.existsSync(rootPath) && walkFiles(rootPath, [".ts", ".js"]).length > 0) {
    return root;
  }
  // Fallback: scan the framework package itself
  return path.resolve(path.dirname(new URL(import.meta.url).pathname));
}

// ── Quick Metrics ────────────────────────────────────────────

export function quickMetrics(root: string = "src"): Record<string, any> {
  root = resolveRoot(root);
  const rootPath = path.resolve(root);
  if (!fs.existsSync(rootPath)) {
    return { error: `Directory not found: ${root}` };
  }

  const tsFiles = walkFiles(rootPath, [".ts", ".js"]);
  const twigFiles = walkFiles(rootPath, [".twig", ".html"]);

  const migrationsDir = path.resolve("migrations");
  const migrationFiles = [
    ...walkFiles(migrationsDir, [".sql"]),
    ...walkFiles(migrationsDir, [".ts"]),
  ];

  const scssFiles = walkFiles(rootPath, [".scss", ".css"]);

  let totalLoc = 0;
  let totalBlank = 0;
  let totalComment = 0;
  let totalClasses = 0;
  let totalFunctions = 0;
  const fileDetails: Record<string, any>[] = [];

  for (const f of tsFiles) {
    const source = readFileSafe(f);
    if (source === null) continue;

    const counts = countLines(source);
    const classes = countClassesQuick(source);
    const functions = countFunctionsQuick(source);

    totalLoc += counts.loc;
    totalBlank += counts.blank;
    totalComment += counts.comment;
    totalClasses += classes;
    totalFunctions += functions;

    fileDetails.push({
      path: relativePath(f),
      loc: counts.loc,
      blank: counts.blank,
      comment: counts.comment,
      classes,
      functions,
    });
  }

  // Sort by LOC descending
  fileDetails.sort((a, b) => b.loc - a.loc);

  // Route and ORM counts (scan for decorators/patterns)
  let routeCount = 0;
  let ormCount = 0;

  for (const f of tsFiles) {
    const source = readFileSafe(f);
    if (source === null) continue;

    // Count route registrations: router.get(, router.post(, @get(, @post(, etc.
    const routes = source.match(
      /(?:router\s*\.\s*(?:get|post|put|delete|patch|any)\s*\(|@(?:get|post|put|delete|patch)\s*\()/g
    );
    if (routes) routeCount += routes.length;

    // Count ORM models: extends ORM, extends Model
    const orms = source.match(
      /class\s+\w+\s+extends\s+(?:ORM|Model)\b/g
    );
    if (orms) ormCount += orms.length;
  }

  const breakdown: Record<string, number> = {
    typescript: tsFiles.filter((f) => f.endsWith(".ts")).length,
    javascript: tsFiles.filter((f) => f.endsWith(".js")).length,
    templates: twigFiles.length,
    migrations: migrationFiles.length,
    stylesheets: scssFiles.length,
  };

  return {
    file_count: tsFiles.length,
    total_loc: totalLoc,
    total_blank: totalBlank,
    total_comment: totalComment,
    lloc: totalLoc,
    classes: totalClasses,
    functions: totalFunctions,
    route_count: routeCount,
    orm_count: ormCount,
    template_count: twigFiles.length,
    migration_count: migrationFiles.length,
    avg_file_size: tsFiles.length > 0 ? Math.round((totalLoc / tsFiles.length) * 10) / 10 : 0,
    largest_files: fileDetails.slice(0, 10),
    breakdown,
  };
}

// ── Full Analysis (cached) ───────────────────────────────────

let _fullCache: { hash: string; data: Record<string, any> | null; time: number } = {
  hash: "",
  data: null,
  time: 0,
};
const _CACHE_TTL = 60; // seconds

function filesHash(root: string = "src"): string {
  const h = crypto.createHash("md5");
  const rootPath = path.resolve(root);
  if (fs.existsSync(rootPath)) {
    const files = walkFiles(rootPath, [".ts", ".js"]).sort();
    for (const f of files) {
      try {
        const stat = fs.statSync(f);
        h.update(`${f}:${stat.mtimeMs}`);
      } catch {
        // skip
      }
    }
  }
  return h.digest("hex");
}

export function fullAnalysis(root: string = "src"): Record<string, any> {
  root = resolveRoot(root);
  const currentHash = filesHash(root);
  const now = Date.now() / 1000;

  if (
    _fullCache.hash === currentHash &&
    _fullCache.data !== null &&
    now - _fullCache.time < _CACHE_TTL
  ) {
    return _fullCache.data;
  }

  const rootPath = path.resolve(root);
  if (!fs.existsSync(rootPath)) {
    return { error: `Directory not found: ${root}` };
  }

  const tsFiles = walkFiles(rootPath, [".ts", ".js"]);

  const allFunctions: FunctionInfo[] = [];
  const fileMetrics: Record<string, any>[] = [];
  const importGraph: Record<string, string[]> = {};
  const reverseGraph: Record<string, string[]> = {};

  for (const f of tsFiles) {
    const source = readFileSafe(f);
    if (source === null) continue;

    const relPath = relativePath(f);
    const lines = source.split("\n");
    const loc = lines.filter(
      (l) => l.trim() && !l.trim().startsWith("//")
    ).length;

    // Extract imports for coupling analysis
    const imports = extractImports(source);
    importGraph[relPath] = imports;

    for (const imp of imports) {
      if (!reverseGraph[imp]) {
        reverseGraph[imp] = [];
      }
      reverseGraph[imp].push(relPath);
    }

    // Analyze functions/methods
    const fileFunctions = extractFunctions(source, f);
    let fileComplexity = 0;

    for (const func of fileFunctions) {
      fileComplexity += func.complexity;
      allFunctions.push(func);
    }

    // Halstead
    const halstead = countHalstead(source);
    const n1 = halstead.uniqueOperators.size;
    const n2 = halstead.uniqueOperands.size;
    const N1 = halstead.operators;
    const N2 = halstead.operands;
    const vocabulary = n1 + n2;
    const length = N1 + N2;
    const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;

    // Maintainability index
    const avgCC =
      fileFunctions.length > 0
        ? fileComplexity / fileFunctions.length
        : 0;
    const mi = maintainabilityIndex(volume, avgCC, loc);

    // Coupling
    const ce = imports.length; // efferent
    const ca = (reverseGraph[relPath] || []).length; // afferent
    const instability = ca + ce > 0 ? ce / (ca + ce) : 0.0;

    fileMetrics.push({
      path: relPath,
      loc,
      complexity: fileComplexity,
      avg_complexity: Math.round(avgCC * 100) / 100,
      functions: fileFunctions.length,
      maintainability: Math.round(mi * 10) / 10,
      halstead_volume: Math.round(volume * 10) / 10,
      coupling_afferent: ca,
      coupling_efferent: ce,
      instability: Math.round(instability * 1000) / 1000,
      has_tests: hasMatchingTest(relPath),
      dep_count: ce,
    });
  }

  // Sort: functions by complexity descending, files by maintainability ascending (worst first)
  allFunctions.sort((a, b) => b.complexity - a.complexity);
  fileMetrics.sort((a, b) => a.maintainability - b.maintainability);

  // Violations
  const violations = detectViolations(allFunctions, fileMetrics);

  // Overall averages
  const totalCC = allFunctions.reduce((sum, f) => sum + f.complexity, 0);
  const avgCC = allFunctions.length > 0 ? totalCC / allFunctions.length : 0;
  const totalMI = fileMetrics.reduce((sum, f) => sum + f.maintainability, 0);
  const avgMI = fileMetrics.length > 0 ? totalMI / fileMetrics.length : 0;

  // Detect if we're scanning framework or project
  const frameworkDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  const scanningFramework = rootPath === frameworkDir || rootPath.startsWith(frameworkDir + path.sep);

  const result: Record<string, any> = {
    files_analyzed: fileMetrics.length,
    total_functions: allFunctions.length,
    avg_complexity: Math.round(avgCC * 100) / 100,
    avg_maintainability: Math.round(avgMI * 10) / 10,
    most_complex_functions: allFunctions.slice(0, 15),
    file_metrics: fileMetrics,
    violations,
    dependency_graph: importGraph,
    scan_mode: scanningFramework ? "framework" : "project",
    scan_root: rootPath,
  };

  _fullCache = { hash: currentHash, data: result, time: now };
  return result;
}

// ── File Detail ──────────────────────────────────────────────

export function fileDetail(filePath: string): Record<string, any> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { error: `File not found: ${filePath}` };
  }

  const source = readFileSafe(resolved);
  if (source === null) {
    return { error: `Could not read file: ${filePath}` };
  }

  const lines = source.split("\n");
  const loc = lines.filter(
    (l) => l.trim() && !l.trim().startsWith("//")
  ).length;

  const classes = countClassesQuick(source);
  const functions = extractFunctions(source, resolved);
  const imports = extractImports(source);

  // Sort functions by complexity descending
  functions.sort((a, b) => b.complexity - a.complexity);

  // Remove file field from function info for single-file detail
  const cleanFunctions = functions.map(({ file, ...rest }) => rest);

  // Detect empty methods/functions (loc <= 1 means only a brace or pass-through)
  const warnings: { type: string; message: string; line: number }[] = [];
  for (const fn of cleanFunctions) {
    if (fn.loc <= 1) {
      warnings.push({
        type: "empty_method",
        message: `Method '${fn.name}' appears to be empty`,
        line: fn.line,
      });
    }
  }

  return {
    path: filePath,
    loc,
    total_lines: lines.length,
    classes,
    functions: cleanFunctions,
    imports,
    warnings,
  };
}

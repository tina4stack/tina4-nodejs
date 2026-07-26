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

function relativePath(filePath: string, root: string = "."): string {
  return path.relative(root, filePath);
}

// Stores the resolved scan root so fileDetail() can locate framework files.
let _lastScanRoot = "";

// ── Test file detection ─────────────────────────────────────

/** Escape a string for safe embedding inside a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Top-level classes DEFINED in a source file. A test that references one of
 * these genuinely exercises this file. Classes only (distinctive PascalCase,
 * length > 2 — so short-but-real names like `ORM`/`Api`/`Log`/`Env` count) —
 * module-level function names like `get`/`run`/`init` are too generic to trust
 * as a coverage signal.
 */
function definedClasses(source: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    // length > 2 (NOT > 3): a 3-char class like ORM/Api/Log/Env is a genuine,
    // distinctive coverage signal — the old > 3 gate silently dropped them so a
    // test that references `new Api()` / `Log.error()` left the file "untested".
    if (name && !name.startsWith("_") && name.length > 2) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Whether a source file has a test that ACTUALLY exercises it.
 *
 * PRECISE detection — a bare word-mention of the module name is NOT enough
 * (that over-reported badly: a default DB adapter looked "tested" because some
 * test merely said the word "sqlite"). A file counts as covered only on a real,
 * file-specific signal:
 *
 *   1. Filename — a dedicated test file named for THIS exact module
 *      (`<m>.test.ts/.js`, `<m>.spec.ts/.js`, `test_<m>.*`, `<m>_test.*`,
 *      `<m>_spec.*`) — NOT the parent directory (one `database.test.ts` must
 *      not mark every file under `adapters/` tested).
 *   2. Import — a test that actually IMPORTS this module by its path
 *      (`import … from ".../<m>.js"`, `require(".../<m>")`).
 *   3. Class reference — a test that references a top-level class DEFINED in
 *      this file (distinctive PascalCase, length > 2 — short-but-real names
 *      like ORM/Api/Log/Env count). NO bare module-name word match and NO
 *      guessed CamelCase-from-snake_case match.
 *
 * Returns true only on a real signal, so the "untested" offenders surfaced by
 * `tina4 metrics` and the dashboard "T" badge are trustworthy.
 */
function hasMatchingTest(relPath: string): boolean {
  const parts = relPath.split("/");
  const basename = parts[parts.length - 1] || "";
  const name = basename.replace(/\.(ts|js)$/, "");

  // Classes defined in THIS file (read from the resolved on-disk file).
  let symbols = new Set<string>();
  const srcFile = _lastScanRoot ? path.join(_lastScanRoot, relPath) : relPath;
  const srcText = readFileSafe(srcFile) ?? readFileSafe(relPath);
  if (srcText !== null) {
    symbols = definedClasses(srcText);
  }

  // Search CWD and (in framework-fallback mode) the repo root that owns test/.
  const searchRoots = [process.cwd()];
  if (_lastScanRoot && _lastScanRoot !== process.cwd()) {
    let repoRoot = _lastScanRoot;
    for (let i = 0; i < 5; i++) {
      if (
        fs.existsSync(path.join(repoRoot, "test")) ||
        fs.existsSync(path.join(repoRoot, "tests")) ||
        fs.existsSync(path.join(repoRoot, "spec"))
      ) {
        searchRoots.push(repoRoot);
        break;
      }
      const parent = path.dirname(repoRoot);
      if (parent === repoRoot) break;
      repoRoot = parent;
    }
  }

  const testDirs = ["test", "tests", "spec"];

  // Stage 1: a dedicated test FILE named for THIS module (no parent-dir blanket).
  for (const root of searchRoots) {
    for (const td of testDirs) {
      const patterns = [
        path.join(root, td, `${name}.test.ts`),
        path.join(root, td, `${name}.test.js`),
        path.join(root, td, `${name}.spec.ts`),
        path.join(root, td, `${name}.spec.js`),
        path.join(root, td, `test_${name}.ts`),
        path.join(root, td, `test_${name}.js`),
        path.join(root, td, `${name}_test.ts`),
        path.join(root, td, `${name}_test.js`),
        path.join(root, td, `${name}_spec.ts`),
        path.join(root, td, `${name}_spec.js`),
      ];
      if (patterns.some((p) => fs.existsSync(p))) return true;
    }
  }

  // Stage 2+3: a test that actually IMPORTS this module (by path), or references
  // a class DEFINED in it. NO bare word-of-the-module-name match.
  // A module specifier whose final path segment is exactly this module name:
  //   "./<name>", "../a/b/<name>.js", "@pkg/<name>" — but NOT "better-<name>"
  //   (the segment boundary is the opening quote or a "/", never a hyphen/word
  //   char). Optional .ts/.js extension.
  const spec = `["'](?:[^"']*\\/)?${escapeRegExp(name)}(?:\\.(?:ts|js))?["']`;
  const importRes: RegExp[] = [
    // import ... from "<spec>"
    new RegExp(`import\\b[^;\\n]*?from\\s*${spec}`),
    // require("<spec>")
    new RegExp(`require\\s*\\(\\s*${spec}\\s*\\)`),
    // dynamic / inline-type import("<spec>") — covers `await import("…/m.js")`
    // AND the TS inline type position `import("…/m.ts").SomeType`. The full
    // package path a test uses ("../packages/core/src/<m>.ts") matches as a
    // SUFFIX via the leading `(?:[^"']*\/)?` in <spec>.
    new RegExp(`import\\s*\\(\\s*${spec}\\s*\\)`),
    // side-effect import "<spec>"
    new RegExp(`import\\s*${spec}`),
  ];

  let classRe: RegExp | null = null;
  if (symbols.size > 0) {
    const alt = [...symbols].map(escapeRegExp).join("|");
    classRe = new RegExp(`\\b(?:${alt})\\b`);
  }

  for (const root of searchRoots) {
    for (const td of testDirs) {
      const fullTd = path.join(root, td);
      if (!fs.existsSync(fullTd)) continue;
      const testFiles = walkFiles(fullTd, [".ts", ".js"]);
      for (const testFile of testFiles) {
        // Never let a file count as its own test.
        if (path.resolve(testFile) === path.resolve(srcFile)) continue;
        const content = readFileSafe(testFile);
        if (content === null) continue;
        if (importRes.some((re) => re.test(content))) return true;
        if (classRe && classRe.test(content)) return true;
      }
    }
  }

  return false;
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

// ── Literal / comment stripping ──────────────────────────────

/**
 * Replace the CONTENTS of string literals, template literals (including
 * interpolations), regex literals, and both comment styles with neutral
 * placeholder characters (spaces), preserving newlines so line numbers and
 * structure stay intact. The surrounding delimiters are kept.
 *
 * This is the regex-based stand-in for Python's AST: the decision-point
 * patterns and the function-extraction patterns must only ever see real code,
 * never text that happens to live inside a string, template, regex, line
 * comment or block comment. Without this, a string full of boolean operators
 * or a regex inflates complexity and yields bogus "functions".
 *
 * Regex-vs-division is resolved conservatively: a slash only starts a regex
 * when the previous significant token can't end an expression (an operator,
 * keyword, open bracket, comma, semicolon, etc.). When in doubt we treat the
 * slash as division and DON'T strip — favouring "leave code intact" over
 * "wrongly blank out a division", per the brief.
 */
function stripLiterals(source: string): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;

  // The last non-whitespace, non-comment character we EMITTED as real code —
  // used to decide whether a `/` opens a regex or is a division operator.
  let prevSignificant = "";
  // The last "word" token (identifier/keyword) emitted, for keyword checks.
  let prevWord = "";

  /** Keywords after which a `/` is a regex, not division. */
  const regexKeywords = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "case", "do", "else", "yield", "await",
  ]);

  /** Can the previous significant token end an expression? If so, `/` = division. */
  function prevEndsExpression(): boolean {
    if (prevSignificant === "") return false; // start of input → regex
    // Identifier/number ending char → could be a value → division …
    if (/[A-Za-z0-9_$]/.test(prevSignificant)) {
      // …unless it's a keyword like `return`/`case` that precedes a regex.
      return !regexKeywords.has(prevWord);
    }
    // Closing brackets and these chars end an expression → division.
    if (prevSignificant === ")" || prevSignificant === "]") return true;
    // `.` (member access) ends an expression-ish context → division ( `a./` is odd, treat as div).
    if (prevSignificant === ".") return true;
    // Everything else (operators, `(`, `,`, `{`, `[`, `;`, `:`, `=`, `<`, `>`, `&`,
    // `|`, `!`, `?`, `+`, `-`, `*`, `%`, `^`, `~`) → regex context.
    return false;
  }

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : "";

    // ── Line comment ──
    if (ch === "/" && next === "/") {
      out.push("//");
      i += 2;
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    // ── Block comment ──
    if (ch === "/" && next === "*") {
      out.push("/*");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("*/");
        i += 2;
      }
      continue;
    }

    // ── String literals ' " ──
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out.push(quote);
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out.push("  "); // blank the escape pair, stay 2 chars wide
          i += 2;
          continue;
        }
        if (source[i] === "\n") {
          out.push("\n"); // unterminated string safety
          i++;
          break;
        }
        out.push(" ");
        i++;
      }
      if (i < n && source[i] === quote) {
        out.push(quote);
        i++;
      }
      prevSignificant = quote;
      prevWord = "";
      continue;
    }

    // ── Template literals ` ` (with ${ ... } interpolation, recursively code) ──
    if (ch === "`") {
      out.push("`");
      i++;
      while (i < n && source[i] !== "`") {
        if (source[i] === "\\" && i + 1 < n) {
          out.push(source[i + 1] === "\n" ? " \n" : "  ");
          i += 2;
          continue;
        }
        // Interpolation: ${ ... } — the inside IS real code, recurse on it.
        if (source[i] === "$" && source[i + 1] === "{") {
          out.push("${");
          i += 2;
          let depth = 1;
          const exprStart = i;
          while (i < n && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            if (depth === 0) break;
            i++;
          }
          // Strip literals INSIDE the interpolation too (handles nested strings/regex).
          out.push(stripLiterals(source.slice(exprStart, i)));
          if (i < n && source[i] === "}") {
            out.push("}");
            i++;
          }
          continue;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n && source[i] === "`") {
        out.push("`");
        i++;
      }
      prevSignificant = "`";
      prevWord = "";
      continue;
    }

    // ── Regex literal / vs division ──
    if (ch === "/" && !prevEndsExpression()) {
      // Scan a regex literal: /.../flags, honouring escapes and [...] classes.
      let j = i + 1;
      let ok = false;
      let inClass = false;
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break; // regex can't span a newline → not a regex
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        out.push("/");
        for (let k = i + 1; k < j; k++) out.push(" ");
        out.push("/");
        i = j + 1;
        // consume flags
        while (i < n && /[a-z]/i.test(source[i])) {
          out.push(source[i]);
          i++;
        }
        prevSignificant = "/"; // a regex value ends an expression-ish slot
        prevWord = "";
        continue;
      }
      // Not a regex — fall through, emit `/` as division.
    }

    // ── Ordinary code char ──
    out.push(ch);
    if (!/\s/.test(ch)) {
      prevSignificant = ch;
      if (/[A-Za-z0-9_$]/.test(ch)) {
        prevWord = /[A-Za-z0-9_$]/.test(source[i - 1] ?? "") ? prevWord + ch : ch;
      } else {
        prevWord = "";
      }
    }
    i++;
  }

  return out.join("");
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
  // Count on cleaned source so `something(...)` inside a string/regex/comment is
  // never mistaken for a method (the chief source of the old over-count).
  const clean = stripLiterals(source);
  let count = 0;
  // function declarations: function foo(, async function foo(, export function foo(
  const funcDecls = clean.match(
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/g
  );
  if (funcDecls) count += funcDecls.length;

  // Method declarations inside classes: name(, async name(, static name(, get name(, set name(
  const methods = clean.match(
    /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/g
  );
  if (methods) count += methods.length;

  // Arrow functions assigned to const/let/var
  const arrows = clean.match(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/g
  );
  if (arrows) count += arrows.length;

  return count;
}

// ── Cyclomatic complexity ────────────────────────────────────

function cycloMaticComplexity(funcBody: string): number {
  let cc = 1;

  // Decision points must be counted on REAL code only — strip string/template/
  // regex literals and comments first so `&&`/`if`/`? :` inside data don't inflate
  // the count (matches the intent of Python's AST-based analyzer).
  const body = stripLiterals(funcBody);

  // Count decision points via regex.
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
    const matches = body.match(pattern);
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

/**
 * Reserved words that look like `keyword(...)` (a call/control-flow head) but are
 * NEVER a function declaration. Guards the loose class-method pattern from
 * extracting `if (...)`, `for (...)`, `return (...)`, `await foo()` etc. as
 * "functions" (the bogus-name source).
 */
const NON_FUNCTION_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "class", "import",
  "export", "from", "do", "else", "typeof", "instanceof", "in", "of", "void",
  "delete", "await", "yield", "throw", "super", "this", "function", "const",
  "let", "var", "async", "static", "public", "private", "protected", "get",
  "set", "type", "interface", "enum", "extends", "implements", "as", "case",
  "default", "with", "debugger",
]);

function extractFunctions(source: string, filePath: string, root: string = "."): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  // Detect/extract on LITERAL-STRIPPED source only — a `word(...)` or a bogus
  // name like "name"/"if" living inside a string/template/regex/comment is now
  // blanked out, so it can never be mistaken for a declaration. Newlines are
  // preserved, so line numbers and the brace-matched body stay accurate.
  const lines = stripLiterals(source).split("\n");

  // Patterns — anchored at the START of the trimmed line so a mid-line call can
  // never match. Only real declaration shapes are accepted.
  // 1) function name(args) / async function name(args) / export …
  const fnDecl = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(([^)]*)\)/;
  // 2) Arrow assigned to a binding: const name = (args) => / = async (args) =>
  const arrowDecl = /^(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*=>/;
  // 3) A class member: optional modifiers then name(args) … {  — only trusted
  //    when we're inside a class body, OR a modifier keyword is present.
  const methodMod = /^(?:(public|private|protected)\s+)?(?:(static)\s+)?(?:(async)\s+)?(?:(get|set)\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?\s*\{/;

  // Track which class we're in
  let currentClass: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();

    // Detect class entry
    const classMatch = stripped.match(
      /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/
    );
    if (classMatch) {
      currentClass = classMatch[1];
    }

    let funcName: string | null = null;
    let argsStr = "";
    let isTopLevelDecl = false; // function/arrow at module/top scope (not class-qualified)

    // 1) function declaration
    let m = stripped.match(fnDecl);
    if (m) {
      funcName = m[1];
      argsStr = m[2] || "";
      isTopLevelDecl = true;
    }

    // 2) arrow binding
    if (funcName === null) {
      m = stripped.match(arrowDecl);
      if (m) {
        funcName = m[1];
        argsStr = m[2] || "";
        isTopLevelDecl = true;
      }
    }

    // 3) class method (only with a modifier, or while inside a class)
    if (funcName === null) {
      m = stripped.match(methodMod);
      if (m) {
        const hasModifier = !!(m[1] || m[2] || m[3] || m[4]);
        const candidate = m[5];
        // Accept only a genuine member: needs a modifier OR an enclosing class.
        // Never accept a reserved control-flow / declaration keyword.
        if (
          candidate &&
          !NON_FUNCTION_WORDS.has(candidate) &&
          (hasModifier || currentClass !== null)
        ) {
          funcName = candidate;
          argsStr = m[6] || "";
        }
      }
    }

    if (funcName !== null && !NON_FUNCTION_WORDS.has(funcName)) {
      // Constructor / class-qualified display name.
      const displayName =
        funcName === "constructor" && currentClass
          ? `${currentClass}.constructor`
          : currentClass !== null && !isTopLevelDecl
            ? `${currentClass}.${funcName}`
            : funcName;

      // Extract function body by brace matching (on cleaned lines).
      const funcBody = extractFunctionBody(lines, i);
      const funcLoc = funcBody.split("\n").length;
      const complexity = cycloMaticComplexity(funcBody);

      // Parse args
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
        file: relativePath(filePath, root),
      });
    }

    // Detect class exit (simple heuristic: closing brace at column 0)
    if (
      currentClass &&
      stripped === "}" &&
      /^\}/.test(lines[i]) // brace at start of line
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
    _lastScanRoot = rootPath;
    return root;
  }
  // Fallback: scan the framework package itself
  const fwDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  _lastScanRoot = fwDir;
  return fwDir;
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
      path: relativePath(f, rootPath),
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

    const relPath = relativePath(f, rootPath);
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
    const fileFunctions = extractFunctions(source, f, rootPath);
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
    // Display-only: the top-15 for the "most complex functions" report.
    // Do NOT source offenders / --fail-on from this — capping here silently
    // hides the 16th+ over-threshold function from the gate. offenders()
    // reads "all_functions" (below) instead.
    most_complex_functions: allFunctions.slice(0, 15),
    // Full, uncapped, complexity-sorted list — offenders()/--fail-on use this
    // so no function over the complexity threshold ever escapes the gate.
    all_functions: allFunctions,
    file_metrics: fileMetrics,
    violations,
    dependency_graph: importGraph,
    scan_mode: scanningFramework ? "framework" : "project",
    scan_root: rootPath,
  };

  _fullCache = { hash: currentHash, data: result, time: now };
  return result;
}

// ── Top Offenders (CLI + dashboard) ──────────────────────────

/** Severity ranking for sorting (higher = more severe). */
export const SEVERITY_RANK: Record<string, number> = { error: 2, warn: 1, info: 0 };

export interface Offender {
  file: string;
  line: number;
  kind: string;
  severity: "error" | "warn" | "info";
  score: number;
  detail: string;
}

export interface OffendersResult {
  offenders: Offender[];
  summary: Record<string, any>;
}

/**
 * Rank the worst code-quality issues into a single "top offenders" list.
 *
 * Reuses {@link fullAnalysis} (does NOT re-analyze — the result is mtime-cached).
 * Each offender is `{ file, line, kind, severity, score, detail }`.
 *
 * Rules (one offender per matching condition — SAME scoring as the master):
 *   - function complexity > 10  → kind "complexity"
 *         severity "error" if > 20 else "warn"; score = complexity
 *   - file loc > 500            → kind "large_file" (warn); score = loc / 100
 *   - file functions > 20       → kind "too_many_functions" (warn); score = functions / 4
 *   - file maintainability < 40 → kind "low_maintainability"
 *         severity "error" if < 20 else "warn"; score = 50 - mi
 *   - file has_tests === false  → kind "untested" (info); score = loc / 100
 *
 * Sorted by (severity rank, score) DESCENDING and truncated to `top`.
 *
 * Returns `{ offenders, summary }` where summary carries the headline numbers
 * the CLI prints (files_analyzed, total_functions, avg_complexity,
 * avg_maintainability, scan_mode, scan_root, total_offenders).
 */
export function offenders(root: string = "src", top: number = 20): OffendersResult {
  const analysis = fullAnalysis(root);
  if (analysis.error) {
    return { offenders: [], summary: { error: analysis.error } };
  }

  const items: Offender[] = [];

  // Function-level: cyclomatic complexity. Use the FULL function list (not the
  // display-capped most_complex_functions[:15]) so a 16th+ over-threshold
  // function is never silently dropped from the offenders list or --fail-on.
  for (const fn of analysis.all_functions || analysis.most_complex_functions || []) {
    const cc: number = fn.complexity;
    if (cc > 10) {
      items.push({
        file: fn.file,
        line: fn.line,
        kind: "complexity",
        severity: cc > 20 ? "error" : "warn",
        score: cc,
        detail: `${fn.name} — cyclomatic complexity ${cc}`,
      });
    }
  }

  // File-level rules.
  for (const fm of analysis.file_metrics || []) {
    const filePath: string = fm.path;
    const loc: number = fm.loc;
    const funcs: number = fm.functions;
    const mi: number = fm.maintainability;

    if (loc > 500) {
      items.push({
        file: filePath,
        line: 1,
        kind: "large_file",
        severity: "warn",
        score: loc / 100,
        detail: `${loc} LOC (max 500)`,
      });
    }

    if (funcs > 20) {
      items.push({
        file: filePath,
        line: 1,
        kind: "too_many_functions",
        severity: "warn",
        score: funcs / 4,
        detail: `${funcs} functions (max 20)`,
      });
    }

    if (mi < 40) {
      items.push({
        file: filePath,
        line: 1,
        kind: "low_maintainability",
        severity: mi < 20 ? "error" : "warn",
        score: 50 - mi,
        detail: `maintainability index ${mi} (min 40)`,
      });
    }

    if (fm.has_tests === false) {
      items.push({
        file: filePath,
        line: 1,
        kind: "untested",
        severity: "info",
        score: loc / 100,
        detail: "no referencing test",
      });
    }
  }

  // Sort by (severity rank, score) DESCENDING.
  items.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.score - a.score;
  });

  const summary = {
    files_analyzed: analysis.files_analyzed,
    total_functions: analysis.total_functions,
    avg_complexity: analysis.avg_complexity,
    avg_maintainability: analysis.avg_maintainability,
    scan_mode: analysis.scan_mode,
    scan_root: analysis.scan_root,
    total_offenders: items.length,
  };

  return { offenders: items.slice(0, top), summary };
}

// ── File Detail ──────────────────────────────────────────────

export function fileDetail(filePath: string): Record<string, any> {
  let resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) && _lastScanRoot) {
    // Try resolving relative to the last scan root (framework mode)
    const candidate = path.resolve(_lastScanRoot, filePath);
    if (fs.existsSync(candidate)) {
      resolved = candidate;
      filePath = candidate;
    }
  }
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

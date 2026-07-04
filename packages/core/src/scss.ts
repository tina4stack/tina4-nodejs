// Tina4 SCSS — Zero-dependency SCSS-to-CSS compiler (subset).
// Supports variables, nesting, & parent selector, @import, @mixin/@include, comments, basic math.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";

// ── Types ────────────────────────────────────────────────────────

export interface ScssConfig {
  importPaths?: string[];
  variables?: Record<string, string>;
}

// ── ScssCompiler ─────────────────────────────────────────────────

export class ScssCompiler {
  private _importPaths: string[];
  private _variables: Record<string, string>;

  constructor(config?: ScssConfig) {
    this._importPaths = config?.importPaths ? [...config.importPaths] : [];
    this._variables = config?.variables ? { ...config.variables } : {};
  }

  /** Compile an SCSS string to CSS. */
  compile(source: string): string {
    return compileString(source, this._importPaths, { ...this._variables });
  }

  /** Compile an SCSS file to CSS. */
  compileFile(filePath: string): string {
    const absPath = resolve(filePath);
    const content = readFileSync(absPath, "utf-8");
    const paths = [dirname(absPath), ...this._importPaths];
    return compileString(content, paths, { ...this._variables });
  }

  /** Add a directory to the import resolution path. */
  addImportPath(path: string): void {
    this._importPaths.push(resolve(path));
  }

  /** Set or override an SCSS variable. */
  setVariable(name: string, value: string): void {
    // Strip leading $ if provided
    const key = name.startsWith("$") ? name.slice(1) : name;
    this._variables[key] = value;
  }

  /** Compile all .scss files in a directory into a single CSS output file. */
  compileScss(scssDir: string = "src/scss", output: string = "src/public/css/default.css", minify: boolean = false): string {
    const absDir = resolve(scssDir);
    if (!existsSync(absDir)) return "";

    // Collect non-partial .scss files, sorted
    const files = readdirSync(absDir)
      .filter((f) => f.endsWith(".scss") && !f.startsWith("_"))
      .sort()
      .map((f) => join(absDir, f));

    if (files.length === 0) return "";

    // Merge all files, resolving imports
    const paths = [absDir, ...this._importPaths];
    const imported = new Set<string>();
    let merged = "";
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      imported.add(file);
      merged += resolveImports(content, paths, imported) + "\n";
    }

    let css = compileString(merged, paths, { ...this._variables });

    if (minify) {
      css = css.replace(/\/\*.*?\*\//gs, "");
      css = css.replace(/\s+/g, " ");
      css = css.replace(/\s*([{}:;,])\s*/g, "$1");
      css = css.replace(/;}/g, "}");
      css = css.trim();
    }

    // Write output only if content changed (avoids triggering DevReload loops)
    const absOutput = resolve(output);
    const outDir = dirname(absOutput);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    let existing: string | null = null;
    try {
      existing = existsSync(absOutput) ? readFileSync(absOutput, "utf-8") : null;
    } catch {
      existing = null;
    }
    if (existing !== css) {
      writeFileSync(absOutput, css, "utf-8");
    }

    return css;
  }
}

// ── Internal Compilation Pipeline ────────────────────────────────

function compileString(
  scss: string,
  importPaths: string[],
  variables: Record<string, string>
): string {
  // 1. Resolve @import statements
  const imported = new Set<string>();
  scss = resolveImports(scss, importPaths, imported);

  // 2. Strip single-line comments (preserve /* */ block comments)
  scss = scss.replace(/(?<![:"'])\/\/[^\n]*/g, "");

  // 3. Extract and store variables
  scss = extractVariables(scss, variables);

  // 4. Extract mixins
  const mixins: Record<string, { params: string[]; body: string }> = {};
  scss = extractMixins(scss, mixins);

  // 5. Resolve @include
  scss = resolveIncludes(scss, mixins);

  // 5.5. Resolve #{ ... } interpolation (before $var substitution + nesting).
  scss = resolveInterpolation(scss, variables);

  // 6. Substitute variables
  scss = substituteVariables(scss, variables);

  // 7. Evaluate basic math in property values
  scss = evalMath(scss);

  // 7.5. Resolve color functions (lighten/darken/rgba/rgb/mix) — after variable
  // substitution so a $colour arg is already a hex literal (issue #124).
  scss = resolveColorFunctions(scss);

  // 8. Flatten nested rules
  const css = flattenNesting(scss);

  // 9. Cleanup
  return cleanup(css);
}

// ── Import Resolution ────────────────────────────────────────────

function resolveImports(content: string, paths: string[], imported: Set<string>): string {
  return content.replace(/@import\s+["']?([^"';\n]+)["']?\s*;/g, (_match, name: string) => {
    name = name.trim();
    const candidates: string[] = [];
    for (const base of paths) {
      candidates.push(
        join(base, `${name}.scss`),
        join(base, `_${name}.scss`),
        join(base, name),
      );
    }
    for (const candidate of candidates) {
      if (existsSync(candidate) && !imported.has(candidate)) {
        imported.add(candidate);
        const fileContent = readFileSync(candidate, "utf-8");
        return resolveImports(fileContent, [dirname(candidate), ...paths], imported);
      }
    }
    return `/* IMPORT NOT FOUND: ${name} */`;
  });
}

// ── Variables ────────────────────────────────────────────────────

function extractVariables(scss: string, variables: Record<string, string>): string {
  return scss.replace(/\$([a-zA-Z_][\w-]*)\s*:\s*([^;]+);/g, (_m, name: string, value: string) => {
    let resolved = value.trim();
    // Resolve variable references within the value
    for (const [vName, vVal] of Object.entries(variables)) {
      resolved = resolved.replaceAll(`$${vName}`, vVal);
    }
    variables[name] = resolved;
    return "";
  });
}

function substituteVariables(scss: string, variables: Record<string, string>): string {
  // Sort by longest name first to avoid partial matches
  const sorted = Object.keys(variables).sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    scss = scss.replaceAll(`$${name}`, variables[name]);
  }
  return scss;
}

/**
 * Resolve SCSS `#{ ... }` interpolation. Each `#{ expr }` is replaced by its
 * resolved inner text: a `$variable` inside the braces resolves to its value,
 * anything else is inlined verbatim (trimmed). This lets a value carry a
 * variable inside a string context plain `$var` substitution can't reach —
 * e.g. `calc(100% - #{$gap})` → `calc(100% - 20px)` — and lets a variable
 * appear in a selector (`.icon-#{$name}` → `.icon-home`). Run BEFORE nested
 * rule flattening so the literal braces never confuse the block matcher.
 */
function resolveInterpolation(scss: string, variables: Record<string, string>): string {
  const sorted = Object.keys(variables).sort((a, b) => b.length - a.length);
  return scss.replace(/#\{([^{}]*)\}/g, (_m, inner: string) => {
    let resolved = inner.trim();
    for (const name of sorted) {
      resolved = resolved.replaceAll(`$${name}`, variables[name]);
    }
    return resolved;
  });
}

// ── Mixins ───────────────────────────────────────────────────────

function extractMixins(
  scss: string,
  mixins: Record<string, { params: string[]; body: string }>
): string {
  const pattern = /@mixin\s+([\w-]+)\s*(?:\(([^)]*)\))?\s*\{/g;
  let match: RegExpExecArray | null;
  const locations: { start: number; end: number; name: string }[] = [];

  while ((match = pattern.exec(scss)) !== null) {
    const name = match[1];
    const paramsStr = match[2] ?? "";
    const params = paramsStr
      .split(",")
      .map((p) => p.trim().replace(/^\$/, ""))
      .filter(Boolean);

    const bodyStart = match.index + match[0].length;
    const body = findBlock(scss, bodyStart);
    if (body !== null) {
      mixins[name] = { params, body };
      locations.push({
        start: match.index,
        end: bodyStart + body.length + 1,
        name,
      });
    }
  }

  // Remove mixin definitions from source (reverse order to preserve indices)
  let result = scss;
  for (const loc of locations.reverse()) {
    result = result.slice(0, loc.start) + result.slice(loc.end);
  }
  return result;
}

function resolveIncludes(
  scss: string,
  mixins: Record<string, { params: string[]; body: string }>
): string {
  return scss.replace(
    /@include\s+([\w-]+)\s*(?:\(([^)]*)\))?\s*;/g,
    (_m, name: string, argsStr: string | undefined) => {
      if (!(name in mixins)) {
        return `/* MIXIN NOT FOUND: ${name} */`;
      }
      const mixin = mixins[name];
      const args = argsStr
        ? argsStr.split(",").map((a) => a.trim()).filter(Boolean)
        : [];
      let body = mixin.body;
      for (let i = 0; i < mixin.params.length; i++) {
        const paramName = mixin.params[i].split(":")[0].trim();
        const defaultVal = mixin.params[i].includes(":")
          ? mixin.params[i].split(":").slice(1).join(":").trim()
          : "";
        const value = i < args.length ? args[i] : defaultVal;
        body = body.replaceAll(`$${paramName}`, value);
      }
      return body;
    }
  );
}

// ── Math Evaluation ──────────────────────────────────────────────

function evalMath(scss: string): string {
  // Mixed-unit arithmetic is left verbatim — that is exactly what CSS calc()
  // is for, and folding it silently produces invalid output (see tina4-nodejs#1).
  // Math inside calc(...) is preserved untouched on the same principle: the
  // author asked the browser to compute it.
  //
  // Rules for folding:
  //   * Both operands unitless                  → fold
  //   * Same unit on both operands              → fold, keep unit
  //   * One operand unitless for * or /         → fold, keep the other unit
  //   * Anything else (mixed units on +/-, etc) → leave verbatim

  // Step 1 — mask calc(...) ranges so the math regex cannot eat into them.
  const placeholders: string[] = [];
  const masked = scss.replace(/calc\([^()]*\)/g, (m) => {
    placeholders.push(m);
    return `\x00CALC${placeholders.length - 1}\x00`;
  });

  // Step 2 — run the math fold on what remains.
  const folded = masked.replace(
    /([\d.]+)([a-z%]*)\s*([+\-*/])\s*([\d.]+)([a-z%]*)/g,
    (full, n1: string, u1: string, op: string, n2: string, u2: string) => {
      const num1 = parseFloat(n1);
      const num2 = parseFloat(n2);
      if (Number.isNaN(num1) || Number.isNaN(num2)) return full;

      const unit1 = u1 || "";
      const unit2 = u2 || "";

      // Decide result unit; bail if units are incompatible.
      let unit: string;
      if (unit1 === unit2) {
        unit = unit1;
      } else if ((op === "*" || op === "/") && unit1 === "") {
        unit = unit2;
      } else if ((op === "*" || op === "/") && unit2 === "") {
        unit = unit1;
      } else {
        return full;
      }

      let result: number;
      switch (op) {
        case "+": result = num1 + num2; break;
        case "-": result = num1 - num2; break;
        case "*": result = num1 * num2; break;
        case "/":
          if (num2 === 0) return full;
          result = num1 / num2;
          break;
        default: return full;
      }

      if (result === Math.floor(result)) {
        return `${Math.floor(result)}${unit}`;
      }
      return `${result.toFixed(2)}${unit}`;
    }
  );

  // Step 3 — restore the calc() ranges verbatim.
  return folded.replace(/\x00CALC(\d+)\x00/g, (_m, idx: string) => {
    return placeholders[parseInt(idx, 10)];
  });
}

// ── Color Functions ──────────────────────────────────────────────

/**
 * Resolve lighten(), darken(), rgba()/rgb(), and mix() color functions.
 *
 * rgba(<hex>, <alpha>) is the damaging case (issue #124): the functional rgba()
 * notation cannot take a hex, so rgba(#0f3460, 0.12) is invalid CSS and browsers
 * drop the whole declaration. Convert the hex to its r,g,b components. Runs after
 * variable substitution so a $colour arg is already a hex literal.
 */
function resolveColorFunctions(scss: string): string {
  scss = scss.replace(/lighten\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g, (_m, color: string, amt: string) =>
    adjustLightness(color.trim(), parseFloat(amt.trim().replace(/%$/, "")) / 100)
  );
  scss = scss.replace(/darken\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g, (_m, color: string, amt: string) =>
    adjustLightness(color.trim(), -(parseFloat(amt.trim().replace(/%$/, "")) / 100))
  );
  // rgba(<hex>, <alpha>) — only the two-arg hex form; leave rgba(r,g,b,a) alone.
  scss = scss.replace(/rgba\(\s*(#[0-9a-fA-F]{3,8})\s*,\s*([\d.]+)\s*\)/g, (whole, hex: string, alpha: string) => {
    const rgb = hexToRgb(hex);
    return rgb === null ? whole : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.trim()})`;
  });
  scss = scss.replace(/rgb\(\s*(#[0-9a-fA-F]{3,8})\s*\)/g, (whole, hex: string) => {
    const rgb = hexToRgb(hex);
    return rgb === null ? whole : `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  });
  // mix(<c1>, <c2>[, <weight>]) — Sass weight is c1's proportion (default 50%).
  scss = scss.replace(
    /mix\(\s*(#[0-9a-fA-F]{3,8})\s*,\s*(#[0-9a-fA-F]{3,8})\s*(?:,\s*([\d.]+%?)\s*)?\)/g,
    (whole, h1: string, h2: string, weight?: string) => {
      const c1 = hexToRgb(h1);
      const c2 = hexToRgb(h2);
      if (c1 === null || c2 === null) return whole;
      const w = weight ? parseFloat(weight.replace(/%$/, "")) / 100 : 0.5;
      const mixed = [0, 1, 2].map((i) => Math.round(c1[i] * w + c2[i] * (1 - w)));
      return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }
  );
  return scss;
}

/** Parse a #rgb / #rrggbb hex string into an [r, g, b] tuple, or null. */
function hexToRgb(color: string): [number, number, number] | null {
  let c = color.trim().replace(/^#/, "");
  if (c.length === 3) {
    c = c.split("").map((ch) => ch + ch).join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(c)) return null;
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

/** Adjust the HSL lightness of a hex color by `amount` (-1..1), return hex.
 * Truncates (Math.trunc) to match the Python master's int(x*255) byte-for-byte. */
function adjustLightness(color: string, amount: number): string {
  const rgb = hexToRgb(color);
  if (rgb === null) return color;
  let [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  l = Math.max(0, Math.min(1, l + amount));
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  const hex = (v: number): string => Math.trunc(v * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

// ── Nesting Flattener ────────────────────────────────────────────

function flattenNesting(scss: string): string {
  const output: string[] = [];
  flattenBlock(scss, [], output);
  return output.join("\n");
}

function flattenBlock(content: string, parentSelectors: string[], output: string[]): void {
  let pos = 0;
  const properties: string[] = [];

  while (pos < content.length) {
    // Skip whitespace
    while (pos < content.length && /[\s]/.test(content[pos])) {
      pos++;
    }
    if (pos >= content.length) break;

    // Block comment — preserve
    if (content[pos] === "/" && content[pos + 1] === "*") {
      const end = content.indexOf("*/", pos + 2);
      if (end === -1) break;
      output.push(content.slice(pos, end + 2));
      pos = end + 2;
      continue;
    }

    // @media query — special handling
    if (content.slice(pos, pos + 6) === "@media") {
      const brace = content.indexOf("{", pos);
      if (brace === -1) break;
      const mediaQuery = content.slice(pos, brace).trim();
      const body = findBlock(content, brace + 1);
      if (body === null) break;
      pos = brace + 1 + body.length + 1;

      const innerOutput: string[] = [];
      flattenBlock(body, parentSelectors, innerOutput);
      if (innerOutput.length > 0) {
        output.push(`${mediaQuery} {`);
        for (const line of innerOutput) {
          output.push(`  ${line}`);
        }
        output.push("}");
      }
      continue;
    }

    // Find next { or ;
    const bracePos = content.indexOf("{", pos);
    const semiPos = content.indexOf(";", pos);

    // Property (has ; before { or no { at all)
    if (semiPos !== -1 && (bracePos === -1 || semiPos < bracePos)) {
      const prop = content.slice(pos, semiPos).trim();
      if (prop && !prop.startsWith("@")) {
        properties.push(prop);
      }
      pos = semiPos + 1;
      continue;
    }

    // Nested block
    if (bracePos !== -1) {
      const selectorText = content.slice(pos, bracePos).trim();
      const body = findBlock(content, bracePos + 1);
      if (body === null) break;
      pos = bracePos + 1 + body.length + 1;

      if (!selectorText) continue;

      // Expand selectors with parent reference (&)
      const selectors = selectorText.split(",").map((s) => s.trim());
      const newSelectors: string[] = [];
      for (const sel of selectors) {
        if (parentSelectors.length > 0) {
          for (const parent of parentSelectors) {
            if (sel.includes("&")) {
              newSelectors.push(sel.replace(/&/g, parent));
            } else {
              newSelectors.push(`${parent} ${sel}`);
            }
          }
        } else {
          newSelectors.push(sel);
        }
      }

      flattenBlock(body, newSelectors, output);
      continue;
    }

    // Remaining text — treat as property
    const remaining = content.slice(pos).trim();
    if (remaining) {
      properties.push(remaining);
    }
    break;
  }

  // Emit properties for current selector
  if (properties.length > 0 && parentSelectors.length > 0) {
    const selectorStr = parentSelectors.join(", ");
    output.push(`${selectorStr} {`);
    for (const prop of properties) {
      output.push(`  ${prop};`);
    }
    output.push("}");
  }
}

// ── Utilities ────────────────────────────────────────────────────

function findBlock(content: string, start: number): string | null {
  let depth = 1;
  let pos = start;
  while (pos < content.length && depth > 0) {
    if (content[pos] === "{") depth++;
    else if (content[pos] === "}") depth--;
    if (depth > 0) pos++;
  }
  return depth === 0 ? content.slice(start, pos) : null;
}

function cleanup(css: string): string {
  // Remove empty rulesets
  css = css.replace(/[^{}]+\{\s*\}/g, "");
  // Remove multiple blank lines
  css = css.replace(/\n{3,}/g, "\n\n");
  // Remove trailing whitespace per line
  css = css
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
  return css.trim() + "\n";
}

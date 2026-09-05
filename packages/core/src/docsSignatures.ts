interface MethodMatch {
  name: string;
  signature: string;
  endIndex: number;
  nameStart: number;
  visibility: "public" | "protected" | "private";
  static: boolean;
}

const METHOD_HEAD_RE =
  /^([ \t]*)((?:public|protected|private|readonly|static|async|abstract|override|\s)*)([A-Za-z_$][\w$]*)\s*[<(]/;

export function matchMethodSignature(stripped: string, source: string, i: number): MethodMatch | null {
  // Method must be at start-of-line-ish position.
  if (i > 0) {
    const prev = stripped.charCodeAt(i - 1);
    if (prev !== 10 && prev !== 32 && prev !== 9 && prev !== 123) return null;
  }
  // Take the rest of the current line + a little ahead.
  let lineEnd = stripped.indexOf("\n", i);
  if (lineEnd === -1) lineEnd = stripped.length;
  // Read up to 4 lines for multi-line signatures.
  let chunkEnd = lineEnd;
  for (let extra = 0; extra < 4 && chunkEnd < stripped.length; extra++) {
    const next = stripped.indexOf("\n", chunkEnd + 1);
    if (next === -1) break;
    chunkEnd = next;
  }
  const chunk = stripped.slice(i, chunkEnd + 1);
  const match = METHOD_HEAD_RE.exec(chunk);
  if (!match) return null;
  const modifiers = match[2] || "";
  const name = match[3];
  // Skip reserved words / control-flow that masquerade as method names.
  const reserved = new Set([
    "if", "for", "while", "switch", "return", "do", "try", "catch", "throw",
    "const", "let", "var", "import", "export", "function", "class", "interface",
    "type", "new", "yield", "await", "case", "break", "continue", "else",
  ]);
  if (reserved.has(name)) return null;

  // Determine visibility from modifiers
  let visibility: "public" | "protected" | "private" = "public";
  if (/\bprivate\b/.test(modifiers)) visibility = "private";
  else if (/\bprotected\b/.test(modifiers)) visibility = "protected";
  const isStatic = /\bstatic\b/.test(modifiers);

  // Capture signature — read from start of "name" up through matching ')' and optional return type.
  const nameStart = i + match[1].length + match[2].length;
  const result = captureSignature(stripped, source, nameStart, name);
  if (!result) return null;

  return {
    name,
    signature: result.signature,
    endIndex: result.endIndex,
    nameStart,
    visibility,
    static: isStatic,
  };
}

const FN_HEAD_RE =
  /^((?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+)([A-Za-z_$][\w$]*)\s*[<(]/;

export function matchTopLevelFunction(stripped: string, source: string, i: number): MethodMatch | null {
  if (i > 0) {
    const prev = stripped.charCodeAt(i - 1);
    if (prev !== 10 && prev !== 32 && prev !== 9) return null;
  }
  let lineEnd = stripped.indexOf("\n", i);
  if (lineEnd === -1) lineEnd = stripped.length;
  let chunkEnd = lineEnd;
  for (let extra = 0; extra < 4 && chunkEnd < stripped.length; extra++) {
    const next = stripped.indexOf("\n", chunkEnd + 1);
    if (next === -1) break;
    chunkEnd = next;
  }
  const chunk = stripped.slice(i, chunkEnd + 1);
  const match = FN_HEAD_RE.exec(chunk);
  if (!match) return null;
  const name = match[2];
  const nameStart = i + match[1].length;
  const result = captureSignature(stripped, source, nameStart, name);
  if (!result) return null;
  return {
    name,
    signature: result.signature,
    endIndex: result.endIndex,
    nameStart,
    visibility: "public",
    static: false,
  };
}

interface CapturedSig {
  signature: string;
  endIndex: number;
}

function skipWhitespace(text: string, start: number, spacesOnly = false): number {
  let i = start;
  while (i < text.length && (spacesOnly ? /[ \t]/.test(text[i]) : /\s/.test(text[i]))) i++;
  return i;
}

function scanBalanced(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

function returnTypeStops(stripped: string, index: number, depth: number): boolean {
  const c = stripped[index];
  if (depth === 0 && (c === "{" || c === ";")) return true;
  if (depth !== 0 || c !== "\n") return false;
  const next = skipWhitespace(stripped, index + 1, true);
  return stripped[next] === "{";
}

function updateReturnDepth(char: string, depth: number): number {
  if (char === "<" || char === "(" || char === "[") return depth + 1;
  if (char === ">" || char === ")" || char === "]") return depth - 1;
  return depth;
}

function captureReturnType(stripped: string, source: string, start: number): { endIndex: number; returnType: string } {
  const retStart = skipWhitespace(stripped, start, true);
  if (stripped[retStart] !== ":") return { endIndex: retStart, returnType: "" };

  let retEnd = retStart + 1;
  let depth = 0;
  while (retEnd < stripped.length) {
    const c = stripped[retEnd];
    if (returnTypeStops(stripped, retEnd, depth)) break;
    depth = updateReturnDepth(c, depth);
    retEnd++;
  }
  return { endIndex: retEnd, returnType: source.slice(retStart, retEnd).trim() };
}

function captureSignature(stripped: string, source: string, nameStart: number, name: string): CapturedSig | null {
  let j = skipWhitespace(stripped, nameStart + name.length);
  if (stripped[j] === "<") j = scanBalanced(stripped, j, "<", ">");
  j = skipWhitespace(stripped, j);
  if (stripped[j] !== "(") return null;

  const parenStart = j;
  j = scanBalanced(stripped, j, "(", ")");
  const parenSegment = source.slice(parenStart, j); // pull from original source for human-readable
  const result = captureReturnType(stripped, source, j);
  const cleanedParens = parenSegment.replace(/\s+/g, " ");
  const sig = name + cleanedParens + (result.returnType ? " " + result.returnType : "");
  return { signature: sig, endIndex: result.endIndex };
}


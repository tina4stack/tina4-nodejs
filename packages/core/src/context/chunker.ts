// Tina4 Node.js
//
// Text folding + chunking for the Context subsystem.
//
// A thin, idiomatic TypeScript port of tina4-python's context/chunker.py
// (itself the proven slice of neemee's tokenizer/chunkers). Zero dependencies —
// nothing here touches SQLite; it produces the (folded body, raw text) pairs the
// FTS5 index stores.

// join comma-grouped numbers ("24,601" -> "24601") and split camelCase
// ("ForeignKeyField" -> "foreign key field") so a query token reaches a
// code identifier. snake_case already splits for free at the tokenizer.
const NUM_COMMA = /(?<=\d),(?=\d)/g;
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])/g;
const WORD_RE = /[a-z0-9]+/g;

// Sentence boundary = end punctuation FOLLOWED BY whitespace/EOL, or a newline.
// NOT a bare '.', which would shred embedded code in prose ("db.fetch()" ->
// "db. fetch()"). Intra-token dots (method calls, module paths) stay intact.
const SENT = /(?<=[.!?])\s+|\n+/;

// Chunk boundaries across languages: python defs/classes/decorators, php/js
// functions and methods, ts exports/interfaces, php traits, and Object Pascal
// unit/type/routine headers (Delphi is case-insensitive, accept either case).
// Anchored at line start; tested per line (parity with python's re.match).
const TOPLEVEL =
  /^(async def |def |class |@\w|\s*(?:public |private |protected |static |final |abstract )*function \w|(?:export )?(?:default )?(?:abstract )?class |interface |trait |export (?:const|function|interface|type|async) |[Uu]nit |[Pp]rocedure |[Ff]unction |[Cc]onstructor |[Dd]estructor |[Tt]ype$)/;

/**
 * Lowercase, strip diacritics, join comma-grouped numbers, split camelCase.
 *
 * Applied symmetrically to the indexed `body` and to query tokens so matching
 * is consistent: a query for `field` reaches `IntegerField`. The trailing
 * NFKD-normalise + strip-non-ASCII mirrors python's
 * `unicodedata.normalize("NFKD", ...).encode("ascii", "ignore")`.
 */
export function fold(text: string): string {
  const split = text.replace(NUM_COMMA, "").replace(CAMEL, " ").toLowerCase();
  // eslint-disable-next-line no-control-regex
  return split.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
}

/**
 * Fold simple plurals: strip one trailing 's', never from ss/us/is endings
 * (class, status, axis). QUERY-side only — so `fields` in a question also
 * reaches `Field` definitions.
 */
export function lightStem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

/** Accent-folded lowercase alphanumeric tokens (digits kept). */
export function terms(text: string): string[] {
  return fold(text).match(WORD_RE) ?? [];
}

/**
 * Split into lines the way python's `str.splitlines()` does: on any line
 * terminator, WITHOUT a trailing empty element for a final newline. A plain
 * `text.split("\n")` would append a spurious "" for "a\n" — this drops it so
 * chunk boundaries and line counts match the reference.
 */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && /[\r\n]$/.test(text)) {
    lines.pop();
  }
  return lines;
}

/**
 * Pack line-segments into chunks of at most `maxLines` lines, hard-splitting
 * any single oversized segment.
 */
function pack(segments: string[][], maxLines: number): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (let seg of segments) {
    while (seg.length > maxLines) {
      if (cur.length) {
        chunks.push(cur);
        cur = [];
      }
      chunks.push(seg.slice(0, maxLines));
      seg = seg.slice(maxLines);
    }
    if (cur.length && cur.length + seg.length > maxLines) {
      chunks.push(cur);
      cur = [];
    }
    cur = cur.concat(seg);
  }
  if (cur.length) {
    chunks.push(cur);
  }
  return chunks;
}

/**
 * Chunk source on top-level def/class/decorator boundaries (sentence chunking
 * shreds code). Segments are packed up to `maxLines`, and every chunk starts
 * with a `# file: <path>` line so the path's tokens are indexed — 'where is the
 * router?' should match core/router.ts by name.
 *
 * Returns a list of `[index, chunkText]` pairs.
 */
export function chunkCode(text: string, path = "", maxLines = 60): Array<[number, string]> {
  const lines = splitLines(text);
  let bounds: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TOPLEVEL.test(lines[i])) bounds.push(i);
  }
  if (bounds.length === 0 || bounds[0] !== 0) {
    bounds = [0, ...bounds];
  }
  const ends = [...bounds.slice(1), lines.length];
  const segments: string[][] = [];
  for (let k = 0; k < bounds.length; k++) {
    segments.push(lines.slice(bounds[k], ends[k]));
  }

  const header = path ? `# file: ${path}` : null;
  const packed = pack(segments, maxLines);
  const out: Array<[number, string]> = [];
  for (let i = 0; i < packed.length; i++) {
    const body = (header ? [header, ...packed[i]] : packed[i]).join("\n");
    out.push([i, body]);
  }
  return out;
}

/**
 * Chunk prose/docs into sentence-packed windows of at most `maxWords` words.
 * Returns a list of `[index, chunkText]` pairs.
 */
export function chunkText(text: string, maxWords = 350): Array<[number, string]> {
  const sents = text
    .split(SENT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const chunks: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  for (const s of sents) {
    const w = s.split(/\s+/).filter(Boolean).length;
    if (cur.length && curWords + w > maxWords) {
      chunks.push(cur.join(" "));
      cur = [];
      curWords = 0;
    }
    cur.push(s);
    curWords += w;
  }
  if (cur.length) {
    chunks.push(cur.join(" "));
  }
  return chunks.map((c, i): [number, string] => [i, c]);
}

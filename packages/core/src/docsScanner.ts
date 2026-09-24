/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Replace string literals and template literal contents with spaces of equal
 * length so brace/paren scanning isn't fooled by characters inside strings.
 * Also strips line + block comments. Newlines are preserved so line numbers
 * line up with the original source.
 */
const BACKTICK = String.fromCharCode(96);

function blankSegment(source: string, start: number, end: number): string {
  return source.slice(start, end).replace(/[^\n]/g, " ");
}

function stripBlockComment(source: string, start: number): { text: string; next: number } {
  const end = source.indexOf("*/", start + 2);
  return end === -1
    ? { text: blankSegment(source, start, source.length), next: source.length }
    : { text: blankSegment(source, start, end + 2), next: end + 2 };
}

function stripLineComment(source: string, start: number): { text: string; next: number } {
  const end = source.indexOf("\n", start);
  const next = end === -1 ? source.length : end;
  return { text: " ".repeat(next - start), next };
}

function stripQuoted(source: string, start: number): { text: string; next: number } {
  const out = [source[start]];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\" && i + 1 < source.length) {
      out.push("  ");
      i += 2;
      continue;
    }
    if (c === source[start]) {
      out.push(c);
      i++;
      break;
    }
    out.push(c === "\n" ? "\n" : " ");
    i++;
  }
  return { text: out.join(""), next: i };
}

function stripTemplateInterpolation(source: string, start: number): { text: string; next: number } {
  const out = ["  "];
  let i = start + 2;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    out.push(c === "\n" ? "\n" : " ");
    i++;
  }
  return { text: out.join(""), next: i };
}

function stripTemplate(source: string, start: number): { text: string; next: number } {
  const out = [BACKTICK];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\" && i + 1 < source.length) {
      out.push("  ");
      i += 2;
      continue;
    }
    if (c === BACKTICK) {
      out.push(BACKTICK);
      i++;
      break;
    }
    if (c === "$" && source[i + 1] === "{") {
      const interpolation = stripTemplateInterpolation(source, i);
      out.push(interpolation.text);
      i = interpolation.next;
      continue;
    }
    out.push(c === "\n" ? "\n" : " ");
    i++;
  }
  return { text: out.join(""), next: i };
}

// A slash starts a regexp where an expression may begin. Division follows a
// value (identifier, number, closing bracket/paren) and must remain visible.
function startsRegex(source: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0 || "=(:,[!&|?;{}".includes(source[i])) return true;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z_$]/.test(source[i])) i--;
  return ["return", "throw", "case", "yield", "await"].includes(source.slice(i + 1, end));
}

function stripRegex(source: string, start: number): { text: string; next: number } | null {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\n" || c === "\r") return null;
    if (c === "\\") { i++; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let next = i + 1;
      while (next < source.length && /[a-z]/i.test(source[next])) next++;
      return { text: blankSegment(source, start, next), next };
    }
  }
  return null;
}

export function stripStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "*") {
      const part = stripBlockComment(source, i);
      out.push(part.text);
      i = part.next;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const part = stripLineComment(source, i);
      out.push(part.text);
      i = part.next;
      continue;
    }
    if (c === "/" && startsRegex(source, i)) {
      const part = stripRegex(source, i);
      if (part) {
        out.push(part.text);
        i = part.next;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const part = stripQuoted(source, i);
      out.push(part.text);
      i = part.next;
      continue;
    }
    if (c === BACKTICK) {
      const part = stripTemplate(source, i);
      out.push(part.text);
      i = part.next;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

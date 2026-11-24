/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Connection URL credentials: the ONE redaction rule, shared by every path
 * that can put a connection string in front of a human (GHSA-h2mr-m3v3-cq8c).
 * Its parsing half - the ONE userinfo splitter every parser uses - is the
 * sibling connectionUrl.ts, which takes its port-versus-password test from
 * here so the two halves cannot drift.
 *
 * IMPORTS NOTHING, on purpose. @tina4/orm imports it (databaseUrl.ts) and so
 * does @tina4/core (the websocket backplane, the boot log, the dev admin) - a
 * leaf module is the only place both can reach without a cycle.
 *
 * THE RULE
 *   - The authority starts after `scheme://`, `scheme:/` or `scheme//`.
 *   - Userinfo ends at the LAST `@` on the line; the password starts at the
 *     first `:` after the authority start. A `/`, `?` or `#` before that `:`
 *     means the text is a path, not a password.
 *   - With no `@`, a non-numeric "port" is the password: it is masked to the end
 *     of the line, keeping a trailing `?key=value` query.
 *   - Parsers refuse a URL without `scheme://`, or whose `@` count differs from
 *     what the parser took as userinfo, with a GENERIC message that never
 *     echoes the value and never chains an error that does.
 *   - Scheme, user and host stay visible, so the line is still useful.
 *
 * Why this replaced the old rules: they cut the authority at the first `/`, `?`
 * or `#`, or split userinfo at the first `@`, so `postgres://u:Pq1/Rs2@h/db`,
 * `postgres:/u:pw@h/db`, `postgres://u:pw` and `postgres://u:pw@h:notaport/db`
 * all printed the password - in redacted log lines, in "invalid URL" errors
 * that named `u:Pq1` as the host, and in driver errors downstream.
 *
 * KNOWN LIMITS (unmaskable by any rule):
 *   - A host-less URL whose password is all digits (`postgres://u:123/x`) is a
 *     valid URL with port 123, so the digits are shown.
 *   - A host-less URL whose password holds an unencoded `@`
 *     (`postgres://u:Pq1@Rs2`) is a valid URL whose HOST is `Rs2`; the tail
 *     after the `@` is shown as the host.
 * Over-redaction is accepted instead: a second `@` later on the same line
 * (`... failed for admin@corp`) masks up to it, hiding a host, never showing a
 * password.
 */

/** The single mask. One spelling, so grepping for it finds every redaction. */
export const REDACTED = "***";

/** `scheme` + one of the three authority markers, not glued to a path or word. */
const SCHEME_MARKER = /(?<![A-Za-z0-9+.\-/])([A-Za-z][A-Za-z0-9+.-]*)(:\/\/|:\/|\/\/)/g;

/** A trailing query worth keeping: `?k=v` pairs (and a fragment), nothing else. */
const KEPT_QUERY = /^\?[^\s=&#?]+=[^\s&#?]*(?:&[^\s=&#?]+=[^\s&#?]*)*(?:#\S*)?$/;

/**
 * Where a keyword VALUE ends in a keyword/value connection string.
 *
 * NOT at the first whitespace. tina4-php redacted its connect-failure message
 * with a `\bpassword=\S` + star pattern, and a password containing a SPACE kept
 * its TAIL in the logged line. The real terminators are the field separators -
 * `;` for ODBC/libpq, `&` for a query string - plus the closing brace/quote of
 * a quoted value, since `PWD={p;w}` and the libpq quoted form both legally
 * contain a separator.
 */
function endOfKeywordValue(text: string, start: number): number {
  const open = text[start];
  if (open === "{") {
    const close = text.indexOf("}", start + 1);
    return close === -1 ? text.length : close + 1;
  }
  if (open === "'" || open === '"') return endOfQuoted(text, start, open);
  const end = text.slice(start).search(/[;&]/);
  return end === -1 ? text.length : start + end;
}

/** Just past the closing quote of a quoted value; a backslash escapes. */
function endOfQuoted(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

/** `PWD=`/`password=`/`passwd=` in an ODBC DSN, a libpq DSN or a query string. */
const SECRET_KEYWORD_PATTERN = /(^|[;&?\s])(pwd|password|passwd)(\s*=\s*)/gi;

function redactKeywordValues(text: string): string {
  const pattern = new RegExp(SECRET_KEYWORD_PATTERN.source, SECRET_KEYWORD_PATTERN.flags);
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const valueStart = match.index + match[0].length;
    out += text.slice(cursor, valueStart) + REDACTED;
    cursor = endOfKeywordValue(text, valueStart);
    pattern.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/** One credential found on a line: the userinfo span and the password span in it. */
interface CredentialSpan {
  /** Index where the authority (and so any userinfo) starts. */
  authorityStart: number;
  /** Index of the `@` that ends userinfo, or -1 for the no-`@` port-shaped password. */
  at: number;
  /** [start, end) of the text to mask as the password. */
  passwordStart: number;
  passwordEnd: number;
}

/**
 * The credential spans on ONE line, left to right.
 *
 * The rule, applied per scheme marker: userinfo runs to the LAST `@` on the
 * line; the password is from the first `:` after the authority start to that
 * `@`, unless a `/`, `?` or `#` comes before the `:` (then it is a path). With
 * no usable `@`, a port that is not all digits is the password, to the end of
 * the line, less a trailing `?key=value` query.
 */
function credentialSpans(line: string): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  const marker = new RegExp(SCHEME_MARKER.source, "g");
  const lastAt = line.lastIndexOf("@");
  let match: RegExpExecArray | null;
  while ((match = marker.exec(line)) !== null) {
    const start = match.index + match[0].length;
    const withAt = userinfoSpan(line, start, lastAt);
    if (withAt !== null) {
      spans.push(withAt);
      // Everything up to the last `@` is now accounted for.
      marker.lastIndex = lastAt + 1;
      continue;
    }
    const portShaped = portShapedSpan(line, start);
    if (portShaped !== null) {
      spans.push(portShaped);
      break; // masked to the end of the line: nothing after it is left to scan
    }
  }
  return spans;
}

/**
 * `user:password@` for an authority starting at `start`, ending at the line's
 * last `@` - or null when there is no such `@`, no `:` before it, or a `/`,
 * `?` or `#` before the `:` (then the text is a path, not a password).
 */
function userinfoSpan(line: string, start: number, lastAt: number): CredentialSpan | null {
  if (lastAt < start) return null;
  const colon = line.indexOf(":", start);
  if (colon === -1 || colon >= lastAt || /[/?#]/.test(line.slice(start, colon))) return null;
  return { authorityStart: start, at: lastAt, passwordStart: colon + 1, passwordEnd: lastAt };
}

/**
 * No `@` reachable: the authority is host[:port], and a port that cannot be a
 * port is the password. Whitespace ends the HOST scan (a host has none) but
 * not the mask - `u:Pq1 Rs2` has to go to the end of the line.
 *
 * A numeric port is a port - unless what follows it cannot follow a port: a
 * fragment, or a query that is not `key=value`. `u:12?Pq1Rs2` and
 * `u:12#Pq1Rs2` are digit-led passwords, not port 12. (Known limit: an
 * all-digit password, or digits then a path, `u:12/x`, looks exactly like a
 * port and stays visible.)
 */
function portShapedSpan(line: string, start: number): CredentialSpan | null {
  const rest = line.slice(start);
  const authorityEnd = rest.search(/[/?#\s]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const colon = authority.indexOf(":", authority.startsWith("[") ? authority.indexOf("]") + 1 : 0);
  if (colon === -1) return null;
  const port = authority.slice(colon + 1);
  if (port === "") return null;
  if (/^\d+$/.test(port) && !digitLedPassword(rest.slice(authority.length))) return null;
  const maskStart = start + colon + 1;
  return { authorityStart: start, at: -1, passwordStart: maskStart, passwordEnd: keptQueryStart(line, maskStart) };
}

/** Where the mask stops: before a trailing `?key=value` query, else the line end. */
function keptQueryStart(line: string, from: number): number {
  const query = line.indexOf("?", from);
  return query !== -1 && KEPT_QUERY.test(line.slice(query)) ? query : line.length;
}

/**
 * True when the text after a host-less `x:digits` cannot be what follows a
 * port - a `#fragment`, or a `?query` that is not `key=value` pairs - so the
 * digits are the start of a password (`postgres://u:12?Pq1Rs2`).
 */
export function digitLedPassword(afterPort: string): boolean {
  if (afterPort.startsWith("#")) return true;
  return afterPort.startsWith("?") && !KEPT_QUERY.test(afterPort.split(/\s/, 1)[0]);
}

function rewriteLines(text: string, render: (line: string, spans: CredentialSpan[]) => string): string {
  return text
    .split(/(\r?\n)/)
    .map((part) => (part === "\n" || part === "\r\n" ? part : render(part, credentialSpans(part))))
    .join("");
}

/**
 * Remove every password from an arbitrary connection string or message.
 *
 * THE single redaction primitive. It works on RAW text - valid or malformed, a
 * URL, an ODBC DSN, or an error message that embeds either - so error paths can
 * use it too. `postgres://u:pw@host/db` becomes `postgres://u:***@host/db`.
 */
export function redactCredentials(raw: string): string {
  if (typeof raw !== "string" || raw === "") return raw;
  const masked = rewriteLines(raw, (line, spans) => {
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      out += line.slice(cursor, span.passwordStart) + REDACTED;
      cursor = span.passwordEnd;
    }
    return out + line.slice(cursor);
  });
  return redactKeywordValues(masked);
}

/**
 * Like redactCredentials(), but drops the whole userinfo (`user:pass@`) rather
 * than masking the password - for the boot log, which names the database
 * target and nothing about who connects to it.
 */
export function stripCredentials(raw: string): string {
  if (typeof raw !== "string" || raw === "") return raw;
  const stripped = rewriteLines(raw, (line, spans) => {
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      if (span.at === -1) {
        out += line.slice(cursor, span.passwordStart) + REDACTED;
        cursor = span.passwordEnd;
      } else {
        out += line.slice(cursor, span.authorityStart);
        cursor = span.at + 1;
      }
    }
    return out + line.slice(cursor);
  });
  return redactKeywordValues(stripped);
}

/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Connection URL credentials: the ONE redaction rule and the ONE userinfo
 * splitter, shared by every parser and every path that can put a connection
 * string in front of a human (GHSA-h2mr-m3v3-cq8c).
 *
 * IMPORTS NOTHING, on purpose. @tina4/orm imports it (databaseUrl.ts, the graph
 * URL) and so does @tina4/core (mqtt, the AMQP queue, the websocket backplane,
 * the boot log, the dev admin) - a leaf module is the only place both can reach
 * without a cycle.
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
  if (open === "'" || open === '"') {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === open) return i + 1;
      i++;
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && text[i] !== ";" && text[i] !== "&") i++;
  return i;
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

    if (lastAt >= start) {
      const colon = line.indexOf(":", start);
      if (colon !== -1 && colon < lastAt && !/[/?#]/.test(line.slice(start, colon))) {
        spans.push({ authorityStart: start, at: lastAt, passwordStart: colon + 1, passwordEnd: lastAt });
        // Everything up to the last `@` is now accounted for.
        marker.lastIndex = lastAt + 1;
        continue;
      }
    }

    // No `@` reachable: the authority is host[:port]; a non-numeric port is
    // the password. Whitespace ends the HOST scan (a host has none) but not the
    // mask - `u:Pq1 Rs2` has to go to the end of the line.
    const rest = line.slice(start);
    const authorityEnd = rest.search(/[/?#\s]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    const hostEnd = authority.startsWith("[") ? authority.indexOf("]") + 1 : 0;
    const colon = authority.indexOf(":", Math.max(hostEnd, 0));
    if (colon === -1) continue;
    const port = authority.slice(colon + 1);
    if (port === "") continue;
    // A numeric port is a port - unless what follows it cannot follow a port:
    // a fragment, or a query that is not `key=value`. `u:12?Pq1Rs2` and
    // `u:12#Pq1Rs2` are digit-led passwords, not port 12. (Known limit: an
    // all-digit password, or digits then a path, `u:12/x`, looks exactly like
    // a port and stays visible.)
    if (/^\d+$/.test(port) && !digitLedPassword(rest.slice(authority.length))) continue;
    const maskStart = start + colon + 1;
    let maskEnd = line.length;
    const query = line.indexOf("?", maskStart);
    if (query !== -1 && KEPT_QUERY.test(line.slice(query))) maskEnd = query;
    spans.push({ authorityStart: start, at: -1, passwordStart: maskStart, passwordEnd: maskEnd });
    break; // masked to the end of the line: nothing after it is left to scan
  }
  return spans;
}

/**
 * True when the text after a host-less `x:digits` cannot be what follows a
 * port - a `#fragment`, or a `?query` that is not `key=value` pairs - so the
 * digits are the start of a password (`postgres://u:12?Pq1Rs2`).
 */
function digitLedPassword(afterPort: string): boolean {
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

// ── parsing ────────────────────────────────────────────────────────────────

/**
 * The error every parser throws for a connection URL it will not accept.
 *
 * The message NEVER carries the value and the error NEVER has a `cause`: a
 * TypeError from `new URL()` keeps the input on `.input`, and a driver's parse
 * error quotes it, so chaining either would put the password straight back.
 */
export class ConnectionUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionUrlError";
  }
}

export interface ConnectionUrlParts {
  /** Lower-cased scheme, e.g. `postgres`, `mongodb+srv`. */
  scheme: string;
  /** Raw (still-encoded) userinfo, or null when the URL has no `@`. */
  userinfo: string | null;
  /** Raw (still-encoded) user, or null. */
  rawUsername: string | null;
  /** Raw (still-encoded) password, or null when no `:` was written. */
  rawPassword: string | null;
  /** Decoded user, or null. */
  username: string | null;
  /** Decoded password, or null when no `:` was written ("" when written blank). */
  password: string | null;
  /** The raw `host[:port]` (or host list) after userinfo - credential-free. */
  hostPort: string;
  /** First host, brackets removed for IPv6, or "" when there is none. */
  host: string;
  /** First host's port, or null when none was written. */
  port: number | null;
  /** Path, query and fragment as written: "" or starting with `/`, `?` or `#`. */
  tail: string;
}

export interface SplitOptions {
  /** Prefix for the error message, e.g. "DatabaseUrl". */
  label: string;
  /** What the message says was expected, e.g. "scheme://[user[:password]@]host[:port]/database". */
  expected?: string;
  /** Accept `h1:1,h2:2` (MongoDB). */
  allowHostList?: boolean;
}

/** Percent-decode, leaving an invalid escape as written instead of throwing. */
export function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try { return decodeURIComponent(seq); } catch { return seq; }
    });
  }
}

const count = (text: string, ch: string): number => text.split(ch).length - 1;

/** `host[:port]` -> [host, port]; null when the shape is wrong. */
function splitHostPort(hostPort: string): [string, string | null] | null {
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close === -1) return null;
    const after = hostPort.slice(close + 1);
    if (after !== "" && !after.startsWith(":")) return null;
    return [hostPort.slice(1, close), after === "" ? null : after.slice(1)];
  }
  const colon = hostPort.indexOf(":");
  if (colon === -1) return [hostPort, null];
  return [hostPort.slice(0, colon), hostPort.slice(colon + 1)];
}

/**
 * Split `scheme://[user[:password]@]host[:port][/path][?query][#fragment]`
 * under THE RULE (see the header), refusing what it cannot split safely.
 *
 * Accepts an unencoded `/`, `?`, `#`, `@`, `:` or `%` in a password, which is
 * what people actually paste into a .env file. Refuses, with a message that
 * never echoes the value:
 *   - no `scheme://` (including `scheme:/` and `scheme//`)
 *   - an `@` outside userinfo (`?email=a@b` - encode it as `%40`)
 *   - userinfo with no host after it, a non-numeric port, a bad IPv6 bracket,
 *     or whitespace in the host
 */
export function splitConnectionUrl(raw: string, options: SplitOptions): ConnectionUrlParts {
  const expected = options.expected ?? "scheme://[user[:password]@]host[:port]/path";
  const named = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw ?? "")?.[1]?.toLowerCase() ?? null;
  const refuse = (why: string, hostPort?: string): ConnectionUrlError =>
    new ConnectionUrlError(
      `${options.label}: invalid ${named ? `${named} ` : ""}URL${hostPort ? ` at '${hostPort}'` : ""} (${why}) - expected ` +
        `${expected}. The URL itself is not shown because it may contain a password.`,
    );

  if (typeof raw !== "string") throw refuse("not a string");
  const head = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (!head) throw refuse(named ? "the scheme must be followed by ://" : "no scheme:// found");
  const scheme = head[1].toLowerCase();
  const rest = raw.slice(head[0].length);

  // The RFC reading cuts the authority at the first / ? #. Where every `@` is
  // inside that, it agrees with the last-`@` rule. Where none is, the cut fell
  // INSIDE a password holding / ? or #. Anything in between means an `@` sits
  // in the path or query, and which `@` ends userinfo is a guess - refuse.
  const rfcEnd = rest.search(/[/?#]/);
  const rfcAuthority = rfcEnd === -1 ? rest : rest.slice(0, rfcEnd);
  const totalAt = count(rest, "@");
  const rfcAt = count(rfcAuthority, "@");

  let userinfo: string | null = null;
  let afterUserinfo = rest;
  if (totalAt > 0) {
    const lastAt = rest.lastIndexOf("@");
    const candidate = rest.slice(0, lastAt);
    if (rfcAt === totalAt) {
      userinfo = candidate;
    } else if (rfcAt === 0) {
      const colon = candidate.indexOf(":");
      if (colon === -1 || /[/?#]/.test(candidate.slice(0, colon))) {
        throw refuse("an @ outside the user:password part - percent-encode it as %40");
      }
      userinfo = candidate;
    } else {
      throw refuse("an @ outside the user:password part - percent-encode it as %40");
    }
    afterUserinfo = rest.slice(lastAt + 1);
  }

  const hostEnd = afterUserinfo.search(/[/?#]/);
  const hostPort = hostEnd === -1 ? afterUserinfo : afterUserinfo.slice(0, hostEnd);
  const tail = afterUserinfo.slice(hostPort.length);
  // Only text after the last `@` may be named: with no `@`, "host:port" can be
  // `user:password` (`postgres://u:secret`).
  const nameable = userinfo !== null ? hostPort : undefined;

  if (/\s/.test(hostPort)) throw refuse("whitespace in the host");
  if (userinfo !== null && hostPort === "") throw refuse("no host after the credentials");

  const hosts = options.allowHostList ? hostPort.split(",") : [hostPort];
  let host = "";
  let port: number | null = null;
  for (let i = 0; i < hosts.length; i++) {
    const split = splitHostPort(hosts[i]);
    if (split === null) throw refuse("a malformed IPv6 host", nameable);
    const [h, p] = split;
    if (p !== null && p !== "" && !/^\d+$/.test(p)) throw refuse("the port must be numeric", nameable);
    if (i === 0) {
      host = h;
      port = p !== null && p !== "" ? parseInt(p, 10) : null;
    }
  }

  // No `@`, a numeric port, then a fragment or a non-`key=value` query: that is
  // a digit-led password (`u:12?Pq1Rs2`), not host `u` port 12 - a whole-value
  // parser (`new URL` included) would put the password in the query.
  if (userinfo === null && port !== null && digitLedPassword(tail)) {
    throw refuse("a port followed by a fragment or a query that is not key=value");
  }

  let rawUsername: string | null = null;
  let rawPassword: string | null = null;
  if (userinfo !== null) {
    const colon = userinfo.indexOf(":");
    rawUsername = colon === -1 ? userinfo : userinfo.slice(0, colon);
    rawPassword = colon === -1 ? null : userinfo.slice(colon + 1);
  }
  return {
    scheme,
    userinfo,
    rawUsername,
    rawPassword,
    username: rawUsername === null ? null : decodeComponent(rawUsername),
    password: rawPassword === null ? null : decodeComponent(rawPassword),
    hostPort,
    host,
    port,
    tail,
  };
}

/**
 * The same URL with its credentials percent-encoded - what a driver that runs
 * its own URL parser (mongodb, redis) is handed, so it can never re-split a
 * password holding `/`, `?`, `#` or `@` and quote the pieces in its errors.
 */
export function canonicalConnectionUrl(parts: ConnectionUrlParts): string {
  let auth = "";
  if (parts.userinfo !== null) {
    auth = encodeURIComponent(parts.username ?? "");
    if (parts.password !== null) auth += `:${encodeURIComponent(parts.password)}`;
    auth += "@";
  }
  return `${parts.scheme}://${auth}${parts.hostPort}${parts.tail}`;
}

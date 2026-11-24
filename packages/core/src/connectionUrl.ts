/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Connection URL parsing: the ONE userinfo splitter every parser uses
 * (DatabaseUrl, GraphUrl, Mqtt.parseUrl, parseAmqpUrl, the Mongo and backplane
 * driver hand-offs) - GHSA-h2mr-m3v3-cq8c. The redaction half, and THE RULE
 * both halves apply, are in urlRedaction.ts.
 *
 * Imports only urlRedaction.ts, itself import-free, so @tina4/core and
 * @tina4/orm both reach it without a cycle.
 */
import { digitLedPassword } from "./urlRedaction.js";

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
  const refuse = refuser(raw, options);
  const { scheme, rest } = schemeAndRest(raw, refuse);
  const { userinfo, afterUserinfo } = splitUserinfo(rest, refuse);
  const { hostPort, tail } = hostPortAndTail(afterUserinfo, userinfo !== null, refuse);
  // Only text after the last `@` may be named: with no `@`, "host:port" can be
  // `user:password` (`postgres://u:secret`).
  const { host, port } = firstHost(hostPort, options.allowHostList === true, refuse, userinfo !== null ? hostPort : undefined);
  refuseDigitLedPassword(userinfo, port, tail, refuse);
  const { rawUsername, rawPassword } = userinfoParts(userinfo);
  return {
    scheme,
    userinfo,
    rawUsername,
    rawPassword,
    username: decodeOrNull(rawUsername),
    password: decodeOrNull(rawPassword),
    hostPort,
    host,
    port,
    tail,
  };
}

/** Builds the one refusal message: label, scheme, why - never the value. */
type Refuse = (why: string, hostPort?: string) => ConnectionUrlError;

const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function refuser(raw: unknown, options: SplitOptions): Refuse {
  const expected = options.expected ?? "scheme://[user[:password]@]host[:port]/path";
  const named = SCHEME_PREFIX.exec(String(raw ?? ""))?.[1]?.toLowerCase();
  const subject = `${options.label}: invalid ${named ? `${named} ` : ""}URL`;
  return (why, hostPort) =>
    new ConnectionUrlError(
      `${subject}${hostPort ? ` at '${hostPort}'` : ""} (${why}) - expected ` +
        `${expected}. The URL itself is not shown because it may contain a password.`,
    );
}

/** `scheme` and everything after `scheme://`; `scheme:/` and `scheme//` are refused. */
function schemeAndRest(raw: unknown, refuse: Refuse): { scheme: string; rest: string } {
  if (typeof raw !== "string") throw refuse("not a string");
  const head = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (!head) throw refuse(SCHEME_PREFIX.test(raw) ? "the scheme must be followed by ://" : "no scheme:// found");
  return { scheme: head[1].toLowerCase(), rest: raw.slice(head[0].length) };
}

const AT_OUTSIDE_USERINFO = "an @ outside the user:password part - percent-encode it as %40";

/**
 * Userinfo by the last-`@` rule. The RFC reading cuts the authority at the
 * first / ? #. Where every `@` is inside that, it agrees with the last-`@`
 * rule. Where none is, the cut fell INSIDE a password holding / ? or #.
 * Anything in between means an `@` sits in the path or query, and which `@`
 * ends userinfo is a guess - refuse.
 */
function splitUserinfo(rest: string, refuse: Refuse): { userinfo: string | null; afterUserinfo: string } {
  const totalAt = count(rest, "@");
  if (totalAt === 0) return { userinfo: null, afterUserinfo: rest };
  const rfcEnd = rest.search(/[/?#]/);
  const rfcAt = count(rfcEnd === -1 ? rest : rest.slice(0, rfcEnd), "@");
  const lastAt = rest.lastIndexOf("@");
  const candidate = rest.slice(0, lastAt);
  const agrees = rfcAt === totalAt || (rfcAt === 0 && hasCleanUser(candidate));
  if (!agrees) throw refuse(AT_OUTSIDE_USERINFO);
  return { userinfo: candidate, afterUserinfo: rest.slice(lastAt + 1) };
}

/** A `:` exists, with no `/`, `?` or `#` in the user before it. */
function hasCleanUser(userinfo: string): boolean {
  const colon = userinfo.indexOf(":");
  return colon !== -1 && !/[/?#]/.test(userinfo.slice(0, colon));
}

/** The raw `host[:port]` up to the first / ? #, and the path+query+fragment after it. */
function hostPortAndTail(afterUserinfo: string, hasUserinfo: boolean, refuse: Refuse): { hostPort: string; tail: string } {
  const hostEnd = afterUserinfo.search(/[/?#]/);
  const hostPort = hostEnd === -1 ? afterUserinfo : afterUserinfo.slice(0, hostEnd);
  if (/\s/.test(hostPort)) throw refuse("whitespace in the host");
  if (hasUserinfo && hostPort === "") throw refuse("no host after the credentials");
  return { hostPort, tail: afterUserinfo.slice(hostPort.length) };
}

/** The first host and its port; every host in a list must be well formed. */
function firstHost(
  hostPort: string,
  allowHostList: boolean,
  refuse: Refuse,
  nameable: string | undefined,
): { host: string; port: number | null } {
  const hosts = allowHostList ? hostPort.split(",") : [hostPort];
  return hosts.map((piece) => oneHost(piece, refuse, nameable))[0];
}

function oneHost(piece: string, refuse: Refuse, nameable: string | undefined): { host: string; port: number | null } {
  const split = splitHostPort(piece);
  if (split === null) throw refuse("a malformed IPv6 host", nameable);
  const [host, port] = split;
  if (port === null || port === "") return { host, port: null };
  if (!/^\d+$/.test(port)) throw refuse("the port must be numeric", nameable);
  return { host, port: parseInt(port, 10) };
}

/**
 * No `@`, a numeric port, then a fragment or a non-`key=value` query: that is
 * a digit-led password (`u:12?Pq1Rs2`), not host `u` port 12 - a whole-value
 * parser (`new URL` included) would put the password in the query.
 */
function refuseDigitLedPassword(userinfo: string | null, port: number | null, tail: string, refuse: Refuse): void {
  if (userinfo !== null || port === null) return;
  if (digitLedPassword(tail)) throw refuse("a port followed by a fragment or a query that is not key=value");
}

/** Raw `user` and `password` (null when no `:` was written) from userinfo. */
function userinfoParts(userinfo: string | null): { rawUsername: string | null; rawPassword: string | null } {
  if (userinfo === null) return { rawUsername: null, rawPassword: null };
  const colon = userinfo.indexOf(":");
  if (colon === -1) return { rawUsername: userinfo, rawPassword: null };
  return { rawUsername: userinfo.slice(0, colon), rawPassword: userinfo.slice(colon + 1) };
}

const decodeOrNull = (value: string | null): string | null => (value === null ? null : decodeComponent(value));

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

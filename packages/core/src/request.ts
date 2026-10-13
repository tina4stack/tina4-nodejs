/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import type { IncomingMessage, IncomingHttpHeaders } from "node:http";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tina4Request, UploadedFile } from "./types.js";
import { resolveClientIp, isTrustedProxy } from "./trustedProxy.js";
import { Log } from "./logger.js";

/**
 * Wrap Node's `IncomingHttpHeaders` in a Proxy so mixed-case lookups
 * (`req.headers["Content-Type"]`) work alongside the canonical lowercase
 * form Node already provides. Parity with PY-10-03 (Python ships a
 * `CaseInsensitiveDict` for the same reason).
 *
 * The raw object is returned as-is by `Object.keys` / iteration — only
 * string property reads/`in` checks are normalised.
 */
export function makeCaseInsensitiveHeaders(
  raw: IncomingHttpHeaders,
): IncomingHttpHeaders {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const lower = prop.toLowerCase();
        if (lower in target) return (target as Record<string, unknown>)[lower];
        return Reflect.get(target, prop, receiver);
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string") {
        return prop.toLowerCase() in target || Reflect.has(target, prop);
      }
      return Reflect.has(target, prop);
    },
  }) as IncomingHttpHeaders;
}

/** Strips `readonly` so construction code can write once; callers outside
 * this function still see the real (readonly) `Tina4Request` shape
 * (REQ-IMMUTABILITY-DIVERGE, 3.13.99). */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

export function createRequest(req: IncomingMessage): Tina4Request {
  const tReq = req as Tina4Request;
  // Construction-only mutable view of the same object — the core wire-derived
  // fields (path/queryString/url/ip/remoteIp/cookies/contentType/query) are
  // `readonly` on Tina4Request itself; this alias is how THIS function is
  // still allowed to set them exactly once, the same way PHP's constructor
  // writes its own `readonly` properties.
  const w = tReq as Writable<Tina4Request>;
  // Wrap `req.headers` so mixed-case lookups work — Node's underlying object
  // is already lower-cased, this just lets readers use any casing they like.
  (tReq as unknown as { headers: IncomingHttpHeaders }).headers =
    makeCaseInsensitiveHeaders(req.headers);

  // Resolve scheme + host honouring proxy headers — parity with PHP/Python/Ruby.
  const trustedPeer = isTrustedProxy(req.socket?.remoteAddress ?? "");
  const xfProto = trustedPeer ? req.headers["x-forwarded-proto"] : undefined;
  const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto)
    ?? ((req.socket as { encrypted?: boolean })?.encrypted ? "https" : "http");
  const xfHost = trustedPeer ? req.headers["x-forwarded-host"] : undefined;
  const host = (Array.isArray(xfHost) ? xfHost[0] : xfHost)
    ?? (req.headers.host ?? "localhost");

  // Parse the request-target into path + query. The WHATWG `URL` parser THROWS
  // `ERR_INVALID_URL` on malformed targets like `//`, `///`, and `/\` — and this
  // runs BEFORE the dispatch try/catch, with the uncaughtException net only wired
  // under TINA4_DEBUG, so an unguarded throw crashes the worker in production
  // (unauthenticated remote DoS — scanners send `//` routinely). Guard it: on a
  // parse failure, derive the path/query straight from the raw target so routing
  // proceeds to a normal 404 instead of taking the process down. (#33)
  const query: Record<string, string> = {};
  let path: string;
  let queryString: string;
  let fullUrl: string;
  try {
    const url = new URL(req.url ?? "/", `${proto}://${host}`);
    for (const [key, value] of url.searchParams) {
      query[key] = value;
    }
    path = url.pathname;
    queryString = url.search.replace(/^\?/, "");
    fullUrl = url.toString();
  } catch {
    const rawTarget = req.url ?? "/";
    const questionIdx = rawTarget.indexOf("?");
    path = questionIdx >= 0 ? rawTarget.slice(0, questionIdx) : rawTarget;
    queryString = questionIdx >= 0 ? rawTarget.slice(questionIdx + 1) : "";
    try {
      for (const [key, value] of new URLSearchParams(queryString)) {
        query[key] = value;
      }
    } catch { /* unparseable query — leave query empty, still route the path */ }
    fullUrl = `${proto}://${host}${rawTarget}`;
  }

  tReq.params = {};
  w.query = query;
  // Path, query string, and full URL — same shape across all four frameworks.
  // `path` is the URL path only; `queryString` is the raw query without "?".
  // `url` is overridden from Node's IncomingMessage.url (path+query) to the
  // full absolute URL — parity with PHP/Python/Ruby.
  w.path = path;
  w.queryString = queryString;
  w.url = fullUrl;
  tReq.body = undefined;
  tReq.files = {};
  w.contentType = (req.headers["content-type"] ?? "") as string;

  // Parse cookies from Cookie header
  const cookieHeader = (req.headers.cookie ?? "") as string;
  const cookies: Record<string, string> = {};
  if (cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const [k, ...v] = pair.trim().split("=");
      if (k) cookies[k.trim()] = v.join("=").trim();
    }
  }
  w.cookies = cookies;

  // Raw socket peer — NEVER honours a forwarding header, so it can be trusted
  // for security decisions. Resolved BEFORE .ip: the peer decides whether the
  // forwarding headers may be believed at all (TINA4_TRUSTED_PROXIES, ADR-0019).
  w.remoteIp = req.socket?.remoteAddress ?? "";
  w.ip = resolveClientIp(req.headers, tReq.remoteIp) || "127.0.0.1";

  // Add convenience methods
  tReq.header = function (name: string): string | undefined {
    const val = req.headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
  };

  tReq.bearerToken = function (): string | null {
    const auth = tReq.header("authorization") ?? "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      return auth.slice(7);
    }
    return null;
  };

  tReq.param = function (key: string, defaultValue?: string | number): string | number | undefined {
    return tReq.params[key] ?? tReq.query[key] ?? defaultValue;
  };

  tReq.parseBody = function (): Promise<void> {
    return parseBody(tReq);
  };

  return tReq;
}


// ── Request limits (ADR-0068) ────────────────────────────────────────────────
// Here rather than in a module of their own: request.ts sits below the server
// and transport.ts, so both can read them without an import cycle, and the
// core barrel's eager module graph stays one module smaller.

export const DEFAULT_MAX_UPLOAD_SIZE = 10_485_760;

const warnedLimits = new Set<string>();

/**
 * Read a numeric limit from the environment. A value that is not a usable
 * number falls back to the default with a warning naming the variable (the
 * same rule as PHP's Server::resolveLimit) - a typo must never be what
 * disables a DoS guard.
 */
export function resolveLimit(name: string, fallback: number, zeroAllowed = false): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && (value > 0 || (value === 0 && zeroAllowed))) return value;
  if (!warnedLimits.has(`${name}=${raw}`)) {
    warnedLimits.add(`${name}=${raw}`);
    Log.warning(`${name}=${raw} is not a usable limit - using ${fallback}`);
  }
  return fallback;
}

/** TINA4_MAX_UPLOAD_SIZE, read when it is needed so a value from .env counts. */
export function maxUploadSize(): number {
  return resolveLimit("TINA4_MAX_UPLOAD_SIZE", DEFAULT_MAX_UPLOAD_SIZE);
}

/** The one 413 wording (ADR-0068 section 4). */
export function bodyTooLargeMessage(bytes: number | bigint | string, limit: number): string {
  return `Request body (${bytes} bytes) exceeds TINA4_MAX_UPLOAD_SIZE (${limit} bytes)`;
}



export class PayloadTooLargeError extends Error {
  public statusCode = 413;
  constructor(actual: number, limit: number) {
    super(bodyTooLargeMessage(actual, limit));
    this.name = "PayloadTooLargeError";
  }
}

async function parseBody(req: Tina4Request): Promise<void> {
  const method = req.method?.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  // Check content-length header against upload size limit before reading body
  const uploadLimit = maxUploadSize();

  const declaredLength = parseInt(req.headers["content-length"] ?? "0", 10);
  if (declaredLength > uploadLimit) {
    throw new PayloadTooLargeError(declaredLength, uploadLimit);
  }

  const contentType = req.headers["content-type"] ?? "";
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    // A RUNNING cap, checked per chunk.
    //
    // The content-length check above only sees what the client DECLARES. A
    // chunked request declares nothing, so declaredLength is 0 and it sails
    // through. Without this counter the body is buffered in full and only
    // then measured, which means the limit cannot prevent the thing it exists
    // to prevent. Measured against a 1MB limit: a 40MB chunked POST with no
    // content-length was accepted whole and grew the server's RSS by exactly
    // 40.0MB before it was refused.
    //
    // Same defect as PHP's unbounded read buffer, and the same fix: stop at
    // the limit instead of measuring the damage afterwards.
    let received = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      received += chunk.length;
      if (received > uploadLimit) {
        refused = true;
        chunks.length = 0; // drop what we have; the request is dead
        reject(new PayloadTooLargeError(received, uploadLimit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!refused) resolve();
    });
    req.on("error", reject);
  });

  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return;

  if (contentType.includes("multipart/form-data")) {
    const boundary = extractBoundary(contentType);
    if (boundary) {
      const { fields, files } = parseMultipart(raw, boundary);
      req.body = fields;
      req.files = files;
    } else {
      req.body = raw.toString("utf-8");
    }
  } else if (contentType.includes("application/json")) {
    const str = raw.toString("utf-8");
    try {
      req.body = JSON.parse(str);
    } catch {
      req.body = str;
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    req.body = nestFormFields([...new URLSearchParams(raw.toString("utf-8"))]);
  } else {
    req.body = raw.toString("utf-8");
  }
}

/**
 * Extract the boundary string from a multipart content-type header.
 */
function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * Parse multipart/form-data body into fields and files.
 * Zero-dependency implementation.
 */
export function parseMultipart(
  body: Buffer,
  boundary: string,
): { fields: Record<string, FormValue>; files: Record<string, UploadedFile | UploadedFile[]> } {
  const pairs: Array<[string, string]> = [];
  const files: Record<string, UploadedFile | UploadedFile[]> = {};

  const delimiter = Buffer.from(`--${boundary}`);
  const closeDelimiter = Buffer.from(`--${boundary}--`);
  const crlf = Buffer.from("\r\n");
  const doubleCrlf = Buffer.from("\r\n\r\n");

  let offset = 0;

  // Find first delimiter
  const firstIdx = bufferIndexOf(body, delimiter, offset);
  if (firstIdx === -1) return { fields: {}, files };
  offset = firstIdx + delimiter.length;

  // Skip CRLF after delimiter
  if (body[offset] === 0x0d && body[offset + 1] === 0x0a) {
    offset += 2;
  }

  while (offset < body.length) {
    // Find the end of headers (double CRLF)
    const headersEnd = bufferIndexOf(body, doubleCrlf, offset);
    if (headersEnd === -1) break;

    const headersStr = body.subarray(offset, headersEnd).toString("utf-8");
    offset = headersEnd + doubleCrlf.length;

    // Find next delimiter
    const nextDelimIdx = bufferIndexOf(body, delimiter, offset);
    if (nextDelimIdx === -1) break;

    // Content data is between current offset and nextDelimIdx - CRLF
    const contentEnd = nextDelimIdx - crlf.length;
    const content = body.subarray(offset, contentEnd);

    // Parse headers
    const disposition = parseDisposition(headersStr);
    const partContentType = parsePartContentType(headersStr);

    if (disposition.filename) {
      // File upload — standardised format: filename, type, content (raw bytes), size
      const file: UploadedFile = {
        fieldName: disposition.name,
        filename: disposition.filename,
        type: partContentType ?? "application/octet-stream",
        content: Buffer.from(content),
        size: content.length,
      };
      // Dict keyed by field name — multiple files under same name become array
      if (files[disposition.name]) {
        const existing = files[disposition.name];
        files[disposition.name] = Array.isArray(existing) ? [...existing, file] : [existing, file];
      } else {
        files[disposition.name] = file;
      }
    } else if (disposition.name) {
      // Regular field, nested once every part is read
      pairs.push([disposition.name, content.toString("utf-8")]);
    }

    // Move past the delimiter
    offset = nextDelimIdx + delimiter.length;

    // Check for close delimiter
    if (body[offset] === 0x2d && body[offset + 1] === 0x2d) {
      // "--" means end of multipart
      break;
    }

    // Skip CRLF after delimiter
    if (body[offset] === 0x0d && body[offset + 1] === 0x0a) {
      offset += 2;
    }
  }

  return { fields: nestFormFields(pairs), files };
}

/**
 * Persist an uploaded file's content inside `targetDir` under a SAFE name.
 *
 * The client-supplied filename is untrusted. Directory components are stripped
 * (so `../../evil` or `/etc/passwd` becomes `evil` / `passwd`), a NUL byte or an
 * unusable name (`''`/`.`/`..`) is refused, and the resolved path is confined to
 * `targetDir` (realpath containment) so an upload can never write outside it.
 *
 * @param file an uploaded-file descriptor (`req.files[name]`) carrying `content`.
 * @param targetDir the directory to write into (created if missing).
 * @param filename an explicit name to use instead of the client filename.
 * @returns the absolute path written.
 * @throws when the derived name is unsafe or would escape `targetDir`.
 */
export function saveUpload(file: UploadedFile, targetDir: string, filename?: string): string {
  const raw = String(filename ?? file.filename ?? "");
  if (raw.includes("\0")) throw new Error("upload filename contains a null byte");
  // Reduce to a single path segment, handling BOTH separators so a Windows
  // "..\\..\\evil" cannot smuggle a directory part past a POSIX basename.
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base === "" || base === "." || base === "..") {
    throw new Error(`upload filename is not a usable name: ${JSON.stringify(raw)}`);
  }
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, base);
  // Defence in depth: the resolved parent of the destination must be exactly
  // the resolved target dir.
  const realDir = realpathSync(targetDir);
  const realParent = realpathSync(dirname(dest));
  if (realParent !== realDir) {
    throw new Error(`refusing to write outside ${targetDir}: ${JSON.stringify(raw)}`);
  }
  // Never write THROUGH a link already at target/base: a symlink (even a
  // dangling one) leads out of targetDir, and a hard link shares its bytes
  // with a file elsewhere. Such an entry is removed so the upload gets a file
  // of its own; a plain file is rewritten in place and keeps its mode.
  if (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(dest);
  const flags = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  let fd = openSync(dest, flags, 0o666);
  try {
    if (fstatSync(fd).nlink > 1) {
      closeSync(fd);
      fd = -1;
      unlinkSync(dest);
      fd = openSync(dest, flags | constants.O_EXCL, 0o666);
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, file.content);
  } finally {
    if (fd >= 0) closeSync(fd);
  }
  return dest;
}

function bufferIndexOf(haystack: Buffer, needle: Buffer, offset: number): number {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

function parseDisposition(headers: string): { name: string; filename?: string } {
  const nameMatch = headers.match(/name="([^"]+)"/);
  const filenameMatch = headers.match(/filename="([^"]+)"/);
  return {
    name: nameMatch?.[1] ?? "",
    filename: filenameMatch?.[1],
  };
}

function parsePartContentType(headers: string): string | null {
  // ReDoS-safe: a single negated class captures the rest of the line (it stops
  // at CR/LF on its own, so no terminator alternation and no leading [ \t]* to
  // overlap). Trim the surrounding whitespace in code.
  const match = headers.match(/Content-Type:([^\r\n]*)/i);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** A form field's value once its name is nested: `tags[]` a list, `user[name]` an object. */
export type FormValue = string | FormValue[] | { [key: string]: FormValue };

/** A field name nested this deep or deeper keeps its flat key. Rack's param_depth_limit. */
const FORM_DEPTH_LIMIT = 32;

/** A form with more fields than this is not nested at all. Rack's params_limit. */
const FORM_FIELD_LIMIT = 4096;

/** A field name longer than this keeps its flat key. */
const FORM_NAME_LIMIT = 1024;

/**
 * Nest form fields the way PHP and Rack (tina4-ruby) nest a form: `tags[]`
 * collects an array, `user[name]` builds an object, `a[][x]` an array of
 * objects, and a repeated plain name keeps its last value. Used for urlencoded
 * and multipart bodies alike, so a form arrives in one shape however it was
 * encoded. A field that cannot nest - its name conflicts with an earlier one
 * (`a=1` then `a[b]=2`), nests too deep or is longer than FORM_NAME_LIMIT -
 * keeps its flat key; the rest still nest. A later plain name replaces an
 * earlier nested value of that name, as Rack and parse_str do. A field with a `__proto__` segment anywhere in its name is dropped.
 */
function nestFormFields(pairs: Array<[string, string]>): Record<string, FormValue> {
  const kept = pairs.filter(([name]) => !/(^|[[\]])__proto__([[\]]|$)/.test(name));
  if (kept.length > FORM_FIELD_LIMIT) return Object.fromEntries(kept);
  const nested = new WeakSet<object>();
  const node = (): Record<string, FormValue> => {
    const created: Record<string, FormValue> = {};
    nested.add(created);
    return created;
  };
  const isNode = (value: unknown): value is Record<string, FormValue> =>
    typeof value === "object" && value !== null && nested.has(value);
  const own = (params: Record<string, FormValue>, key: string): FormValue | undefined =>
    Object.prototype.hasOwnProperty.call(params, key) ? params[key] : undefined;
  const list = (params: Record<string, FormValue>, key: string): FormValue[] => {
    const current = own(params, key) ?? (params[key] = []);
    if (!Array.isArray(current)) throw new RangeError(`expected an array for '${key}'`);
    return current;
  };
  const object = (params: Record<string, FormValue>, key: string): Record<string, FormValue> => {
    const current = own(params, key) ?? (params[key] = node());
    if (!isNode(current)) throw new RangeError(`expected an object for '${key}'`);
    return current;
  };
  const hasKey = (params: Record<string, FormValue>, key: string): boolean => {
    if (key.includes("[]")) return false;
    let level: FormValue | undefined = params;
    for (const part of key.split(/[[\]]+/).filter(Boolean)) {
      if (!isNode(level) || own(level, part) === undefined) return false;
      level = level[part];
    }
    return true;
  };
  const splitName = (name: string, depth: number): [string, string] => {
    if (depth === 0) {
      const start = name.indexOf("[", 1);
      return start === -1 ? [name, ""] : [name.slice(0, start), name.slice(start)];
    }
    if (name.startsWith("[]")) return ["[]", name.slice(2)];
    const close = name.indexOf("]", 1);
    return name.startsWith("[") && close !== -1 ? [name.slice(1, close), name.slice(close + 1)] : [name, ""];
  };
  // `a[][x]`: fill the last record unless it already has `x`, else start one.
  const putListItem = (items: FormValue[], after: string, value: string, depth: number): void => {
    let childKey = after[2] === "[" && after.endsWith("]") ? after.slice(3, -1) : "";
    if (childKey === "" || childKey.includes("[") || childKey.includes("]")) childKey = after.slice(2);
    const last = items[items.length - 1];
    if (isNode(last) && !hasKey(last, childKey)) put(last, childKey, value, depth + 1);
    else items.push(put(node(), childKey, value, depth + 1) as FormValue);
  };
  // Rack::QueryParser#normalize_params, ported from tina4-ruby's form parser.
  const put = (params: Record<string, FormValue>, name: string, value: string, depth: number): FormValue | undefined => {
    const [key, after] = splitName(name, depth);
    if (key === "") return undefined;
    if (after === "" && key === "[]" && depth !== 0) return [value];
    if (after === "") params[key] = value;
    else if (after === "[") params[name] = value;
    else if (after === "[]") list(params, key).push(value);
    else if (after.startsWith("[]")) putListItem(list(params, key), after, value, depth);
    else put(object(params, key), after, value, depth + 1);
    return params;
  };
  // Counts brackets only up to the limit, so a name of millions of them costs nothing.
  const tooDeep = (name: string): boolean => {
    let count = 0;
    for (let at = name.indexOf("["); at !== -1; at = name.indexOf("[", at + 1)) {
      if (++count >= FORM_DEPTH_LIMIT) return true;
    }
    return false;
  };
  const fields = node();
  for (const [name, value] of kept) {
    if (name.length > FORM_NAME_LIMIT || tooDeep(name)) {
      fields[name] = value;
      continue;
    }
    try {
      put(fields, name, value, 0);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      fields[name] = value;
    }
  }
  return fields;
}

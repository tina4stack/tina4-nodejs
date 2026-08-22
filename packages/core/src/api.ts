/**
 * Tina4 API Client — HTTP client using Node.js built-in modules only.
 *
 *     import { Api } from "@tina4/core";
 *
 *     const api = new Api("https://api.example.com");
 *     const result = await api.get("/users");
 *     const result = await api.post("/users", { name: "Alice" });
 *
 * Multipart upload (from disk or in-memory bytes), streaming download,
 * an injectable transport seam (for USERS to unit-test their own code),
 * an opt-in per-client cookie jar, and redirect following with a
 * cross-origin Authorization/Cookie strip are all built on the same
 * zero-dependency node:http / node:https core.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { promises as fsp, createWriteStream } from "node:fs";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { TINA4_VERSION } from "./version.js";

export interface ApiResult {
    http_code: number | null;
    body: unknown;
    headers: Record<string, string>;
    error: string | null;
}

/**
 * Options for the streaming primitives ({@link Api.streamBytes},
 * {@link Api.streamLines}, {@link Api.streamSse}). All fields optional.
 * `timeout` bounds the WHOLE stream (headers + body), matching
 * `TINA4_API_TIMEOUT`; `connectTimeout` bounds only the connection +
 * headers-arrival phase, matching `TINA4_API_CONNECT_TIMEOUT`.
 */
export interface StreamOptions {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    contentType?: string;
    timeout?: number;
    connectTimeout?: number;
}

/**
 * One SSE event yielded by {@link Api.streamSse}. `data` is always present
 * (multi-line `data:` fields are concatenated with `\n`). `event`, `id`,
 * `retry` are set only when the corresponding SSE field appeared. `retry`
 * is a number (milliseconds) per the SSE spec.
 */
export interface SseEvent {
    data: string;
    event?: string;
    id?: string;
    retry?: number;
}

/** Raised by the streaming primitives on a non-2xx status. */
export class ApiStreamError extends Error {
    constructor(message: string, public readonly status: number | null = null) {
        super(message);
        this.name = "ApiStreamError";
    }
}

/**
 * Result of {@link Api.download}. There is no `body` field — the response
 * body went to disk. `path` is the destination on success and `null` on any
 * error (missing dest, HTTP error status, transport failure); the file is not
 * written on error. Keeps `http_code` (snake_case) for parity with
 * {@link ApiResult} and the Python/PHP/Ruby `download` return.
 */
export interface DownloadResult {
    http_code: number | null;
    headers: Record<string, string>;
    error: string | null;
    path: string | null;
}

/**
 * An injectable transport seam (constructor option `transport`). When supplied
 * it fully REPLACES the node:http/https network call. Called as
 * `(method, url, headers, body, timeout)` and must return the same result
 * shape every verb returns (`{ http_code, body, headers, error }`); may be sync
 * or async.
 *
 * NOTE: Tina4's own test suite must NEVER inject a fake/canned transport — the
 * no-mock rule stands, so framework tests always exercise the real network path
 * against a real local server. This seam exists purely so *application*
 * developers can unit-test code that calls an `Api` instance without a live
 * server.
 */
export type ApiTransport = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer | null,
    timeout: number,
) => ApiResult | Promise<ApiResult>;

/**
 * Options for {@link Api.upload}. Supply the file EITHER as `filePath` (a file
 * on disk) OR as `fileBytes` + `filename` (an in-memory payload) — a caller
 * never needs a temp file.
 */
export interface UploadOptions {
    /** A file on disk. `filename` defaults to its basename. */
    filePath?: string;
    /** The form field the file is sent under (default `"file"`). */
    fieldName?: string;
    /** Additional text parts of the multipart body. */
    extraFields?: Record<string, string>;
    /** Extra per-call headers merged onto the request. */
    headers?: Record<string, string>;
    /** An in-memory payload (Buffer or string). Requires `filename` for a name. */
    fileBytes?: Buffer | string;
    /** Filename used in the Content-Disposition part header. */
    filename?: string;
}

/**
 * HTTP statuses that warrant an automatic retry when `maxRetries` > 0:
 * rate-limit (429) plus the transient server-side 5xx family. 4xx client
 * errors (401, 404, …) are NOT retried — a repeat won't succeed.
 */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * Streaming download writes this many bytes per buffer so a multi-megabyte body
 * never lands in memory in one piece (matches Python's 64 KB chunked read).
 */
const DOWNLOAD_CHUNK_SIZE = 64 * 1024;

/** Bounded redirect hop count — mirrors urllib's HTTPRedirectHandler default. */
const MAX_REDIRECTS = 10;

/**
 * Headers dropped when a redirect crosses to a different origin — a bearer
 * token or a session cookie must never be handed to a host you didn't
 * authenticate to.
 */
const STRIP_ON_CROSS_ORIGIN: ReadonlySet<string> = new Set(["authorization", "cookie"]);

/**
 * Minimal extension → MIME map for guessing a multipart part's Content-Type.
 * Kept in-repo so the client stays zero-dependency (Node has no stdlib
 * mimetypes). Values match Python's `mimetypes.guess_type` for these common
 * extensions, so the multipart wire body is byte-identical across frameworks.
 */
const MIME_BY_EXT: Record<string, string> = {
    txt: "text/plain",
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    csv: "text/csv",
    js: "text/javascript",
    mjs: "text/javascript",
    json: "application/json",
    xml: "application/xml",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/vnd.microsoft.icon",
    bmp: "image/bmp",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/x-wav",
    ogg: "audio/ogg",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
};

/**
 * Constructor options for {@link Api}. Used as the second argument to
 * `new Api(url, { ... })` — cross-framework parity with Python
 * `Api(bearer_token=, ...)` kwargs added in 3.13.x.
 */
export interface ApiOptions {
    authHeader?: string;
    timeout?: number;
    ignoreSsl?: boolean;
    /** Positive form of ignoreSsl — `verifySsl: false` disables verification. */
    verifySsl?: boolean;
    bearerToken?: string;
    username?: string;
    password?: string;
    headers?: Record<string, string>;
    /**
     * Maximum automatic retries on a transient failure (default 0 = off, so
     * existing callers are unaffected). When > 0, a transport error or a
     * retryable status (429/5xx) is retried up to this many times with
     * exponential backoff. NOTE: a retried non-idempotent request (POST/…)
     * may be re-sent — retries are opt-in for that reason.
     */
    maxRetries?: number;
    /** Base backoff in seconds, doubling each attempt (default 0.5). */
    retryBackoff?: number;
    /**
     * Injectable transport seam (default undefined = the real network path).
     * When supplied it REPLACES the node:http/https call. See {@link ApiTransport}.
     * Tina4's own suite never injects it (no-mock rule) — it exists so
     * application developers can unit-test their own code.
     */
    transport?: ApiTransport;
    /**
     * Opt-in per-client, in-memory cookie jar (default false = off, zero
     * behaviour change). When true, `Set-Cookie` response headers are parsed and
     * the accumulated `Cookie` header is sent on subsequent requests. Not
     * persisted; scoped to this instance.
     */
    cookies?: boolean;
}

/** True when two URLs share scheme + host + (effective) port. */
function sameOrigin(urlA: string, urlB: string): boolean {
    try {
        const a = new URL(urlA);
        const b = new URL(urlB);
        const defaultPort: Record<string, string> = { "http:": "80", "https:": "443" };
        const portA = a.port || defaultPort[a.protocol] || "";
        const portB = b.port || defaultPort[b.protocol] || "";
        return a.protocol === b.protocol && a.hostname === b.hostname && portA === portB;
    } catch {
        return false;
    }
}

/** Delete a header by name, case-insensitively (headers may use any casing). */
function deleteHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower) {
            delete headers[key];
        }
    }
}

/** Flatten node's IncomingHttpHeaders into a plain string map (arrays joined). */
function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
            out[key] = Array.isArray(value) ? value.join(", ") : value;
        }
    }
    return out;
}

/** Guess a multipart part's Content-Type from the filename extension. */
function guessContentType(filename: string): string {
    const dot = filename.lastIndexOf(".");
    if (dot >= 0) {
        const ext = filename.slice(dot + 1).toLowerCase();
        const found = MIME_BY_EXT[ext];
        if (found) {
            return found;
        }
    }
    return "application/octet-stream";
}

/**
 * Assemble a `multipart/form-data` body as a Buffer.
 *
 * Text fields come first, then the file part, then the closing delimiter —
 * matching the canonical Python/Ruby `build_multipart_body` layout so every
 * framework produces a byte-identical body: `--<boundary>\r\n` delimited parts,
 * `\r\n` line breaks, closing `--<boundary>--\r\n`.
 */
function buildMultipartBody(
    boundary: string,
    fieldName: string,
    filename: string,
    fileContent: Buffer,
    contentType: string,
    extraFields?: Record<string, string>,
): Buffer {
    const crlf = "\r\n";
    const delimiter = `--${boundary}`;
    const parts: Buffer[] = [];
    if (extraFields) {
        for (const [key, value] of Object.entries(extraFields)) {
            parts.push(Buffer.from(delimiter + crlf, "utf-8"));
            parts.push(Buffer.from(`Content-Disposition: form-data; name="${key}"` + crlf + crlf, "utf-8"));
            parts.push(Buffer.from(String(value) + crlf, "utf-8"));
        }
    }
    parts.push(Buffer.from(delimiter + crlf, "utf-8"));
    parts.push(
        Buffer.from(`Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"` + crlf, "utf-8"),
    );
    parts.push(Buffer.from(`Content-Type: ${contentType}` + crlf + crlf, "utf-8"));
    parts.push(fileContent);
    parts.push(Buffer.from(crlf, "utf-8"));
    parts.push(Buffer.from(delimiter + "--" + crlf, "utf-8"));
    return Buffer.concat(parts);
}

/**
 * Split an async byte iterable into UTF-8 lines. Handles LF and CRLF; a
 * multibyte codepoint that lands across a chunk boundary buffers across the
 * split (TextDecoder({stream: true})). A trailing line without a terminator
 * yields on EOF.
 *
 * Exported so {@link Api} instance methods AND `Ai.chat` streaming share
 * one framer — ADR-0060's "no duplicate framing code" rule.
 */
export async function* parseLineStream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    for await (const chunk of chunks) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
            let line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.endsWith("\r")) {
                line = line.slice(0, -1);
            }
            yield line;
        }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
        if (buffer.endsWith("\r")) {
            buffer = buffer.slice(0, -1);
        }
        yield buffer;
    }
}

/**
 * Parse SSE (Server-Sent Events) framing from a line iterable. Yields
 * one {@link SseEvent} per event boundary (blank line) or on EOF for a
 * final trailing event. `:` comment lines are ignored. Fields are
 * `data` (multi-line concatenated with `\n`), `event`, `id`, `retry`.
 *
 * Follows the WHATWG SSE parsing algorithm closely enough for every LLM
 * provider (OpenAI, Anthropic, local): one leading space after the colon
 * is stripped, unknown fields are ignored, malformed `retry:` values are
 * ignored.
 */
export async function* parseSseStream(lines: AsyncIterable<string>): AsyncGenerator<SseEvent> {
    let dataParts: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    let retry: number | undefined;
    let has = false;
    const emit = (): SseEvent | null => {
        if (!has) return null;
        const ev: SseEvent = { data: dataParts.join("\n") };
        if (event !== undefined) ev.event = event;
        if (id !== undefined) ev.id = id;
        if (retry !== undefined) ev.retry = retry;
        return ev;
    };
    const reset = (): void => { dataParts = []; event = undefined; id = undefined; retry = undefined; has = false; };
    for await (const line of lines) {
        if (line === "") {
            const ev = emit();
            if (ev) yield ev;
            reset();
            continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        switch (field) {
            case "data":
                dataParts.push(value);
                has = true;
                break;
            case "event":
                event = value;
                has = true;
                break;
            case "id":
                id = value;
                has = true;
                break;
            case "retry": {
                const parsed = Number(value);
                if (Number.isFinite(parsed) && parsed >= 0) {
                    retry = parsed;
                    has = true;
                }
                break;
            }
        }
    }
    const trailing = emit();
    if (trailing) yield trailing;
}

/** Outcome of a single network exchange (after any redirects are followed). */
type NetworkResult =
    | { kind: "response"; res: http.IncomingMessage }
    | { kind: "error"; error: string };

export class Api {
    private baseUrl: string;
    private headers: Record<string, string>;
    private timeout: number;
    private authHeader: string;
    private ignoreSsl: boolean;
    private maxRetries: number;
    private retryBackoff: number;
    private transportFn?: ApiTransport;
    private cookiesEnabled: boolean;
    private cookies: Record<string, string>;

    /**
     * Construct an Api client.
     *
     * Two construction styles supported:
     *
     *     // Legacy positional form
     *     new Api("https://api.example.com", "Bearer token", 30);
     *
     *     // 3.13.1: ergonomic options bag (recommended) — cross-framework
     *     // parity with Python tina4_python.api.Api kwargs.
     *     new Api("https://api.example.com", { bearerToken: "sk-abc" });
     *     new Api("https://api.example.com", { username: "u", password: "p" });
     *     new Api("https://api.example.com", { headers: { "X-Tenant": "acme" } });
     *     new Api("https://self-signed.local", { verifySsl: false });
     *
     * Bearer wins over basic-auth when both passed. `verifySsl: false` is
     * the positive form of `ignoreSsl: true`; `ignoreSsl` wins when both
     * supplied for backward compatibility.
     *
     * `maxRetries` (default 0 = off) enables automatic retry with
     * exponential backoff (`retryBackoff` seconds base, doubling each
     * attempt) on a transport error or a retryable status (429/5xx). A
     * retried non-idempotent request (POST/…) may be re-sent — retries are
     * opt-in for that reason.
     *
     *     new Api("https://api.example.com", { maxRetries: 3, retryBackoff: 0.5 });
     *
     * `transport` (default undefined = the real network path) is an injectable
     * seam so USERS can unit-test their own code; `cookies` (default false)
     * turns on a per-client, in-memory cookie jar.
     */
    constructor(
        baseUrl: string = "",
        authHeaderOrOptions: string | ApiOptions = "",
        timeout: number = 30
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.headers = {};
        // Retry defaults: off (0) so existing callers are unaffected.
        this.maxRetries = 0;
        this.retryBackoff = 0.5;
        // Transport seam + cookie jar default to inert (zero behaviour change).
        this.transportFn = undefined;
        this.cookiesEnabled = false;
        this.cookies = {};

        // Options-bag form — second arg is an object literal
        if (typeof authHeaderOrOptions === "object" && authHeaderOrOptions !== null) {
            const opts = authHeaderOrOptions;
            this.authHeader = opts.authHeader ?? "";
            this.timeout = opts.timeout ?? timeout;
            this.ignoreSsl = (opts.ignoreSsl ?? false) || (opts.verifySsl === false);
            this.maxRetries = Math.max(0, opts.maxRetries ?? 0);
            this.retryBackoff = opts.retryBackoff ?? 0.5;
            this.transportFn = opts.transport;
            this.cookiesEnabled = opts.cookies ?? false;

            // Bearer wins over basic-auth when both are passed
            if (opts.bearerToken != null) {
                this.setBearerToken(opts.bearerToken);
            } else if (opts.username != null && opts.password != null) {
                this.setBasicAuth(opts.username, opts.password);
            }

            if (opts.headers) {
                this.addHeaders(opts.headers);
            }
            return;
        }

        // Legacy positional form
        this.authHeader = authHeaderOrOptions;
        this.timeout = timeout;
        this.ignoreSsl = false;
    }

    /**
     * Add custom headers to all subsequent requests.
     */
    addHeaders(headers: Record<string, string>): void {
        Object.assign(this.headers, headers);
    }

    /**
     * Set Bearer token authentication.
     */
    setBearerToken(token: string): void {
        this.authHeader = `Bearer ${token}`;
    }

    /**
     * Set Basic authentication.
     */
    setBasicAuth(username: string, password: string): void {
        const encoded = Buffer.from(`${username}:${password}`).toString("base64");
        this.authHeader = `Basic ${encoded}`;
    }

    /**
     * Disable SSL certificate verification (dev/self-signed certs only).
     */
    setIgnoreSsl(ignore: boolean): void {
        this.ignoreSsl = ignore;
    }

    /**
     * HTTP GET request.
     */
    async get(path: string, params?: Record<string, string>): Promise<ApiResult> {
        let url = this.buildUrl(path);
        if (params && Object.keys(params).length > 0) {
            const qs = new URLSearchParams(params).toString();
            url += (url.includes("?") ? "&" : "?") + qs;
        }
        return this.execute("GET", url);
    }

    /**
     * HTTP POST request.
     */
    async post(path: string, body?: unknown, contentType: string = "application/json"): Promise<ApiResult> {
        return this.sendRequest("POST", path, body, contentType);
    }

    /**
     * HTTP PUT request.
     */
    async put(path: string, body?: unknown, contentType: string = "application/json"): Promise<ApiResult> {
        return this.sendRequest("PUT", path, body, contentType);
    }

    /**
     * HTTP PATCH request.
     */
    async patch(path: string, body?: unknown, contentType: string = "application/json"): Promise<ApiResult> {
        return this.sendRequest("PATCH", path, body, contentType);
    }

    /**
     * HTTP DELETE request.
     */
    async delete(path: string, body?: unknown): Promise<ApiResult> {
        return this.sendRequest("DELETE", path, body);
    }

    /**
     * Generic request method — public entry point for any HTTP method.
     */
    async sendRequest(
        method: string,
        path: string,
        body?: unknown,
        contentType: string = "application/json",
    ): Promise<ApiResult> {
        const url = this.buildUrl(path);
        return this.execute(method.toUpperCase(), url, body, contentType);
    }

    /**
     * POST a `multipart/form-data` body — a file plus optional text fields.
     *
     * Two ways to supply the file, so a caller never needs a temp file:
     *
     *   - `filePath` — a file on disk. `filename` defaults to its basename.
     *   - `fileBytes` + `filename` — an in-memory payload (Buffer or string).
     *
     * `fieldName` (default `"file"`) is the form field the file is sent under.
     * `extraFields` become additional text parts. `headers` are extra per-call
     * headers merged onto the request. The part's Content-Type is guessed from
     * the filename (falling back to `application/octet-stream`).
     *
     * Returns the standard {@link ApiResult}. A missing file or no source given
     * returns a clean error result (`http_code` null, `error` set) — it does NOT
     * throw. Retry/backoff (if configured) applies, exactly like the verbs.
     *
     *     await api.upload("/avatars", { filePath: "/tmp/me.png" });
     *     await api.upload("/avatars", { fileBytes: raw, filename: "me.png",
     *                                    extraFields: { user_id: "42" } });
     */
    async upload(path: string, opts: UploadOptions = {}): Promise<ApiResult> {
        const { filePath, fieldName = "file", extraFields, headers, fileBytes, filename } = opts;

        let content: Buffer;
        let uploadName: string;

        if (fileBytes !== undefined && fileBytes !== null) {
            content = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(String(fileBytes), "utf-8");
            uploadName = filename || "upload.bin";
        } else if (filePath) {
            let isFile = false;
            try {
                isFile = (await fsp.stat(filePath)).isFile();
            } catch {
                isFile = false;
            }
            if (!isFile) {
                return { http_code: null, body: null, headers: {}, error: `file not found: ${filePath}` };
            }
            try {
                content = await fsp.readFile(filePath);
            } catch (err) {
                return {
                    http_code: null,
                    body: null,
                    headers: {},
                    error: err instanceof Error ? err.message : String(err),
                };
            }
            uploadName = filename || basename(filePath);
        } else {
            return { http_code: null, body: null, headers: {}, error: "upload requires filePath or fileBytes" };
        }

        const partContentType = guessContentType(uploadName);
        const boundary = "----Tina4Boundary" + randomBytes(16).toString("hex");
        const bodyBuffer = buildMultipartBody(boundary, fieldName, uploadName, content, partContentType, extraFields);
        const contentType = `multipart/form-data; boundary=${boundary}`;
        return this.execute("POST", this.buildUrl(path), bodyBuffer, contentType, headers);
    }

    /**
     * Stream a GET response body to `destPath` in chunks.
     *
     * The body is written to disk `DOWNLOAD_CHUNK_SIZE` bytes at a time instead
     * of being buffered whole in memory — safe for large payloads. Redirect
     * following, the cross-origin auth strip, the cookie jar, and the SSL flag
     * all apply, exactly like the other verbs.
     *
     * Returns {@link DownloadResult} — there is no `body` field (it went to
     * disk). `path` is `destPath` on success and `null` on any error (missing
     * dest, HTTP error status, or a transport failure); the destination file is
     * not written on error.
     */
    async download(path: string, destPath: string, params?: Record<string, string>): Promise<DownloadResult> {
        if (!destPath) {
            return { http_code: null, headers: {}, error: "download requires destPath", path: null };
        }

        let url = this.buildUrl(path);
        if (params && Object.keys(params).length > 0) {
            const qs = new URLSearchParams(params).toString();
            url += (url.includes("?") ? "&" : "?") + qs;
        }

        const { headers, data } = this.buildRequest("GET", "application/json", undefined);

        // An injected transport can't stream (it returns a buffered result), so
        // write its body out; only the real network path streams chunk-by-chunk.
        if (this.transportFn) {
            const result = await this.callTransport("GET", url, headers, data);
            const code = result.http_code;
            if (result.error === null && code !== null && code >= 200 && code < 300) {
                const raw = result.body;
                let buffer: Buffer;
                if (Buffer.isBuffer(raw)) {
                    buffer = raw;
                } else if (typeof raw === "string") {
                    buffer = Buffer.from(raw, "utf-8");
                } else {
                    buffer = Buffer.from(JSON.stringify(raw ?? null), "utf-8");
                }
                try {
                    await fsp.writeFile(destPath, buffer);
                } catch (err) {
                    return {
                        http_code: code,
                        headers: result.headers,
                        error: err instanceof Error ? err.message : String(err),
                        path: null,
                    };
                }
                return { http_code: code, headers: result.headers, error: null, path: destPath };
            }
            return {
                http_code: code,
                headers: result.headers,
                error: result.error ?? `download failed (HTTP ${code})`,
                path: null,
            };
        }

        const net = await this.performRequest("GET", url, headers, data, MAX_REDIRECTS);
        if (net.kind === "error") {
            return { http_code: null, headers: {}, error: net.error, path: null };
        }

        const res = net.res;
        const code = res.statusCode ?? null;
        const respHeaders = flattenHeaders(res.headers);

        // >= 400 mirrors Python's urllib raising HTTPError — no file written.
        if (code === null || code >= 400) {
            res.resume(); // drain so the socket is freed
            return {
                http_code: code,
                headers: respHeaders,
                error: `download failed (HTTP ${code})`,
                path: null,
            };
        }

        this.storeCookies(res.headers["set-cookie"]);

        const fileStream = createWriteStream(destPath, { highWaterMark: DOWNLOAD_CHUNK_SIZE });
        try {
            await pipeline(res, fileStream);
        } catch (err) {
            return {
                http_code: code,
                headers: respHeaders,
                error: err instanceof Error ? err.message : String(err),
                path: null,
            };
        }
        return { http_code: code, headers: respHeaders, error: null, path: destPath };
    }

    /**
     * Stream a response body as raw bytes. Yields the chunks the transport
     * delivers, in order, never buffered whole. Ends cleanly on EOF and
     * throws on a transport failure or a non-2xx status (body drained
     * first). No JSON decoding, no line splitting, no framing —
     * {@link streamLines} and {@link streamSse} build on this primitive.
     *
     * Closing the iterator before EOF (a `break` out of a `for await`)
     * destroys the underlying socket, so a caller who takes only the
     * first few chunks never leaks the connection.
     *
     * `opts.timeout` bounds the whole stream duration (default
     * `TINA4_API_TIMEOUT` or the client `timeout`); `opts.connectTimeout`
     * bounds just the connect + headers phase (default
     * `TINA4_API_CONNECT_TIMEOUT` or 10s).
     */
    async *streamBytes(path: string, opts: StreamOptions = {}): AsyncGenerator<Uint8Array> {
        const url = this.buildUrl(path);
        const method = (opts.method ?? "GET").toUpperCase();
        const contentType = opts.contentType ?? "application/json";
        const { headers, data } = this.buildRequest(method, contentType, opts.body, opts.headers);
        const totalSec = this.streamSeconds(opts.timeout, "TINA4_API_TIMEOUT", this.timeout);
        const connectSec = this.streamSeconds(opts.connectTimeout, "TINA4_API_CONNECT_TIMEOUT", 10);
        const opened = await this.openStreamRequest(method, url, headers, data, connectSec);
        const res = opened.res;
        const status = res.statusCode ?? 0;
        this.storeCookies(res.headers["set-cookie"]);
        if (status < 200 || status >= 300) {
            res.resume();
            throw new ApiStreamError(`stream failed with HTTP ${status}`, status);
        }
        let totalTimer: NodeJS.Timeout | null = null;
        if (totalSec > 0) {
            totalTimer = setTimeout(() => {
                res.destroy(new ApiStreamError(`stream total timeout after ${totalSec}s`, null));
            }, totalSec * 1000);
        }
        try {
            for await (const chunk of res) {
                yield chunk as Uint8Array;
            }
        } finally {
            if (totalTimer) clearTimeout(totalTimer);
            if (!res.destroyed) res.destroy();
        }
    }

    /**
     * Stream the response body as UTF-8 lines. Splits on LF or CRLF;
     * buffers a multibyte codepoint that lands across a chunk boundary;
     * yields a trailing line without a terminator on EOF. Built on
     * {@link streamBytes} plus the shared {@link parseLineStream}.
     */
    async *streamLines(path: string, opts: StreamOptions = {}): AsyncGenerator<string> {
        yield* parseLineStream(this.streamBytes(path, opts));
    }

    /**
     * Stream the response as SSE (Server-Sent Events). Yields one
     * {@link SseEvent} per event boundary (blank line) or on EOF for a
     * trailing event. `data:[DONE]` is delivered as an ordinary event
     * with `data === "[DONE]"` and the iterator ends on the next EOF.
     * Built on {@link streamLines} plus the shared {@link parseSseStream}.
     */
    async *streamSse(path: string, opts: StreamOptions = {}): AsyncGenerator<SseEvent> {
        yield* parseSseStream(this.streamLines(path, opts));
    }

    // ── Internal helpers ──────────────────────────────────────────────

    /**
     * Resolve a stream duration from (in order): explicit `opts` field,
     * the named env var, then the fallback. Zero disables. A non-numeric
     * or negative env value warns via a fallback rather than throwing —
     * a bad env var must not brick every streaming call.
     */
    private streamSeconds(explicit: number | undefined, envName: string, fallback: number): number {
        if (explicit !== undefined) {
            return Number.isFinite(explicit) && explicit >= 0 ? Number(explicit) : fallback;
        }
        const raw = process.env[envName];
        if (raw === undefined) return fallback;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    }

    /**
     * Open a streaming HTTP request. Returns the raw
     * {@link http.IncomingMessage} once headers arrive. Redirects are NOT
     * followed on streams (a caller who needs a redirect should do a
     * regular GET first). Connect phase is bounded by `connectSec`;
     * body-phase timeout is applied by the caller (streamBytes) via
     * `res.destroy()`.
     */
    private openStreamRequest(
        method: string,
        url: string,
        headers: Record<string, string>,
        data: Buffer | undefined,
        connectSec: number,
    ): Promise<{ res: http.IncomingMessage }> {
        return new Promise((resolve, reject) => {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            const isHttps = parsed.protocol === "https:";
            const protocolModule = isHttps ? https : http;
            const options: http.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method,
                headers,
                timeout: connectSec > 0 ? connectSec * 1000 : undefined,
            };
            if (isHttps && this.ignoreSsl) {
                (options as https.RequestOptions).rejectUnauthorized = false;
            }
            const req = protocolModule.request(options, (res) => {
                resolve({ res });
            });
            req.on("timeout", () => {
                req.destroy(new ApiStreamError(`stream connect timeout after ${connectSec}s`, null));
            });
            req.on("error", (err) => {
                reject(err);
            });
            if (data) req.write(data);
            req.end();
        });
    }

    private buildUrl(path: string): string {
        if (path.startsWith("http://") || path.startsWith("https://")) {
            return path;
        }
        if (!path) {
            return this.baseUrl;
        }
        return `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
    }

    /**
     * Build the request headers (default User-Agent + auth + cookie jar +
     * extras) and serialize the body to a Buffer. Shared by every verb,
     * upload, and download so the wire shape is identical and the transport
     * seam sees exactly what the network path would.
     *
     * VERSION-DEC-03 (feature 130): every outbound request carries a default
     * `Tina4/<version>` User-Agent. `this.headers` is spread AFTER the
     * default, and `extraHeaders` after that, so a caller-supplied
     * `User-Agent` (via the constructor's `headers` option, `addHeaders()`,
     * or a per-call `extraHeaders`) always wins -- this is a default, never a
     * clobber.
     */
    private buildRequest(
        method: string,
        contentType: string,
        body: unknown,
        extraHeaders?: Record<string, string>,
    ): { headers: Record<string, string>; data: Buffer | undefined } {
        const headers: Record<string, string> = { "User-Agent": `Tina4/${TINA4_VERSION}`, ...this.headers };
        if (this.authHeader) {
            headers["Authorization"] = this.authHeader;
        }

        // Cookie jar: attach the accumulated Cookie header when enabled.
        if (this.cookiesEnabled) {
            const cookieHeader = this.cookieHeader();
            if (cookieHeader) {
                headers["Cookie"] = cookieHeader;
            }
        }

        let data: Buffer | undefined;
        if (body !== undefined && body !== null) {
            if (contentType === "application/json" && typeof body === "object" && !Buffer.isBuffer(body)) {
                data = Buffer.from(JSON.stringify(body), "utf-8");
                headers["Content-Type"] = "application/json";
            } else if (typeof body === "string") {
                data = Buffer.from(body, "utf-8");
                headers["Content-Type"] = contentType;
            } else if (Buffer.isBuffer(body)) {
                data = body;
                headers["Content-Type"] = contentType;
            } else {
                // Fallback: stringify anything else as JSON
                data = Buffer.from(JSON.stringify(body), "utf-8");
                headers["Content-Type"] = "application/json";
            }
            if (data) {
                headers["Content-Length"] = String(data.length);
            }
        }

        if (extraHeaders) {
            Object.assign(headers, extraHeaders);
        }

        return { headers, data };
    }

    /**
     * Execute the request with opt-in retry/backoff.
     *
     * With `maxRetries` > 0, a transport failure (`http_code` null) or a
     * retryable status (429/5xx) is retried up to `maxRetries` times with
     * exponential backoff; any other outcome (2xx, 3xx, other 4xx) returns
     * at once. A retried non-idempotent request may be re-sent — retries
     * are opt-in for that reason.
     */
    private async execute(
        method: string,
        url: string,
        body?: unknown,
        contentType: string = "application/json",
        extraHeaders?: Record<string, string>,
    ): Promise<ApiResult> {
        const attempts = this.maxRetries + 1;
        let result: ApiResult = { http_code: null, body: null, headers: {}, error: null };
        for (let attempt = 0; attempt < attempts; attempt++) {
            result = await this.attempt(method, url, body, contentType, extraHeaders);
            const code = result.http_code;
            const retryable = code === null || RETRY_STATUSES.has(code);
            if (!retryable || attempt === attempts - 1) {
                return result;
            }
            const delayMs = this.retryBackoff * Math.pow(2, attempt) * 1000;
            await new Promise<void>((r) => setTimeout(r, delayMs));
        }
        return result;
    }

    /** A single HTTP attempt — returns the standardized result. */
    private async attempt(
        method: string,
        url: string,
        body?: unknown,
        contentType: string = "application/json",
        extraHeaders?: Record<string, string>,
    ): Promise<ApiResult> {
        const { headers, data } = this.buildRequest(method, contentType, body, extraHeaders);

        // A user-injected transport fully replaces the network call.
        if (this.transportFn) {
            return this.callTransport(method, url, headers, data);
        }

        const net = await this.performRequest(method, url, headers, data, MAX_REDIRECTS);
        if (net.kind === "error") {
            return { http_code: null, body: null, headers: {}, error: net.error };
        }
        return this.readResponse(net.res);
    }

    /**
     * Invoke a user-injected transport and normalize its result. The transport
     * is called with `(method, url, headers, body, timeout)` and its returned
     * `Set-Cookie` headers (if any) feed the cookie jar.
     */
    private async callTransport(
        method: string,
        url: string,
        headers: Record<string, string>,
        data: Buffer | undefined,
    ): Promise<ApiResult> {
        let normalized: ApiResult;
        try {
            const result = await this.transportFn!(method, url, headers, data ?? null, this.timeout);
            normalized = {
                http_code: result?.http_code ?? null,
                body: result?.body ?? null,
                headers: result?.headers ?? {},
                error: result?.error ?? null,
            };
        } catch (err) {
            return { http_code: null, body: null, headers: {}, error: err instanceof Error ? err.message : String(err) };
        }
        this.storeCookiesFromRecord(normalized.headers);
        return normalized;
    }

    /**
     * Perform the network request, following up to `redirectsLeft` redirects.
     *
     * node:http/https `request` does NOT auto-follow redirects. On a 3xx with a
     * Location, this drains the intermediate response and re-issues to the new
     * URL: 301/302/303 on a non-GET/HEAD become GET (body dropped, urllib
     * behaviour); 307/308 preserve method + body. When the redirect target is a
     * DIFFERENT origin, the Authorization and Cookie headers are stripped so a
     * bearer token / session cookie never leaks to a host you didn't
     * authenticate to.
     */
    private performRequest(
        method: string,
        url: string,
        headers: Record<string, string>,
        data: Buffer | undefined,
        redirectsLeft: number,
    ): Promise<NetworkResult> {
        return new Promise<NetworkResult>((resolve) => {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch (err) {
                resolve({ kind: "error", error: err instanceof Error ? err.message : String(err) });
                return;
            }

            const isHttps = parsed.protocol === "https:";
            const protocolModule = isHttps ? https : http;

            const options: http.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method,
                headers,
                timeout: this.timeout * 1000,
            };

            if (isHttps && this.ignoreSsl) {
                (options as https.RequestOptions).rejectUnauthorized = false;
            }

            const req = protocolModule.request(options, (res) => {
                const status = res.statusCode ?? 0;
                const location = res.headers.location;

                if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
                    res.resume(); // drain the redirect body, free the socket

                    let nextUrl: string;
                    try {
                        nextUrl = new URL(location, url).toString();
                    } catch {
                        resolve({ kind: "response", res });
                        return;
                    }

                    const crossOrigin = !sameOrigin(url, nextUrl);
                    let nextMethod = method;
                    let nextData = data;
                    const nextHeaders: Record<string, string> = { ...headers };

                    // 301/302/303 on a body-bearing method → GET, drop the body
                    // (matches urllib's HTTPRedirectHandler); 307/308 preserve.
                    if (
                        (status === 301 || status === 302 || status === 303) &&
                        method !== "GET" &&
                        method !== "HEAD"
                    ) {
                        nextMethod = "GET";
                        nextData = undefined;
                        deleteHeaderCaseInsensitive(nextHeaders, "content-type");
                        deleteHeaderCaseInsensitive(nextHeaders, "content-length");
                    }

                    if (crossOrigin) {
                        for (const name of STRIP_ON_CROSS_ORIGIN) {
                            deleteHeaderCaseInsensitive(nextHeaders, name);
                        }
                    }

                    this.performRequest(nextMethod, nextUrl, nextHeaders, nextData, redirectsLeft - 1).then(resolve);
                    return;
                }

                resolve({ kind: "response", res });
            });

            req.on("timeout", () => {
                req.destroy();
                resolve({ kind: "error", error: `Request timed out after ${this.timeout}s` });
            });

            req.on("error", (err) => {
                resolve({ kind: "error", error: err.message });
            });

            if (data) {
                req.write(data);
            }
            req.end();
        });
    }

    /** Buffer a response body, parse JSON if possible, and store cookies. */
    private readResponse(res: http.IncomingMessage): Promise<ApiResult> {
        return new Promise<ApiResult>((resolve) => {
            const chunks: Buffer[] = [];

            res.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            });

            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf-8");
                const respHeaders = flattenHeaders(res.headers);
                this.storeCookies(res.headers["set-cookie"]);

                let parsed: unknown;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    parsed = raw;
                }

                resolve({
                    http_code: res.statusCode ?? null,
                    body: parsed,
                    headers: respHeaders,
                    error: null,
                });
            });

            res.on("error", (err) => {
                resolve({ http_code: null, body: null, headers: {}, error: err.message });
            });
        });
    }

    // ── cookie jar (opt-in, in-memory, per-client) ─────────────────────────

    /** The accumulated `Cookie` request header, or null when the jar is empty. */
    private cookieHeader(): string | null {
        const names = Object.keys(this.cookies);
        if (names.length === 0) {
            return null;
        }
        return names.map((name) => `${name}=${this.cookies[name]}`).join("; ");
    }

    /**
     * Parse `Set-Cookie` response headers into the jar (when enabled). Only the
     * leading `name=value` pair of each is kept (Path/HttpOnly/Expires ignored);
     * a later value for the same name overwrites an earlier one.
     */
    private storeCookies(setCookie: string | string[] | undefined): void {
        if (!this.cookiesEnabled || !setCookie) {
            return;
        }
        const values = Array.isArray(setCookie) ? setCookie : [setCookie];
        for (const raw of values) {
            const firstPair = raw.split(";", 1)[0].trim();
            const eq = firstPair.indexOf("=");
            if (eq > 0) {
                const name = firstPair.slice(0, eq).trim();
                const value = firstPair.slice(eq + 1).trim();
                if (name) {
                    this.cookies[name] = value;
                }
            }
        }
    }

    /** Store cookies from a plain header record (the transport seam path). */
    private storeCookiesFromRecord(headers: Record<string, string>): void {
        if (!this.cookiesEnabled) {
            return;
        }
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === "set-cookie" && value) {
                this.storeCookies(value);
            }
        }
    }
}

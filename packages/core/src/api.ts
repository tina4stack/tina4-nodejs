/**
 * Tina4 API Client — HTTP client using Node.js built-in modules only.
 *
 *     import { Api } from "@tina4/core";
 *
 *     const api = new Api("https://api.example.com");
 *     const result = await api.get("/users");
 *     const result = await api.post("/users", { name: "Alice" });
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface ApiResult {
    http_code: number | null;
    body: unknown;
    headers: Record<string, string>;
    error: string | null;
}

/**
 * HTTP statuses that warrant an automatic retry when `maxRetries` > 0:
 * rate-limit (429) plus the transient server-side 5xx family. 4xx client
 * errors (401, 404, …) are NOT retried — a repeat won't succeed.
 */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

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
}

export class Api {
    private baseUrl: string;
    private headers: Record<string, string>;
    private timeout: number;
    private authHeader: string;
    private ignoreSsl: boolean;
    private maxRetries: number;
    private retryBackoff: number;

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

        // Options-bag form — second arg is an object literal
        if (typeof authHeaderOrOptions === "object" && authHeaderOrOptions !== null) {
            const opts = authHeaderOrOptions;
            this.authHeader = opts.authHeader ?? "";
            this.timeout = opts.timeout ?? timeout;
            this.ignoreSsl = (opts.ignoreSsl ?? false) || (opts.verifySsl === false);
            this.maxRetries = Math.max(0, opts.maxRetries ?? 0);
            this.retryBackoff = opts.retryBackoff ?? 0.5;

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

    // ── Internal helpers ──────────────────────────────────────────────

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
    ): Promise<ApiResult> {
        const attempts = this.maxRetries + 1;
        let result: ApiResult = { http_code: null, body: null, headers: {}, error: null };
        for (let attempt = 0; attempt < attempts; attempt++) {
            result = await this.attempt(method, url, body, contentType);
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
    private attempt(
        method: string,
        url: string,
        body?: unknown,
        contentType: string = "application/json",
    ): Promise<ApiResult> {
        return new Promise<ApiResult>((resolve) => {
            try {
                const parsed = new URL(url);
                const isHttps = parsed.protocol === "https:";
                const transport = isHttps ? https : http;

                // Build headers
                const reqHeaders: Record<string, string> = { ...this.headers };
                if (this.authHeader) {
                    reqHeaders["Authorization"] = this.authHeader;
                }

                // Serialize body
                let data: Buffer | undefined;
                if (body !== undefined && body !== null) {
                    if (contentType === "application/json" && typeof body === "object") {
                        data = Buffer.from(JSON.stringify(body), "utf-8");
                        reqHeaders["Content-Type"] = "application/json";
                    } else if (typeof body === "string") {
                        data = Buffer.from(body, "utf-8");
                        reqHeaders["Content-Type"] = contentType;
                    } else if (Buffer.isBuffer(body)) {
                        data = body;
                        reqHeaders["Content-Type"] = contentType;
                    } else {
                        // Fallback: stringify anything else as JSON
                        data = Buffer.from(JSON.stringify(body), "utf-8");
                        reqHeaders["Content-Type"] = "application/json";
                    }
                    if (data) {
                        reqHeaders["Content-Length"] = String(data.length);
                    }
                }

                const options: http.RequestOptions = {
                    hostname: parsed.hostname,
                    port: parsed.port || (isHttps ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method,
                    headers: reqHeaders,
                    timeout: this.timeout * 1000,
                };

                if (isHttps && this.ignoreSsl) {
                    (options as https.RequestOptions).rejectUnauthorized = false;
                }

                const req = transport.request(options, (res) => {
                    const chunks: Buffer[] = [];

                    res.on("data", (chunk: Buffer) => {
                        chunks.push(chunk);
                    });

                    res.on("end", () => {
                        const raw = Buffer.concat(chunks).toString("utf-8");
                        const respHeaders: Record<string, string> = {};
                        for (const [key, val] of Object.entries(res.headers)) {
                            if (val !== undefined) {
                                respHeaders[key] = Array.isArray(val) ? val.join(", ") : val;
                            }
                        }

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
                });

                req.on("timeout", () => {
                    req.destroy();
                    resolve({
                        http_code: null,
                        body: null,
                        headers: {},
                        error: `Request timed out after ${this.timeout}s`,
                    });
                });

                req.on("error", (err) => {
                    resolve({
                        http_code: null,
                        body: null,
                        headers: {},
                        error: err.message,
                    });
                });

                if (data) {
                    req.write(data);
                }
                req.end();
            } catch (err) {
                resolve({
                    http_code: null,
                    body: null,
                    headers: {},
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        });
    }
}

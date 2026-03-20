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

export class Api {
    private baseUrl: string;
    private headers: Record<string, string>;
    private timeout: number;
    private authHeader: string;
    private ignoreSsl: boolean;

    constructor(baseUrl: string = "", authHeader: string = "", timeout: number = 30) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.authHeader = authHeader;
        this.timeout = timeout;
        this.headers = {};
        this.ignoreSsl = false;
    }

    /**
     * Add custom headers to all subsequent requests.
     */
    addCustomHeaders(headers: Record<string, string>): void {
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
        return this.sendRequest(path, "POST", body, contentType);
    }

    /**
     * HTTP PUT request.
     */
    async put(path: string, body?: unknown, contentType: string = "application/json"): Promise<ApiResult> {
        return this.sendRequest(path, "PUT", body, contentType);
    }

    /**
     * HTTP PATCH request.
     */
    async patch(path: string, body?: unknown, contentType: string = "application/json"): Promise<ApiResult> {
        return this.sendRequest(path, "PATCH", body, contentType);
    }

    /**
     * HTTP DELETE request.
     */
    async delete(path: string, body?: unknown): Promise<ApiResult> {
        return this.sendRequest(path, "DELETE", body);
    }

    /**
     * Generic request method — public entry point for any HTTP method.
     */
    async sendRequest(
        path: string,
        method: string,
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

    private execute(
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

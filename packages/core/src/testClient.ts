/**
 * Tina4 Test Client — Test routes without starting a server.
 *
 * Usage:
 *
 *   import { TestClient } from "@tina4/core";
 *
 *   const client = new TestClient(router);
 *
 *   const response = await client.get("/api/users");
 *   assert(response.status === 200);
 *   assert(response.json().users);
 *
 *   const response = await client.post("/api/users", { json: { name: "Alice" } });
 *   assert(response.status === 201);
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createRequest } from "./request.js";
import { createResponse } from "./response.js";
import { defaultRouter, type Router } from "./router.js";

export class TestResponse {
  public readonly status: number;
  public readonly body: string;
  public readonly headers: Record<string, string>;
  public readonly contentType: string;

  constructor(statusCode: number, headers: Record<string, string>, body: string) {
    this.status = statusCode;
    this.body = body;
    this.headers = headers;
    this.contentType = headers["content-type"] ?? "";
  }

  /** Parse body as JSON. */
  json(): unknown {
    if (!this.body) return null;
    try {
      return JSON.parse(this.body);
    } catch {
      return null;
    }
  }

  /** Return body as a string. */
  text(): string {
    return this.body;
  }

  toString(): string {
    return `<TestResponse status=${this.status} contentType="${this.contentType}">`;
  }
}

export interface RequestOptions {
  json?: Record<string, unknown> | unknown[];
  body?: string;
  headers?: Record<string, string>;
}

export class TestClient {
  private router: Router;

  constructor(router?: Router) {
    this.router = router ?? defaultRouter;
  }

  /** Send a GET request. */
  async get(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this._request("GET", path, options);
  }

  /** Send a POST request. */
  async post(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this._request("POST", path, options);
  }

  /** Send a PUT request. */
  async put(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this._request("PUT", path, options);
  }

  /** Send a PATCH request. */
  async patch(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this._request("PATCH", path, options);
  }

  /** Send a DELETE request. */
  async delete(path: string, options?: RequestOptions): Promise<TestResponse> {
    return this._request("DELETE", path, options);
  }

  /** Build a mock request, match the route, execute the handler. */
  private async _request(method: string, path: string, options?: RequestOptions): Promise<TestResponse> {
    const { json, body, headers } = options ?? {};

    // Build raw body
    let rawBody = "";
    let contentType = "";
    if (json !== undefined) {
      rawBody = JSON.stringify(json);
      contentType = "application/json";
    } else if (body !== undefined) {
      rawBody = body;
    }

    // Build headers
    const reqHeaders: Record<string, string> = {};
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        reqHeaders[k.toLowerCase()] = v;
      }
    }
    if (contentType && !reqHeaders["content-type"]) {
      reqHeaders["content-type"] = contentType;
    }
    if (rawBody && !reqHeaders["content-length"]) {
      reqHeaders["content-length"] = String(Buffer.byteLength(rawBody));
    }

    // Create a mock IncomingMessage
    const socket = new Socket();
    const rawReq = new IncomingMessage(socket);
    rawReq.method = method.toUpperCase();
    rawReq.url = path;
    rawReq.headers = { ...reqHeaders, host: "localhost:7145" };

    // Push body data into the readable stream
    if (rawBody) {
      rawReq.push(Buffer.from(rawBody));
    }
    rawReq.push(null); // signal end of stream

    // Create a mock ServerResponse that captures output
    const rawRes = new ServerResponse(rawReq);
    const chunks: Buffer[] = [];
    const originalWrite = rawRes.write.bind(rawRes);
    const originalEnd = rawRes.end.bind(rawRes);

    rawRes.write = function (chunk: any, ...args: any[]): boolean {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    } as typeof rawRes.write;

    rawRes.end = function (chunk?: any, ...args: any[]): ServerResponse {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return rawRes;
    } as typeof rawRes.end;

    // Create Tina4 request/response wrappers
    const req = createRequest(rawReq);
    const res = createResponse(rawRes);

    // Parse body (populates req.body)
    await req.parseBody();

    // Split path for route matching
    const cleanPath = path.includes("?") ? path.split("?")[0] : path;

    // Match route
    const match = this.router.match(method.toUpperCase(), cleanPath);
    if (!match) {
      return new TestResponse(404, { "content-type": "application/json" }, '{"error":"Not found"}');
    }

    // Inject route params
    req.params = match.params;

    // Execute handler
    await match.handler(req, res);

    // Collect response
    const responseBody = Buffer.concat(chunks).toString();
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawRes.getHeaders())) {
      if (value !== undefined) {
        responseHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    }

    // Clean up the socket
    socket.destroy();

    return new TestResponse(rawRes.statusCode, responseHeaders, responseBody);
  }
}

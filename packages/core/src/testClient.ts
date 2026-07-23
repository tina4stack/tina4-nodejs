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
import { defaultRouter, Router, runRouteMiddlewares } from "./router.js";
import { MiddlewareRunner } from "./middleware.js";
import { enforceRouteAuth } from "./authGate.js";

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
    const httpMethod = method.toUpperCase();
    const match = this.router.match(httpMethod, cleanPath);
    if (!match) {
      // D6: dispatch through the REAL front-controller behaviour on a miss —
      // never fabricate a body. This mirrors the live server tail
      // (server.ts dispatch): RFC 9110 conformance first (a path registered
      // under another method answers OPTIONS with 204 + Allow and any other
      // method with 405 + Allow), then the framework's real 404. The old
      // TestClient short-circuited to a hand-invented {"error":"Not found"}
      // that the live server never sends, so a green test proved nothing about
      // production (the same silent-success class as Python's pre-fix client).
      const allowed = this.router.methodsAllowedForPath(cleanPath);
      if (allowed.length > 0) {
        const allowHeader = allowed.join(", ");
        if (httpMethod === "OPTIONS") {
          return new TestResponse(204, { allow: allowHeader, "content-length": "0" }, "");
        }
        const body405 = JSON.stringify({
          error: "Method Not Allowed",
          path: cleanPath,
          method: httpMethod,
          allow: allowed,
          statusCode: 405,
        });
        return new TestResponse(405, { allow: allowHeader, "content-type": "application/json" }, body405);
      }
      // The framework's real 404. The live server renders an HTML error page
      // when a project templatesDir/frondEngine exists and otherwise emits this
      // exact JSON; a server-less TestClient has no project dir, so it produces
      // the JSON fallback the live front controller itself falls back to.
      // tina4: HTML-error-page + filesystem static serving are the only live
      // front-controller steps a server-less client can't reproduce.
      const body404 = JSON.stringify({
        error: "Not Found",
        statusCode: 404,
        message: `No route found for ${httpMethod} ${cleanPath}`,
      });
      return new TestResponse(404, { "content-type": "application/json" }, body404);
    }

    // Inject route params
    req.params = match.params;

    // Global class-based middleware (Router.use / MiddlewareRunner.use), run in
    // the SAME order the live dispatcher uses (server.ts): beforeX hooks before
    // the handler, afterX hooks after — even on a before-short-circuit. Empty
    // when a test registers none, so this is additive/non-breaking.
    const globalMiddleware = [
      ...new Set([...Router.getClassMiddlewares(), ...MiddlewareRunner.getGlobal()]),
    ];
    if (globalMiddleware.length > 0) {
      const [, , proceed] = await MiddlewareRunner.runBefore(globalMiddleware, req, res);
      if (!proceed || res.raw.writableEnded) {
        await MiddlewareRunner.runAfter(globalMiddleware, req, res);
        if (!res.raw.writableEnded) res.raw.end();
        return this._collect(rawRes, chunks, socket);
      }
    }

    // Per-route middleware, same as the live dispatcher.
    if (match.middlewares && match.middlewares.length > 0) {
      const proceed = await runRouteMiddlewares(match.middlewares, req, res);
      if (!proceed || res.raw.writableEnded) {
        return this._collect(rawRes, chunks, socket);
      }
    }

    // Route through the REAL auth gate (parity with the live server). A write to
    // an auth-required route (secure-by-default POST/PUT/PATCH/DELETE, or any
    // .secure() route) with no valid token / formToken / session token 401s here
    // exactly as it would in production. The TestClient used to skip this and run
    // the handler directly, so a green test could hide a live 401 — the
    // verification layer lied. A public route (GET, or a write marked .noAuth())
    // passes straight through. When rejected, enforceRouteAuth has written a 401
    // to res.raw, so the collection below reports it just like a handler response.
    // (#PY2 parity)
    const isDevAdmin = cleanPath.startsWith("/__dev");
    const rejected = enforceRouteAuth(req, res, match, isDevAdmin);

    // Execute handler (only if auth passed)
    if (!rejected) {
      await match.handler(req, res);
      // Global afterX hooks (logging / post-processing), mirroring the live tail.
      if (globalMiddleware.length > 0) {
        await MiddlewareRunner.runAfter(globalMiddleware, req, res);
      }
    }

    return this._collect(rawRes, chunks, socket);
  }

  /** Gather the captured status/headers/body into a TestResponse and free the socket. */
  private _collect(rawRes: ServerResponse, chunks: Buffer[], socket: Socket): TestResponse {
    const responseBody = Buffer.concat(chunks).toString();
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawRes.getHeaders())) {
      if (value !== undefined) {
        responseHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    }
    socket.destroy();
    return new TestResponse(rawRes.statusCode, responseHeaders, responseBody);
  }
}

/**
 * Tina4 Test Client — Test routes without starting a server.
 *
 * Builds a mock IncomingMessage/ServerResponse and dispatches them through
 * the REAL Tina4 front controller (server.ts's `runDispatch`, over either the
 * live server's DispatchContext when one is running in this process, or a
 * standalone one bound to the given/default router when none is) — the same
 * function every live socket connection runs. Everything a live request
 * gets, an in-process test request gets: the session stage, global + per-
 * route middleware in the live order (gate BEFORE route middleware, per
 * ADR-0012), the secure-by-default auth gate, static files, template routes,
 * the landing page, RFC 9110 OPTIONS/405 `Allow` responses, and the 404/500
 * renderers.
 *
 * This used to re-implement the dispatch order itself — matching the route
 * directly and running global/route middleware and the auth gate by hand —
 * which meant the session stage never ran (a session-token auth regression
 * was structurally unreachable) and route middleware ran BEFORE the gate
 * (the live server's order is gate first, ADR-0012). Delegating to the real
 * `runDispatch` closes both gaps for free, along with everything else the
 * live pipeline does that this file never had to know about (feature 131,
 * TC-DEC-01 — the same shape as the #PY2 auth fix and the Python/PHP/Ruby
 * TestClients, which have always called their own real front controller:
 * `core.server.app`, `Router::dispatch`, `RackApp#call`).
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
import { defaultRouter, Router } from "./router.js";
import { runDispatch, buildDispatchContext, getLiveDispatchContext, type DispatchContext } from "./server.js";

export class TestResponse {
  public readonly status: number;
  public readonly body: string;
  public readonly headers: Record<string, string>;
  public readonly contentType: string;

  /** Every value sent per header name (lowercased), in emission order. */
  private readonly headerList: Record<string, string[]>;

  constructor(statusCode: number, headerList: Record<string, string[]>, body: string) {
    this.status = statusCode;
    this.body = body;
    this.headerList = headerList;

    // `headers` stays the back-compat single-value view — the LAST value per
    // name, the shape every existing reader already expects (TC-HEADER-
    // COLLAPSE, TC-DEC-02: a duplicate response header, e.g. two Set-Cookie
    // from two response.cookie() calls, used to collapse via a comma-join
    // here, which is unsafe for Set-Cookie specifically since a cookie's own
    // Expires attribute can itself contain a comma — getHeaderList() below is
    // the one place every value is visible; headers[name] keeps collapsing).
    const flat: Record<string, string> = {};
    for (const [name, values] of Object.entries(headerList)) {
      if (values.length > 0) flat[name] = values[values.length - 1]!;
    }
    this.headers = flat;
    this.contentType = this.headers["content-type"] ?? "";
  }

  /**
   * Every value sent for `name` (case-insensitive), in emission order.
   *
   * A header sent once returns a one-item array; a header never sent returns
   * an empty array. This is the one place a duplicate response header (two
   * `Set-Cookie`) is visible — `headers[name]` always collapses to the LAST
   * value, same as before (TC-HEADER-COLLAPSE, TC-DEC-02).
   */
  getHeaderList(name: string): string[] {
    return this.headerList[name.toLowerCase()] ?? [];
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
  /** An explicitly-injected router (test isolation); undefined means "use the live server's router, or defaultRouter". */
  private readonly explicitRouter: Router | undefined;
  private ctxPromise: Promise<DispatchContext> | null = null;

  constructor(router?: Router) {
    this.explicitRouter = router;
  }

  /**
   * Resolve (and memoise) the DispatchContext this client dispatches
   * through.
   *
   * An explicitly-injected router always gets its OWN standalone context
   * (buildDispatchContext) — the test-isolation contract an injected router
   * has always had: a dedicated Router never races with whatever else is
   * registered on defaultRouter or a live server. With no injected router,
   * the LIVE server's context wins when one is running in this process
   * (getLiveDispatchContext — maximum fidelity, mirrors Ruby's
   * `RackApp.current`), else a standalone context bound to defaultRouter.
   */
  private context(): Promise<DispatchContext> {
    if (this.ctxPromise) return this.ctxPromise;

    if (!this.explicitRouter) {
      const live = getLiveDispatchContext();
      if (live) {
        this.ctxPromise = Promise.resolve(live);
        return this.ctxPromise;
      }
    }

    this.ctxPromise = buildDispatchContext(this.explicitRouter ?? defaultRouter);
    return this.ctxPromise;
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

  /** Build a mock request/response pair and dispatch it through the REAL pipeline (runDispatch). */
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
    rawReq.headers = { ...reqHeaders, host: "localhost:7148" };

    // Push body data into the readable stream
    if (rawBody) {
      rawReq.push(Buffer.from(rawBody));
    }
    rawReq.push(null); // signal end of stream

    // Create a mock ServerResponse that captures output.
    //
    // A response over a real socket flips `writableEnded` only when Node's
    // OWN write/end implementation actually runs, and this mock never calls
    // it — write()/end() are fully replaced, since there is no real peer to
    // stream bytes to. Left alone, `rawRes.writableEnded` therefore stays
    // FALSE forever (confirmed empirically), even after this mock's own
    // end() has "completed". The real pipeline checks `res.raw.writableEnded`
    // in several places to decide whether a stage already answered the
    // request — most importantly runMatchedRoute's trailing
    // `if (!res.raw.writableEnded) res.raw.end();` — so a permanently-false
    // reading causes a SECOND, redundant end() call after every matched
    // route. That reaches compressionEtagIntercept's wrapped end(), whose own
    // buffered chunks were never cleared from the first call, and it resends
    // them: the captured body comes out DUPLICATED. `ended` is the real
    // single source of truth here, exposed via an own-property override of
    // `writableEnded` so every pipeline stage's check reads correctly, and
    // write()/end() themselves become no-ops once it is set (idempotent,
    // matching the real "write/end after end is a no-op" contract).
    const rawRes = new ServerResponse(rawReq);
    const chunks: Buffer[] = [];
    let ended = false;
    Object.defineProperty(rawRes, "writableEnded", { get: () => ended, configurable: true });

    rawRes.write = ((chunk?: any, ..._args: any[]): boolean => {
      if (ended) return true;
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    }) as typeof rawRes.write;

    rawRes.end = ((chunk?: any, ..._args: any[]): ServerResponse => {
      if (ended) return rawRes;
      if (chunk != null && typeof chunk !== "function") {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      ended = true;
      return rawRes;
    }) as typeof rawRes.end;

    const ctx = await this.context();
    await runDispatch(ctx, rawReq, rawRes);

    return this._collect(rawRes, chunks, socket);
  }

  /** Gather the captured status/headers/body into a TestResponse and free the socket. */
  private _collect(rawRes: ServerResponse, chunks: Buffer[], socket: Socket): TestResponse {
    const responseBody = Buffer.concat(chunks).toString();
    const headerList: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(rawRes.getHeaders())) {
      if (value === undefined) continue;
      headerList[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : [String(value)];
    }
    socket.destroy();
    return new TestResponse(rawRes.statusCode, headerList, responseBody);
  }
}

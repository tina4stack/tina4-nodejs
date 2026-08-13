/**
 * The dispatch pipeline: the concerns of `dispatch`, named and extracted.
 *
 * `dispatch` was a 485-line closure at cyclomatic complexity 65 against a
 * ceiling of 10, on the path of every request, nested inside `startServer`
 * (which is why that measured 45 as well). These are its concerns as
 * standalone functions, so each can be read and tested without standing up a
 * server.
 *
 * PROLOGUE_STAGES run before anything else, in order. They are extracted FIRST
 * because they close over nothing from `startServer` - only the raw
 * request/response - so no context object is needed for them at all. The later
 * stages need `router`, `staticDir`, `port` and `middleware`, and follow.
 * `sessionAutoStart` is the one prologue stage that runs INSIDE the dispatch
 * try-block, so a TINA4_SESSION_STRICT refusal renders a 500 like every other
 * request error instead of rejecting `dispatch` into an unhandled rejection
 * that takes the worker down (ADR-0021; parity with Python, where the raise
 * leaves the request path and the ASGI server turns it into a 500).
 *
 * Ordering here is BEHAVIOUR, not taste:
 *   * `headStripIntercept` MUST run before anything can write. Node streams its
 *     response, so there is no single exit point to strip at - the interception
 *     IS the mechanism (ADR-0011: the CONTRACT is the outcome, and Ruby and
 *     Python satisfy it by stripping late at their single return instead).
 *   * `sessionAutoStart` wraps `end` after that, so its save-and-set-cookie
 *     runs on the real `end` rather than on the HEAD interceptor's.
 *
 * @see tina4-ruby/lib/tina4/dispatch_pipeline.rb - the same extraction, and
 *      the source of the stage-list-as-data pattern.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Tina4Request } from "./types.js";
import type { Session as SessionInstance } from "./session.js";
import { Log } from "./logger.js";

/**
 * The prologue, in order. Exported as DATA so the pipeline can be asserted and
 * compared across frameworks without reading an implementation.
 */
export const PROLOGUE_STAGES = [
  "resetRequestCaches",
  "headStripIntercept",
  "compressionEtagIntercept",
  "sessionAutoStart",
] as const;

/**
 * After the prologue, before a route is looked up.
 *
 * `wrapResponseEnd` MUST come before the global pass: it installs the end()
 * wrapper that injects the dev toolbar and captures the request, and a
 * middleware that short-circuits still has to be captured.
 */
export const REQUEST_STAGES = [
  "blockAiPortReload",
  "wrapResponseEnd",
  "runGlobalMiddlewarePass",
] as const;

/**
 * A matched route, in order - and the order is BEHAVIOUR (ADR-0012):
 * POST-MATCH globals -> auth gate -> the route's OWN middleware -> handler.
 *
 * The globals run BEFORE the gate so a rate limiter can throttle a brute-force
 * login and an access log records the 401 - neither is possible if they only
 * run on authenticated requests. The route's own middleware stays AFTER the
 * gate, so middleware attached to a secured route never processes an
 * unauthenticated request.
 *
 * `runGlobalMiddlewarePass` appears here AND in REQUEST_STAGES on purpose:
 * one function, two phases. That split IS ADR-0012.
 */
export const ROUTE_STAGES = [
  "runGlobalMiddlewarePass",
  "enforceRouteAuth",
  "runRouteMiddlewares",
  "invokeRouteHandler",
  "renderIfTemplateRoute",
] as const;

/**
 * Nothing matched a route: the fallback chain, walked until one answers.
 *
 * Order is BEHAVIOUR: a template beats the landing page (so a project's own
 * pages/index.twig wins at "/"), 405 beats static (a known path with the wrong
 * method is not a missing file), and the 404 is terminal.
 *
 * This chain runs AFTER matching because routes beat files (ADR-0010): a file
 * from a build step or a careless deploy must never shadow a reviewed route.
 *
 * server.ts holds the same order as an array of the real FUNCTIONS - that is
 * what dispatch actually walks. dispatchPipeline.test.ts asserts the two agree,
 * so this list cannot drift from the runner.
 */
export const FALLBACK_STAGES = [
  "serveTemplateFallback",
  "serveLandingPage",
  "serveMethodNotAllowed",
  "serveStaticAsset",
  "serveNotFound",
] as const;

/** The catch arm. Everything above throws into this one. */
export const ERROR_STAGES = ["renderDispatchError"] as const;

/**
 * Memoised import of the ORM's cache reset. Resolves once on first use;
 * subsequent requests reuse the resolved module.
 */
let _resetRequestCaches: Promise<(() => void) | null> | undefined;

/**
 * Request-scoped DB query cache boundary.
 *
 * Clears the request-scoped cache on every live connection at the START of each
 * request so it never serves rows across requests (persistent-mode connections
 * are left alone). The ORM is loaded lazily and may be absent, so this is
 * best-effort: a failure here must never break a request. Mirrors Python's
 * dispatcher calling `Database.reset_request_caches()`.
 */
export async function resetRequestCaches(): Promise<void> {
  if (_resetRequestCaches === undefined) {
    _resetRequestCaches = import("../../orm/src/index.js")
      .then((orm) => orm.resetRequestCaches as () => void)
      .catch(() => null);
  }
  try {
    const reset = await _resetRequestCaches;
    if (reset) reset();
  } catch {
    /* ORM not installed / cache unavailable — non-fatal */
  }
}

/**
 * RFC 9110 s9.3.2: the server MUST NOT send content in a HEAD response.
 *
 * Intercepts `write` / `end` so every code path - an explicit `Router.head()`
 * handler, the GET auto-fallback, 405 and 404 responses - drops its body.
 * Content-Length is preserved when present, so cache validators, link checkers
 * and monitoring probes still see the size the equivalent GET would have sent.
 *
 * No-op for any method other than HEAD.
 *
 * @param rawReq Node's incoming message, read for the method
 * @param rawRes Node's server response, whose write/end are replaced in place
 */
export function headStripIntercept(rawReq: IncomingMessage, rawRes: ServerResponse): void {
  if ((rawReq.method ?? "GET").toUpperCase() !== "HEAD") return;

  const origEnd = rawRes.end.bind(rawRes);
  const origWrite = rawRes.write.bind(rawRes);
  let accumulated = 0;

  rawRes.write = ((chunk?: any, _enc?: any, cb?: any): boolean => {
    if (chunk != null) {
      accumulated += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    }
    if (typeof cb === "function") cb();
    return true;
  }) as typeof rawRes.write;

  rawRes.end = ((chunk?: any, _enc?: any, cb?: any): any => {
    if (chunk != null && typeof chunk !== "function") {
      accumulated += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    }
    if (accumulated > 0 && !rawRes.headersSent && !rawRes.hasHeader("Content-Length")) {
      rawRes.setHeader("Content-Length", String(accumulated));
    }
    const realCb = typeof chunk === "function" ? chunk : cb;
    void origWrite; // referenced to keep tsc happy
    return typeof realCb === "function" ? origEnd(realCb) : origEnd();
  }) as typeof rawRes.end;
}

/** Content-type prefixes that benefit from gzip. Mirrors the Python master's `_is_compressible`. */
const COMPRESSIBLE_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "image/svg",
];

/** Whether a content type benefits from gzip compression (feature 40, CE-DEC-01). */
function isCompressibleContentType(contentType: string): boolean {
  return COMPRESSIBLE_PREFIXES.some((prefix) => contentType.includes(prefix));
}

/**
 * Match an If-None-Match header value against `etag` (RFC 7232 S3.2 weak
 * comparison): an optional W/ prefix is ignored on both sides, the header may
 * carry a comma-separated candidate list, and `*` matches any current
 * representation. Same algorithm as static.ts's own matcher (kept local here
 * rather than imported, since static.ts writes to the raw response directly
 * and never reaches this interceptor).
 */
function etagMatchesInm(ifNoneMatch: string, etag: string): boolean {
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = strip(etag);
  return ifNoneMatch.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || strip(trimmed) === target;
  });
}

/**
 * Gzip-compress + attach an ETag, and answer a matching conditional GET with
 * a 304 that PRESERVES whichever validators the 200 would have carried
 * (feature 40, CE-DEC-01/02). Mirrors the Python master's `build_headers()` +
 * `app()` dispatch — the ONE header-builder step every DYNAMIC response
 * funnels through.
 *
 * Node has no single "build the response, then send it" object the way
 * Python/PHP/Ruby do — every response.ts method (json/html/text/xml/send/
 * file/render) calls `res.end()` directly. So this intercepts `write`/`end`
 * on the raw `ServerResponse` and buffers the body until `end()` is finally
 * called, which is the only point a COMPLETE body — and therefore a
 * Content-Length, a gzip candidate, and an ETag — exists to compute.
 *
 * BYPASS: a response that has ALREADY sent its headers by the time
 * write()/end() is first called here (checked via `rawRes.headersSent`) is a
 * streaming response — `response.ts`'s `stream()` calls `res.raw.writeHead()`
 * up front, before any chunk — and is passed straight through unbuffered,
 * exactly like Python's "streaming responses bypass ETag/compression".
 *
 * Installed in the PROLOGUE, right after `headStripIntercept`: since the LAST
 * installed wrapper runs FIRST when `end()` is finally called, and
 * `wrapResponseEnd` (dev-toolbar/feedback injection) installs LATER (in the
 * REQUEST stage), the real execution order at send time is
 * injection -> this -> `headStripIntercept` -> the true Node `res.end()` — so
 * a HEAD response's preserved Content-Length reflects the (possibly
 * compressed) body the equivalent GET would have sent, and the injected
 * bytes are included in the compressed body + ETag hash, matching Python's
 * ordering exactly.
 *
 * A static-file response (`static.ts`) still funnels through this same
 * intercepted `write`/`end` — it pins its own weak size+mtime ETag and (when
 * eligible) compresses itself BEFORE calling `res.raw.end()`, so by the time
 * this runs, its status is already 200-with-ETag-set (this never overwrites
 * it) or already 304 (the `statusCode === 200` guard below leaves it alone).
 *
 * @param rawReq Node's incoming message, read for Accept-Encoding / If-None-Match / If-Modified-Since
 * @param rawRes Node's server response, whose write/end are replaced in place
 */
export function compressionEtagIntercept(rawReq: IncomingMessage, rawRes: ServerResponse): void {
  const origEnd = rawRes.end.bind(rawRes);
  const origWrite = rawRes.write.bind(rawRes);
  const chunks: Buffer[] = [];
  let bypass = false;

  const toBuffer = (chunk: unknown, encoding?: unknown): Buffer | null => {
    if (chunk == null || typeof chunk === "function") return null;
    if (Buffer.isBuffer(chunk)) return chunk;
    return Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf-8");
  };

  rawRes.write = ((chunk?: any, encodingOrCb?: any, cb?: any): boolean => {
    if (bypass || rawRes.headersSent) {
      bypass = true;
      return origWrite(chunk, encodingOrCb, cb);
    }
    const buf = toBuffer(chunk, typeof encodingOrCb === "string" ? encodingOrCb : undefined);
    if (buf) chunks.push(buf);
    const realCb = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    if (typeof realCb === "function") realCb();
    return true;
  }) as typeof rawRes.write;

  rawRes.end = ((chunk?: any, encodingOrCb?: any, cb?: any): any => {
    if (bypass || rawRes.headersSent) {
      return origEnd(chunk, encodingOrCb, cb);
    }

    const buf = toBuffer(chunk, typeof encodingOrCb === "string" ? encodingOrCb : undefined);
    if (buf) chunks.push(buf);
    let body = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
    const realCb = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    const statusCode = rawRes.statusCode || 200;

    // Compression: body > 1024 bytes AND Accept-Encoding offers gzip AND the
    // content type is compressible. Applies to ANY response (matches every
    // route, not status-gated), same as the Python master.
    //
    // REAL BUG (found 2026-08-13, tina4cssServed.test.ts): a static-file
    // response (static.ts) already gzips itself and sets Content-Encoding
    // before calling res.raw.end() — but that end() is THIS intercepted one,
    // so without the guard below it gzipped an already-gzipped body a second
    // time. The client's one layer of automatic decompression then handed
    // back a still-gzipped blob instead of the real bytes. Skip compression
    // here whenever an earlier stage already set Content-Encoding.
    const acceptEncoding = String(rawReq.headers["accept-encoding"] ?? "");
    const contentTypeHeader = rawRes.getHeader("content-type");
    const contentType = typeof contentTypeHeader === "string" ? contentTypeHeader : "";
    const alreadyEncoded = !!rawRes.getHeader("content-encoding");
    if (!alreadyEncoded && body.length > 1024 && acceptEncoding.includes("gzip") && isCompressibleContentType(contentType)) {
      body = gzipSync(body, { level: 6 });
      rawRes.setHeader("Content-Encoding", "gzip");
      rawRes.setHeader("Vary", "Accept-Encoding");
    }

    if (statusCode === 200 && body.length > 0) {
      // ETag: a strong md5 hash (first 16 hex chars) over the FINAL
      // (post-compression) body, UNLESS a validator is already set — a
      // static-file response (static.ts) pins its own weak size+mtime ETag
      // before this ever runs (CE-DEC-02), so this never overwrites it with
      // a content hash.
      let etag = rawRes.getHeader("etag");
      if (!etag) {
        etag = `"${createHash("md5").update(body).digest("hex").slice(0, 16)}"`;
        rawRes.setHeader("ETag", etag);
      }

      // Conditional GET -> 304, preserving whichever validators are set.
      // If-None-Match takes precedence over If-Modified-Since (RFC 9110 S13.1.3).
      const ifNoneMatch = String(rawReq.headers["if-none-match"] ?? "");
      const lastModifiedHeader = rawRes.getHeader("last-modified");
      const lastModified = typeof lastModifiedHeader === "string" ? lastModifiedHeader : "";
      let notModified = false;
      if (ifNoneMatch) {
        notModified = etagMatchesInm(ifNoneMatch, String(etag));
      } else if (lastModified) {
        const ifModifiedSince = String(rawReq.headers["if-modified-since"] ?? "");
        if (ifModifiedSince) {
          const modified = Date.parse(lastModified);
          const since = Date.parse(ifModifiedSince);
          notModified = !Number.isNaN(modified) && !Number.isNaN(since) && modified <= since;
        }
      }

      if (notModified) {
        rawRes.statusCode = 304;
        rawRes.removeHeader("Content-Type");
        rawRes.removeHeader("Content-Encoding");
        rawRes.removeHeader("Vary");
        rawRes.removeHeader("Content-Length");
        return typeof realCb === "function" ? origEnd(realCb) : origEnd();
      }
    }

    if (!rawRes.headersSent && statusCode !== 304) {
      rawRes.setHeader("Content-Length", body.length);
    }
    return typeof realCb === "function" ? origEnd(body, realCb) : origEnd(body);
  }) as typeof rawRes.end;
}

/**
 * `Type: message` for a caught value, so an operator reading the log sees the
 * REAL driver failure rather than an opaque wrapper. Mirrors the Python fix's
 * `f"({type(e).__name__}): {e}"`.
 */
function errorLabel(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Auto-start the session: read the cookie, create the session, then save it and
 * set the cookie when the response ends.
 *
 * The incoming cookie is read by the SAME configured name the write side emits
 * (`TINA4_SESSION_NAME`, default `tina4_session`) via the shared
 * `sessionCookieName()` resolver - otherwise a renamed cookie would be written
 * but never read back and the session would silently never resume. A whole
 * cookie pair is matched by its exact `name=` prefix (split on ";", trim,
 * startsWith) so `tina4_session` never matches `tina4_session_foo=` nor a value
 * mid-header. Parity with Python `core/server._init_session`.
 *
 * @param rawReq Node's incoming message, read for cookies and the proxy scheme
 * @param rawRes Node's server response, whose `end` is wrapped
 * @param req    The Tina4 request the session is attached to
 */
export async function sessionAutoStart(
  rawReq: IncomingMessage,
  rawRes: ServerResponse,
  req: Tina4Request,
): Promise<void> {
  const { Session, buildSessionCookie, sessionCookieName, sessionStrictMode } =
    await import("./session.js");
  const cookieHeader = rawReq.headers.cookie ?? "";

  const cookiePrefix = sessionCookieName() + "=";
  let existingSid: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(cookiePrefix)) {
      existingSid = trimmed.slice(cookiePrefix.length);
      break;
    }
  }

  // LOG LOUD, THEN DEGRADE (ADR-0021). Construction and start() sat outside
  // every guard, so a backend that cannot be reached 500'd EVERY request
  // instead of degrading: the database handler opens its connection and runs a
  // PRAGMA in its constructor, and an unknown TINA4_SESSION_BACKEND throws by
  // design. Session's own safeRead/safeWrite policy cannot cover either - both
  // fail BEFORE there is an object to ask, which is also why strict mode has to
  // be read from the module-level `sessionStrictMode()` here.
  //
  // An EMPTY session never reaches this catch. `start()` returns a fresh empty
  // session for a first-time visitor and for a well-formed id the store has
  // never heard of; both are ORDINARY, and logging them would fill the log with
  // noise on every new visitor and bury the real outage - the same blindness
  // this fix exists to cure.
  let sess: SessionInstance;
  try {
    sess = new Session();
    sess.start(existingSid);
  } catch (err) {
    Log.error(`Session unavailable for this request (${errorLabel(err)})`);
    if (sessionStrictMode()) throw err;
    (req as any).session = null;
    return;
  }
  (req as any).session = sess;

  const origEnd = rawRes.end.bind(rawRes);
  // Finalise EXACTLY once. Under strict mode the save below re-throws, and the
  // dispatch catch renders its 500 by calling end() again - without this the
  // retry hits the still-dirty save, throws a second time out of the error
  // renderer, and the worker dies on the way to reporting the failure.
  let finalised = false;
  rawRes.end = function (...args: any[]) {
    if (finalised) return origEnd(...args);
    finalised = true;

    // Same policy as the start side above: loud, then degrade. Session.save()
    // already logs a backend write failure and returns false without throwing,
    // so anything arriving here is a failure OUTSIDE that policy (a strict-mode
    // re-throw, or the cookie/gc work below) and was previously unguarded - in
    // res.end, where an uncaught throw is especially bad.
    try {
      sess.save();
    } catch (err) {
      Log.error(`Session could not be finalised for this response (${errorLabel(err)})`);
      if (sessionStrictMode()) throw err;
    }

    // Probabilistic garbage collection (~1% of requests)
    if (Math.floor(Math.random() * 100) === 0) {
      try { sess.gc(); } catch { /* GC failure is non-critical */ }
    }

    const newSid = (sess as any).sessionId ?? (sess as any).getSessionId?.();
    if (newSid && newSid !== existingSid && !rawRes.headersSent) {
      const ttl = parseInt(process.env.TINA4_SESSION_TTL ?? "3600", 10);
      // Thread the client's real scheme in so an HTTPS deploy behind a
      // TLS-terminating proxy ships the session cookie with `Secure`
      // (nodejs#34). `x-forwarded-proto` is the same header request.ts trusts
      // for URL construction; native socket TLS is the fallback.
      const xfProto = rawReq.headers["x-forwarded-proto"];
      const forwardedProto = Array.isArray(xfProto) ? xfProto[0] : xfProto;
      const socketEncrypted = (rawReq.socket as { encrypted?: boolean })?.encrypted === true;
      // appendHeader, not setHeader (feature 131 fix, found while proving
      // TC-DEC-02): setHeader REPLACES any existing Set-Cookie value wholesale,
      // so a route that had already called response.cookie() of its own — on
      // the SAME request that also needs a fresh session cookie (first visit
      // to any route, or a session id rotation) — had its own cookie(s)
      // silently discarded, live server included, not just under TestClient.
      // appendHeader adds to whatever is already there (promoting a scalar to
      // an array, extending an existing array) and behaves exactly like
      // setHeader when nothing is set yet, so the common case is unchanged.
      rawRes.appendHeader("Set-Cookie", buildSessionCookie(newSid, ttl, undefined, forwardedProto, socketEncrypted));
    }
    return origEnd(...args);
  } as typeof rawRes.end;
}

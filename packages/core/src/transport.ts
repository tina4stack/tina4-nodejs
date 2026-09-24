/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * The HTTP transport around node:http (ADR-0068 sections 2-4).
 *
 * node:http parses the request, so most of the rules are its own; this module
 * makes what the client SEES match the contract every Tina4 framework keeps:
 *
 *  - every transport rejection (400, 408, 413, 431, 500) has one shape: an
 *    exact JSON body, Content-Type, Content-Length, Connection: close and the
 *    canonical security headers (no HSTS - it is written before the scheme is
 *    known);
 *  - TINA4_MAX_REQUEST_HEADER caps the head (431) and TINA4_REQUEST_TIMEOUT
 *    answers a request that stalls part-way (408);
 *  - a declared body over TINA4_MAX_UPLOAD_SIZE is refused before any of it is
 *    read, and a refused upload is closed - node:http would otherwise read and
 *    discard the rest of it to keep the connection alive;
 *  - a header node:http refuses natively still produces the fixture's answer
 *    (500 {"error":"Invalid response header"}), not a route error page.
 */
import { createServer, validateHeaderName, validateHeaderValue } from "node:http";
import type { IncomingMessage, ServerResponse, Server, OutgoingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { SecurityHeadersMiddleware } from "./middleware.js";
import { Log } from "./logger.js";
import { quoteHeaderName } from "./response.js";
import { resolveLimit, maxUploadSize, bodyTooLargeMessage } from "./request.js";

const DEFAULT_MAX_REQUEST_HEADER = 65_536;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;

/**
 * After a rejection the server stops reading the connection at once and keeps
 * it open for at most HOLD_SECONDS before closing it (ADR-0068 section 4).
 *
 * Why hold rather than close: closing with unread bytes in the kernel buffer
 * sends a reset, and a client still uploading would lose the answer. Why not
 * drain (read and discard, as PHP and Python do): on loopback two seconds of
 * draining is gigabytes read, and a refused upload must not make the server
 * read more of it. Paused, TCP flow control stalls the client instead, it
 * reads the answer, and the bytes read after the refusal stay bounded by what
 * was already in flight.
 */
const HOLD_SECONDS = 2;

const held = new WeakSet<Socket>();
function stopReadingThenClose(socket: Socket): void {
  if (held.has(socket)) return;
  held.add(socket);
  socket.pause();
  // node:http resumes the socket to discard an unread request body (and after
  // a parse error); on this socket that must not happen any more.
  (socket as Socket & { resume: () => Socket }).resume = () => socket;
  const timer = setTimeout(() => socket.destroy(), HOLD_SECONDS * 1000);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}

const REASONS: Record<number, string> = {
  400: "Bad Request",
  408: "Request Timeout",
  413: "Content Too Large",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
};

function rejectionHeaders(body: string): Array<[string, string]> {
  const headers: Array<[string, string]> = [
    ["Content-Type", "application/json"],
    ["Content-Length", String(Buffer.byteLength(body))],
    ["Connection", "close"],
  ];
  for (const [name, value] of Object.entries(SecurityHeadersMiddleware.canonicalHeaders())) {
    // A broken environment override must not break the rejection itself.
    if (!/[\r\n\0]/.test(value)) headers.push([name, value]);
  }
  return headers;
}

function rejectionBody(message: string): string {
  return JSON.stringify({ error: message });
}

/** A whole rejection as raw bytes, for a socket no ServerResponse owns yet. */
function rawRejection(status: number, message: string): string {
  const body = rejectionBody(message);
  const head = rejectionHeaders(body).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  return `HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}\r\n${head}\r\n${body}`;
}

/**
 * Answer through a ServerResponse with the rejection shape and close. Every
 * header already on the response is dropped: the shape is exact. Node closes
 * the connection once the answer is flushed (Connection: close), so the rest
 * of a refused upload is never read.
 */
export function sendTransportRejection(res: ServerResponse, status: number, message: string, end = res.end.bind(res)): void {
  if (res.headersSent) {
    res.socket?.destroy();
    return;
  }
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.statusCode = status;
  res.statusMessage = REASONS[status] ?? "Error";
  const body = rejectionBody(message);
  for (const [name, value] of rejectionHeaders(body)) res.setHeader(name, value);
  res.shouldKeepAlive = false;
  const socket = res.socket;
  if (socket) {
    // node:http closes a Connection: close response with destroySoon() once
    // it is flushed, which resets a client that is still uploading before it
    // has read the answer. Half-close instead; stopReadingThenClose() closes.
    (socket as Socket & { destroySoon: () => void }).destroySoon = () => socket.end();
    stopReadingThenClose(socket);
  }
  end(body);
}

/** Write a rejection to a socket no response owns yet, then drain and close. */
const rejectedSockets = new WeakSet<Socket>();
function rejectSocket(socket: Socket, status: number, message: string): void {
  if (rejectedSockets.has(socket)) return;
  rejectedSockets.add(socket);
  socket.end(rawRejection(status, message));
  stopReadingThenClose(socket);
}

const HEADER_REFUSAL_CODES = new Set(["ERR_INVALID_CHAR", "ERR_INVALID_HTTP_TOKEN", "ERR_HTTP_INVALID_HEADER_VALUE"]);

function isHeaderRefusal(err: unknown): boolean {
  return err instanceof TypeError && HEADER_REFUSAL_CODES.has((err as { code?: string }).code ?? "");
}

/**
 * ADR-0068 section 2 for Node. node:http refuses an unsafe header where it is
 * set (setHeader / appendHeader / writeHead). A header set straight on the raw
 * response - past Tina4's own call-site check - used to surface as a route
 * error page. Here the refusal is recorded instead, and whatever the handler
 * sends next becomes the fixture's 500 {"error":"Invalid response header"},
 * logged by header name. Tina4's own Response keeps refusing at the call site
 * (its check runs before this layer is reached).
 */
export function guardUnsafeHeaders(res: ServerResponse): void {
  let refusedName: string | null = null;
  const originalEnd = res.end.bind(res);
  const originalWrite = res.write.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  const originalSetHeader = res.setHeader.bind(res);
  const originalAppendHeader = typeof res.appendHeader === "function" ? res.appendHeader.bind(res) : null;

  const refuse = (name: unknown): void => {
    if (refusedName !== null) return;
    refusedName = String(name);
    Log.error(
      `Refusing to write an unsafe response header ${quoteHeaderName(refusedName)}: ` +
        "the name is not an HTTP token or the value contains CR, LF or NUL",
    );
  };
  // While the refusal itself is being written the wrappers step aside:
  // node:http's end() calls this.writeHead() and this.setHeader() internally.
  let answering = false;
  const answerRefused = (): void => {
    if (answering) return;
    answering = true;
    sendTransportRejection(res, 500, "Invalid response header", originalEnd as typeof res.end);
  };

  res.setHeader = function (name: string, value: number | string | readonly string[]) {
    try {
      return originalSetHeader(name, value);
    } catch (err) {
      if (!isHeaderRefusal(err)) throw err;
      refuse(name);
      return res;
    }
  } as typeof res.setHeader;

  if (originalAppendHeader) {
    res.appendHeader = function (name: string, value: string | readonly string[]) {
      try {
        return originalAppendHeader(name, value);
      } catch (err) {
        if (!isHeaderRefusal(err)) throw err;
        refuse(name);
        return res;
      }
    } as typeof res.appendHeader;
  }

  res.writeHead = function (this: ServerResponse, statusCode: number, ...rest: unknown[]) {
    // Validate the headers object BEFORE anything reaches the wire: node:http
    // would otherwise send the head without the refused header.
    const headers = rest.find((arg) => arg !== null && typeof arg === "object") as OutgoingHttpHeaders | string[] | undefined;
    if (headers && !Array.isArray(headers)) {
      for (const [name, value] of Object.entries(headers)) {
        try {
          validateHeaderName(name);
          if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) validateHeaderValue(name, String(item));
        } catch (err) {
          if (!isHeaderRefusal(err)) throw err;
          refuse(name);
        }
      }
    }
    if (refusedName !== null && !answering) return res;
    try {
      return (originalWriteHead as (...args: unknown[]) => ServerResponse)(statusCode, ...rest);
    } catch (err) {
      if (!isHeaderRefusal(err)) throw err;
      refuse("(writeHead)");
      return res;
    }
  } as typeof res.writeHead;

  res.write = function (...args: unknown[]) {
    if (refusedName !== null && !answering) {
      answerRefused();
      return false;
    }
    return (originalWrite as (...a: unknown[]) => boolean)(...args);
  } as typeof res.write;

  res.end = function (...args: unknown[]) {
    if (refusedName !== null && !answering) {
      answerRefused();
      return res;
    }
    return (originalEnd as (...a: unknown[]) => ServerResponse)(...args);
  } as typeof res.end;
}

/**
 * Refuse a request on its head alone, before a body byte is read: a
 * Transfer-Encoding other than exactly `chunked` (node:http has already
 * refused one combined with Content-Length, or repeated), and a declared
 * Content-Length over TINA4_MAX_UPLOAD_SIZE. Returns true when it answered.
 */
function rejectOnHead(req: IncomingMessage, res: ServerResponse): boolean {
  const transferEncoding = req.headers["transfer-encoding"];
  if (transferEncoding !== undefined && transferEncoding.trim().toLowerCase() !== "chunked") {
    sendTransportRejection(res, 400, "Invalid Transfer-Encoding");
    return true;
  }
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    const limit = maxUploadSize();
    const declared = BigInt(contentLength); // node:http accepts digits only
    if (declared > BigInt(limit)) {
      sendTransportRejection(res, 413, bodyTooLargeMessage(declared, limit));
      return true;
    }
  }
  return false;
}

/**
 * Answer 408 when a request's body stops arriving for TINA4_REQUEST_TIMEOUT
 * seconds. Idle, not total: a slow but steady upload is never cut off.
 * (A head that never completes is node:http's headersTimeout, set to the same
 * value.)
 */
function watchBody(req: IncomingMessage, res: ServerResponse, idleSeconds: number): void {
  if (idleSeconds <= 0 || req.complete) return;
  const socket = req.socket;
  let timer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    socket.off("data", onData);
  };
  const fire = (): void => {
    stop();
    if (req.complete) return;
    sendTransportRejection(res, 408, "Request timed out before it was complete");
  };
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, idleSeconds * 1000);
    timer.unref();
  };
  // Added after node:http's own listener, so the parser has already consumed
  // the chunk and req.complete is current.
  function onData(): void {
    if (req.complete) stop();
    else arm();
  }
  socket.on("data", onData);
  req.once("end", stop);
  req.once("close", stop);
  res.once("close", stop);
  arm();
}

/** Map a node:http parse failure to the ADR-0068 answer. */
function onClientError(err: NodeJS.ErrnoException, socket: Socket): void {
  if (rejectedSockets.has(socket) || held.has(socket)) return; // answered already
  if (err.code === "ECONNRESET" || !socket.writable) {
    socket.destroy();
    return;
  }
  const inFlight = (socket as Socket & { _httpMessage?: ServerResponse | null })._httpMessage ?? null;

  if (err.code === "ERR_HTTP_REQUEST_TIMEOUT") {
    // A connection that never sent a byte has no request to answer.
    if (socket.bytesRead === 0) {
      socket.destroy();
    } else if (inFlight) {
      sendTransportRejection(inFlight, 408, "Request timed out before it was complete");
    } else {
      rejectSocket(socket, 408, "Request timed out before it was complete");
    }
    return;
  }

  // The head was accepted and the body broke: bad chunk framing.
  if (inFlight) {
    if (inFlight.headersSent) socket.destroy();
    else sendTransportRejection(inFlight, 400, "Invalid Transfer-Encoding");
    return;
  }

  switch (err.code) {
    case "HPE_HEADER_OVERFLOW":
      rejectSocket(socket, 431, `Request header fields exceed TINA4_MAX_REQUEST_HEADER (${resolveLimit("TINA4_MAX_REQUEST_HEADER", DEFAULT_MAX_REQUEST_HEADER)} bytes)`);
      return;
    case "HPE_INVALID_CONTENT_LENGTH":
    case "HPE_UNEXPECTED_CONTENT_LENGTH":
      rejectSocket(socket, 400, "Invalid Content-Length");
      return;
    case "HPE_INVALID_TRANSFER_ENCODING":
    case "HPE_INVALID_CHUNK_SIZE":
      rejectSocket(socket, 400, "Invalid Transfer-Encoding");
      return;
    default:
      rejectSocket(socket, 400, "Malformed request head");
  }
}

/**
 * Create the HTTP server Tina4 listens with - the main port, its loopback
 * siblings, the AI port and every cluster worker - so every one of them keeps
 * the same limits and answers.
 */
export function createTina4HttpServer(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Server {
  const maxRequestHeader = resolveLimit("TINA4_MAX_REQUEST_HEADER", DEFAULT_MAX_REQUEST_HEADER);
  const idleSeconds = resolveLimit("TINA4_REQUEST_TIMEOUT", DEFAULT_REQUEST_TIMEOUT_SECONDS, true);
  const timeouts =
    idleSeconds > 0
      ? {
          headersTimeout: idleSeconds * 1000,
          requestTimeout: Math.max(300_000, idleSeconds * 1000),
          connectionsCheckingInterval: 1000,
        }
      : {};

  const server = createServer({ maxHeaderSize: maxRequestHeader, ...timeouts }, (req, res) => {
    if (rejectOnHead(req, res)) return;
    watchBody(req, res, idleSeconds);
    return handler(req, res);
  });
  server.on("clientError", onClientError);
  return server;
}

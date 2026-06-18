/**
 * Tina4 WebSocket — Zero-dependency RFC 6455 implementation.
 *
 * Native WebSocket server using Node.js built-in `http` module.
 *
 *   import { WebSocketServer } from "@tina4/core";
 *
 *   const wss = new WebSocketServer({ port: 8080 });
 *   wss.on("open", (client) => {
 *     console.log("Connected:", client.id);
 *   });
 *   wss.on("message", (client, message) => {
 *     wss.broadcast(message);
 *   });
 *   await wss.start();
 *
 * Supported:
 *   - HTTP Upgrade handshake (RFC 6455 Sec-WebSocket-Accept)
 *   - Frame protocol: text, binary, close, ping, pong
 *   - Masking / unmasking (client->server)
 *   - Extended payload lengths (7-bit, 16-bit, 64-bit)
 *   - Connection manager with broadcast
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { Server } from "node:http";
import type { WebSocketConnection } from "./websocketConnection.js";
import type { WebSocketRouteHandler } from "./types.js";
import { Router } from "./router.js";

// ── Constants ────────────────────────────────────────────────

const MAGIC_STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Opcodes
export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

// Close codes
export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_PROTOCOL_ERROR = 1002;

// ── Types ────────────────────────────────────────────────────

export interface WebSocketClient {
  id: string;
  socket: Socket;
  ip: string;
  connectedAt: number;
  closed: boolean;
  /** The URL path this client connected on (e.g. "/chat", "/notifications"). */
  path: string;
}

type EventHandler = (...args: unknown[]) => void;

// ── Frame Utilities (internal) ───────────────────────────────

/**
 * Compute Sec-WebSocket-Accept from Sec-WebSocket-Key per RFC 6455.
 */
export function computeAcceptKey(key: string): string {
  return createHash("sha1")
    .update(key + MAGIC_STRING)
    .digest("base64");
}

/**
 * Parse HTTP headers from raw upgrade request data.
 */
export function parseUpgradeHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = raw.split("\r\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  if (parts.length >= 2) {
    headers["_method"] = parts[0];
    headers["_path"] = parts[1];
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      headers[key] = value;
    }
  }
  return headers;
}

/**
 * Build a WebSocket frame (server->client, never masked).
 */
export function buildFrame(opcode: number, payload: Buffer, fin: boolean = true): Buffer {
  const frame: number[] = [];
  const firstByte = (fin ? 0x80 : 0x00) | opcode;
  frame.push(firstByte);

  const length = payload.length;
  if (length < 126) {
    frame.push(length);
  } else if (length < 65536) {
    frame.push(126);
    frame.push((length >> 8) & 0xff);
    frame.push(length & 0xff);
  } else {
    frame.push(127);
    // 8 bytes for 64-bit length
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(length));
    for (let i = 0; i < 8; i++) {
      frame.push(buf[i]);
    }
  }

  const header = Buffer.from(frame);
  return Buffer.concat([header, payload]);
}

/**
 * Parse a WebSocket frame from a buffer.
 * Returns { fin, opcode, payload, bytesConsumed } or null if not enough data.
 */
export function parseFrame(
  data: Buffer,
): { fin: boolean; opcode: number; payload: Buffer; bytesConsumed: number } | null {
  if (data.length < 2) return null;

  const fin = (data[0] >> 7) & 1;
  const opcode = data[0] & 0x0f;
  const masked = (data[1] >> 7) & 1;
  let payloadLen = data[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (data.length < 4) return null;
    payloadLen = data.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (data.length < 10) return null;
    payloadLen = Number(data.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (data.length < offset + 4 + payloadLen) return null;
    const maskKey = data.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = data[offset + i] ^ maskKey[i % 4];
    }
    return { fin: !!fin, opcode, payload, bytesConsumed: offset + payloadLen };
  }

  if (data.length < offset + payloadLen) return null;
  const payload = data.subarray(offset, offset + payloadLen);
  return { fin: !!fin, opcode, payload: Buffer.from(payload), bytesConsumed: offset + payloadLen };
}

// ── WebSocket Server ─────────────────────────────────────────

export class WebSocketServer {
  private port: number;
  private server: Server | null = null;
  private clients: Map<string, WebSocketClient> = new Map();
  private handlers: Map<string, EventHandler[]> = new Map();
  /** rooms[roomName] = Set of clientIds */
  private rooms: Map<string, Set<string>> = new Map();
  /** clientRooms[clientId] = Set of roomNames */
  private clientRooms: Map<string, Set<string>> = new Map();
  /** Route-style handlers registered via route(), keyed by path */
  private _routeHandlers: Map<string, (conn: WebSocketConnection) => void | Promise<void>> = new Map();

  constructor(options?: { port?: number }) {
    this.port = options?.port ?? parseInt(process.env.TINA4_WS_PORT ?? "8080", 10);
  }

  /**
   * Register an event handler.
   */
  on(event: string, handler: Function): WebSocketServer {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as EventHandler);
    this.handlers.set(event, list);
    return this;
  }

  /**
   * Register a WebSocket handler for a path (decorator style, matches Python).
   *
   * The handler receives a WebSocketConnection and sets up callbacks via
   * `conn.onMessage(handler)` and `conn.onClose(handler)`.
   *
   * Internally this creates an adapter that converts from the decorator style
   * to the Router's `(conn, event, data)` style and registers it via
   * `Router.websocket()`.
   */
  route(path: string, handler: (conn: WebSocketConnection) => void | Promise<void>): void {
    this._routeHandlers.set(path, handler);

    // Adapt to Router's (conn, event, data) style
    const adapter: WebSocketRouteHandler = async (conn, event, data) => {
      if (event === "open") {
        const result = handler(conn);
        if (result instanceof Promise) {
          await result;
        }
      } else if (event === "message") {
        if (conn._onMessage) {
          const result = conn._onMessage(data);
          if (result instanceof Promise) {
            await result;
          }
        }
      } else if (event === "close") {
        if (conn._onClose) {
          const result = conn._onClose();
          if (result instanceof Promise) {
            await result;
          }
        }
      }
    };

    Router.websocket(path, adapter);
  }

  /**
   * Broadcast a message to all connected clients.
   *
   * When `path` is provided, only clients connected on that specific path
   * receive the message (matching PHP's WebSocket::broadcast behaviour).
   * When `path` is omitted/undefined, all clients receive the message
   * (backward compatible).
   */
  broadcast(message: string, excludeIds?: string[], path?: string): void {
    const frame = buildFrame(OP_TEXT, Buffer.from(message, "utf-8"));
    const exclude = new Set(excludeIds ?? []);

    for (const [id, client] of this.clients) {
      if (exclude.has(id)) continue;
      if (client.closed) continue;
      if (path !== undefined && client.path !== path) continue;
      try {
        client.socket.write(frame);
      } catch {
        // client disconnected
      }
    }
  }

  /**
   * Send a message to a specific client by ID.
   */
  sendTo(clientId: string, message: string): void {
    const client = this.clients.get(clientId);
    if (!client || client.closed) return;

    const frame = buildFrame(OP_TEXT, Buffer.from(message, "utf-8"));
    try {
      client.socket.write(frame);
    } catch {
      // client disconnected
    }
  }

  /**
   * Start the WebSocket server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      });

      this.server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
        this.handleUpgrade(req, socket, head);
      });

      this.server.listen(this.port, () => {
        resolve();
      });

      this.server.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
    });
  }

  /**
   * Stop the server and disconnect all clients.
   */
  stop(): void {
    // Close all client connections
    for (const [id, client] of this.clients) {
      if (!client.closed) {
        try {
          const closeFrame = buildFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])); // 1000
          client.socket.write(closeFrame);
          client.socket.end();
        } catch {
          // already closed
        }
        client.closed = true;
      }
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Get all connected clients.
   */
  getClients(): Map<string, WebSocketClient> {
    return this.clients;
  }

  /**
   * Close a specific client connection with an optional code and reason.
   */
  close(clientId: string, code: number = 1000, reason: string = ""): void {
    const client = this.clients.get(clientId);
    if (!client || client.closed) return;
    client.closed = true;
    const reasonBytes = Buffer.from(reason, "utf-8");
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    try {
      client.socket.write(buildFrame(OP_CLOSE, payload));
      client.socket.end();
    } catch {
      // already closed
    }
    this.clients.delete(clientId);
    this.removeClientFromAllRooms(clientId);
  }

  // ── Rooms ──────────────────────────────────────────────────

  /**
   * Add a client to a named room.
   */
  joinRoom(clientId: string, roomName: string): void {
    if (!this.rooms.has(roomName)) this.rooms.set(roomName, new Set());
    this.rooms.get(roomName)!.add(clientId);

    if (!this.clientRooms.has(clientId)) this.clientRooms.set(clientId, new Set());
    this.clientRooms.get(clientId)!.add(roomName);
  }

  /**
   * Remove a client from a named room.
   */
  leaveRoom(clientId: string, roomName: string): void {
    this.rooms.get(roomName)?.delete(clientId);
    this.clientRooms.get(clientId)?.delete(roomName);
  }

  /**
   * Return the list of client IDs in a room.
   */
  getRoomConnections(roomName: string): string[] {
    return Array.from(this.rooms.get(roomName) ?? []);
  }

  /**
   * Return the number of clients in a room.
   */
  roomCount(roomName: string): number {
    return this.rooms.get(roomName)?.size ?? 0;
  }

  /**
   * Return the names of all rooms a client has joined.
   */
  getClientRooms(clientId: string): string[] {
    return Array.from(this.clientRooms.get(clientId) ?? []);
  }

  /**
   * Broadcast a message to all clients in a room.
   */
  broadcastToRoom(roomName: string, message: string, excludeIds?: string[]): void {
    const members = this.rooms.get(roomName);
    if (!members) return;

    const frame = buildFrame(OP_TEXT, Buffer.from(message, "utf-8"));
    const exclude = new Set(excludeIds ?? []);

    for (const clientId of members) {
      if (exclude.has(clientId)) continue;
      const client = this.clients.get(clientId);
      if (!client || client.closed) continue;
      try {
        client.socket.write(frame);
      } catch {
        // client disconnected
      }
    }
  }

  // ── Private ────────────────────────────────────────────────

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.handlers.get(event) ?? [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const wsKey = req.headers["sec-websocket-key"];
    if (!wsKey) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const wsVersion = req.headers["sec-websocket-version"];
    if (wsVersion && wsVersion !== "13") {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\n\r\n");
      socket.destroy();
      return;
    }

    // Compute accept key and send upgrade response
    const acceptKey = computeAcceptKey(wsKey);
    const response = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n");

    socket.write(response);

    // Create client — track the URL path for path-scoped broadcast
    const clientId = randomUUID().slice(0, 8);
    const client: WebSocketClient = {
      id: clientId,
      socket,
      ip: (socket.remoteAddress ?? "unknown"),
      connectedAt: Date.now(),
      closed: false,
      path: req.url ?? "/",
    };

    this.clients.set(clientId, client);
    this.emit("open", client);

    // Handle incoming data
    let buffer: Buffer = Buffer.alloc(0);
    if (head.length > 0) {
      buffer = Buffer.concat([buffer, head]);
    }

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      this.processBuffer(client, buffer, (remaining) => {
        buffer = remaining;
      });
    });

    socket.on("close", () => {
      client.closed = true;
      this.clients.delete(clientId);
      this.removeClientFromAllRooms(clientId);
      this.emit("close", client);
    });

    socket.on("error", (err) => {
      client.closed = true;
      this.clients.delete(clientId);
      this.removeClientFromAllRooms(clientId);
      this.emit("error", err, client);
    });
  }

  private processBuffer(
    client: WebSocketClient,
    buffer: Buffer,
    setBuffer: (remaining: Buffer) => void,
  ): void {
    let remaining = buffer;

    while (remaining.length > 0) {
      const frame = parseFrame(remaining);
      if (!frame) break;

      remaining = remaining.subarray(frame.bytesConsumed);

      switch (frame.opcode) {
        case OP_TEXT:
          this.emit("message", client, frame.payload.toString("utf-8"));
          break;

        case OP_BINARY:
          this.emit("message", client, frame.payload);
          break;

        case OP_PING: {
          const pongFrame = buildFrame(OP_PONG, frame.payload);
          try {
            client.socket.write(pongFrame);
          } catch {
            // client disconnected
          }
          break;
        }

        case OP_PONG:
          // ignore
          break;

        case OP_CLOSE: {
          if (!client.closed) {
            client.closed = true;
            const closeFrame = buildFrame(OP_CLOSE, Buffer.from([0x03, 0xe8]));
            try {
              client.socket.write(closeFrame);
              client.socket.end();
            } catch {
              // already closed
            }
            this.clients.delete(client.id);
            this.removeClientFromAllRooms(client.id);
            this.emit("close", client);
          }
          break;
        }
      }
    }

    setBuffer(remaining);
  }

  private removeClientFromAllRooms(clientId: string): void {
    const rooms = this.clientRooms.get(clientId);
    if (rooms) {
      for (const roomName of rooms) {
        this.rooms.get(roomName)?.delete(clientId);
      }
    }
    this.clientRooms.delete(clientId);
  }
}

// ── Dev-reload WebSocket manager ─────────────────────────────

/** A single accepted /__dev_reload socket plus its dashboard tracker id. */
interface DevReloadClient {
  socket: Socket;
  /** WsTracker id, so the connection shows in the dev-admin /__dev/api/websockets list. */
  trackerId?: string;
}

/**
 * Connection manager for the dev-reload channel (`/__dev_reload`).
 *
 * Mirrors Python's `_ws_manager` scoped to `/__dev_reload`: it accepts the
 * RFC 6455 handshake on the *main* dev server's HTTP `upgrade` event, holds the
 * raw sockets open, and lets `POST /__dev/api/reload` push an instant reload to
 * every connected browser via {@link broadcast}. The framework never reads from
 * the client — the open socket is the whole point. This restores the documented
 * WebSocket-primary DevReload design (the dev toolbar and dev-admin dashboard
 * both connect here). Registered only when `TINA4_DEBUG` is on, and never on the
 * stable AI port.
 */
class DevReloadWsManager {
  private clients: Set<DevReloadClient> = new Set();
  /** Optional hooks (add/remove) so the dev-admin connection list stays in sync. */
  private onAdd?: (remoteAddress: string, path: string) => string;
  private onRemove?: (id: string) => void;

  /** Wire dev-admin tracking callbacks (WsTracker.add / WsTracker.remove). */
  setTracker(onAdd: (remoteAddress: string, path: string) => string, onRemove: (id: string) => void): void {
    this.onAdd = onAdd;
    this.onRemove = onRemove;
  }

  /** Number of currently-open dev-reload sockets (test/diagnostic helper). */
  get size(): number {
    return this.clients.size;
  }

  /**
   * Accept a WebSocket upgrade on `/__dev_reload` and hold the socket open.
   *
   * Completes the RFC 6455 handshake, registers the connection, and drains
   * inbound frames — responding to pings and cleaning up on close — without
   * ever interpreting client data. Returns true if the handshake was accepted.
   */
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const wsKey = req.headers["sec-websocket-key"];
    if (!wsKey || (typeof wsKey === "string" && wsKey.length === 0)) {
      try {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
      } catch {
        /* socket already gone */
      }
      return false;
    }

    const acceptKey = computeAcceptKey(Array.isArray(wsKey) ? wsKey[0] : wsKey);
    const response = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n");
    try {
      socket.write(response);
    } catch {
      return false;
    }

    const client: DevReloadClient = { socket };
    if (this.onAdd) {
      client.trackerId = this.onAdd(socket.remoteAddress ?? "unknown", "/__dev_reload");
    }
    this.clients.add(client);

    const cleanup = () => {
      if (!this.clients.has(client)) return;
      this.clients.delete(client);
      if (client.trackerId && this.onRemove) this.onRemove(client.trackerId);
    };

    // We don't act on client data, but we must still drain frames so the OS
    // buffer doesn't stall, answer pings, and notice a client-side close.
    let buffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        const frame = parseFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.bytesConsumed);
        if (frame.opcode === OP_PING) {
          try {
            socket.write(buildFrame(OP_PONG, frame.payload));
          } catch {
            /* client disconnected */
          }
        } else if (frame.opcode === OP_CLOSE) {
          try {
            socket.write(buildFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])));
            socket.end();
          } catch {
            /* already closed */
          }
          cleanup();
          return;
        }
      }
    });
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    return true;
  }

  /**
   * Broadcast a text frame to every connected dev-reload client.
   *
   * Best-effort: a dead socket is dropped silently. Never throws — the caller
   * (`POST /__dev/api/reload`) must not 500 because a browser tab went away.
   */
  broadcast(message: string): void {
    if (this.clients.size === 0) return;
    const frame = buildFrame(OP_TEXT, Buffer.from(message, "utf-8"));
    for (const client of Array.from(this.clients)) {
      try {
        client.socket.write(frame);
      } catch {
        this.clients.delete(client);
        if (client.trackerId && this.onRemove) this.onRemove(client.trackerId);
      }
    }
  }
}

/** Process-wide dev-reload manager (one channel: `/__dev_reload`). */
export const devReloadWs = new DevReloadWsManager();

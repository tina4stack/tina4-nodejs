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
import { Log } from "./logger.js";
import { WsBackplaneManager, type WsEnvelope } from "./websocketBackplane.js";

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
export const CLOSE_POLICY_VIOLATION = 1008;

// ── Types ────────────────────────────────────────────────────

export interface WebSocketClient {
  id: string;
  socket: Socket;
  ip: string;
  connectedAt: number;
  closed: boolean;
  /** The URL path this client connected on (e.g. "/chat", "/notifications"). */
  path: string;
  /**
   * Epoch ms of the last inbound frame. Updated on every frame; the idle
   * reaper closes connections silent longer than `TINA4_WS_IDLE_TIMEOUT`
   * (opt-in). Optional so externally-injected/legacy client objects still fit.
   */
  lastActivity?: number;
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
 * Return true if the upgrade request's `Origin` is permitted.
 *
 * Controlled by `TINA4_WS_ALLOWED_ORIGINS` (comma-separated list of exact
 * origins, e.g. `https://app.example.com,https://admin.example.com`).
 *
 * Empty/unset = allow ALL origins (current behaviour, non-breaking). When set,
 * only requests whose `Origin` header exactly matches a listed value are
 * allowed; a missing `Origin` header is rejected once the allow-list is active.
 * Header lookup is case-insensitive on the key (Node lowercases header keys,
 * but the helper also checks an exact `Origin` so it works with raw maps too).
 */
export function originAllowed(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = (process.env.TINA4_WS_ALLOWED_ORIGINS ?? "").trim();
  if (!raw) return true; // No allow-list configured — permit everything.
  const allowed = new Set(
    raw.split(",").map((o) => o.trim()).filter((o) => o.length > 0),
  );
  if (allowed.size === 0) return true;
  const rawOrigin = headers["origin"] ?? headers["Origin"];
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  return origin !== undefined && allowed.has(origin);
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
  /**
   * Backplane (multi-instance scaling). Lazily wired on the first broadcast
   * via {@link ensureBackplane}. Each instance owns a stable id so it can
   * ignore its own echoes coming back over the shared pub/sub channel.
   */
  private backplane: WsBackplaneManager = new WsBackplaneManager();
  /** Set once ensureBackplane() has fired so we only attempt the wiring once. */
  private backplaneStarted = false;
  /** Idle-connection reaper timer (opt-in via TINA4_WS_IDLE_TIMEOUT). */
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { port?: number }) {
    this.port = options?.port ?? parseInt(process.env.TINA4_WS_PORT ?? "8080", 10);
  }

  /** Test/diagnostic helper: this instance's stable backplane id. */
  get instanceId(): string {
    return this.backplane.instanceId;
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
  broadcast(message: string | Buffer, excludeIds?: string[], path?: string): void {
    this.ensureBackplane();
    const exclude = new Set(excludeIds ?? []);
    // Deliver to LOCAL connections first (resilient — a dead client is pruned,
    // never aborts the loop), then fan out to sibling instances.
    for (const [id, client] of Array.from(this.clients)) {
      if (exclude.has(id)) continue;
      if (path !== undefined && client.path !== path) continue;
      this.safeSend(client, message);
    }
    this.backplane.publish(
      path !== undefined ? "path" : "all",
      message,
      { path: path ?? null, exclude: excludeIds?.[0] ?? null },
      Log,
    );
  }

  /**
   * Send a message to a specific client by ID.
   *
   * Local-only: a connection lives on exactly one instance, so there is
   * nothing to fan out over the backplane.
   */
  sendTo(clientId: string, message: string | Buffer): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.safeSend(client, message);
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
        this.startIdleReaper();
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
    // Cancel the idle reaper if it was started.
    if (this.reaperTimer !== null) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
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
   *
   * Resilient to dead clients (a failed send prunes the client, never aborts
   * the loop) and fans out to sibling instances over the backplane when
   * configured — a room can span instances, so each one delivers to its own
   * members.
   */
  broadcastToRoom(roomName: string, message: string | Buffer, excludeIds?: string[]): void {
    this.ensureBackplane();
    const members = this.rooms.get(roomName);
    const exclude = new Set(excludeIds ?? []);

    if (members) {
      for (const clientId of Array.from(members)) {
        if (exclude.has(clientId)) continue;
        const client = this.clients.get(clientId);
        if (!client) continue;
        this.safeSend(client, message);
      }
    }
    this.backplane.publish("room", message, { room: roomName, exclude: excludeIds?.[0] ?? null }, Log);
  }

  // ── Private ────────────────────────────────────────────────

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.handlers.get(event) ?? [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  // ── Backplane (multi-instance scaling) ─────────────────────
  //
  // When TINA4_WS_BACKPLANE is configured, every broadcast is ALSO published
  // to a shared pub/sub channel so sibling server instances can relay it to
  // their own local connections. Node is single-threaded async, so the
  // subscribe callback relays directly on the event loop (no thread bridge) —
  // it still applies the origin guard (drop our own echo) and never
  // re-publishes (which would loop the cluster). The wiring is best-effort: a
  // backplane failure logs and degrades to local-only, never crashing a
  // broadcast.

  /** Lazily wire the backplane on the first broadcast. Idempotent. */
  private ensureBackplane(): void {
    if (this.backplaneStarted) return;
    this.backplaneStarted = true;
    // Fire-and-forget: ensure() is async (connecting to the bus), but the
    // local delivery that just happened must not wait on it. Any failure is
    // logged inside ensure() and degrades to local-only.
    void this.backplane.ensure((env) => this.relayLocal(env), Log);
  }

  /**
   * Deliver a remote-originated envelope to LOCAL connections only. NEVER
   * re-publishes (that would loop the message around the cluster). Dispatches
   * by `kind`: room / path / all.
   */
  private relayLocal(env: WsEnvelope): void {
    const message = WsBackplaneManager.decodeMessage(env);
    if (message === null) return;
    const exclude = env.exclude ?? null;

    let targets: WebSocketClient[];
    if (env.kind === "room") {
      const members = env.room ? this.rooms.get(env.room) : undefined;
      targets = members
        ? Array.from(members).map((id) => this.clients.get(id)).filter((c): c is WebSocketClient => !!c)
        : [];
    } else if (env.kind === "path") {
      targets = env.path
        ? Array.from(this.clients.values()).filter((c) => c.path === env.path)
        : [];
    } else {
      // "all" (and anything unknown) → every local connection
      targets = Array.from(this.clients.values());
    }

    for (const client of targets) {
      if (exclude && client.id === exclude) continue;
      this.safeSend(client, message);
    }
  }

  /**
   * Send to ONE client without letting a single dead/slow client abort a
   * broadcast loop. A write failure (or an already-closed client) is logged
   * and the client is pruned. Returns true if the frame was handed to the
   * socket.
   *
   * Slow-client backpressure: `socket.write()` returns false when the kernel
   * send buffer is full. We don't unboundedly buffer — a client whose backlog
   * has blown past TINA4_WS_MAX_BACKLOG bytes is hopelessly behind, so we drop
   * and close it rather than let it grow the process heap without bound.
   */
  private safeSend(client: WebSocketClient, message: string | Buffer): boolean {
    if (client.closed) {
      this.pruneClient(client);
      return false;
    }
    const payload = typeof message === "string" ? Buffer.from(message, "utf-8") : message;
    const opcode = typeof message === "string" ? OP_TEXT : OP_BINARY;
    const frame = buildFrame(opcode, payload);
    try {
      // A saturated socket buffer means the client can't keep up. write()
      // still queues the frame and returns false; if the queued backlog is
      // hopeless, close the client rather than buffer without bound.
      client.socket.write(frame);
      const backlog = client.socket.writableLength ?? 0;
      const maxBacklog = parseInt(process.env.TINA4_WS_MAX_BACKLOG ?? "1048576", 10);
      if (maxBacklog > 0 && backlog > maxBacklog) {
        Log.warn(`WebSocket client ${client.id} backlog ${backlog}B exceeds limit, dropping slow client`);
        this.pruneClient(client);
        return false;
      }
      return true;
    } catch (err) {
      Log.warn(`WebSocket send to ${client.id} failed, pruning: ${(err as Error).message}`);
      this.pruneClient(client);
      return false;
    }
  }

  /** Remove a client from the manager, rooms, and close its socket. */
  private pruneClient(client: WebSocketClient): void {
    client.closed = true;
    this.clients.delete(client.id);
    this.removeClientFromAllRooms(client.id);
    try {
      client.socket.destroy();
    } catch {
      /* already gone */
    }
  }

  // ── Idle reaper (opt-in via TINA4_WS_IDLE_TIMEOUT) ──────────

  /**
   * Close connections whose last inbound frame is older than `timeoutSeconds`.
   * Returns the number reaped. `timeoutSeconds <= 0` is a no-op (the reaper is
   * opt-in via TINA4_WS_IDLE_TIMEOUT).
   */
  reapIdle(timeoutSeconds: number): number {
    if (timeoutSeconds <= 0) return 0;
    const now = Date.now();
    const cutoff = timeoutSeconds * 1000;
    const stale = Array.from(this.clients.values()).filter(
      (c) => now - (c.lastActivity ?? c.connectedAt ?? now) > cutoff,
    );
    for (const client of stale) {
      this.close(client.id, CLOSE_GOING_AWAY, "idle timeout");
    }
    if (stale.length > 0) {
      Log.info(`WebSocket idle reaper closed ${stale.length} connection(s)`);
    }
    return stale.length;
  }

  /**
   * Spin up the idle-connection reaper when TINA4_WS_IDLE_TIMEOUT is a
   * positive number of seconds. Opt-in and non-breaking — unset/0 means no
   * timer is created at all (current behaviour). Called from start().
   */
  private startIdleReaper(): void {
    const raw = process.env.TINA4_WS_IDLE_TIMEOUT ?? "0";
    const timeout = parseFloat(raw);
    if (!Number.isFinite(timeout) || timeout <= 0 || this.reaperTimer !== null) return;
    // Sweep at a fraction of the timeout (min 1s) so an idle conn is closed
    // within roughly one timeout window of going silent.
    const intervalMs = Math.max(1000, (timeout / 2) * 1000);
    this.reaperTimer = setInterval(() => {
      try {
        this.reapIdle(timeout);
      } catch (err) {
        Log.error(`WebSocket idle reaper sweep failed: ${(err as Error).message}`);
      }
    }, intervalMs);
    // Don't keep the event loop alive just for the reaper.
    this.reaperTimer.unref?.();
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

    // Origin allow-list (opt-in via TINA4_WS_ALLOWED_ORIGINS). Unset = allow
    // all, so this never breaks an existing deployment.
    if (!originAllowed(req.headers)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Compute accept key and send upgrade response
    const acceptKey = computeAcceptKey(Array.isArray(wsKey) ? wsKey[0] : wsKey);
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
      lastActivity: Date.now(),
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
      client.lastActivity = Date.now(); // mark activity for the idle reaper

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

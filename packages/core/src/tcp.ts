// Copyright (c) 2026 Code Infinity
// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Raw TCP service — a user-facing, non-HTTP, long-lived binary TCP listener.
 *
 * Governed by ADR-0102 (feature 142), and the Python reference tina4_python/tcp.
 * A Tina4 app exposes its own protocol — a GPS/GPRS car-tracker gateway
 * (GT06/TK103/Concox/Teltonika) is the driving case — in the SAME process as its
 * HTTP dashboard, reusing config, logging, ORM and queue.
 *
 *   const svc = tcpService(5023, {
 *     onData(conn, data) {
 *       const frame = parse(data);               // the APP frames the stream
 *       if (frame.isLogin) conn.identify(frame.imei);
 *       conn.send(ackFor(frame));                // ACK on the same socket
 *     },
 *   });
 *
 *   // server -> device push from an HTTP route:
 *   tcp("trackers").sendTo(imei, buildCommand("set_interval", 30));
 *
 * The listener runs on the SAME event loop as the HTTP server (D1 in-process),
 * via `net.createServer`. The framework owns the socket hard-parts: lifecycle,
 * max_connections refusal, an idle reaper (default OFF for long-lived device
 * sockets), graceful-shutdown drain, bounded write backpressure, and
 * single-owner bind under N workers.
 *
 * Non-goals in v1 (ADR-0102): no CRC/length framing helper beyond on_line, no
 * TLS termination, no UDP, no replacement for the WebSocket surface.
 */
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { Log } from "./logger.js";

/** A stalled reader is dropped once this many bytes are queued unsent. */
const DEFAULT_MAX_BACKLOG = 1 << 20; // 1 MiB

export type TcpConnectHandler = (conn: TcpConnection) => void | Promise<void>;
export type TcpDataHandler = (conn: TcpConnection, data: Buffer) => void | Promise<void>;
export type TcpCloseHandler = (conn: TcpConnection) => void | Promise<void>;
export type TcpLineHandler = (conn: TcpConnection, line: Buffer) => void | Promise<void>;

export interface TcpServiceOptions {
  name?: string;
  onConnect?: TcpConnectHandler;
  onData?: TcpDataHandler;
  onClose?: TcpCloseHandler;
  onLine?: TcpLineHandler;
  /** Seconds; 0 (default) disables the idle reaper (device sockets are long-lived). */
  idleTimeout?: number;
  /** The (N+1)th connection past this is refused; unset = unbounded. */
  maxConnections?: number;
  /** Per-connection outstanding-write ceiling in bytes (default TINA4_TCP_MAX_BACKLOG or 1 MiB). */
  maxBacklog?: number;
}

function resolveMaxBacklog(explicit?: number): number {
  if (explicit !== undefined) return explicit > 0 ? explicit : DEFAULT_MAX_BACKLOG;
  const raw = (process.env.TINA4_TCP_MAX_BACKLOG ?? "").trim();
  if (raw === "") return DEFAULT_MAX_BACKLOG;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BACKLOG;
}

/**
 * One live TCP connection — the uniform connection object (ADR-0102 D5). The
 * SAME surface exists in all four frameworks so the primitive ports.
 */
export class TcpConnection {
  /** The registry id (the IMEI), or null until identify() is called. */
  id: string | null = null;
  /** Per-connection mutable state bag — the app's parse buffer, auth flag. */
  context: Record<string, unknown> = {};
  /** The raw TCP peer address ("127.0.0.1:54321"), never a forwarded header. */
  readonly remoteAddr: string;

  lastActivity = Date.now();
  lineBuffer: Buffer = Buffer.alloc(0);

  private closed = false;
  private closeFired = false;

  constructor(
    readonly socket: Socket,
    private readonly service: TcpService,
  ) {
    this.remoteAddr = `${socket.remoteAddress ?? ""}:${socket.remotePort ?? 0}`;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Register this live connection under an app-chosen id (the IMEI). A second
   * connection identifying with the same id SUPERSEDES the first in the
   * registry — exactly a device that dropped and reconnected.
   */
  identify(appId: string | number): this {
    this.id = String(appId);
    this.service._registerId(this.id, this);
    return this;
  }

  /**
   * Write raw bytes to THIS socket. Returns true when queued/sent, false when
   * the connection is closed or dropped for backpressure. A stalled reader
   * (never draining) is bounded: once more than the service's maxBacklog bytes
   * are outstanding, the connection is dropped rather than buffered without end
   * (mirrors the WebSocket TINA4_WS_MAX_BACKLOG posture).
   */
  send(data: Buffer | string): boolean {
    if (this.closed) return false;
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    this.socket.write(buffer);
    if (this.socket.writableLength > this.service.maxBacklog) {
      Log.warning(
        `tcp_service '${this.service.name}': dropping a stalled reader — ` +
          `${this.socket.writableLength} bytes queued exceeds the ` +
          `${this.service.maxBacklog}-byte backlog limit`,
      );
      this.close();
      return false;
    }
    return true;
  }

  /**
   * Close this connection. on_close fires exactly once (from the socket's close
   * event) and the registry entry is removed.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  /** @internal mark activity for the idle reaper. */
  _touch(): void {
    this.lastActivity = Date.now();
  }

  /** @internal fire on_close exactly once (called from the service removal path). */
  _fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.closed = true;
    const handler = this.service._callbacks.onClose;
    if (!handler) return;
    try {
      void Promise.resolve(handler(this)).catch((error: unknown) => {
        Log.error(`tcp_service '${this.service.name}' onClose error: ${String(error)}`);
      });
    } catch (error) {
      Log.error(`tcp_service '${this.service.name}' onClose error: ${String(error)}`);
    }
  }
}

/** A named raw TCP listener and its connection registry (ADR-0102). */
export class TcpService {
  readonly name: string;
  readonly port: number;
  readonly maxBacklog: number;
  /** @internal the callback bag, read by TcpConnection. */
  readonly _callbacks: Required<Pick<TcpServiceOptions, never>> & {
    onConnect?: TcpConnectHandler;
    onData?: TcpDataHandler;
    onClose?: TcpCloseHandler;
    onLine?: TcpLineHandler;
  };

  private readonly idleTimeout: number;
  private readonly maxConnections: number | null;
  private readonly connections = new Set<TcpConnection>();
  private readonly byId = new Map<string, TcpConnection>();
  private server: Server | null = null;
  private owner = false;
  private boundPortValue: number | null = null;
  private reaper: NodeJS.Timeout | null = null;

  constructor(port: number, options: TcpServiceOptions = {}) {
    this.port = port;
    this.name = options.name ?? "default";
    this._callbacks = {
      onConnect: options.onConnect,
      onData: options.onData,
      onClose: options.onClose,
      onLine: options.onLine,
    };
    // Default OFF: tracker sockets are deliberately long-lived and mostly idle
    // between location packets, so a default reaper would kill healthy devices.
    this.idleTimeout = options.idleTimeout ?? 0;
    this.maxConnections = options.maxConnections ?? null;
    this.maxBacklog = resolveMaxBacklog(options.maxBacklog);
  }

  get isOwner(): boolean {
    return this.owner;
  }

  /** The port actually bound (resolves an ephemeral port=0 to the real one). */
  get boundPort(): number {
    return this.boundPortValue ?? this.port;
  }

  count(): number {
    return this.connections.size;
  }

  // ── Registry (D4 — server -> device push) ──────────────────────────────────

  /** @internal */
  _registerId(appId: string, conn: TcpConnection): void {
    this.byId.set(appId, conn); // supersede: the live reconnection wins
  }

  /** The live connection for an app id, or null if unknown or closed. */
  connection(appId: string | number): TcpConnection | null {
    const conn = this.byId.get(String(appId));
    if (!conn || conn.isClosed) return null;
    return conn;
  }

  /**
   * Write bytes to exactly the connection identified by appId. A send to an
   * unknown or closed id is a NO-OP that returns false — never a throw.
   */
  sendTo(appId: string | number, data: Buffer | string): boolean {
    const conn = this.connection(appId);
    if (!conn) return false;
    return conn.send(data);
  }

  /** Write bytes to every live connection. Returns how many received it. */
  broadcast(data: Buffer | string): number {
    let delivered = 0;
    for (const conn of [...this.connections]) {
      if (conn.send(data)) delivered += 1;
    }
    return delivered;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Bind the listener on host:port on the event loop. SO_REUSEPORT is OFF, so
   * under a multi-worker deployment exactly ONE worker wins the bind; a worker
   * that finds the port already bound skips silently (single-owner, D1).
   * Resolves true when THIS call bound the port.
   */
  start(host = "0.0.0.0"): Promise<boolean> {
    if (this.server) return Promise.resolve(this.owner);
    return new Promise((resolve) => {
      const server = createServer((socket) => this.handleConnection(socket));
      this.server = server;
      const onError = (error: NodeJS.ErrnoException): void => {
        if (error.code === "EADDRINUSE" || error.code === "EADDRNOTAVAIL") {
          this.owner = false;
          this.server = null;
          Log.info(
            `tcp_service '${this.name}' port ${this.port} is already bound by another worker — ` +
              `single-owner, this worker will not bind (${error.code})`,
          );
          resolve(false);
          return;
        }
        Log.error(`tcp_service '${this.name}' failed to start: ${error.message}`);
        this.server = null;
        resolve(false);
      };
      server.once("error", onError);
      server.listen(this.port, host, () => {
        server.off("error", onError);
        server.on("error", (error) => Log.error(`tcp_service '${this.name}' error: ${String(error)}`));
        this.owner = true;
        const addr = server.address();
        this.boundPortValue = typeof addr === "object" && addr ? addr.port : this.port;
        Log.info(`tcp_service '${this.name}' listening on ${host}:${this.boundPortValue}`);
        this.startReaper();
        resolve(true);
      });
    });
  }

  private handleConnection(socket: Socket): void {
    // Refuse past the limit BEFORE the connection joins the registry.
    if (this.maxConnections !== null && this.connections.size >= this.maxConnections) {
      socket.destroy();
      return;
    }
    const conn = new TcpConnection(socket, this);
    this.connections.add(conn);

    socket.on("data", (chunk: Buffer) => {
      // Pause while an async handler runs so chunks are delivered in order
      // (parity with the Python reference awaiting each on_data).
      socket.pause();
      void this.dispatch(conn, chunk).finally(() => {
        if (!conn.isClosed) socket.resume();
      });
    });
    socket.on("close", () => this.remove(conn));
    socket.on("error", () => {
      /* a reset/broken pipe surfaces as 'close' next; never crash the loop */
    });

    const onConnect = this._callbacks.onConnect;
    if (onConnect) {
      void Promise.resolve(onConnect(conn)).catch((error: unknown) => {
        Log.error(`tcp_service '${this.name}' onConnect error: ${String(error)}`);
      });
    }
  }

  private async dispatch(conn: TcpConnection, chunk: Buffer): Promise<void> {
    conn._touch();
    const { onData, onLine } = this._callbacks;
    if (onData) {
      // Raw bytes, exactly as received — never newline-split, never decoded.
      try {
        await onData(conn, chunk);
      } catch (error) {
        Log.error(`tcp_service '${this.name}' onData error: ${String(error)}`);
      }
    }
    if (onLine) {
      conn.lineBuffer = Buffer.concat([conn.lineBuffer, chunk]);
      let newline = conn.lineBuffer.indexOf(0x0a);
      while (newline !== -1) {
        let line = conn.lineBuffer.subarray(0, newline);
        conn.lineBuffer = conn.lineBuffer.subarray(newline + 1);
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
          line = line.subarray(0, line.length - 1); // strip a trailing \r
        }
        try {
          await onLine(conn, line);
        } catch (error) {
          Log.error(`tcp_service '${this.name}' onLine error: ${String(error)}`);
        }
        newline = conn.lineBuffer.indexOf(0x0a);
      }
    }
  }

  /** @internal remove a connection and fire on_close exactly once. */
  remove(conn: TcpConnection): void {
    const existed = this.connections.delete(conn);
    if (conn.id !== null && this.byId.get(conn.id) === conn) {
      // Only drop the id when THIS connection still owns it; a newer connection
      // that superseded it keeps the id.
      this.byId.delete(conn.id);
    }
    if (existed) conn._fireClose();
  }

  // ── Idle reaper (D1 consumer shape — default OFF) ───────────────────────────

  private startReaper(): void {
    if (this.idleTimeout <= 0 || this.reaper) return;
    const intervalMs = Math.max(50, Math.min(1000, (this.idleTimeout / 2) * 1000));
    this.reaper = setInterval(() => this.reapIdle(), intervalMs);
    this.reaper.unref();
  }

  private reapIdle(): void {
    const now = Date.now();
    const limitMs = this.idleTimeout * 1000;
    for (const conn of [...this.connections]) {
      if (now - conn.lastActivity >= limitMs) conn.close();
    }
  }

  /** Stop accepting new connections (close the listener). Live conns stay. */
  stopAccepting(): void {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    if (this.server && this.owner) {
      this.server.close();
    }
  }

  /** Close every live connection (firing on_close) and release the listener. */
  async drain(): Promise<void> {
    this.stopAccepting();
    for (const conn of [...this.connections]) conn.close();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        this.server!.unref();
      }).catch(() => undefined);
      this.server = null;
    }
  }

  /** Stop accepting and drain in one call (used by direct callers/tests). */
  async stop(): Promise<void> {
    await this.drain();
  }
}

// ── Public surface: registry facade + server-driven lifecycle hooks ───────────

const services = new Map<string, TcpService>();

/**
 * Register a named raw TCP service; the server binds it on boot (D1). Options
 * are read once here. Reachable anywhere via `tcp(name)`.
 */
export function tcpService(port: number, options: TcpServiceOptions = {}): TcpService {
  const service = new TcpService(port, options);
  services.set(service.name, service);
  return service;
}

/**
 * The registry for a named service, for server -> device push. Throws for an
 * unknown service name — a programming error, unlike a send to an unknown
 * device id, which is a runtime no-op.
 */
export function tcp(name = "default"): TcpService {
  const service = services.get(name);
  if (!service) {
    const known = services.size === 0 ? "(none registered)" : [...services.keys()].join(", ");
    throw new Error(`no tcp_service named '${name}' is registered; known services: ${known}`);
  }
  return service;
}

export function registeredTcpServices(): TcpService[] {
  return [...services.values()];
}

/** Drop every registered service (test isolation; not used in production). */
export function clearTcpRegistry(): void {
  services.clear();
}

/** Start every registered service on boot (called by startServer). */
export async function startAllTcpServices(host = "0.0.0.0"): Promise<void> {
  for (const service of registeredTcpServices()) {
    try {
      await service.start(host);
    } catch (error) {
      Log.error(`tcp_service '${service.name}' failed to start: ${String(error)}`);
    }
  }
}

/** Stop every service accepting (shutdown step 1). */
export function stopAcceptingAllTcpServices(): void {
  for (const service of registeredTcpServices()) {
    try {
      service.stopAccepting();
    } catch (error) {
      Log.error(`tcp_service '${service.name}' stop-accepting failed: ${String(error)}`);
    }
  }
}

/** Drain and release every service's connections (shutdown drain step). */
export async function drainAllTcpServices(): Promise<void> {
  for (const service of registeredTcpServices()) {
    try {
      await service.drain();
    } catch (error) {
      Log.error(`tcp_service '${service.name}' drain failed: ${String(error)}`);
    }
  }
}
